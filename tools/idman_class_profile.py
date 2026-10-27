#!/usr/bin/env python3
"""Profil d'une classe : agrège, pour toutes ses méthodes virtuelles, les API
importées, les chaînes référencées et les constantes immédiates.

Sert de « fiche d'identité comportementale » sans décompilateur (cf. JOURNAL D-019) :
on lit ce qu'une classe *fait au système* (API) et *ce qu'elle nomme* (chaînes), puis on
compare deux classes (ex. `CDownload` vs `CFilePart`) pour reconstituer une architecture.

Entrée : analysis/idman/classes.json (produit par tools/idman_classes.py).
Sortie : analysis/idman/profiles/<Classe>.json + tableau récapitulatif sur stdout.

Usage :
    python3 tools/idman_class_profile.py CDownload HTTPConnection CMaxConnNumbers
    python3 tools/idman_class_profile.py --all-download   # toutes les classes du domaine « download »
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys

import capstone
import pefile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from idman_args import Binary, describe_immediate  # noqa: E402


def method_end(binary: Binary, rva: int, limit: int = 0x4000) -> int:
    """Fin d'une méthode : `ret` suivi de 4 octets de remplissage (CC/90)."""
    offset = binary.rva_to_offset(rva)
    if offset is None:
        return rva
    md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_32)
    code = binary.raw[offset:offset + limit]
    last = rva
    seen = 0
    for instruction in md.disasm(code, binary.base + rva):
        last = instruction.address + instruction.size - binary.base
        seen += 1
        if instruction.mnemonic in ("ret", "retf"):
            position = last - rva
            if all(byte in (0xCC, 0x90) for byte in code[position:position + 4]):
                return last
        # frontière dure : nouveau prologue encadré de remplissage
        if seen > 8 and code[position_of(code, last - rva):][:3] == b"\x55\x8b\xec":
            back = code[max(0, last - rva - 4):last - rva]
            if b"\xcc" in back or b"\x90" in back:
                return last
    return last


def position_of(code: bytes, delta: int) -> int:
    return max(0, min(delta, len(code) - 3))


def profile_method(binary: Binary, rva: int) -> dict:
    offset = binary.rva_to_offset(rva)
    if offset is None:
        return {"rva": hex(rva), "error": "hors sections"}
    end = method_end(binary, rva)
    code = binary.raw[offset:offset + max(8, end - rva + 1)]
    MD = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_32)
    MD.detail = True

    apis: set[str] = set()
    strings: list[str] = []
    constants: dict[int, int] = {}
    calls_internal = 0
    calls_indirect = 0

    for instruction in MD.disasm(code, binary.base + rva):
        operands = instruction.operands
        if instruction.mnemonic == "call":
            if operands and operands[0].type == capstone.x86.X86_OP_MEM and not operands[0].mem.base:
                name = binary.iat.get(operands[0].mem.disp)
                if name:
                    apis.add(name)
                else:
                    calls_indirect += 1
            elif operands and operands[0].type == capstone.x86.X86_OP_IMM:
                target = operands[0].imm - binary.base
                if 0 <= target < 0x600000:
                    calls_internal += 1
                else:
                    name = binary.iat.get(operands[0].imm)
                    if name:
                        apis.add(name)
            elif operands and operands[0].type == capstone.x86.X86_OP_REG:
                calls_indirect += 1
            continue

        if instruction.mnemonic == "push" and operands and operands[0].type == capstone.x86.X86_OP_IMM:
            value = operands[0].imm
            text = binary.string_at(value) or binary.wide_string_at(value)
            if text:
                strings.append(text)
            elif 0x100 <= value < binary.base:
                constants[value] = constants.get(value, 0) + 1
            continue

        for operand in operands:
            if operand.type == capstone.x86.X86_OP_IMM and 0x100 <= operand.imm < binary.base:
                constants[operand.imm] = constants.get(operand.imm, 0) + 1

    return {
        "rva": hex(rva),
        "size": end - rva + 1,
        "apis": sorted(apis),
        "strings": list(dict.fromkeys(strings)),
        "constants": {hex(k): v for k, v in sorted(constants.items(),
                                                   key=lambda kv: -kv[1])[:12]},
        "internal_calls": calls_internal,
        "indirect_calls": calls_indirect,
    }


