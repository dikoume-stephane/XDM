#!/usr/bin/env python3
"""Où vit le grabber ? Mesure statique des frontières du module `IDMan.exe`.

Contexte : la fiche B (grabber) dépend de `Q-B-01` — l'algorithme d'exploration.
Ce script ne prétend pas le reconstituer : il **mesure** ce que le module contient
réellement du grabber, pour distinguer trois cas de figure très différents :

1. le code est là et il suffit de le lire ;
2. le code est là mais demande un décompilateur ;
3. le code **n'est pas dans ce module**.

Produit (déterministe) :

- `settings` : carte des champs de `CGrabberSettings`, extraite du chargeur
  `0x1381e0` (nom de valeur de registre → offset dans l'objet, largeur) ;
- `containers` : classes RTTI `IDMSPIDER_*` / `CArray<…SPL|RL|LI2>` et leurs
  méthodes, avec le nombre de références **code** et **données** ;
- `symbols` : chaînes du grabber (`.rdata`) avec leur RVA et leur nombre d'appels ;
- `verdict` : agrégats qui tranchent entre les trois cas ci-dessus.

Usage :
    python3 tools/idman_grabber.py [--pe cible/IDMan.exe] [-o analysis/idman/grabber.json]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import struct

import capstone
import pefile

SETTINGS_LOADER = 0x1381E0  # CGrabberSettings::Load (RegQueryValueExA par valeur)
SETTINGS_CTOR = 0x137E20  # construction de l'objet (sous-objets, deux CArray de filtres)
LOG_STEP = 0x299340  # "IDM Site Grabber. Step %d --- %s"

GRABBER_STRING = re.compile(
    r"(Grabber|grabber|Spider|spider|IDMSPIDER|\.gsd\b|Site Map|site page|robots)",
)

IGNORED_STRING_PREFIXES = (".?AV", ".?AU")


class Binary:
    def __init__(self, path: str) -> None:
        self.pe = pefile.PE(path, fast_load=True)
        self.raw = open(path, "rb").read()
        self.base = self.pe.OPTIONAL_HEADER.ImageBase
        self.sections = [
            (
                s.Name.rstrip(b"\0").decode("ascii", "replace"),
                s.VirtualAddress,
                s.Misc_VirtualSize,
                s.SizeOfRawData,
                s.PointerToRawData,
            )
            for s in self.pe.sections
        ]
        self.md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_32)
        self.md.detail = True
        self.md.skipdata = True

    # -- conversions -----------------------------------------------------
    def offset(self, rva: int) -> int | None:
        for _, va, vsize, rawsize, praw in self.sections:
            if va <= rva < va + max(vsize, rawsize):
                return praw + (rva - va)
        return None

    def rva_of(self, file_offset: int) -> int | None:
        for _, va, _, rawsize, praw in self.sections:
            if praw <= file_offset < praw + rawsize:
                return va + (file_offset - praw)
        return None

    def section_of(self, rva: int) -> str | None:
        for name, va, vsize, rawsize, _ in self.sections:
            if va <= rva < va + max(vsize, rawsize):
                return name
        return None

    def text(self):
        """Parcours linéaire de `.text` ; les octets non décodables sont sautés."""
        for name, va, _, rawsize, praw in self.sections:
            if name != ".text":
                continue
            for insn in self.md.disasm(self.raw[praw:praw + rawsize], self.base + va):
                if insn.id == 0:  # donnée sautée (mode skipdata)
                    continue
                yield insn

    def disasm_at(self, rva: int, limit: int = 4096):
        start = self.offset(rva)
        if start is None:
            return
        for insn in self.md.disasm(self.raw[start:start + limit], self.base + rva):
            if insn.id == 0:
                continue
            yield insn

    def string_at(self, va: int) -> str | None:
        rva = va - self.base
        if rva <= 0:
            return None
        off = self.offset(rva)
        if off is None:
            return None
        end = self.raw.find(b"\0", off)
        if end < 0 or end - off > 200:
            return None
        chunk = self.raw[off:end]
        if len(chunk) < 4 or not all(32 <= b < 127 for b in chunk):
            return None
        return chunk.decode("ascii")


def settings_fields(binary: Binary) -> list[dict]:
    """Carte `nom de valeur -> offset` lue dans le chargeur des réglages.

    Le motif observé est stable : `push offset "nom"` → `call RegQueryValueExA`
    → `test eax, eax` / `jne` → `mov [esi+0xNN], reg` (dword) ou
    `setne dl` + `mov byte [esi+0xNN], dl` (booléen).
    """
    fields: list[dict] = []
    current: str | None = None
    pending = 0
    for insn in binary.disasm_at(SETTINGS_LOADER, 6144):
        for op in insn.operands:
            if op.type == capstone.x86.X86_OP_IMM:
                text = binary.string_at(op.imm)
                if text and binary.section_of(op.imm - binary.base) in (".rdata", ".data"):
                    if re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{2,40}", text):
                        current = text
                        pending = 24
        if insn.mnemonic == "ret":
            break
        if current and pending > 0:
            pending -= 1
            text = insn.op_str
            match = re.search(r"(byte|word|dword) ptr \[esi \+ (0x[0-9a-f]+)\]", text)
            if match and insn.mnemonic in ("mov", "cmp", "setne", "sete", "or"):
                width = {"byte": 1, "word": 2, "dword": 4}[match.group(1)]
                offset = int(match.group(2), 16)
                if not any(f["offset"] == offset for f in fields):
                    fields.append(
                        {
                            "name": current,
                            "offset": offset,
                            "width": width,
                            "at": f"0x{insn.address - binary.base:x}",
                        }
                    )
            if pending == 0:
                current = None
    fields.sort(key=lambda f: f["offset"])
    return fields


def containers(classes_path: str) -> list[dict]:
    with open(classes_path, encoding="utf-8") as handle:
        data = json.load(handle)
    out = []
    for entry in data["classes"]:
        if "SPIDER" not in entry["class"] and "Spider" not in entry["class"]:
            continue
        for item in entry["entries"]:
            out.append(
                {
                    "class": entry["class"],
                    "vtable_rva": f"0x{item['vtable_slot_offset']:x}",
                    "methods": [f"0x{int(m, 16):x}" for m in item["methods"]],
                }
            )
    out.sort(key=lambda c: c["class"])
    return out


def reference_counts(binary: Binary, targets: set[int]) -> dict[str, dict]:
    """Compte les références code (immédiat) et données (pointeur 4 octets)."""
    counts = {t: {"code": 0, "data": 0} for t in targets}
    for insn in binary.text():
        for op in insn.operands:
            if op.type == capstone.x86.X86_OP_IMM:
                rva = op.imm - binary.base
                if rva in counts:
                    counts[rva]["code"] += 1
    for name, va, _, rawsize, praw in binary.sections:
        if name not in (".rdata", ".data"):
            continue
        chunk = binary.raw[praw:praw + rawsize]
        for index in range(0, len(chunk) - 4, 4):
            value = struct.unpack_from("<I", chunk, index)[0]
            rva = value - binary.base
            if rva in counts:
                counts[rva]["data"] += 1
    return {
        f"0x{target:x}": counts[target]
        for target in sorted(counts)
    }


def grabber_strings(binary: Binary) -> list[dict]:
    found: dict[str, dict] = {}
    for match in re.finditer(rb"[ -~]{4,160}", binary.raw):
        text = match.group().decode("ascii")
        if not GRABBER_STRING.search(text):
            continue
        if text.startswith(IGNORED_STRING_PREFIXES):
            continue
        rva = binary.rva_of(match.start())
        if rva is None or rva in found:
            continue
        found[rva] = {"rva": f"0x{rva:x}", "text": text[:120]}
    return [found[key] for key in sorted(found)]


def build(pe_path: str, classes_path: str) -> dict:
    binary = Binary(pe_path)
    fields = settings_fields(binary)
    container_rows = containers(classes_path)

    crawl_targets: set[int] = set()
    for row in container_rows:
        if row["class"].startswith("?$CArray@UIDMSPIDER") or "RELPARSERINFO" in row["class"]:
            crawl_targets.update(int(m, 16) for m in row["methods"])
            crawl_targets.add(int(row["vtable_rva"], 16))

    spider_vtable = 0x28D0C0
    crawl_targets.add(spider_vtable)

    counts = reference_counts(binary, crawl_targets)
    crawl_code_refs = sum(v["code"] for v in counts.values())

    return {
        "artifact": {
            "pe": pe_path,
            "sha256": hashlib.sha256(binary.raw).hexdigest(),
            "image_base": f"0x{binary.base:x}",
        },
        "constants": {
            "settings_loader": f"0x{SETTINGS_LOADER:x}",
            "settings_ctor": f"0x{SETTINGS_CTOR:x}",
            "step_log": f"0x{LOG_STEP:x}",
        },
        "settings": fields,
        "containers": [
            {**row, "references": counts.get(row["vtable_rva"], {"code": 0, "data": 0})}
            for row in container_rows
        ],
        "reference_counts": counts,
        "symbols": grabber_strings(binary),
        "verdict": {
            "settings_fields": len(fields),
            "spider_classes": len(container_rows),
            "crawl_container_code_references": crawl_code_refs,
            "spider_vtable_code_references": counts.get(f"0x{spider_vtable:x}", {}).get("code", 0),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pe", default="cible/IDMan.exe")
    parser.add_argument("--classes", default="analysis/idman/classes.json")
    parser.add_argument("-o", "--output", default="analysis/idman/grabber.json")
    args = parser.parse_args()

    result = build(args.pe, args.classes)
    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=2, ensure_ascii=False)
        handle.write("\n")

    verdict = result["verdict"]
    print(f"champs de réglages      : {verdict['settings_fields']}")
    print(f"classes du spider       : {verdict['spider_classes']}")
    print(f"réf. code conteneurs    : {verdict['crawl_container_code_references']}")
    print(f"réf. code vtable spider : {verdict['spider_vtable_code_references']}")
    print(f"chaînes du grabber      : {len(result['symbols'])}")
    print(f"-> {args.output}")


if __name__ == "__main__":
    main()
