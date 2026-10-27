#!/usr/bin/env python3
"""Attribution des noms « Classe::Methode » à des adresses de fonctions.

La cible nomme ses méthodes dans ses messages de journal (voir `idman_symbols.py`) mais
n'a pas de symboles. Ce script rattache chaque message à la fonction qui le pousse, en
s'appuyant sur trois sources d'ancrages de fonctions, de fiabilité décroissante :

1. `vtable`         — adresse présente dans une vtable extraite des RTTI
                      (`classes.json`) : frontière **certaine** (D-021) ;
2. `padded`         — prologue `55 8B EC` précédé de deux octets `CC`/`90` : frontière
                      certaine (remplissage MSVC) ;
3. `after-terminator` — prologue `55 8B EC` précédé d'un terminateur (`C3`, `C2`, `EB`,
                      `E9`, `FF`) : frontière **probable**, retenue seulement pour réduire
                      les grands trous ; à citer avec prudence.

L'attribution elle-même est « probable » : on prend l'ancrage le plus proche **avant**
l'instruction qui pousse la chaîne. Un `gap` (distance à l'ancrage) élevé signale une
frontière manquée, donc une attribution douteuse.

Sortie : analysis/idman/methods.json
    { "counts": {...},
      "methods":  [ {"class","method","message","push_rva","function_rva","gap",
                     "anchor","vtable_classes"} ],
      "functions": { "0x171250": ["FTPConnection::SendUser", ...] } }

Usage :
    python3 tools/idman_attrib.py [-o analysis/idman/methods.json]
"""

from __future__ import annotations

import argparse
import bisect
import hashlib
import json
import struct

import pefile

TEXT_START = 0x1000
TEXT_END = 0x279000
PUSH_OPCODES = (0x68,)
MOV_OPCODES = range(0xB8, 0xC0)
TERMINATORS = (0xC3, 0xC2, 0xEB, 0xE9, 0xFF)


class Image:
    def __init__(self, path: str):
        self.path = path
        self.raw = open(path, "rb").read()
        pe = pefile.PE(path)
        self.base = pe.OPTIONAL_HEADER.ImageBase
        self.sections = [(s.VirtualAddress, s.SizeOfRawData, s.PointerToRawData) for s in pe.sections]

    def off_to_rva(self, offset: int) -> int | None:
        for va, size, ptr in self.sections:
            if ptr <= offset < ptr + size:
                return va + offset - ptr
        return None

    def rva_to_off(self, rva: int) -> int | None:
        for va, size, ptr in self.sections:
            if va <= rva < va + size:
                return ptr + rva - va
        return None

    def u32(self, offset: int) -> int:
        return struct.unpack_from("<I", self.raw, offset)[0]


def load_symbols(path: str) -> dict:
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def load_vtable_methods(path: str) -> tuple[dict[int, set[str]], set[int]]:
    """Retourne {adresse: {classes}} et l'ensemble des adresses de méthodes virtuelles."""
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
    methods: dict[int, set[str]] = {}
    for entry in data["classes"]:
        for variant in entry["entries"]:
            for rva in variant["methods"]:
                methods.setdefault(int(rva, 16), set()).add(entry["class"])
    return methods, set(methods)


def find_anchors(image: Image, vtable_methods: set[int]) -> dict[int, str]:
    """{adresse: type d'ancrage} ; les ancrages fiables gagnent sur les probables."""
    anchors: dict[int, str] = {rva: "vtable" for rva in vtable_methods}
    raw = image.raw
    start = image.rva_to_off(TEXT_START)
    stop = image.rva_to_off(TEXT_END) - 4
    for offset in range(start + 2, stop):
        if raw[offset:offset + 3] != b"\x55\x8b\xec":
            continue
        previous = raw[offset - 1]
        if previous in (0xCC, 0x90) and raw[offset - 2] in (0xCC, 0x90):
            kind = "padded"
        elif previous in TERMINATORS:
            kind = "after-terminator"
        else:
            continue
        rva = image.off_to_rva(offset)
        if rva is not None and rva not in anchors:
            anchors[rva] = kind
    return anchors


def string_start(image: Image, offset: int, window: int = 400) -> int:
    start = image.raw.rfind(b"\x00", max(0, offset - window), offset) + 1
    return start


def push_sites(image: Image, string_rva: int) -> list[int]:
    """Adresses des `push imm32` / `mov reg, imm32` qui référencent la chaîne."""
    pattern = struct.pack("<I", image.base + string_rva)
    sites: list[int] = []
    cursor = 0
    while True:
        hit = image.raw.find(pattern, cursor)
        if hit < 0:
            break
        cursor = hit + 1
        if hit < 1:
            continue
        opcode = image.raw[hit - 1]
        if opcode not in PUSH_OPCODES and opcode not in MOV_OPCODES:
            continue
        rva = image.off_to_rva(hit - 1)
        if rva is not None and TEXT_START <= rva < TEXT_END:
            sites.append(rva)
    return sites


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pe", default="cible/IDMan.exe")
    parser.add_argument("--symbols", default="analysis/idman/symbols.json")
    parser.add_argument("--classes", default="analysis/idman/classes.json")
    parser.add_argument("-o", "--output", default="analysis/idman/methods.json")
    args = parser.parse_args()

    image = Image(args.pe)
    symbols = load_symbols(args.symbols)
    vtable_classes, vtable_methods = load_vtable_methods(args.classes)
    anchors = find_anchors(image, vtable_methods)
    ordered = sorted(anchors)

    rows: list[dict] = []
    functions: dict[str, list[str]] = {}
    unmatched = 0
    for entry in symbols["messages"]:
        offset = image.rva_to_off(int(entry["rva"], 16))
        if offset is None:
            continue
        sites = push_sites(image, image.off_to_rva(string_start(image, offset)))
        if not sites:
            unmatched += 1
            continue
        push = sites[0]
        index = bisect.bisect_right(ordered, push) - 1
        name = f"{entry['class']}::{entry['method']}"
        if index < 0:
            unmatched += 1
            continue
        function = ordered[index]
        row = {
            "class": entry["class"],
            "method": entry["method"],
            "message": entry["text"].strip(),
            "push_rva": hex(push),
            "function_rva": hex(function),
            "gap": push - function,
            "anchor": anchors[function],
            "vtable_classes": sorted(vtable_classes.get(function, [])),
        }
        rows.append(row)
        functions.setdefault(hex(function), []).append(name)

    confirmed = sum(1 for row in rows if row["anchor"] in ("vtable", "padded") and row["gap"] < 0x800)
    result = {
        "artifact": {"path": args.pe, "sha256": hashlib.sha256(image.raw).hexdigest()},
        "counts": {
            "messages": len(symbols["messages"]),
            "attributed": len(rows),
            "unmatched": unmatched,
            "functions": len(functions),
            "anchors": len(anchors),
            "confirmed": confirmed,
        },
        "methods": rows,
        "functions": dict(sorted(functions.items())),
    }
    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=1, sort_keys=True, ensure_ascii=False)
        handle.write("\n")

    print(json.dumps(result["counts"], indent=1))
    print(f"écrit {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
