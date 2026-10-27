#!/usr/bin/env python3
"""Reconstruction des arguments d'appel (stdcall) autour des API Windows.

Complète `idman_function.py` : pour chaque `call` d'une fonction, on remonte les
`push` immédiatement précédents et on affiche la liste d'arguments, avec les chaînes et
les constantes nommées (types de registre, accès, hives).

But : répondre à des questions de format (« `ChList` est-il une valeur binaire ou des
sous-clés ? ») sans décompilateur, en lisant les arguments réels passés à
`RegSetValueExA` / `RegEnumKeyExA` / `RegQueryInfoKeyA`.

Usage :
    python3 tools/idman_args.py --rva 0x1bbea0
    python3 tools/idman_args.py --rva 0x1381c0 --max-bytes 2000
    python3 tools/idman_args.py --entry --json out.json
"""

from __future__ import annotations

import argparse
import json
import struct

import capstone
import pefile

REG_TYPES = {1: "REG_SZ", 2: "REG_EXPAND_SZ", 3: "REG_BINARY", 4: "REG_DWORD",
             7: "REG_MULTI_SZ", 0xB: "REG_QWORD"}
HIVES = {0x80000000: "HKU", 0x80000001: "HKCU", 0x80000002: "HKLM",
         0x80000003: "HKCR", 0x80000005: "HKCC"}
ACCESS = {0x20019: "KEY_READ", 0xF003F: "KEY_ALL_ACCESS", 0x20006: "KEY_WRITE",
          0x1: "KEY_QUERY_VALUE", 0x2: "KEY_SET_VALUE", 0x4: "KEY_CREATE_SUB_KEY",
          0x8: "KEY_ENUMERATE_SUB_KEYS"}


class Binary:
    def __init__(self, path: str):
        self.raw = open(path, "rb").read()
        self.pe = pefile.PE(path)
        self.base = self.pe.OPTIONAL_HEADER.ImageBase
        self.sections = [(s.VirtualAddress, s.SizeOfRawData, s.PointerToRawData)
                         for s in self.pe.sections]
        # sections de données : seules zones où une chaîne est crédible
        self.data_ranges = [(s.VirtualAddress, s.VirtualAddress + s.SizeOfRawData)
                            for s in self.pe.sections
                            if not (s.Characteristics & 0x20000000)]
        self.iat = self._build_iat()

    def _build_iat(self) -> dict[int, str]:
        table: dict[int, str] = {}
        for directory in (getattr(self.pe, "DIRECTORY_ENTRY_IMPORT", []),
                          getattr(self.pe, "DIRECTORY_ENTRY_DELAY_IMPORT", [])):
            for entry in directory:
                dll = entry.dll.decode("latin-1")
                for item in entry.imports:
                    name = item.name.decode("latin-1") if item.name else f"ordinal:{item.ordinal}"
                    table[item.address] = f"{dll}!{name}"
        return table

    def rva_to_offset(self, rva: int) -> int | None:
        for va, size, ptr in self.sections:
            if va <= rva < va + size:
                return ptr + rva - va
        return None

    def offset_to_rva(self, offset: int) -> int | None:
        for va, size, ptr in self.sections:
            if ptr <= offset < ptr + size:
                return va + offset - ptr
        return None

    def _in_data(self, va: int) -> bool:
        rva = va - self.base
        return any(low <= rva < high for low, high in self.data_ranges)

    def string_at(self, va: int, limit: int = 400) -> str | None:
        if not self._in_data(va):
            return None
        offset = self.rva_to_offset(va - self.base)
        if offset is None:
            return None
        end = self.raw.find(b"\x00", offset, offset + limit)
        if end < 0 or end - offset < 3:
            return None
        blob = self.raw[offset:end]
        if not all(0x20 <= byte < 0x7F for byte in blob):
            return None
        return blob.decode("latin-1")

    def wide_string_at(self, va: int, limit: int = 400) -> str | None:
        if not self._in_data(va):
            return None
        offset = self.rva_to_offset(va - self.base)
        if offset is None:
            return None
        end = offset
        while end + 1 < offset + limit:
            if self.raw[end:end + 2] == b"\x00\x00":
                break
            end += 2
        if end - offset < 8:
            return None
        try:
            text = self.raw[offset:end].decode("utf-16le")
        except UnicodeDecodeError:
            return None
        # une chaîne UTF-16 crédible reste dans l'ASCII imprimable : le code ou les
        # ressources relus en UTF-16 produisent des idéogrammes, à rejeter.
        return text if text and all(0x20 <= ord(c) < 0x7F for c in text) else None


def describe_immediate(binary: Binary, value: int) -> str:
    for render in (binary.string_at, binary.wide_string_at):
        text = render(value)
        if text:
            return f'"{text}"'
    if value in HIVES:
        return HIVES[value]
    if value in ACCESS:
        return ACCESS[value]
    if value in REG_TYPES:
        return f"{REG_TYPES[value]} ({value})"
    if value == 0:
        return "0/NULL"
    return f"0x{value:x}"