def profile_class(binary: Binary, entry: dict) -> dict:
    methods = []
    for item in entry["entries"]:
        for method in item["methods"]:
            methods.append(profile_method(binary, int(method, 16)))
    apis: dict[str, int] = {}
    strings: dict[str, int] = {}
    constants: dict[str, int] = {}
    for method in methods:
        for api in method.get("apis", []):
            apis[api] = apis.get(api, 0) + 1
        for text in method.get("strings", []):
            strings[text] = strings.get(text, 0) + 1
        for key in method.get("constants", {}):
            constants[key] = constants.get(key, 0) + 1
    return {
        "class": entry["class"],
        "vtables": len(entry["entries"]),
        "methods": len(methods),
        "method_details": methods,
        "apis": dict(sorted(apis.items(), key=lambda kv: -kv[1])),
        "strings": dict(sorted(strings.items(), key=lambda kv: -kv[1])),
        "constants": dict(sorted(constants.items(), key=lambda kv: -kv[1])),
    }


def summarize(profile: dict, top_apis: int = 12, top_strings: int = 10) -> str:
    lines = [f"### {profile['class']} — {profile['methods']} méthodes, "
             f"{len(profile['apis'])} API distinctes"]
    apis = list(profile["apis"].items())[:top_apis]
    lines.append("API : " + ", ".join(f"{name.split('!')[-1]}×{count}" for name, count in apis))
    if profile["strings"]:
        items = list(profile["strings"].items())[:top_strings]
        lines.append("chaînes : " + " · ".join(f'"{text[:60]}"' for text, _ in items))
    if profile["constants"]:
        items = list(profile["constants"].items())[:10]
        lines.append("constantes : " + ", ".join(f"{key}×{count}" for key, count in items))
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("classes", nargs="*", help="noms de classes RTTI exacts")
    parser.add_argument("--pattern", help="motif regex pour sélectionner des classes")
    parser.add_argument("--artifact", default="cible/IDMan.exe")
    parser.add_argument("--classes-json", default="analysis/idman/classes.json")
    parser.add_argument("--outdir", default="analysis/idman/profiles")
    parser.add_argument("--json", dest="json_out", help="agrégat de tous les profils")
    args = parser.parse_args()

    data = json.load(open(args.classes_json))
    by_name = {entry["class"]: entry for entry in data["classes"]}

    selected: list[str] = list(args.classes)
    if args.pattern:
        regex = re.compile(args.pattern)
        selected += [name for name in by_name if regex.search(name)]
    if not selected:
        parser.error("fournir un nom de classe ou --pattern")

    binary = Binary(args.artifact)
    os.makedirs(args.outdir, exist_ok=True)
    profiles = []
    for name in selected:
        entry = by_name.get(name)
        if entry is None:
            print(f"!! classe absente de classes.json : {name}", file=sys.stderr)
            continue
        profile = profile_class(binary, entry)
        profiles.append(profile)
        with open(os.path.join(args.outdir, f"{re.sub(r'[^A-Za-z0-9_.-]', '_', name)}.json"),
                  "w", encoding="utf-8") as handle:
            json.dump(profile, handle, indent=1, ensure_ascii=False)
            handle.write("\n")
        print(summarize(profile))
        print()

    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as handle:
            json.dump({"artifact": args.artifact,
                       "classes": [{k: v for k, v in p.items() if k != "method_details"}
                                   for p in profiles]},
                      handle, indent=1, ensure_ascii=False)
            handle.write("\n")
        print(f"écrit {args.json_out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
