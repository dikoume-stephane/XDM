#!/usr/bin/env python3
"""Triage statique reproductible de la cible IDM (cible/IDMan.exe).

Ce script produit un JSON *déterministe* (aucun horodatage) qui sert de source
de vérité pour les annexes de mémoire (`analysis/idman/`) : en-têtes PE,
sections et entropie, mitigations, informations de build, imports, ressources,
RTTI MFC, chaînes remarquables et marqueurs de protocoles.

Dépendances : pefile 2024.8.26 (pip install pefile) — REA ne fournit pas cette
vue agrégée, mais ses bundles Evidence restent l'autorité citée en annexe.

Usage :
    python3 tools/idman_triage.py [chemin_du_PE] [-o analysis/idman/triage.json]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import struct
import sys

try:
    import pefile
except ImportError:  # pragma: no cover
    sys.exit("pefile manquant : python3 -m pip install --break-system-packages pefile")


FILE_CHARACTERISTICS = {
    0x0001: "RELOCS_STRIPPED",
    0x0002: "EXECUTABLE_IMAGE",
    0x0004: "LINE_NUMS_STRIPPED",
    0x0008: "LOCAL_SYMS_STRIPPED",
    0x0020: "LARGE_ADDRESS_AWARE",
    0x0100: "32BIT_MACHINE",
    0x0200: "DEBUG_STRIPPED",
    0x1000: "SYSTEM",
    0x2000: "DLL",
}

DLL_CHARACTERISTICS = {
    0x0020: "HIGH_ENTROPY_VA",
    0x0040: "DYNAMIC_BASE (ASLR)",
    0x0080: "FORCE_INTEGRITY",
    0x0100: "NX_COMPAT (DEP)",
    0x0200: "NO_ISOLATION",
    0x0400: "NO_SEH",
    0x0800: "NO_BIND",
    0x1000: "APPCONTAINER",
    0x2000: "WDM_DRIVER",
    0x4000: "GUARD_CF (Control Flow Guard)",
    0x8000: "TERMINAL_SERVER_AWARE",
}

RESOURCE_TYPES = {
    1: "CURSOR", 2: "BITMAP", 3: "ICON", 4: "MENU", 5: "DIALOG", 6: "STRING",
    7: "FONTDIR", 8: "FONT", 9: "ACCELERATOR", 10: "RCDATA", 11: "MESSAGETABLE",
    12: "GROUP_CURSOR", 14: "GROUP_ICON", 16: "VERSION", 23: "HTML",
    24: "MANIFEST", 240: "DLGINIT", 241: "TOOLBAR",
}

# Marqueurs de protocoles / fonctionnalités recherchés dans les chaînes.
PROTOCOL_MARKERS = [
    "http://", "https://", "ftp://", "ftps://", "rtmp://", "rtmpe://", "mms://",
    "mmst://", "mmsh://", ".m3u8", "EXT-X-", ".mpd", "sidx", "moov", "moof",
    "Content-Range", "Content-Length", "Accept-Ranges", "Range:", "Cookie:",
    "Set-Cookie", "Referer", "User-Agent", "Proxy-Authorization",
    "application/x-amz", "AMF", "text/xml", "SOAPAction", "multipart/byteranges",
]

BROWSER_MARKERS = [
    "chrome", "edge", "firefox", "brave", "opera", "vivaldi", "seamonkey",
    "palemoon", "waterfox", "orca.exe", "coccoc", "netscape", "mozilla",
]

ANTI_ANALYSIS_MARKERS = [
    "IsDebuggerPresent", "CheckRemoteDebuggerPresent", "NtQueryInformationProcess",
    "OutputDebugString", "SetUnhandledExceptionFilter", "UnhandledExceptionFilter",
    "GetTickCount", "QueryPerformanceCounter", "VirtualProtect", "VirtualAlloc",
    "IsBadReadPtr", "LoadLibraryA", "GetProcAddress", "SetWindowsHookEx",
]


def entropy(data: bytes) -> float:
    if not data:
        return 0.0
    counts = [0] * 256
    for byte in data:
        counts[byte] += 1
    total = len(data)
    return -sum((c / total) * math.log2(c / total) for c in counts if c)


def wide_string(data: bytes, offset: int) -> tuple[str, int]:
    chars = []
    while offset + 1 < len(data):
        pair = data[offset:offset + 2]
        if pair == b"\x00\x00":
            offset += 2
            break
        chars.append(pair.decode("utf-16le", "replace"))
        offset += 2
    return "".join(chars), offset


def resource_entries(pe: pefile.PE, type_id: int):
    for entry in getattr(pe, "DIRECTORY_ENTRY_RESOURCE", []).entries:
        if entry.id != type_id:
            continue
        for name in entry.directory.entries:
            for lang in name.directory.entries:
                data = pe.get_data(lang.data.struct.OffsetToData, lang.data.struct.Size)
                yield name.id, lang.data.struct.OffsetToData, lang.data.struct.Size, data


def parse_menu_template(data: bytes) -> list[str]:
    if len(data) < 4:
        return []
    _, header_size = struct.unpack("<HH", data[:4])
    labels: list[str] = []
    offset = header_size
    while offset + 2 <= len(data):
        flags = struct.unpack("<H", data[offset:offset + 2])[0]
        offset += 2
        if flags & 0x10:  # MF_POPUP
            label, offset = wide_string(data, offset)
            labels.append("[" + label + "]")
            continue
        if flags & 0x40:  # MF_END
            break
        label, offset = wide_string(data, offset)
        offset += 2
        if label:
            labels.append(label)
    return labels


def parse_string_table(data: bytes) -> list[str]:
    out: list[str] = []
    offset = 0
    while offset + 2 <= len(data):
        length = struct.unpack("<H", data[offset:offset + 2])[0]
        offset += 2
        text = data[offset:offset + length * 2].decode("utf-16le", "replace")
        offset += length * 2
        if text.strip():
            out.append(text)
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", nargs="?", default="cible/IDMan.exe")
    parser.add_argument("-o", "--output", default="analysis/idman/triage.json")
    args = parser.parse_args()

    raw = open(args.path, "rb").read()
    pe = pefile.PE(args.path)

    result: dict = {}
    result["artifact"] = {
        "path": args.path,
        "bytes": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
    }

    result["headers"] = {
        "machine": hex(pe.FILE_HEADER.Machine),
        "characteristics": hex(pe.FILE_HEADER.Characteristics),
        "characteristics_flags": [
            label for bit, label in sorted(FILE_CHARACTERISTICS.items())
            if pe.FILE_HEADER.Characteristics & bit
        ],
        "timestamp_utc": None,  # rempli plus bas, en clair
        "time_date_stamp": pe.FILE_HEADER.TimeDateStamp,
        "optional_header_magic": hex(pe.OPTIONAL_HEADER.Magic),
        "subsystem": pe.OPTIONAL_HEADER.Subsystem,
        "dll_characteristics": hex(pe.OPTIONAL_HEADER.DllCharacteristics),
        "mitigations": [
            label for bit, label in sorted(DLL_CHARACTERISTICS.items())
            if pe.OPTIONAL_HEADER.DllCharacteristics & bit
        ],
        "entry_point_rva": hex(pe.OPTIONAL_HEADER.AddressOfEntryPoint),
        "image_base": hex(pe.OPTIONAL_HEADER.ImageBase),
        "checksum": hex(pe.OPTIONAL_HEADER.CheckSum),
    }
    import datetime
    result["headers"]["timestamp_utc"] = datetime.datetime.fromtimestamp(
        pe.FILE_HEADER.TimeDateStamp, datetime.timezone.utc
    ).strftime("%Y-%m-%dT%H:%M:%SZ")
    # Les entrées de resources ci-dessous n'utilisent pas le timbre, mais le
    # retirer garantit un JSON identique entre deux exécutions.

    result["sections"] = [
        {
            "name": s.Name.rstrip(b"\x00").decode("latin-1"),
            "virtual_address": hex(s.VirtualAddress),
            "virtual_size": s.Misc_VirtualSize,
            "raw_size": s.SizeOfRawData,
            "raw_pointer": hex(s.PointerToRawData),
            "entropy": round(entropy(s.get_data()), 3),
            "characteristics": hex(s.Characteristics),
            "writable": bool(s.Characteristics & 0x80000000),
            "executable": bool(s.Characteristics & 0x20000000),
        }
        for s in pe.sections
    ]

    debug = []
    for entry in getattr(pe, "DIRECTORY_ENTRY_DEBUG", []):
        item = {"type": entry.struct.Type, "size": entry.struct.SizeOfData}
        if entry.struct.Type == 2 and hasattr(entry, "entry"):
            item["pdb"] = entry.entry.PdbFileName.rstrip(b"\x00").decode("latin-1")
            item["guid"] = str(entry.entry.Signature_Data1) if hasattr(entry.entry, "Signature_Data1") else None
            item["age"] = getattr(entry.entry, "Age", None)
        debug.append(item)
    result["debug"] = debug

    version = {}
    try:
        for info in pe.FileInfo[0]:
            if info.Key == b"StringFileInfo":
                for table in info.StringTable:
                    for key, value in table.entries.items():
                        version[key.decode()] = value.decode("latin-1", "replace")
    except (AttributeError, IndexError):
        pass
    result["version_info"] = dict(sorted(version.items()))

    imports = {}
    for kind, container in (("imports", getattr(pe, "DIRECTORY_ENTRY_IMPORT", [])),
                            ("delay_imports", getattr(pe, "DIRECTORY_ENTRY_DELAY_IMPORT", []))):
        rows = []
        for entry in container:
            functions = []
            for imp in entry.imports:
                functions.append(imp.name.decode("latin-1") if imp.name else f"ordinal:{imp.ordinal}")
            rows.append({"dll": entry.dll.decode("latin-1"), "count": len(functions),
                         "functions": sorted(functions)})
        rows.sort(key=lambda r: (-r["count"], r["dll"]))
        imports[kind] = rows
    result["imports"] = imports
    notable = re.compile(r"(Internet|Http|WinInet|Ftp|Ras|Crypt|Socket|WSA|Reg[A-Z]|CreateThread|"
                         r"VirtualAlloc|VirtualProtect|LoadLibrary|GetProcAddress|IsDebugger|"
                         r"CheckRemote|SetWindowsHook|ShellExecute|CreateProcess|SetTimer)")
    result["notable_imports"] = sorted({
        f"{row['dll']}!{fn}" for kind in imports.values() for row in kind for fn in row["functions"]
        if notable.search(fn)
    })

    resources: dict[str, dict] = {}
    raw_resources: list[dict] = []
    for entry in getattr(pe, "DIRECTORY_ENTRY_RESOURCE", []).entries:
        if entry.id is None:
            type_name = "NAMED:" + str(entry.name)
        else:
            type_name = RESOURCE_TYPES.get(entry.id, str(entry.id))
        count = 0
        for name in entry.directory.entries:
            for lang in name.directory.entries:
                count += 1
                raw_resources.append({
                    "type": type_name, "id": name.id, "lang": lang.id,
                    "offset": lang.data.struct.OffsetToData, "size": lang.data.struct.Size,
                })
        resources[type_name] = resources.get(type_name, 0) + count
    result["resources"] = {"counts": dict(sorted(resources.items())),
                           "entries": sorted(raw_resources, key=lambda r: (r["type"], str(r["id"]), r["offset"]))}

    menus = []
    for menu_id, offset, size, data in resource_entries(pe, 4):
        menus.append({"id": menu_id, "offset": offset, "labels": parse_menu_template(data)})
    result["menus"] = menus

    string_tables: list[str] = []
    for _, _, _, data in resource_entries(pe, 6):
        string_tables.extend(parse_string_table(data))
    result["rt_string"] = string_tables

    classes = sorted({
        m.group(1).decode("latin-1")
        for m in re.finditer(rb"\.\?AV([A-Za-z0-9_@?$<>:,\-\.]{2,120})@@", raw)
    })
    result["rtti"] = {
        "count": len(classes),
        "plain": [c for c in classes if not c.startswith("?$")],
        "templates": [c for c in classes if c.startswith("?$")],
    }

    def offset_of(needle: bytes) -> int | None:
        idx = raw.find(needle)
        return idx if idx >= 0 else None

    markers = {}
    for marker in PROTOCOL_MARKERS:
        hit = offset_of(marker.encode("latin-1"))
        hits = raw.count(marker.encode("latin-1"))
        if hits:
            markers[marker] = {"first_offset": hit, "occurrences": hits}
    result["protocol_markers"] = markers

    browsers: dict[str, int] = {}
    lowered = raw.lower()
    for name in BROWSER_MARKERS:
        hits = lowered.count(name.encode("latin-1"))
        if hits:
            browsers[name] = hits
    result["browser_markers"] = dict(sorted(browsers.items(), key=lambda kv: -kv[1]))

    anti: dict[str, int] = {}
    for name in ANTI_ANALYSIS_MARKERS:
        hits = raw.count(name.encode("latin-1"))
        if hits:
            anti[name] = hits
    result["anti_analysis_markers"] = dict(sorted(anti.items(), key=lambda kv: -kv[1]))

    ascii_for_registry = re.findall(rb"[\x20-\x7e]{6,}", raw)
    registry = sorted({
        text.decode("latin-1").strip()
        for text in ascii_for_registry
        if (b"SOFTWARE\\" in text or b"Software\\" in text or b"software\\" in text)
    })
    result["registry_hits"] = registry

    ascii_strings = re.findall(rb"[\x20-\x7e]{6,}", raw)
    utf16_strings = re.findall(rb"(?:[\x20-\x7e]\x00){5,}", raw)
    result["strings_summary"] = {
        "ascii_count": len(ascii_strings),
        "utf16_count": len(utf16_strings),
        "module_names": sorted({
            s.decode("latin-1").strip() for s in ascii_strings + utf16_strings
            if re.fullmatch(rb"[A-Za-z0-9_.\-]{3,40}\.(?:exe|dll|xpi)", s.strip())
        }),
    }

    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=1, sort_keys=True, ensure_ascii=False)
        handle.write("\n")
    print(f"écrit {args.output} — {len(json.dumps(result))} octets")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
