#!/usr/bin/env python3
"""Machine à états des connexions : champ d'état, tables de saut, transitions.

IDM garde l'état d'une connexion dans un entier de l'objet (`this + 0xa4`) et le
distribue par `switch` compilés en tables MSVC :

    mov   eax, [reg + 0xa4]        ; champ d'état
    cmp   eax, <max>               ; borne
    ja    <défaut>
    movzx eax, byte [eax + BYTE]   ; table d'index (un octet par état)
    jmp   [eax*4 + JUMP]           ; table de sauts

Ce script :
1. retrouve les `switch` sur `+0xa4` et décode **état → gestionnaire** ;
2. retrouve les **écritures** du champ (`mov dword [reg+0xa4], imm`) = transitions ;
3. rattache chaque site à sa fonction (ancrages de `idman_attrib.py`) et, quand elle
   est connue, aux noms de méthodes (`methods.json`).

Sortie : analysis/idman/states.json

Usage :
    python3 tools/idman_states.py [--pe cible/IDMan.exe] [-o analysis/idman/states.json]
"""

from __future__ import annotations

import argparse
import bisect
import collections
import hashlib
import json
import struct

import idman_attrib as attrib

FIELD = 0xA4  # décalage du champ d'état dans l'objet connexion (observé, annexe 14)


def load_json(path: str) -> dict:
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def to_rva(image: attrib.Image, value: int) -> int:
    """Les disp32 des tables sont des VA absolues (ImageBase + RVA)."""
    return value - image.base if value >= image.base else value


def find_dispatchers(image: attrib.Image) -> list[dict]:
    """Repère `movzx eax, byte [eax+B]` suivi de `jmp [eax*4+T]`."""
    raw = image.raw
    start = image.rva_to_off(attrib.TEXT_START)
    stop = image.rva_to_off(attrib.TEXT_END) - 16
    found = []
    for offset in range(start, stop):
        if raw[offset:offset + 2] != b"\x0f\xb6":
            continue
        modrm = raw[offset + 2]
        if modrm & 0xC7 != 0x80:  # movzx r32, byte [reg + disp32]
            continue
        byte_table = to_rva(image, image.u32(offset + 3))
        nxt = offset + 7
        if raw[nxt:nxt + 3] != b"\xff\x24\x85":  # jmp [eax*4 + disp32]
            continue
        jump_table = to_rva(image, image.u32(nxt + 3))
        # champ testé : dernier `mov reg32, [reg + disp32]` avant le movzx
        field = None
        for back in range(3, 0x40):
            pos = offset - back
            if raw[pos] == 0x8B and raw[pos + 1] & 0xC0 == 0x80 and (raw[pos + 1] & 0x07) != 0x04:
                field = image.u32(pos + 2)
                break
        # borne du switch : dernier `cmp eax, imm` dans les 0x30 octets précédents
        bound = None
        for back in range(2, 0x30):
            pos = offset - back
            if raw[pos:pos + 2] == b"\x83\xf8":
                bound = raw[pos + 2]
                break
            if raw[pos:pos + 1] == b"\x3d":
                bound = image.u32(pos + 1)
                break
        found.append({
            "site_rva": image.off_to_rva(offset),
            "field_offset": field,
            "byte_table_rva": byte_table,
            "jump_table_rva": jump_table,
            "max_state": bound,
        })
    return found


def decode(dispatcher: dict, image: attrib.Image) -> dict | None:
    """Décode un switch ; `None` si les tables ne sont pas exploitables."""
    jump = dispatcher["jump_table_rva"]
    byte = dispatcher["byte_table_rva"]
    entries = (byte - jump) // 4
    bound = dispatcher["max_state"]
    if entries <= 0 or bound is None or bound > 0x400:
        return None
    if image.rva_to_off(jump) is None or image.rva_to_off(byte) is None:
        return None
    handlers: dict[int, list[int]] = collections.defaultdict(list)
    for state in range(bound + 1):
        index = image.raw[image.rva_to_off(byte) + state]
        if index >= entries:
            continue
        target = image.u32(image.rva_to_off(jump) + 4 * index) - image.base
        handlers[target].append(state)
    if not handlers or any(not attrib.TEXT_START <= target < attrib.TEXT_END for target in handlers):
        return None
    return {
        **dispatcher,
        "entries": entries,
        "states": {str(state): target for target, group in handlers.items() for state in group},
        "handlers": {hex(target): sorted(group) for target, group in sorted(handlers.items())},
    }


