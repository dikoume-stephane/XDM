#!/usr/bin/env python3
"""Modèle d'E/S du moteur : sites d'appel, jeux de sockets, seuils, valeurs par défaut.

Ce que le script mesure, sans rien supposer du code :

1. les appels aux primitives d'E/S importées (`select`, `ioctlsocket`, `CreateThread`,
   `Sleep`, `WaitForMultipleObjects`) — nombre et adresses ;
2. autour de chaque `select`, les constantes comparées (`cmp reg, imm`) : c'est là
   qu'apparaissent la taille d'un `fd_set` (128 entrées) et le plafond de délai ;
3. les décalages d'objets manipulés dans la boucle (`lea reg, [reg+disp]`), qui donnent
   les trois `fd_set` de la session et la taille d'un objet connexion (`imul` par un
   pas de tableau) ;
4. la valeur par défaut du nombre de connexions : après un `RegQueryValueExA` sur
   `MaxConnectionsNumber`, la constante écrite quand la valeur manque.

Sortie : analysis/idman/io-model.json

Usage :
    python3 tools/idman_io.py [--pe cible/IDMan.exe] [-o analysis/idman/io-model.json]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct

import pefile
from capstone import CS_ARCH_X86, CS_MODE_32, Cs

import idman_attrib as attrib

WANTED = ("select", "ioctlsocket", "CreateThread", "Sleep", "WaitForMultipleObjects",
          "GetTickCount", "SetTimer", "RegQueryValueExA")


def import_slots(pe: pefile.PE) -> dict[str, int]:
    """{nom d'import: RVA de son entrée IAT} (imports classiques + delay-imports)."""
    slots: dict[str, int] = {}
    for entry in list(pe.DIRECTORY_ENTRY_IMPORT) + list(getattr(pe, "DIRECTORY_ENTRY_DELAY_IMPORT", [])):
        for imp in entry.imports:
            if imp.name:
                slots.setdefault(imp.name.decode(), imp.address - pe.OPTIONAL_HEADER.ImageBase)
    return slots


def import_owner(pe: pefile.PE, rva: int):
    """(dll, nom, rva) pour le slot d'import demandé, imports classiques et différés."""
    for entry in list(pe.DIRECTORY_ENTRY_IMPORT) + list(getattr(pe, "DIRECTORY_ENTRY_DELAY_IMPORT", [])):
        for imp in entry.imports:
            slot = imp.address - pe.OPTIONAL_HEADER.ImageBase
            if slot == rva:
                yield entry.dll.decode(), (imp.name.decode() if imp.name else f"ord{imp.ordinal}"), slot


def call_sites(image: attrib.Image, iat_rva: int) -> list[int]:
    """`call dword ptr [iat]` = FF 15 <imm32>."""
    pattern = struct.pack("<I", image.base + iat_rva)
    sites, cursor = [], 0
    while True:
        hit = image.raw.find(pattern, cursor)
        if hit < 0:
            break
        cursor = hit + 1
        if image.raw[hit - 2:hit] != b"\xff\x15":
            continue
        rva = image.off_to_rva(hit - 2)
        if rva is not None and attrib.TEXT_START <= rva < attrib.TEXT_END:
            sites.append(rva)
    return sites


def nearby_constants(image: attrib.Image, site: int, span: int = 0x140) -> dict[str, int]:
    """Constantes comparées autour d'un site, lues sur les octets (sans désassemblage).

    Balayage volontairement alignement-insensible : `83 /7 ib` (cmp r32, imm8),
    `81 /7 id` (cmp r32, imm32) et `3D id` (cmp eax, imm32).
    """
    raw = image.raw
    begin = image.rva_to_off(max(attrib.TEXT_START, site - span))
    stop = image.rva_to_off(site + span)
    found: dict[str, int] = {}
    offset = begin
    while offset < stop:
        value = None
        if raw[offset] == 0x83 and raw[offset + 1] & 0xF8 == 0xF8:
            value = raw[offset + 2]
            offset += 3
        elif raw[offset] == 0x81 and raw[offset + 1] & 0xF8 == 0xF8:
            value = struct.unpack_from("<I", raw, offset + 2)[0]
            offset += 6
        elif raw[offset] == 0x3D:
            value = struct.unpack_from("<I", raw, offset + 1)[0]
            offset += 5
        else:
            offset += 1
            continue
        if value and value <= 0x100000:  # au-delà : motif d'octets, pas une constante
            key = hex(value)
            found[key] = found.get(key, 0) + 1
    return found


def object_offsets(image: attrib.Image, site: int, span: int = 0x100) -> list[int]:
    """Décalages `lea reg, [reg+disp]` autour du site (fenêtres d'objets)."""
    md = Cs(CS_ARCH_X86, CS_MODE_32)
    start = max(attrib.TEXT_START, site - span)
    code = image.raw[image.rva_to_off(start):image.rva_to_off(site + span)]
    offsets = []
    for insn in md.disasm(code, image.base + start):
        if insn.mnemonic != "lea" or " + 0x" not in insn.op_str:
            continue
        try:
            value = int(insn.op_str.split(" + ")[1].rstrip("]"), 16)
        except (IndexError, ValueError):
            continue
        offsets.append(value)
    return sorted({value for value in offsets if 0 < value < 0x10000})


def table_stride(image: attrib.Image, site: int, span: int = 0x100) -> list[int]:
    """Pas de tableau : `imul reg, reg, imm` autour du site."""
    md = Cs(CS_ARCH_X86, CS_MODE_32)
    start = max(attrib.TEXT_START, site - span)
    code = image.raw[image.rva_to_off(start):image.rva_to_off(site + span)]
    strides = []
    for insn in md.disasm(code, image.base + start):
        if insn.mnemonic != "imul":
            continue
        parts = insn.op_str.split(", ")
        if parts and parts[-1].startswith("0x"):
            strides.append(int(parts[-1], 16))
    return sorted({value for value in strides if value > 0x1000})


def default_after_query(image: attrib.Image, name: str) -> dict | None:
    """Valeur écrite juste après l'échec d'un `RegQueryValueExA` sur `name`."""
    needle = name.encode() + b"\x00"
    offset = image.raw.find(needle)
    if offset < 0:
        return None
    string_rva = image.off_to_rva(offset)
    pattern = struct.pack("<I", image.base + string_rva)
    cursor = 0
    while True:
        hit = image.raw.find(pattern, cursor)
        if hit < 0:
            return None
        cursor = hit + 1
        rva = image.off_to_rva(hit)
        if rva is None or not attrib.TEXT_START <= rva < attrib.TEXT_END:
            continue
        # on ne regarde que les sites suivis d'un appel (donc d'une lecture)
        code = image.raw[image.rva_to_off(rva):image.rva_to_off(rva) + 0x120]
        if b"\xff\x15" not in code:
            continue
        md = Cs(CS_ARCH_X86, CS_MODE_32)
        for insn in md.disasm(code, image.base + rva):
            if insn.mnemonic != "mov" or "dword ptr [" not in insn.op_str:
                continue
            tail = insn.op_str.rsplit(", ", 1)[-1]
            if not tail.isdigit():
                continue
            value = int(tail)
            if 2 <= value <= 64 and value not in (3, 7, 9):
                return {"site": hex(insn.address - image.base), "value": value}
        continue


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pe", default="cible/IDMan.exe")
    parser.add_argument("-o", "--output", default="analysis/idman/io-model.json")
    parser.add_argument("--resolve", metavar="RVA",
                        help="résout un slot d'import (ex. 0x35c0a0) et sort")
    args = parser.parse_args()

    image = attrib.Image(args.pe)
    pe = pefile.PE(args.pe)
    slots = import_slots(pe)

    if args.resolve:
        wanted = int(args.resolve, 16)
        for dll, name, rva in import_owner(pe, wanted):
            print(f"{hex(rva)} = {dll}!{name}")
            return 0
        print(f"{args.resolve} : aucun import à ce slot")
        return 1

    imports = {}
    for name in WANTED:
        if name not in slots:
            imports[name] = {"iat_rva": None, "call_sites": []}
            continue
        sites = call_sites(image, slots[name])
        imports[name] = {"iat_rva": hex(slots[name]), "call_sites": [hex(s) for s in sites]}

    selects = []
    for name in ("select",):
        for site in call_sites(image, slots[name]) if name in slots else []:
            selects.append({
                "site": hex(site),
                "constants": nearby_constants(image, site),
                "object_offsets": object_offsets(image, site),
            })

    sends = []
    for name in ("SendGet",):
        pass
    strides = sorted({step for entry in selects for step in table_stride(image, int(entry["site"], 16))})

    result = {
        "artifact": {"path": args.pe, "sha256": hashlib.sha256(image.raw).hexdigest()},
        "imports": imports,
        "select_sites": selects,
        "table_strides": [hex(step) for step in strides],
        "max_connections_default": default_after_query(image, "MaxConnectionsNumber"),
        "counts": {
            "select": len(imports["select"]["call_sites"]),
            "ioctlsocket": len(imports["ioctlsocket"]["call_sites"]),
            "create_thread": len(imports["CreateThread"]["call_sites"]),
        },
    }
    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=1, sort_keys=True, ensure_ascii=False)
        handle.write("\n")

    print(json.dumps(result["counts"]))
    for entry in selects:
        print(f"select {entry['site']} : constantes {entry['constants']}")
        print(f"   décalages d'objets : {[hex(o) for o in entry['object_offsets'][:14]]}")
    print(f"pas de tableau : {result['table_strides']}")
    print(f"défaut MaxConnectionsNumber : {result['max_connections_default']}")
    print(f"écrit {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
