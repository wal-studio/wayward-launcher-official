#!/usr/bin/env python3
import sys
import zipfile
from pathlib import Path

if len(sys.argv) != 3:
    raise SystemExit("usage: extract-wml-mod-list.py mods.zip output.js")

archive, output = sys.argv[1], Path(sys.argv[2])
with zipfile.ZipFile(archive) as bundle:
    candidates = [
        name for name in bundle.namelist()
        if name.replace("\\", "/").endswith("wml/mods/mods.js")
    ]
    if not candidates:
        raise SystemExit("pinned mods.zip does not contain wml/mods/mods.js")
    selected = "wml/mods/mods.js" if "wml/mods/mods.js" in candidates else sorted(candidates)[0]
    data = bundle.read(selected)

output.write_bytes(data)
print(f"Extracted {selected}: {len(data)} bytes")