def find_writes(image: attrib.Image, max_state: int) -> list[tuple[int, int]]:
    """`mov dword ptr [reg + 0xa4], imm32` (disp32 puis disp8)."""
    raw = image.raw
    start = image.rva_to_off(attrib.TEXT_START)
    stop = image.rva_to_off(attrib.TEXT_END) - 10
    writes = []
    offset = start
    while offset < stop:
        if raw[offset] == 0xC7 and raw[offset + 1] & 0xC7 == 0x86 and raw[offset + 2:offset + 6] == struct.pack("<I", FIELD):
            value = struct.unpack_from("<i", raw, offset + 6)[0]
            if 0 <= value <= max_state:
                writes.append((image.off_to_rva(offset), value))
            offset += 10
            continue
        if raw[offset] == 0xC7 and raw[offset + 1] & 0xC0 == 0x40 and raw[offset + 2] == FIELD:
            value = struct.unpack_from("<i", raw, offset + 3)[0]
            if 0 <= value <= max_state:
                writes.append((image.off_to_rva(offset), value))
            offset += 7
            continue
        offset += 1
    return writes


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pe", default="cible/IDMan.exe")
    parser.add_argument("--classes", default="analysis/idman/classes.json")
    parser.add_argument("--methods", default="analysis/idman/methods.json")
    parser.add_argument("-o", "--output", default="analysis/idman/states.json")
    args = parser.parse_args()

    image = attrib.Image(args.pe)
    vtable_classes, vtable_methods = attrib.load_vtable_methods(args.classes)
    anchors = attrib.find_anchors(image, vtable_methods)
    ordered = sorted(anchors)
    named = load_json(args.methods)["functions"]

    all_switches = find_dispatchers(image)
    state_switches = [d for d in all_switches if d["field_offset"] == FIELD]
    dispatchers = [decoded for decoded in (decode(d, image) for d in state_switches) if decoded]
    max_state = max((d["max_state"] for d in dispatchers), default=0)

    def function_of(rva: int) -> int | None:
        index = bisect.bisect_right(ordered, rva) - 1
        return ordered[index] if index >= 0 else None

    writes = []
    by_state: dict[int, list[str]] = collections.defaultdict(list)
    for rva, state in find_writes(image, max_state):
        function = function_of(rva)
        names = named.get(hex(function), []) if function is not None else []
        row = {
            "rva": hex(rva),
            "state": state,
            "function_rva": hex(function) if function is not None else None,
            "anchor": anchors.get(function) if function is not None else None,
            "methods": names,
            "vtable_classes": sorted(vtable_classes.get(function, [])) if function is not None else [],
        }
        writes.append(row)
        for name in names:
            by_state[state].append(name)

    result = {
        "artifact": {"path": args.pe, "sha256": hashlib.sha256(image.raw).hexdigest()},
        "counts": {
            "field_offset": FIELD,
            "states": max_state + 1,
            "dispatchers": len(dispatchers),
            "switches_total": len(all_switches),
            "writes": len(writes),
            "states_written": len({w["state"] for w in writes}),
            "states_labelled": len(by_state),
        },
        "dispatchers": dispatchers,
        "other_switches": [
            {key: value for key, value in d.items() if key in ("site_rva", "field_offset", "max_state")}
            for d in all_switches if d["field_offset"] != FIELD
        ],
        "by_state": {str(state): sorted(set(names)) for state, names in sorted(by_state.items())},
        "writes": writes,
    }
    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=1, sort_keys=True, ensure_ascii=False)
        handle.write("\n")

    print(json.dumps(result["counts"], indent=1))
    for dispatcher in dispatchers:
        print(f"switch {dispatcher['site_rva']:#x} : {dispatcher['entries']} gestionnaires, "
              f"états 0..{dispatcher['max_state']}, table {dispatcher['jump_table_rva']:#x}")
    for state, names in result["by_state"].items():
        print(f"  état {state:>2} <- {', '.join(names[:4])}")
    print(f"écrit {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
