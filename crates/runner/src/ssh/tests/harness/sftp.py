"""Independent filesystem-backed SFTP v3 test peer, not a production client.

The pinned Rust CI image already provides Python's standard library. Normal
interoperability is also checked explicitly against OpenSSH's real server.
"""

import errno
import os
import struct
import sys

mode = sys.argv[1]
handles = {}
serial = 0


def integer(value):
    return struct.pack(">I", value)


def string(value):
    if isinstance(value, str):
        value = os.fsencode(value)
    return integer(len(value)) + value


def attrs(value):
    return integer(13) + struct.pack(">QIII", value.st_size, value.st_mode,
                                     int(value.st_atime), int(value.st_mtime))


def send(kind, body):
    packet = bytes([kind]) + body
    sys.stdout.buffer.write(integer(len(packet)) + packet)
    sys.stdout.buffer.flush()


def status(request, code):
    send(101, integer(request) + integer(code) + string("peer diagnostic canary") + string("en"))


class Fields:
    def __init__(self, data):
        self.data = data

    def take(self, count):
        assert count <= len(self.data)
        result, self.data = self.data[:count], self.data[count:]
        return result

    def number(self):
        return struct.unpack(">I", self.take(4))[0]

    def string(self):
        return self.take(self.number())

    def offset(self):
        return struct.unpack(">Q", self.take(8))[0]


while True:
    header = sys.stdin.buffer.read(4)
    if not header:
        break
    length = struct.unpack(">I", header)[0]
    assert 0 < length <= 65536
    fields = Fields(sys.stdin.buffer.read(length))
    kind = fields.take(1)[0]
    request = fields.number()
    if kind == 1:
        assert request == 3
        if mode == "oversized":
            sys.stdout.buffer.write(integer(0xffffffff))
            sys.stdout.buffer.flush()
            continue
        extensions = b"" if mode == "unsupported" else (
            string("hardlink@openssh.com") + string("1") +
            string("posix-rename@openssh.com") + string("1"))
        send(2, integer(3) + extensions)
        continue
    if mode == "mismatched":
        status(request + 1, 0)
        continue
    if mode == "denied":
        status(request, 3)
        continue
    try:
        if kind == 16:
            path = os.path.realpath(fields.string(), strict=True)
            send(104, integer(request) + integer(1) + string(path) + string(path) + attrs(os.stat(path)))
        elif kind == 7:
            send(105, integer(request) + attrs(os.lstat(fields.string())))
        elif kind == 8:
            send(105, integer(request) + attrs(os.fstat(handles[fields.string()])))
        elif kind == 3:
            path, flags = fields.string(), fields.number()
            assert fields.number() == 4
            permissions = fields.number()
            serial += 1
            # Handles are opaque bytes, deliberately invalid UTF-8.
            handle = b"\xff\0" + integer(serial)
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL if flags & 8 else os.O_RDONLY, permissions)
            handles[handle] = fd
            send(102, integer(request) + string(handle))
        elif kind == 4:
            os.close(handles.pop(fields.string()))
            status(request, 0)
        elif kind == 5:
            fd, offset, size = handles[fields.string()], fields.offset(), fields.number()
            value = os.pread(fd, size, offset)
            if value:
                send(103, integer(request) + string(value))
                if mode == "mutate":
                    os.utime(fd, (1, 1))
            else:
                status(request, 1)
        elif kind == 6:
            fd, offset, value = handles[fields.string()], fields.offset(), fields.string()
            assert os.pwrite(fd, value, offset) == len(value)
            status(request, 0)
        elif kind == 14:
            path = fields.string()
            assert fields.number() == 4
            os.mkdir(path, fields.number())
            if mode == "lost-create":
                break
            status(request, 0)
        elif kind in (13, 15):
            if mode == "cleanup-denied":
                status(request, 3)
            else:
                (os.unlink if kind == 13 else os.rmdir)(fields.string())
                status(request, 0)
        elif kind == 200:
            extension, source, target = fields.string(), fields.string(), fields.string()
            if extension == b"hardlink@openssh.com":
                os.link(source, target)
            else:
                assert extension == b"posix-rename@openssh.com"
                os.replace(source, target)
            if mode == "lost-publish":
                break
            status(request, 0)
        else:
            status(request, 8)
    except OSError as error:
        status(request, {errno.ENOENT: 2, errno.EACCES: 3, errno.EPERM: 3}.get(error.errno, 4))
