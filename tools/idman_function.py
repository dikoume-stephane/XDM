#!/usr/bin/env python3
"""Lecture ciblée d'une fonction : API importées, chaînes, appels directs, constantes.

Remplace provisoirement le décompilateur (Ghidra indisponible ici, voir JOURNAL D-019) :
produit un **résumé comportemental** lisible d'une fonction à partir d'un désassemblage
capstone borné, sans exécuter la cible.

Ce que le résumé contient :
- les appels d'API Windows (résolution de l'IAT et des delay-imports) ;
- les chaînes référencées (`push imm32` vers une chaîne .rdata/.data) ;
- les appels directs internes (cibles RVA) ;
- les accès registre/fichier détectés (`mov reg, [reg+disp]` n'est pas interprété : on
  s'appuie sur les API, plus fiables) ;
- les constantes immédiates « parlantes » (tailles, masques, valeurs >= 0x100).

Usage :
    python3 tools/idman_function.py --rva 0x156670 [--rva 0x1b5c30] [--bytes 4096] [-o json]
    python3 tools/idman_function.py --entry        # point d'entrée du PE
"""

from __future__ import annotations

import argparse
import json
import struct

import capstone
import pefile

SECTIONS = None
RAW = None
BASE = None


def init(pe: pefile.PE, raw: bytes) -> None:
    global SECTIONS, RAW, BASE
    SECTIONS = [(s.VirtualAddress, s.SizeOfRawData, s.PointerToRawData) for s in pe.sections]
    RAW, BASE = raw, pe.OPTIONAL_HEADER.ImageBase


def rva_to_offset(rva: int) -> int | None:
    for va, size, ptr in SECTIONS:
        if va <= rva < va + size:
            return ptr + rva - va
    return None


def offset_to_rva(offset: int) -> int | None:
    for va, size, ptr in SECTIONS:
        if ptr <= offset < ptr + size:
            return va + offset - ptr
    return None


def build_iat(pe: pefile.PE) -> dict[int, str]:
    """VA de l'entrée IAT -> 'DLL!Fonction' (imports + delay-imports)."""
    table: dict[int, str] = {}
    for directory, kind in ((getattr(pe, "DIRECTORY_ENTRY_IMPORT", []), "import"),
                            (getattr(pe, "DIRECTORY_ENTRY_DELAY_IMPORT", []), "delay")):
        for entry in directory:
            dll = entry.dll.decode("latin-1")
            for item in entry.imports:
                name = item.name.decode("latin-1") if item.name else f"ordinal:{item.ordinal}"
                table[item.address] = f"{dll}!{name}"
    return table


def read_cstring(va: int, limit: int = 512) -> str | None:
    rva = va - BASE
    offset = rva_to_offset(rva)
    if offset is None:
        return None
    end = RAW.find(b"\x00", offset, offset + limit)
    if end < 0:
        return None
    if end - offset < 4:
        return None
    blob = RAW[offset:end]
    if any(byte < 0x09 or (0x0E <= byte < 0x20) for byte in blob):
        return None
    try:
        text = blob.decode("latin-1")
    except UnicodeDecodeError:
        return None
    return text if all(0x20 <= ord(c) < 0x7F for c in text) else None


