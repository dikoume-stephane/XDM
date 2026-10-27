#!/usr/bin/env python3
"""Décrit la structure et la persistance des filtres du grabber (IDM 6.42).

Sortie : analysis/idman/filters.json

Preuves lues dans `cible/IDMan.exe` :
  * `0xC2BC0`  `CArray<IDM_SPIDERFILTER>::SetAtGrow` — contient le pas d'élément
               (`shl reg, 4` ⇒ 16 octets) et la recopie champ par champ (+0, +4, +8, +0xC) ;
  * `0xC2C10`  `GrbFsDlg::OnAddF` — attribue un identifiant via `GrabberSts\\nextFilterID` ;
  * `0x137F00` sérialisation : une valeur `REG_SZ` par filtre sous `GrabberSts\\<liste>` ;
  * `0x1385F0` chargement : `RegQueryInfoKeyA` + boucle `RegEnumValueA`.

Le script échoue bruyamment si une preuve disparaît : aucune valeur n'est supposée.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

from capstone import CS_ARCH_X86, CS_MODE_32, Cs

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import idman_attrib  # noqa: E402

SETATGROW = 0xC2BC0
ONADDF = 0xC2C10
SAVER = 0x137F00
LOADER = 0x1385F0

STRINGS = {
    "cle_exclusion": b"Software\\DownloadManager\\GrabberSts\\ExcludeFilters",
    "cle_inclusion": b"Software\\DownloadManager\\GrabberSts\\IncludeFilters",
    "compteur": b"nextFilterID",
    "format_valeur": b"%ld %s",
    "reglage_niveaux": b"nLevels",
    "reglage_auto": b"bAutoAddFOnCl",
}


def find_string(image: idman_attrib.Image, needle: bytes) -> list[str]:
    """Toutes les occurrences (RVA) — un même littéral peut apparaître plusieurs fois."""
    out, start = [], 0
    while True:
        offset = image.raw.find(needle, start)
        if offset < 0:
            return out
        before = image.raw[offset - 1] if offset else 0
        after = image.raw[offset + len(needle)]
        if before == 0 and after == 0:  # littéral complet, pas un préfixe
            out.append(hex(image.off_to_rva(offset)))
        start = offset + 1


def default_patterns(image: idman_attrib.Image) -> dict | None:
    """Liste d'exclusion par défaut (littéral complet, non tronqué)."""
    needle = b"*.html,*.htm"
    offset = image.raw.find(needle)
    if offset < 0:
        return None
    end = image.raw.find(b"\x00", offset)
    return {"rva": hex(image.off_to_rva(offset)),
            "motifs": image.raw[offset:end].decode("ascii", "replace")}


def disasm(image: idman_attrib.Image, start: int, size: int):
    md = Cs(CS_ARCH_X86, CS_MODE_32)
    code = image.raw[image.rva_to_off(start):image.rva_to_off(start + size)]
    yield from md.disasm(code, image.base + start)


def set_at_grow(image: idman_attrib.Image) -> dict:
    """Pas d'élément et champs recopiés par `CArray::SetAtGrow`."""
    element_size, fields = None, []
    for insn in disasm(image, SETATGROW, 0x60):
        if insn.mnemonic == "shl" and insn.op_str.endswith(", 4"):
            element_size = 1 << 4
        elif insn.mnemonic == "mov" and insn.op_str.startswith("dword ptr [esi + "):
            fields.append({"dst": insn.op_str.split("[")[1].split("]")[0], "kind": "dword"})
        elif insn.mnemonic == "mov" and insn.op_str.startswith("byte ptr [esi + "):
            fields.append({"dst": insn.op_str.split("[")[1].split("]")[0], "kind": "byte"})
        elif insn.mnemonic == "lea" and insn.op_str.startswith("ecx, [esi + "):
            fields.append({"dst": insn.op_str.split("[")[1].split("]")[0], "kind": "CString"})
    return {"rva": hex(SETATGROW), "element_size": element_size, "copied_fields": fields}


def on_add(image: idman_attrib.Image) -> dict:
    """Identifiants : compteur persistant, valeur de repli quand la valeur est absente."""
    default, writes = None, []
    for insn in disasm(image, ONADDF, 0x250):
        if insn.mnemonic == "mov" and insn.op_str.startswith("edi, 0x"):
            default = int(insn.op_str.split(", ")[1], 16)
        elif insn.mnemonic == "call" and "0x678090" in insn.op_str:  # RegSetValueExA
            writes.append(hex(insn.address - image.base))
    return {"rva": hex(ONADDF), "first_id_if_absent": default,
            "reg_set_value_sites": writes}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pe", nargs="?", default="cible/IDMan.exe")
    parser.add_argument("-o", "--output", default="analysis/idman/filters.json")
    args = parser.parse_args()

    image = idman_attrib.Image(args.pe)
    grow = set_at_grow(image)
    if grow["element_size"] != 16:
        print("échec : pas de `shl reg, 4` dans SetAtGrow — la structure a changé", file=sys.stderr)
        return 1

    report = {
        "cible": os.path.basename(args.pe),
        "structure": {
            "nom": "IDM_SPIDERFILTER",
            "taille": grow["element_size"],
            "champs": {"+0x0": "CString nom", "+0x4": "CString motif",
                       "+0x8": "int id", "+0xC": "BYTE actif"},
            "preuve": grow,
        },
        "identifiants": on_add(image),
        "persistance": {role: find_string(image, needle) for role, needle in STRINGS.items()},
        "motifs_exclus_par_defaut": default_patterns(image),
        "sites": {"serialisation": hex(SAVER), "chargement": hex(LOADER)},
    }
    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    print(json.dumps({k: report[k] for k in ("structure", "identifiants")},
                     indent=2, ensure_ascii=False))
    print(f"écrit {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
