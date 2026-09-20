/** Portable recovery tooling ships with every v3 export and needs only Python 3. */
export const USER_EXPORT_RESTORE_SCRIPT = String.raw`#!/usr/bin/env python3
"""Restore an Okou v3 ZIP: python3 restore.py export.zip output-directory."""
import argparse
import binascii
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sqlite3
import struct
import tarfile
import tempfile

CHUNK = 1024 * 1024
MAX_JSON = 64 * CHUNK
HEX = re.compile(r"^[0-9a-f]{64}$")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def safe_path(name):
    require(isinstance(name, str) and name, "Empty archive path")
    require("\\" not in name and "\0" not in name, "Unsafe archive path")
    require(not re.match(r"^[a-zA-Z]:", name), "Unsafe archive drive path")
    require(all(part not in ("", ".", "..") for part in name.split("/")),
            "Unsafe archive path: " + name)
    return name


def integer(value, label):
    require(type(value) is int and value >= 0, "Invalid " + label)
    return value


def read_exact(stream, length):
    value = stream.read(length)
    require(len(value) == length, "Truncated ZIP metadata")
    return value


class RangeReader(io.RawIOBase):
    def __init__(self, archive, offset, length):
        self.stream = open(archive, "rb")
        self.stream.seek(offset)
        self.remaining = length

    def readable(self):
        return True

    def readinto(self, destination):
        size = min(len(destination), self.remaining)
        data = self.stream.read(size)
        require(len(data) == size, "Truncated ZIP entry")
        destination[:size] = data
        self.remaining -= size
        return size

    def close(self):
        self.stream.close()
        super().close()


class Archive:
    def __init__(self, path, db):
        self.path = path
        self.db = db
        db.execute("CREATE TABLE files(path TEXT PRIMARY KEY, offset INTEGER, size INTEGER, crc INTEGER, central_seen INTEGER DEFAULT 0)")
        db.execute("CREATE TABLE expected(path TEXT PRIMARY KEY, size INTEGER, sha TEXT)")
        with open(path, "rb") as source:
            size = os.fstat(source.fileno()).st_size
            while True:
                signature = read_exact(source, 4)
                if signature in (b"PK\x01\x02", b"PK\x05\x06", b"PK\x06\x06"):
                    break
                require(signature == b"PK\x03\x04", "Invalid ZIP local record")
                fields = struct.unpack("<HHHHHIIIHH", read_exact(source, 26))
                _, flags, method, _, _, crc, compressed, length, name_size, extra_size = fields
                require(flags in (0, 0x800) and method == 0,
                        "This tool requires the original uncompressed Okou v3 ZIP")
                name = safe_path(read_exact(source, name_size).decode("utf-8"))
                extra = read_exact(source, extra_size)
                if length == 0xffffffff or compressed == 0xffffffff:
                    position = 0
                    found = False
                    while position + 4 <= len(extra):
                        kind, field_size = struct.unpack_from("<HH", extra, position)
                        position += 4
                        field = extra[position:position + field_size]
                        require(len(field) == field_size, "Truncated ZIP64 field")
                        position += field_size
                        if kind == 1:
                            value_offset = 0
                            if length == 0xffffffff:
                                require(len(field) >= value_offset + 8, "Missing ZIP64 file size")
                                length = struct.unpack_from("<Q", field, value_offset)[0]
                                value_offset += 8
                            if compressed == 0xffffffff:
                                require(len(field) >= value_offset + 8, "Missing ZIP64 stored size")
                                compressed = struct.unpack_from("<Q", field, value_offset)[0]
                            found = True
                            break
                    require(found, "Missing ZIP64 metadata")
                require(length == compressed and source.tell() + length <= size,
                        "Invalid stored ZIP size")
                db.execute("INSERT INTO files(path,offset,size,crc) VALUES(?,?,?,?)", (name, source.tell(), length, crc))
                source.seek(length, os.SEEK_CUR)
            while signature == b"PK\x01\x02":
                fields = struct.unpack("<HHHHHHIIIHHHHHII", read_exact(source, 42))
                flags, method, crc = fields[2], fields[3], fields[6]
                name_size, extra_size, comment_size = fields[9:12]
                attributes = fields[14]
                name = safe_path(read_exact(source, name_size).decode("utf-8"))
                read_exact(source, extra_size + comment_size)
                require(flags in (0, 0x800) and method == 0, "Unsupported ZIP central record")
                require((attributes >> 16) & 0o170000 in (0, 0o100000) and not attributes & 0x10,
                        "ZIP contains a link, directory, or special file")
                changed = db.execute("UPDATE files SET central_seen=1 WHERE path=? AND crc=? AND central_seen=0",
                                     (name, crc)).rowcount
                require(changed == 1, "ZIP central directory does not match its files")
                signature = read_exact(source, 4)
            require(signature in (b"PK\x05\x06", b"PK\x06\x06"), "Missing ZIP end record")
            require(db.execute("SELECT COUNT(*) FROM files WHERE central_seen=0").fetchone()[0] == 0,
                    "Incomplete ZIP central directory")
        db.commit()

    def open(self, name):
        row = self.db.execute("SELECT offset,size FROM files WHERE path=?", (safe_path(name),)).fetchone()
        require(row is not None, "Missing export file: " + name)
        return io.BufferedReader(RangeReader(self.path, row[0], row[1]), buffer_size=CHUNK)

    def json(self, name):
        with self.open(name) as source:
            body = source.read(MAX_JSON + 1)
        require(len(body) <= MAX_JSON, "JSON record exceeds 64 MiB: " + name)
        return json.loads(body)

    def chunks(self, name):
        with self.open(name) as source:
            while True:
                chunk = source.read(CHUNK)
                if not chunk:
                    return
                yield chunk

    def verify(self, name, expected_size=None, expected_sha=None, aggregate=None):
        row = self.db.execute("SELECT size,crc FROM files WHERE path=?", (name,)).fetchone()
        require(row is not None, "Missing export file: " + name)
        digest, crc, count = hashlib.sha256(), 0, 0
        for chunk in self.chunks(name):
            digest.update(chunk)
            crc = binascii.crc32(chunk, crc)
            count += len(chunk)
            if aggregate is not None:
                aggregate.update(chunk)
        require(count == row[0] and crc == row[1], "ZIP checksum mismatch: " + name)
        if expected_size is not None:
            require(count == expected_size, "File length mismatch: " + name)
        if expected_sha is not None:
            require(digest.hexdigest() == expected_sha, "SHA-256 mismatch: " + name)


def json_lines(source):
    while True:
        line = source.readline(MAX_JSON + 1)
        if not line:
            return
        require(len(line) <= MAX_JSON, "A JSON record exceeds 64 MiB")
        if line.strip():
            yield json.loads(line), line.decode("utf-8").strip()


def verify_archive(archive):
    archive.verify("export-manifest.json")
    manifest = archive.json("export-manifest.json")
    require(manifest.get("formatVersion") == 3, "Expected export format version 3")
    files = manifest["filesManifest"]
    require(files.get("pageSize") == 100 and
            files.get("pathPattern") == "manifest/files-{pageStart}.jsonl" and
            files.get("algorithm") == "sha256-concatenated-pages", "Unsupported manifest index")
    count = integer(files["pageCount"], "manifest page count")
    require(count > 0 and HEX.fullmatch(files["sha256"]), "Invalid manifest digest")
    aggregate = hashlib.sha256()
    for page in range(count):
        path = "manifest/files-" + str(page * 100) + ".jsonl"
        archive.verify(path, aggregate=aggregate)
        with archive.open(path) as source:
            entries = 0
            for record, _ in json_lines(source):
                name = safe_path(record["path"])
                require(name != "export-manifest.json" and not name.startswith("manifest/"),
                        "Manifest cannot list itself")
                size = integer(record["size"], "file size")
                digest = record["sha256"]
                require(isinstance(digest, str) and HEX.fullmatch(digest), "Invalid file digest")
                archive.db.execute("INSERT INTO expected VALUES(?,?,?)", (name, size, digest))
                entries += 1
            require(0 < entries <= 100 and (page == count - 1 or entries == 100),
                    "Invalid manifest page length")
    require(aggregate.hexdigest() == files["sha256"], "Manifest page SHA-256 mismatch")
    for name, size, digest in archive.db.execute("SELECT path,size,sha FROM expected ORDER BY path"):
        archive.verify(name, size, digest)
    actual = archive.db.execute("SELECT COUNT(*) FROM files").fetchone()[0]
    expected = archive.db.execute("SELECT COUNT(*) FROM expected").fetchone()[0]
    require(actual == expected + count + 1, "Export contains unlisted files")
    archive.db.commit()
    return manifest


def create_file(root, name):
    destination = root.joinpath(*safe_path(name).split("/"))
    destination.resolve().relative_to(root.resolve())
    destination.parent.mkdir(parents=True, exist_ok=True)
    return open(destination, "xb")


def write_json_line(output, value):
    output.write((json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))


def add_events(archive, source, thread_id, lower, upper):
    for event, line in json_lines(source):
        require(isinstance(event, dict) and event.get("chatThreadId") == thread_id,
                "Chat event belongs to a different thread")
        seq = integer(event["seqId"], "chat sequence")
        event_id = event["id"]
        require(isinstance(event_id, str) and event_id, "Invalid chat event ID")
        if not lower < seq <= upper:
            continue
        previous = archive.db.execute("SELECT seq,body FROM events WHERE id=?", (event_id,)).fetchone()
        if previous:
            require(previous[0] == seq and json.loads(previous[1]) == event,
                    "Conflicting duplicate chat event ID")
        else:
            archive.db.execute("INSERT INTO events VALUES(?,?,?)", (event_id, seq, line))


def restore_threads(archive, output):
    archive.db.execute("CREATE TABLE events(id TEXT PRIMARY KEY, seq INTEGER UNIQUE, body TEXT)")
    with create_file(output, "chat-threads.jsonl") as threads:
        for (path,) in archive.db.execute("SELECT path FROM expected WHERE path GLOB 'chat-threads/*.json' ORDER BY path"):
            thread = archive.json(path)
            thread_id = thread["id"]
            require(isinstance(thread_id, str) and "/" not in safe_path(thread_id), "Invalid thread ID")
            require(path == "chat-threads/" + thread_id + ".json", "Thread metadata path mismatch")
            write_json_line(threads, thread)
            base = "chat-messages/" + thread_id + "/"
            index = archive.json(base + "index.json")
            require(index["threadId"] == thread_id, "Thread index identity mismatch")
            upper = integer(index["upperSeqId"], "upper chat sequence")
            coverage = integer(index["snapshotPhysicalCoverage"], "snapshot coverage")
            archive.db.execute("DELETE FROM events")
            snapshot = index["snapshotPath"]
            if snapshot is not None:
                require(safe_path(snapshot).startswith(base + "snapshots/"), "Invalid snapshot reference")
                with archive.open(snapshot) as raw, gzip.GzipFile(fileobj=raw) as source:
                    add_events(archive, source, thread_id, -1, upper)
            else:
                require(coverage == 0, "Snapshot coverage has no source")
            for (tail,) in archive.db.execute("SELECT path FROM expected WHERE path GLOB ? ORDER BY path", (base + "tail/*.jsonl",)):
                with archive.open(tail) as source:
                    add_events(archive, source, thread_id, coverage, upper)
            archive.db.commit()
            with create_file(output, "chat-messages/" + thread_id + ".jsonl") as messages:
                for (body,) in archive.db.execute("SELECT body FROM events ORDER BY seq"):
                    messages.write((body + "\n").encode("utf-8"))
    archive.db.execute("DROP TABLE events")


def restore_instructions(archive, output, kind):
    with create_file(output, kind + ".jsonl") as destination:
        for (path,) in archive.db.execute("SELECT path FROM expected WHERE path GLOB ? ORDER BY path", (kind + "/*.json",)):
            write_json_line(destination, archive.json(path))


class JsonStream:
    """Incrementally decode a memory manifest's files array, one file at a time."""
    def __init__(self, source):
        self.source = io.TextIOWrapper(source, encoding="utf-8")
        self.buffer = ""
        self.decoder = json.JSONDecoder()

    def trim(self):
        self.buffer = self.buffer.lstrip()
        while not self.buffer:
            chunk = self.source.read(65536)
            require(chunk != "", "Unexpected end of memory manifest")
            self.buffer += chunk
            self.buffer = self.buffer.lstrip()

    def take(self, character):
        self.trim()
        require(self.buffer.startswith(character), "Invalid memory manifest syntax")
        self.buffer = self.buffer[len(character):]

    def peek(self):
        self.trim()
        return self.buffer[0]

    def value(self):
        self.trim()
        while True:
            try:
                value, end = self.decoder.raw_decode(self.buffer)
                # A number may end at a buffer boundary while more digits follow.
                if end < len(self.buffer):
                    self.buffer = self.buffer[end:]
                    return value
            except json.JSONDecodeError:
                pass
            require(len(self.buffer) <= MAX_JSON, "Memory metadata record exceeds 64 MiB")
            chunk = self.source.read(65536)
            require(chunk != "", "Incomplete memory manifest value")
            self.buffer += chunk


def memory_manifest(archive, path):
    archive.db.execute("DELETE FROM memory_files")
    count, total, properties = 0, 0, {}
    with archive.open(path) as source:
        reader = JsonStream(source)
        reader.take("{")
        while reader.peek() != "}":
            key = reader.value()
            require(isinstance(key, str) and key not in properties, "Duplicate memory manifest key")
            reader.take(":")
            if key == "files":
                properties[key] = True
                reader.take("[")
                while reader.peek() != "]":
                    record = reader.value()
                    name = record["path"]
                    if name.startswith("./"):
                        name = name[2:]
                    name = safe_path(name)
                    size = integer(record["size"], "memory file size")
                    digest = record["hash"]
                    require(isinstance(digest, str) and HEX.fullmatch(digest), "Invalid memory SHA-256")
                    archive.db.execute("INSERT INTO memory_files VALUES(?,?,?,0)", (name, size, digest))
                    count += 1
                    total += size
                    if reader.peek() != "]":
                        reader.take(",")
                reader.take("]")
            else:
                properties[key] = reader.value()
            if reader.peek() != "}":
                reader.take(",")
        reader.take("}")
        require(not reader.buffer.strip(), "Trailing memory manifest content")
        while True:
            trailing = reader.source.read(65536)
            if not trailing:
                break
            require(not trailing.strip(), "Trailing memory manifest content")
    require(properties.get("files") is True and properties.get("fileCount") == count and
            properties.get("totalSize") == total, "Memory manifest totals do not match its files")


def restore_memory(archive, output):
    archive.db.execute("CREATE TABLE memory_files(path TEXT PRIMARY KEY, size INTEGER, sha TEXT, seen INTEGER)")
    for (path,) in archive.db.execute("SELECT path FROM expected WHERE path GLOB 'memory/*/*/archive.tar.gz' ORDER BY path"):
        parts = path.split("/")
        require(len(parts) == 4, "Invalid memory archive path")
        base = "/".join(parts[:3])
        memory_manifest(archive, base + "/manifest.json")
        with archive.open(path) as raw, gzip.GzipFile(fileobj=raw) as decompressed:
            with tarfile.open(fileobj=decompressed, mode="r|") as archive_tar:
                for member in archive_tar:
                    name = member.name[2:] if member.name.startswith("./") else member.name
                    if member.isdir():
                        if name not in ("", "."):
                            safe_path(name.rstrip("/"))
                    else:
                        name = safe_path(name)
                        require(member.isfile() and not member.issparse(), "Memory archive contains a link or special file")
                        record = archive.db.execute("SELECT size,sha,seen FROM memory_files WHERE path=?", (name,)).fetchone()
                        require(record is not None and record[0] == member.size and record[2] == 0,
                                "Memory file is unlisted, duplicated, or has the wrong size: " + name)
                        digest, written = hashlib.sha256(), 0
                        content = archive_tar.extractfile(member)
                        require(content is not None, "Memory file has no readable data")
                        with content, create_file(output, "memory/" + parts[1] + "/" + name) as destination:
                            while True:
                                chunk = content.read(CHUNK)
                                if not chunk:
                                    break
                                written += len(chunk)
                                digest.update(chunk)
                                destination.write(chunk)
                        require(written == record[0] and digest.hexdigest() == record[1], "Memory file SHA-256 mismatch: " + name)
                        archive.db.execute("UPDATE memory_files SET seen=1 WHERE path=?", (name,))
                    archive_tar.members.clear()
            while decompressed.read(CHUNK):
                pass
        require(archive.db.execute("SELECT COUNT(*) FROM memory_files WHERE seen=0").fetchone()[0] == 0,
                "Memory archive is missing files from its manifest")
        archive.db.commit()
    archive.db.execute("DROP TABLE memory_files")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", help="Original Okou export ZIP")
    parser.add_argument("output", help="New output directory; must not already exist")
    arguments = parser.parse_args()
    archive_path = Path(arguments.archive).resolve(strict=True)
    output = Path(arguments.output).absolute()
    require(not output.exists() and not output.is_symlink(), "Output directory already exists")
    require(output.parent.is_dir(), "Output parent directory does not exist")
    with tempfile.TemporaryDirectory(prefix=".okou-restore-", dir=output.parent) as temporary:
        temporary = Path(temporary)
        with sqlite3.connect(temporary / "index.sqlite") as db:
            db.execute("PRAGMA cache_size=-8192")
            db.execute("PRAGMA temp_store=FILE")
            archive = Archive(archive_path, db)
            manifest = verify_archive(archive)
            restored = temporary / "restored"
            restored.mkdir()
            restore_threads(archive, restored)
            restore_instructions(archive, restored, "agents")
            restore_instructions(archive, restored, "workflows")
            restore_memory(archive, restored)
            with create_file(restored, "export-manifest.json") as destination:
                write_json_line(destination, manifest)
            require(not output.exists() and not output.is_symlink(), "Output directory appeared during restore")
            os.rename(restored, output)
    print("Verified and restored export to " + str(output))


if __name__ == "__main__":
    try:
        main()
    except (OSError, EOFError, ValueError, KeyError, TypeError, sqlite3.Error, tarfile.TarError) as error:
        raise SystemExit("Restore failed: " + str(error))
`;

