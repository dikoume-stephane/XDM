#!/usr/bin/env python3
"""Extractions brutes reproductibles pour la mémoire du projet IDM.

Écrit dans analysis/raw/idman/ (non versionné) :
    strings-ascii.txt      chaînes ASCII >= 6 caractères imprimables
    strings-utf16.txt      chaînes UTF-16LE >= 5 caractères
    rtti-classes.txt       noms de types RTTI (`.?AV…@@`), un par ligne
    rt-string.txt          table RT_STRING (37 tables -> chaînes d'aide/UI)
    dialog-captions.txt    ID de dialogue + légende (105 modèles)
    menus.txt              ID de menu + libellés récupérables

Dépendance : pefile. Usage : python3 tools/idman_extract.py [PE] [-o dossier]
"""

from __future__ import annotations

import argparse
import re
import struct
import pefile

RES_STRING = 6
RES_DIALOG = 5
RES_MENU = 4


def wide(data: bytes, offset: int) -> tuple[str, int]:
    out = []
    while offset + 1 < len(data):
        pair = data[offset:offset + 2]
        if pair == b"\x00\x00":
            offset += 2
            break
        out.append(pair.decode("utf-16le", "replace"))
        offset += 2
    return "".join(out), offset


def ordinal_or_string(data: bytes, offset: int) -> tuple[object, int]:
    """Lit un champ MENU/CLASSE/TITRE d'un modèle de dialogue (ordinal ou chaîne)."""
    value = struct.unpack("<H", data[offset:offset + 2])[0]
    if value == 0xFFFF:
        return struct.unpack("<H", data[offset + 2:offset + 4])[0], offset + 4
    return wide(data, offset)


def resource_blobs(pe: pefile.PE, type_id: int):
    for entry in getattr(pe, "DIRECTORY_ENTRY_RESOURCE", []).entries:
        if entry.id != type_id:
            continue
        for name in entry.directory.entries:
            for lang in name.directory.entries:
                yield (name.id,
                       pe.get_data(lang.data.struct.OffsetToData, lang.data.struct.Size))


def parse_string_table(data: bytes) -> list[str]:
    out, offset = [], 0
    while offset + 2 <= len(data):
        length = struct.unpack("<H", data[offset:offset + 2])[0]
        offset += 2
        text = data[offset:offset + length * 2].decode("utf-16le", "replace")
        offset += length * 2
        if text.strip():
            out.append(text)
    return out


def parse_menu(data: bytes) -> list[str]:
    if len(data) < 4:
        return []
    _, header = struct.unpack("<HH", data[:4])
    labels, offset = [], header
    while offset + 2 <= len(data):
        flags = struct.unpack("<H", data[offset:offset + 2])[0]
        offset += 2
        if flags & 0x10:  # MF_POPUP
            label, offset = wide(data, offset)
            labels.append("[" + label + "]")
            continue
        if flags & 0x40:  # MF_END
            break
        label, offset = wide(data, offset)
        offset += 2
        if label:
            labels.append(label)
    return labels


def dialog_caption(data: bytes) -> str:
    is_ex = len(data) > 4 and struct.unpack("<H", data[2:4])[0] == 0xFFFF
    offset = 4 + 4 + 4 + 4 + 2 + 8 if is_ex else 4 + 4 + 2 + 8
    _, offset = ordinal_or_string(data, offset)   # menu
    _, offset = ordinal_or_string(data, offset)   # classe de fenêtre
    caption, _ = ordinal_or_string(data, offset)  # titre
    return caption if isinstance(caption, str) else f"<ordinal {caption}>"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", nargs="?", default="cible/IDMan.exe")
    parser.add_argument("-o", "--outdir", default="analysis/raw/idman")
    args = parser.parse_args()

    raw = open(args.path, "rb").read()
    pe = pefile.PE(args.path)
    ascii_strings = re.findall(rb"[\x20-\x7e]{6,}", raw)
    with open(f"{args.outdir}/strings-ascii.txt", "w", encoding="utf-8") as fh:
        fh.write("\n".join(s.decode("latin-1") for s in ascii_strings) + "\n")
    print(f"strings-ascii.txt   {len(ascii_strings)} chaînes")

    utf16 = [m.group(0).decode("utf-16le", "replace")
             for m in re.finditer(rb"(?:[\x20-\x7e]\x00){5,}", raw)]
    with open(f"{args.outdir}/strings-utf16.txt", "w", encoding="utf-8") as fh:
        fh.write("\n".join(utf16) + "\n")
    print(f"strings-utf16.txt   {len(utf16)} chaînes")

    names = sorted({m.group(1).decode("latin-1")
                    for m in re.finditer(rb"\.\?AV([A-Za-z0-9_@?$<>:,\-\.]{2,120})@@", raw)})
    with open(f"{args.outdir}/rtti-classes.txt", "w", encoding="utf-8") as fh:
        fh.write("\n".join(names) + "\n")
    print(f"rtti-classes.txt    {len(names)} noms RTTI")

    strings: list[str] = []
    for _, data in resource_blobs(pe, RES_STRING):
        strings.extend(parse_string_table(data))
    with open(f"{args.outdir}/rt-string.txt", "w", encoding="utf-8") as fh:
        fh.write("\n".join(strings) + "\n")
    print(f"rt-string.txt       {len(strings)} chaînes")

    dialogs = []
    errors = 0
    for dialog_id, data in resource_blobs(pe, RES_DIALOG):
        try:
            dialogs.append((dialog_id, dialog_caption(data)))
        except Exception:  # modèle exotique : on le signale sans bloquer
            dialogs.append((dialog_id, "<illisible>"))
            errors += 1
    with open(f"{args.outdir}/dialog-captions.txt", "w", encoding="utf-8") as fh:
        fh.write("\n".join(f"{i}\t{t}" for i, t in dialogs) + "\n")
    print(f"dialog-captions.txt {len(dialogs)} modèles ({errors} illisibles)")

    with open(f"{args.outdir}/menus.txt", "w", encoding="utf-8") as fh:
        for menu_id, data in resource_blobs(pe, RES_MENU):
            fh.write(f"# menu {menu_id}\n" + "\n".join(parse_menu(data)) + "\n\n")
    print("menus.txt           écrit")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
