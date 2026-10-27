#!/usr/bin/env python3
"""Politique de taille de morceau : table par classe + encadrement.

Deux mécanismes observés dans `IDMan.exe` (annexe 14 §5.4) :

1. `0x1559e0` — `switch` sur `(arg1 - 0xA7)` borné à `0xAA`, compilé en table d'octets
   (`0x155a68`) → table de sauts (`0x155a5c`). Chaque branche rend une taille de morceau
   64 bits (`edx:eax`) : 1, 2 ou 5 MiB selon la classe et la taille du fichier.
2. `0x155bd0` — encadrement du résultat : plafond `0xA00000` (10 MiB), plancher
   `0x100000` (1 MiB).

Sortie : analysis/idman/chunks.json

Usage :
    python3 tools/idman_chunks.py [-o analysis/idman/chunks.json]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct

from capstone import CS_ARCH_X86, CS_MODE_32, Cs

import idman_attrib as attrib

SELECTOR_BASE = 0xA7          # soustrait à la classe avant le switch
JUMP_TABLE = 0x155A5C
BYTE_TABLE = 0x155A68
SELECTOR_MAX = 0xAA           # borne du switch (0..0xAA)
CLAMP_WINDOW = (0x155B90, 0x155C40)
CHUNK_IMMEDIATES = {0x100000, 0x200000, 0x500000, 0xA00000}


def u32(image: attrib.Image, rva: int) -> int:
    offset = image.rva_to_off(rva)
    return struct.unpack("<I", image.raw[offset:offset + 4])[0]


def decode_switch(image: attrib.Image) -> dict:
    entries = (BYTE_TABLE - JUMP_TABLE) // 4
    handlers: dict[int, list[int]] = {}
    for selector in range(SELECTOR_MAX + 1):
        index = image.raw[image.rva_to_off(BYTE_TABLE) + selector]
        if index >= entries:
            continue
        target = u32(image, JUMP_TABLE + 4 * index) - image.base
        handlers.setdefault(target, []).append(selector + SELECTOR_BASE)
    return {"entries": entries, "handlers": {hex(k): v for k, v in sorted(handlers.items())}}


def handler_constants(image: attrib.Image, handler: int, span: int = 0x60) -> dict:
    """Tailles rendues (`mov eax, imm32`) et seuils de taille de fichier comparés."""
    md = Cs(CS_ARCH_X86, CS_MODE_32)
    code = image.raw[image.rva_to_off(handler):image.rva_to_off(handler + span)]
    values, thresholds = [], []
    for insn in md.disasm(code, image.base + handler):
        if insn.mnemonic == "mov" and insn.op_str.startswith("eax, 0x"):
            values.append(int(insn.op_str.split(", ")[1], 16))
        elif insn.mnemonic == "cmp" and "esp + 8" in insn.op_str:
            tail = insn.op_str.rsplit(", ", 1)[-1]
            if tail.startswith("0x"):
                candidate = int(tail, 16)
                # un seuil de *taille de fichier*, pas une taille de morceau
                if candidate > 0x1000000:
                    thresholds.append(candidate)
        elif insn.mnemonic.startswith("ret"):
            break
    return {"values": values, "file_size_thresholds": thresholds}


def default_size(image: attrib.Image) -> int | None:
    """Taille posée avant le `switch` (valeur de repli)."""
    md = Cs(CS_ARCH_X86, CS_MODE_32)
    code = image.raw[image.rva_to_off(0x1559E0):image.rva_to_off(0x155A00)]
    for insn in md.disasm(code, image.base + 0x1559E0):
        if insn.mnemonic == "mov" and insn.op_str.startswith("eax, 0x"):
            return int(insn.op_str.split(", ")[1], 16)
    return None


def clamps(image: attrib.Image) -> dict:
    md = Cs(CS_ARCH_X86, CS_MODE_32)
    start, stop = CLAMP_WINDOW
    code = image.raw[image.rva_to_off(start):image.rva_to_off(stop)]
    found = {"max": None, "min": None, "sites": []}
    for insn in md.disasm(code, image.base + start):
        if insn.mnemonic != "cmp":
            continue
        parts = insn.op_str.split(", ")
        if len(parts) != 2 or not parts[1].startswith("0x"):
            continue
        value = int(parts[1], 16)
        if value not in CHUNK_IMMEDIATES:
            continue
        found["sites"].append({"rva": hex(insn.address - image.base), "compare": hex(value)})
        if value == 0xA00000:
            found["max"] = hex(value)
        elif value == 0x100000:
            found["min"] = hex(value)
    return found


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pe", default="cible/IDMan.exe")
    parser.add_argument("-o", "--output", default="analysis/idman/chunks.json")
    args = parser.parse_args()

    image = attrib.Image(args.pe)
    switch = decode_switch(image)
    handlers = {
        handler: {"selectors": selectors, **handler_constants(image, int(handler, 16))}
        for handler, selectors in switch["handlers"].items()
    }
    result = {
        "artifact": {"path": args.pe, "sha256": hashlib.sha256(image.raw).hexdigest()},
        "switch": {"jump_table": hex(JUMP_TABLE), "byte_table": hex(BYTE_TABLE),
                   "selector_base": SELECTOR_BASE, "entries": switch["entries"]},
        "handlers": handlers,
        "default_size": hex(default_size(image)) if default_size(image) else None,
        "clamps": clamps(image),
        "counts": {"handlers": len(handlers),
                   "classes": sum(len(h["selectors"]) for h in handlers.values())},
    }
    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=1, sort_keys=True, ensure_ascii=False)
        handle.write("\n")

    print(json.dumps(result["counts"]))
    for handler, info in handlers.items():
        sizes = ", ".join(hex(v) for v in info["values"]) or "-"
        print(f"  gestionnaire {handler} : {len(info['selectors'])} classes, tailles {sizes}, "
              f"seuils de taille {[hex(c) for c in info['file_size_thresholds']]}")
    print(f"encadrement : min {result['clamps']['min']}, max {result['clamps']['max']} "
          f"({len(result['clamps']['sites'])} comparaisons)")
    print(f"écrit {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
