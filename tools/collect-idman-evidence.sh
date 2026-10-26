#!/usr/bin/env bash
# Collecte reproductible des Evidence REA pour la cible IDM.
# Usage : bash tools/collect-idman-evidence.sh [chemin/vers/IDMan.exe]
# Les bundles sont écrits dans analysis/raw/idman/ (ignoré par Git).
set -euo pipefail

TARGET="${1:-cible/IDMan.exe}"
REA="./node_modules/.bin/rea"
OUT="analysis/raw/idman"
mkdir -p "$OUT"

run() {
  local name="$1"; shift
  if timeout 300 "$REA" "$@" --format json 2>/dev/null | tail -1 > "$OUT/$name.json"; then
    echo "ok   $name -> $(wc -c < "$OUT/$name.json") octets"
  else
    echo "FAIL $name" >&2
  fi
}

run inspect-artifact            inspect-artifact "$TARGET"
run inspect-pe-imports          inspect-pe-imports "$TARGET"
run inspect-pe-certificates     inspect-pe-certificates "$TARGET"
run inspect-pe-resources        inspect-pe-resources "$TARGET"
run inspect-pe-load-config      inspect-pe-load-config "$TARGET"
run inspect-native-exports      inspect-native-exports "$TARGET"
run inspect-byte-entropy        inspect-byte-entropy "$TARGET"
run inspect-managed-artifact    inspect-managed-artifact "$TARGET"
run objdump-file_headers        inspect-with-objdump "$TARGET" file_headers
run objdump-section_headers     inspect-with-objdump "$TARGET" section_headers
run objdump-symbols             inspect-with-objdump "$TARGET" symbols

"$REA" doctor > "$OUT/doctor.txt" 2>&1 || true
echo "journal REA : $OUT/"
