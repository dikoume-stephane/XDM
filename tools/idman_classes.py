#!/usr/bin/env python3
"""WP-04 : reconstruction des vtables MSVC, attribution classe -> méthodes, xrefs de chaînes.

La cible n'a pas de symboles, mais elle conserve ses RTTI. Ce script reconstruit,
**sans exécuter** le binaire, la chaîne complète :

    nom `. ?AV<Classe>@@` (inline dans son type_info)
        -> type_info (`vftbl`, 0, nom inline)
        -> RTTICompleteObjectLocator / COL (signature 0, pTypeDescriptor = VA du type_info)
        -> vtable (le dword qui précède les méthodes vaut VA du COL)
        -> méthodes (pointeurs de VA dans `.text`)

puis, dans l'autre sens :

    chaîne intéressante (grabber, HTTP, HLS, registre…)
        -> `push imm32` dans `.text`
        -> prologue `55 8B EC` le plus proche = borne basse de la fonction
        -> classe(s) dont une méthode est cette fonction (ou un thunk voisin)

Constats de format vérifiés sur la cible (à conserver si elle change) :
- les noms RTTI sont dans `.data` (pas `.rdata`) ;
- tous les pointeurs stockés sont des **VA absolues** (image base 0x400000) ;
- le nom est **inline** dans le type_info (pas de pointeur vers une chaîne).

Sortie : analysis/idman/classes.json (déterministe, sans horodatage) — source de l'annexe 10.

Dépendances : pefile. Usage :
    python3 tools/idman_classes.py [PE] [-o analysis/idman/classes.json]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import struct

import pefile

# Chaînes porteuses de sens fonctionnel (jointure classe <-> comportement).
INTERESTING = [
    # --- grabber
    "IDM Site Grabber", "GrabberSts", "IncludeFilters", "ExcludeFilters", "ChList",
    "RecentProjects", "Template Name", "Load project", "Grabber Statistics",
    "Settings of IDM Grabber", "Schedule the grabber project", "Start Exploring",
    "Stop Exploring", "Check All Files", "IDM Grabber", "Save to",
    # --- moteur / HTTP
    "bytes=%I64d-%I64d", "multipart/byteranges", "accept-ranges:", "Content-Range:",
    "Content-Disposition:", "User-Agent:", "Proxy-Authorization:", "Referer",
    "Set-Cookie", "Content-Length", "chunked", "CONNECT %s:%ld HTTP/1.1",
    "%s %s HTTP/1.1", "Content-Type:", "Content-Encoding:",
    # --- médias
    "#EXTM3U", "#EXT-X-MAP:", "#EXT-X-BYTERANGE:", "#EXT-X-KEY:", "#EXTINF:",
    "#EXT-X-STREAM-INF:", "#EXT-X-TARGETDURATION:", "sidx", "moof", "moov",
    "rtmp://", "rtmpe://", "rtmpt://", "mms://", "ftp://",
    # --- registre du grabber (chaînes complètes : la correspondance se fait sur des
    # chaînes délimitées par \0, donc « GrabberSts » seul ne matcherait rien)
    "Software\\DownloadManager\\GrabberSts",
    "Software\\DownloadManager\\GrabberSts\\IncludeFilters",
    "Software\\DownloadManager\\GrabberSts\\ExcludeFilters",
    "Software\\DownloadManager\\GrabberSts\\RecentProjects",
    "Software\\DownloadManager\\GrabberSts\\Projects",
    "Software\\DownloadManager\\GrabberSts\\Projects\\%ld\\",
    "Software\\DownloadManager\\GrabberSts\\Projects\\%ld\\%ld",
    "Software\\DownloadManager\\GrabberSts\\Projects\\%ld\\%ld\\ChList",
    "Software\\DownloadManager\\Scheduler", "Software\\DownloadManager\\Queue",
    "Software\\DownloadManager\\ProxyServers", "Software\\DownloadManager\\Passwords",
    "Software\\DownloadManager\\MCN", "SOFTWARE\\Internet Download Manager",
    # --- intégration
    "com.tonec.idm", "NativeMessagingHosts", "sporder.dll",
    "IDMNetMon.dll", "IDMVMPrs.dll", "idmnmcl.dll", "idmcchandler2.dll",
    "IDMGrHlp.exe", "SCHANNEL", "Protocol_Catalog9", "Internet Download Manager",
]

CODE_SECTION = ".text"
DATA_SECTIONS = (".rdata", ".data")


def load_sections(pe: pefile.PE) -> list[dict]:
    return [{
        "name": s.Name.rstrip(b"\x00").decode("latin-1"),
        "va": s.VirtualAddress,
        "vsize": s.Misc_VirtualSize,
        "raw": s.PointerToRawData,
        "rawsize": s.SizeOfRawData,
    } for s in pe.sections]


def offset_to_rva(sections, offset: int) -> int | None:
    for section in sections:
        if section["raw"] <= offset < section["raw"] + section["rawsize"]:
            return section["va"] + (offset - section["raw"])
    return None


def rva_to_offset(sections, rva: int) -> int | None:
    for section in sections:
        if section["va"] <= rva < section["va"] + section["rawsize"]:
            return section["raw"] + (rva - section["va"])
    return None


def dword(raw: bytes, offset: int) -> int | None:
    if offset < 0 or offset + 4 > len(raw):
        return None
    return struct.unpack_from("<I", raw, offset)[0]


def find_dword_positions(raw: bytes, start: int, end: int, value: int) -> list[int]:
    """Occurrences de `value` (4 octets LE, alignées sur 4) dans [start, end)."""
    out, position, blob = [], start, struct.pack("<I", value)
    while True:
        found = raw.find(blob, position, end)
        if found < 0:
            return out
        if found % 4 == 0:
            out.append(found)
        position = found + 1


PADDING = {0xCC, 0x90, 0x00, 0xC3, 0xC2, 0x8B}   # int3, nop, zéros, ret, ret n


def looks_like_function_start(raw: bytes, offset: int) -> bool:
    """Prologue plausible : `55 8B EC` précédé d'un remplissage typique.

    MSVC aligne les fonctions sur 4/16 octets et comble avec `CC` (int3) ou `90`.
    On exige donc le prologue **et** un remplissage dans les 16 octets précédents.
    """
    if raw[offset:offset + 3] != b"\x55\x8b\xec":
        return False
    for back in range(1, 17):
        if offset - back < 0:
            return False
        if raw[offset - back] == 0xCC:
            return True
        if raw[offset - back] == 0x90:
            return True
    return False


def nearest_prologue(raw: bytes, offset: int, window: int = 0x1000) -> int | None:
    limit = max(0, offset - window)
    position = offset
    while position >= limit:
        if raw[position:position + 3] == b"\x55\x8b\xec":
            return position
        position -= 1
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", nargs="?", default="cible/IDMan.exe")
    parser.add_argument("-o", "--output", default="analysis/idman/classes.json")
    parser.add_argument("--max-methods", type=int, default=256)
    args = parser.parse_args()

    raw = open(args.path, "rb").read()
    pe = pefile.PE(args.path)
    sections = load_sections(pe)
    base = pe.OPTIONAL_HEADER.ImageBase
    text = next(s for s in sections if s["name"] == CODE_SECTION)
    data_secs = [s for s in sections if s["name"] in DATA_SECTIONS]
    text_lo, text_hi = text["va"], text["va"] + text["vsize"]
    data_lo = min(s["va"] for s in data_secs)
    data_hi = max(s["va"] + s["rawsize"] for s in data_secs)

    def to_rva(value: int) -> int:
        """Retire l'image base d'une VA stockée dans le fichier."""
        return value - base if base <= value < base + pe.OPTIONAL_HEADER.SizeOfImage else value

    in_text = lambda rva: text_lo <= rva < text_hi
    in_data = lambda rva: data_lo <= rva < data_hi

    # ------------------------------------------------------------ 1. noms RTTI
    names: dict[str, int] = {}
    for match in re.finditer(rb"\.\?AV([A-Za-z0-9_@?$<>:,\-\.]{2,120})@@", raw):
        rva = offset_to_rva(sections, match.start())
        if rva is None or not in_data(rva):
            continue
        names.setdefault(match.group(1).decode("latin-1"), rva)

    # -------------------------------------- 2. COL de chaque type_info (via pTD)
    classes, unresolved = [], []
    for name, name_rva in sorted(names.items()):
        td_rva = name_rva - 8                     # type_info : vftbl(4), 0(4), nom inline
        td_off = rva_to_offset(sections, td_rva)
        if td_off is None:
            unresolved.append({"class": name, "reason": "type_info hors sections"})
            continue
        vftbl = to_rva(dword(raw, td_off) or 0)
        if not in_data(vftbl):
            unresolved.append({"class": name, "reason": "vftable de type_info absente"})
            continue

        entries = []
        td_va = base + td_rva
        for td_ref in find_dword_positions(raw, data_secs[0]["raw"],
                                           data_hi - data_lo + data_secs[0]["raw"], td_va):
            col_off = td_ref - 12                  # signature, offset, cdOffset, pTD, pCHD
            signature = dword(raw, col_off)
            if signature not in (0, 1):
                continue
            if to_rva(dword(raw, col_off + 12) or 0) != td_rva:
                continue
            chd = to_rva(dword(raw, col_off + 16) or 0)
            if not chd or not in_data(chd):
                continue                              # pClassDescriptor doit être en .data
            col_rva = offset_to_rva(sections, col_off)
            if col_rva is None:
                continue

            # un COL peut être référencé à plusieurs endroits : on garde la plus
            # longue suite de pointeurs vers .text (la vtable réelle).
            best: list[int] = []
            alternatives = 0
            for slot in find_dword_positions(raw, data_secs[0]["raw"],
                                             data_hi - data_lo + data_secs[0]["raw"],
                                             base + col_rva):
                alternatives += 1
                cursor = slot + 4
                candidate: list[int] = []
                while len(candidate) < args.max_methods:
                    value = dword(raw, cursor)
                    if not value:
                        break
                    rva = to_rva(value)
                    if not in_text(rva):
                        break
                    candidate.append(rva)
                    cursor += 4
                if len(candidate) > len(best):
                    best = candidate
            methods = best

            entries.append({
                "type_info_rva": hex(td_rva),
                "col_rva": hex(col_rva),
                "class_hierarchy_rva": hex(chd),
                "col_references": alternatives,
                "method_count": len(methods),
                "methods": [hex(m) for m in methods],
            })

        if entries:
            classes.append({"class": name, "entries": entries})
        else:
            unresolved.append({"class": name, "reason": "COL/vtable non résolus"})

    # -------------------------------------- 3. chaînes intéressantes -> RVA/VA
    located: dict[int, str] = {}
    for needle in INTERESTING:
        for encoder in ("latin-1", "utf-16le"):
            blob = needle.encode(encoder)
            unit = 1 if encoder == "latin-1" else 2
            start = 0
            while True:
                found = raw.find(blob, start)
                if found < 0:
                    break
                start = found + 1
                before_ok = found >= unit and raw[found - unit:found] == b"\x00" * unit
                after = raw[found + len(blob):found + len(blob) + unit]
                after_ok = after == b"\x00" * unit or not after
                if not (before_ok and after_ok):
                    continue                     # sous-chaîne : on ignore
                rva = offset_to_rva(sections, found)
                if rva is not None:
                    located.setdefault(rva, needle)

    # -------------------------------------- 4. `push imm32` (0x68) dans .text
    method_to_classes: dict[int, list[str]] = {}
    for entry in classes:
        for item in entry["entries"]:
            for method in item["methods"]:
                method_to_classes.setdefault(int(method, 16), []).append(entry["class"])

    sorted_methods = sorted(method_to_classes)

    def classes_for(rva: int) -> list[str]:
        owners = set(method_to_classes.get(rva, ()))
        for delta in range(4, 0x41, 4):           # tolérance thunk / adjusteur
            owners.update(method_to_classes.get(rva - delta, ()))
        return sorted(owners)

    def nearest_method(rva: int, window: int = 0x8000) -> int | None:
        """Méthode virtuelle déclarée la plus proche en amont (borne de fonction)."""
        low, high, best = 0, len(sorted_methods) - 1, None
        while low <= high:
            middle = (low + high) // 2
            if sorted_methods[middle] <= rva:
                best = sorted_methods[middle]
                low = middle + 1
            else:
                high = middle - 1
        if best is not None and rva - best <= window:
            return best
        return None

    text_start, text_end = text["raw"], text["raw"] + text["rawsize"]
    xrefs = []
    for rva, label in sorted(located.items()):
        hits = []
        target = struct.pack("<I", base + rva)
        position = text_start
        while True:
            found = raw.find(target, position, text_end)
            if found < 0:
                break
            position = found + 1
            if found < 1 or raw[found - 1] != 0x68:   # push imm32
                continue
            instruction_rva = offset_to_rva(sections, found - 1) or 0
            prologue = nearest_prologue(raw, found - 1)
            prologue_rva = offset_to_rva(sections, prologue) if prologue is not None else None
            prologue_ok = prologue is not None and looks_like_function_start(raw, prologue)
            method_rva = nearest_method(instruction_rva)
            # Une méthode de vtable est une frontière exacte ; un prologue n'est qu'un
            # indice. On préfère donc la méthode quand elle est proche (< 0x600 o),
            # et on signale l'ambiguïté quand un prologue plus proche la contredit.
            function_rva, source, confidence = None, None, "faible"
            if method_rva is not None and instruction_rva - method_rva <= 0x600:
                function_rva, source = method_rva, "méthode de vtable"
                confidence = "élevée" if prologue_rva is None else "moyenne"
            elif prologue_rva is not None:
                function_rva = prologue_rva
                source = "prologue vérifié" if prologue_ok else "prologue approximatif"
                confidence = "moyenne" if prologue_ok else "faible"
            owners_method = classes_for(method_rva) if method_rva else []
            owners_prologue = classes_for(prologue_rva) if prologue_rva else []
            hits.append({
                "instruction_offset": hex(found - 1),
                "instruction_rva": hex(instruction_rva),
                "function_rva": hex(function_rva) if function_rva else None,
                "nearest_method_rva": hex(method_rva) if method_rva else None,
                "nearest_prologue_rva": hex(prologue_rva) if prologue_rva else None,
                "function_source": source,
                "confidence": confidence,
                "classes_method": owners_method,
                "classes_prologue": owners_prologue,
            })
        if hits:
            owners = sorted({c for hit in hits
                             for c in hit["classes_method"] + hit["classes_prologue"]})
            xrefs.append({"string": label, "rva": hex(rva), "classes": owners,
                          "references": hits})

    result = {
        "artifact": {"path": args.path, "sha256": hashlib.sha256(raw).hexdigest(),
                     "image_base": hex(base)},
        "method": {
            "rtti_names": len(names),
            "locator": "COL = ref(VA type_info) - 12 ; vtable = ref(VA COL) ; methodes = +4",
            "pointer_form": "VA absolues (image base 0x400000)",
        },
        "counts": {
            "classes_with_vtable": len(classes),
            "classes_without_vtable": len(unresolved),
            "vtables": sum(len(c["entries"]) for c in classes),
            "methods_total": sum(e["method_count"] for c in classes for e in c["entries"]),
            "classes_with_methods": sum(1 for c in classes if c["entries"][0]["method_count"]),
            "strings_located": len(located),
            "strings_with_reference": len(xrefs),
            "references_total": sum(len(x["references"]) for x in xrefs),
        },
        "classes": classes,
        "unresolved": unresolved,
        "xrefs": xrefs,
    }

    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=1, sort_keys=True, ensure_ascii=False)
        handle.write("\n")
    print(json.dumps(result["counts"], indent=1))
    print(f"écrit {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