def analyze(rva: int, iat: dict[int, str], size: int) -> dict:
    offset = rva_to_offset(rva)
    if offset is None:
        return {"rva": hex(rva), "error": "RVA hors sections"}
    code = RAW[offset:offset + size]
    md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_32)
    md.detail = True

    apis: list[dict] = []
    strings: list[dict] = []
    internal_calls: list[dict] = []
    constants: dict[str, int] = {}
    instructions = 0
    end_offset = None

    for instruction in md.disasm(code, BASE + rva):
        instructions += 1
        mnemonic = instruction.mnemonic
        ops = instruction.operands

        # --- appels d'API via IAT : call dword ptr [VA]
        if mnemonic == "call" and ops and ops[0].type == capstone.x86.X86_OP_MEM:
            target = ops[0].mem.disp + (0 if not ops[0].mem.base else 0)
            base_register = instruction.reg_name(ops[0].mem.base) if ops[0].mem.base else ""
            if not base_register and target in iat:
                apis.append({"insn": hex(instruction.address),
                             "api": iat[target]})
        # --- appels directs
        elif mnemonic == "call" and ops and ops[0].type == capstone.x86.X86_OP_IMM:
            target = ops[0].imm - BASE
            internal_calls.append({"insn": hex(instruction.address), "target_rva": hex(target)})
        # --- push d'une chaîne
        elif mnemonic == "push" and ops and ops[0].type == capstone.x86.X86_OP_IMM:
            text = read_cstring(ops[0].imm)
            if text:
                strings.append({"insn": hex(instruction.address), "text": text})
            else:
                if ops[0].imm >= 0x100 and ops[0].imm < BASE:
                    constants[f"0x{ops[0].imm:x}"] = constants.get(f"0x{ops[0].imm:x}", 0) + 1
        # --- constantes immédiates ailleurs
        elif ops:
            for operand in ops:
                if operand.type == capstone.x86.X86_OP_IMM and 0x100 <= operand.imm < BASE:
                    key = f"0x{operand.imm:x}"
                    constants[key] = constants.get(key, 0) + 1

        # --- fin de fonction plausible : retour, ou remplissage int3/nop après du code
        if mnemonic in ("ret", "retf"):
            end_offset = offset_to_rva(instruction.address + instruction.size - BASE)
            break
        if mnemonic in ("int3", "ud2") and instructions > 4:
            end_offset = offset_to_rva(instruction.address - BASE)
            break
        if instruction.address + instruction.size - BASE >= rva + size:
            break

    api_sorted = sorted({item["api"] for item in apis})
    interesting = {k: v for k, v in sorted(constants.items(), key=lambda kv: -kv[1])[:24]}
    return {
        "rva": hex(rva),
        "instructions": instructions,
        "end_rva": hex(end_offset) if end_offset is not None else None,
        "apis": api_sorted,
        "api_calls": apis,
        "strings": [s["text"] for s in strings],
        "internal_calls": internal_calls[:40],
        "constants_top": interesting,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", nargs="?", default="cible/IDMan.exe")
    parser.add_argument("--rva", action="append", default=[], help="RVA à analyser (répétable)")
    parser.add_argument("--entry", action="store_true", help="analyser le point d'entrée")
    parser.add_argument("--bytes", type=int, default=4096)
    parser.add_argument("-o", "--output")
    args = parser.parse_args()

    raw = open(args.path, "rb").read()
    pe = pefile.PE(args.path)
    init(pe, raw)
    iat = build_iat(pe)

    targets = [int(value, 16) for value in args.rva]
    if args.entry:
        targets.insert(0, pe.OPTIONAL_HEADER.AddressOfEntryPoint)
    if not targets:
        parser.error("fournir au moins --rva 0x… ou --entry")

    results = [analyze(rva, iat, args.bytes) for rva in targets]

    for result in results:
        print(f"=== {result['rva']}  ({result.get('instructions', 0)} instructions)")
        if "error" in result:
            print("   ", result["error"])
            continue
        print("   API :", ", ".join(result["apis"]) or "aucune")
        if result["strings"]:
            print("   chaînes :")
            for text in result["strings"][:12]:
                print(f"      · {text[:110]}")
        if result["constants_top"]:
            print("   constantes :", ", ".join(f"{k}×{v}" for k, v in
                                               list(result["constants_top"].items())[:10]))
        print("   appels internes :", len(result["internal_calls"]))

    if args.output:
        with open(args.output, "w", encoding="utf-8") as handle:
            json.dump({"artifact": args.path, "functions": results}, handle,
                      indent=1, sort_keys=True, ensure_ascii=False)
            handle.write("\n")
        print(f"écrit {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