def find_function_end(disassembler, code: bytes, start_rva: int) -> int:
    """Fin = retour suivi d'au moins 4 octets de remplissage (CC/90)."""
    last = start_rva
    for instruction in disassembler.disasm(code, 0x400000 + start_rva):
        last = instruction.address + instruction.size - 0x400000
        if instruction.mnemonic in ("ret", "retf"):
            position = instruction.address + instruction.size - 0x400000
            offset = position - start_rva
            if all(byte in (0xCC, 0x90) for byte in code[offset:offset + 4]):
                return last
    return last


def analyze(binary: Binary, rva: int, max_bytes: int = 0x2000) -> dict:
    offset = binary.rva_to_offset(rva)
    if offset is None:
        return {"rva": hex(rva), "error": "hors sections"}
    code = binary.raw[offset:offset + max_bytes]

    md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_32)
    md.detail = True
    end = find_function_end(md, code, rva)
    code = binary.raw[offset:offset + (end - rva) + 1]

    pending: list[str] = []
    calls: list[dict] = []
    api_seen: list[str] = []
    branch_targets: list[int] = []

    for instruction in md.disasm(code, binary.base + rva):
        mnemonic = instruction.mnemonic
        operands = instruction.operands

        if mnemonic == "push":
            if operands[0].type == capstone.x86.X86_OP_IMM:
                pending.append(describe_immediate(binary, operands[0].imm))
            elif operands[0].type == capstone.x86.X86_OP_REG:
                pending.append(instruction.reg_name(operands[0].reg))
            elif operands[0].type == capstone.x86.X86_OP_MEM:
                pending.append(f"[{instruction.op_str}]")
            continue

        if mnemonic == "call":
            target = None
            if operands[0].type == capstone.x86.X86_OP_MEM and not operands[0].mem.base:
                target = binary.iat.get(operands[0].mem.disp)
            if target:
                api_seen.append(target)
                calls.append({
                    "insn": hex(instruction.address - binary.base),
                    "api": target,
                    "args": list(reversed(pending)),
                })
            elif operands[0].type == capstone.x86.X86_OP_IMM:
                calls.append({
                    "insn": hex(instruction.address - binary.base),
                    "api": None,
                    "internal": hex(operands[0].imm - binary.base),
                    "args": list(reversed(pending))[:4],
                })
            pending = []
            continue

        if mnemonic.startswith("j") and operands and operands[0].type == capstone.x86.X86_OP_IMM:
            branch_targets.append(operands[0].imm - binary.base)

        # On garde les pushes récents à travers les `mov`/`lea` (les compilateurs
        # intercalent la préparation des registres), mais on repart à zéro sur un
        # changement de flux ou une remise à niveau de la pile.
        if mnemonic in ("jmp", "ret", "retf", "pop", "leave"):
            pending = []
        elif mnemonic in ("add", "sub") and instruction.op_str.startswith("esp"):
            pending = []
        elif len(pending) > 8:
            pending = pending[-8:]

    return {
        "rva": hex(rva),
        "end_rva": hex(end),
        "size": end - rva + 1,
        "apis": sorted(set(api_seen)),
        "calls": calls,
        "branch_count": len(branch_targets),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", nargs="?", default="cible/IDMan.exe")
    parser.add_argument("--rva", action="append", default=[])
    parser.add_argument("--entry", action="store_true")
    parser.add_argument("--max-bytes", type=int, default=0x2000)
    parser.add_argument("--json", dest="json_out")
    args = parser.parse_args()

    binary = Binary(args.path)
    targets = [int(value, 16) for value in args.rva]
    if args.entry:
        targets.insert(0, binary.pe.OPTIONAL_HEADER.AddressOfEntryPoint)
    if not targets:
        parser.error("fournir --rva 0x… ou --entry")

    results = [analyze(binary, rva, args.max_bytes) for rva in targets]
    for result in results:
        if "error" in result:
            print(f"=== {result['rva']} : {result['error']}")
            continue
        print(f"=== {result['rva']} .. {result['end_rva']} ({result['size']} octets, "
              f"{result['branch_count']} sauts)")
        for call in result["calls"]:
            name = call["api"] or f"sub_{call['internal']}"
            if call["api"] or call["args"]:
                print(f"   {call['insn']}  {name}")
                if call["args"]:
                    printed = ", ".join(call["args"][:8])
                    print(f"        args: {printed}")
    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as handle:
            json.dump({"artifact": args.path, "functions": results}, handle,
                      indent=1, sort_keys=True, ensure_ascii=False)
            handle.write("\n")
        print(f"écrit {args.json_out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
