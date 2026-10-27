#!/usr/bin/env python3
"""Extraction des noms de méthodes « Class::Method » embarqués dans les messages.

La cible n'a pas de table de symboles, mais ses chaînes d'erreur/journal contiennent des
noms qualifiés (`HTTPConnection::GetRetrRangeReply`, `Connection::ProcessRecv`,
`FTPConnection::AuditForRestart`…). Ces noms **nomment des fonctions non virtuelles** que
les vtables ne donnent pas : c'est la seule source de vocabulaire interne disponible sans
décompilateur (cf. JOURNAL D-019).

Sortie déterministe : analysis/idman/symbols.json
    { "artifact": {...}, "counts": {...},
      "classes": { "HTTPConnection": ["GetRetrRangeReply", ...], ... },
      "messages": [ {"rva": "0x…", "class": "…", "method": "…", "text": "…"} ] }

Usage :
    python3 tools/idman_symbols.py [PE] [-o analysis/idman/symbols.json]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys

import pefile

# Un nom qualifié plausible : classe C++ + méthode (pas de chemins, pas d'URL).
PATTERN = re.compile(rb"\b([A-Za-z_][A-Za-z0-9_]{2,40})::(~?[A-Za-z_][A-Za-z0-9_]{0,60})\b")
# Filtres : bruit courant des bibliothèques (MFC/ATL) et faux positifs de format.
NOISE_PREFIX = ("std", "__", "ATL", "Afx", "type_info", "operator", "?")

# Classes qui portent le cœur fonctionnel : on les met en avant dans le rapport.
DOMAINS = {
    "transport": ("Connection", "HTTPConnection", "FTPConnection", "MMSConnection",
                  "RTMPConnection", "ProxyConnection", "CSocks", "CInetConnector",
                  "HTTPSession", "FTPSession", "MMSSession", "RTMPSession", "Session"),
    "moteur": ("CDownload", "ChunksList", "CSessionsArray", "CDownloadQueue",
               "CCacheManager", "CDownloadLimits", "CMaxConnNumbers", "CFilePart"),
    "grabber": ("CIDMSpider", "CSpiderSettings", "CGrabbersSchedulers",
                "CSchedulerOfGrabberProject", "CGrabberFiltersDlg"),
    "http": ("HTTPConnection", "CFirstParser", "CContentTypeChecker", "CIDMProxyScript"),
}


def section_bounds(pe: pefile.PE):
    return [(s.VirtualAddress, s.SizeOfRawData, s.PointerToRawData) for s in pe.sections]


def offset_to_rva(sections, offset: int) -> int | None:
    for va, size, ptr in sections:
        if ptr <= offset < ptr + size:
            return va + offset - ptr
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", nargs="?", default="cible/IDMan.exe")
    parser.add_argument("-o", "--output", default="analysis/idman/symbols.json")
    args = parser.parse_args()

    raw = open(args.path, "rb").read()
    pe = pefile.PE(args.path)
    sections = section_bounds(pe)

    classes: dict[str, list[str]] = {}
    messages: list[dict] = []
    seen: set[tuple[str, str]] = set()

    for match in PATTERN.finditer(raw):
        # la chaîne doit être lisible et délimitée : on écarte le code désassemblé
        start = raw.rfind(b"\x00", max(0, match.start() - 200), match.start()) + 1
        end = raw.find(b"\x00", match.end(), match.end() + 300)
        if end < 0:
            continue
        text = raw[start:end]
        if not all(0x20 <= byte < 0x7F or byte in (0x09, 0x0A, 0x0D) for byte in text):
            continue
        if b"://" in text or text.count(b"\\") > 0:
            continue
        klass = match.group(1).decode("latin-1")
        method = match.group(2).decode("latin-1")
        if klass.startswith(NOISE_PREFIX) or not method:
            continue
        key = (klass, method)
        if key in seen:
            continue
        seen.add(key)
        classes.setdefault(klass, []).append(method)
        messages.append({
            "rva": hex(offset_to_rva(sections, match.start()) or 0),
            "class": klass,
            "method": method,
            "text": text.decode("latin-1")[:200],
        })

    for methods in classes.values():
        methods.sort()

    total_methods = sum(len(v) for v in classes.values())
    by_domain = {}
    for domain, names in DOMAINS.items():
        found = {name: len(classes.get(name, [])) for name in names if name in classes}
        by_domain[domain] = dict(sorted(found.items(), key=lambda kv: -kv[1]))

    result = {
        "artifact": {"path": args.path, "sha256": hashlib.sha256(raw).hexdigest()},
        "counts": {
            "classes_named": len(classes),
            "methods_named": total_methods,
            "messages": len(messages),
        },
        "by_domain": by_domain,
        "classes": dict(sorted(classes.items())),
        "messages": sorted(messages, key=lambda m: m["rva"]),
    }

    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=1, sort_keys=True, ensure_ascii=False)
        handle.write("\n")

    print(json.dumps(result["counts"], indent=1))
    for domain, found in by_domain.items():
        print(f"{domain:10} " + ", ".join(f"{name}({count})" for name, count in found.items()))
    print(f"écrit {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
