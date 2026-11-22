"""Read the exact R8 map for an optimized APK."""

import gzip
import hashlib
import json
import re
import zipfile


def read_release_mapping(apk, mapping_gz):
    with gzip.open(mapping_gz, "rb") as stream:
        mapping = stream.read()
    compiler_match = re.search(rb"^# compiler_version: (\S+)\r?$", mapping, re.MULTILINE)
    map_id_match = re.search(rb"^# pg_map_id: (\S+)\r?$", mapping, re.MULTILINE)
    map_hash = re.search(rb"^# pg_map_hash: SHA-256 ([0-9a-f]{64})\r?\n", mapping, re.MULTILINE)
    if compiler_match is None or map_id_match is None or map_hash is None:
        raise ValueError("Mapping must contain an R8 compiler version, pg_map_id and SHA-256 hash")
    if hashlib.sha256(mapping[map_hash.end():]).hexdigest() != map_hash[1].decode("ascii"):
        raise ValueError("R8 mapping content does not match its SHA-256 hash")
    compiler = compiler_match[1].decode("ascii")
    map_id = map_id_match[1].decode("ascii")
    with zipfile.ZipFile(apk) as archive:
        markers = [
            json.loads(marker)
            for name in archive.namelist()
            if re.fullmatch(r"classes\d*\.dex", name)
            for marker in re.findall(rb"~~R8(\{[^\x00]*?\})", archive.read(name))
        ]
    if not markers or any(
        marker.get("pg-map-id") != map_id or marker.get("version") != compiler
        for marker in markers
    ):
        raise ValueError("APK and R8 mapping identities do not match")
    return mapping, compiler, map_id
