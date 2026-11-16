#!/usr/bin/env python3
"""Verify signed DUT content against the production unsigned APK and gzip map.

Usage: verify-release-pair.py UNSIGNED_APK MAPPING_GZ SIGNED_APK MAPPING_TXT OUTPUT
Writes content hashes only after payload and mapping equality are established.
APK signing entries/blocks may differ; all other ZIP entries must match exactly.
"""

import gzip
import hashlib
import json
from pathlib import Path
import sys
import zipfile


def payload(path):
    with zipfile.ZipFile(path) as apk:
        return {
            name: hashlib.sha256(apk.read(name)).hexdigest()
            for name in apk.namelist()
            if not (name.upper() == "META-INF/MANIFEST.MF" or
                    (name.upper().startswith("META-INF/") and
                     Path(name).suffix.upper() in {".SF", ".RSA", ".DSA", ".EC"}))
        }


def verify(unsigned, mapping_gz, signed, mapping, output):
    original = payload(unsigned)
    if original != payload(signed):
        raise ValueError("The signed tested APK differs from the production unsigned payload")
    if gzip.decompress(mapping_gz.read_bytes()) != mapping.read_bytes():
        raise ValueError("The tested APK mapping differs from the retained production mapping")
    output.write_text(json.dumps({
        "files": {str(path): hashlib.sha256(path.read_bytes()).hexdigest()
                  for path in (unsigned, mapping_gz, signed, mapping)},
        "payload": original,
    }, indent=2) + "\n")


if __name__ == "__main__":
    verify(*(Path(value) for value in sys.argv[1:]))