export const USER_EXPORT_RESTORE_README = `# Restore readable export files

Keep the original ZIP. Extract restore.py next to it, then run:

    python3 restore.py okou-data-export.zip restored-export

Python 3.9 or newer is sufficient; no packages or network access are needed.
The output directory must not already exist. The tool verifies the manifest
pages, each source file's SHA-256 and byte length, and ZIP CRC32 checksums before
restoring any content. Temporary files are removed if verification fails.

The output contains chat-threads.jsonl, chat-messages/<threadId>.jsonl,
agents.jsonl, workflows.jsonl, and memory/<orgId>/<originalPath>. Chat events
preserve their IDs, sequence numbers, payloads and control/revocation records.
The final per-thread index selects the current snapshot and its captured upper
sequence bound; earlier snapshot copies and overlapping tail rows are excluded.
Sequence gaps are valid. This is a collection over time, not one account-wide
point-in-time snapshot.

Large snapshots and memory archives are processed as streams. Temporary SQLite
tables hold the inventory and message sorting/deduplication state on disk.
Allow free disk space for the restored files plus temporary message data. One
JSON record may occupy up to 64 MiB; a larger record fails explicitly. Memory
files retain their original binary bytes and are checked against the memory
manifest. Unsafe paths, links, special files, duplicates and missing sources
cause the restore to fail; existing files are never deliberately overwritten.

The tool reads the original uncompressed ZIP produced by Okou. Recompressing or
editing that ZIP can invalidate its checksums or its supported format. Checksums
detect damaged or mismatched data; they are not a cryptographic signature.
`;
