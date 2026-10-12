#!/usr/bin/env python3
"""Synthetic, private-pipe MIT acceptor for authenticated RFC4752 hostile controls.

Not a production backend, QEMU replacement or cryptographic implementation.
Requires the exact Ubuntu MIT1.20.1 fixture library and generated server keytab.
No token, key, native diagnostic cause or credential is written to stderr/logs.
"""
import argparse
import ctypes as C
import pathlib
import struct
import sys


class Buffer(C.Structure):
    _fields_ = [("length", C.c_size_t), ("value", C.c_void_p)]


class Oid(C.Structure):
    _fields_ = [("length", C.c_uint), ("elements", C.c_void_p)]


class OidSet(C.Structure):
    _fields_ = [("count", C.c_size_t), ("elements", C.POINTER(Oid))]


def exact(size):
    result = sys.stdin.buffer.read(size)
    if len(result) != size:
        raise RuntimeError("private peer input incomplete")
    return result


def read_frame():
    size = struct.unpack("!I", exact(4))[0]
    if not 1 <= size <= 16384:
        raise RuntimeError("private peer frame refused")
    return exact(size)


def write_frame(value):
    if not 1 <= len(value) <= 16384:
        raise RuntimeError("private peer output refused")
    sys.stdout.buffer.write(struct.pack("!I", len(value)) + value)
    sys.stdout.buffer.flush()


class Acceptor:
    def __init__(self):
        # This EXACT test-only library version is checked by the outer harness.
        self.lib = C.CDLL("libgssapi_krb5.so.2")
        self.name, self.credential, self.context = C.c_void_p(), C.c_void_p(), C.c_void_p()
        signatures = {
            "gss_import_name": [C.POINTER(C.c_uint), C.POINTER(Buffer), C.POINTER(Oid), C.POINTER(C.c_void_p)],
            "gss_acquire_cred": [C.POINTER(C.c_uint), C.c_void_p, C.c_uint, C.POINTER(OidSet), C.c_int, C.POINTER(C.c_void_p), C.c_void_p, C.POINTER(C.c_uint)],
            "gss_accept_sec_context": [C.POINTER(C.c_uint), C.POINTER(C.c_void_p), C.c_void_p, C.POINTER(Buffer), C.c_void_p, C.POINTER(C.c_void_p), C.POINTER(C.POINTER(Oid)), C.POINTER(Buffer), C.POINTER(C.c_uint), C.POINTER(C.c_uint), C.c_void_p],
            "gss_wrap": [C.POINTER(C.c_uint), C.c_void_p, C.c_int, C.c_uint, C.POINTER(Buffer), C.POINTER(C.c_int), C.POINTER(Buffer)],
            "gss_unwrap": [C.POINTER(C.c_uint), C.c_void_p, C.POINTER(Buffer), C.POINTER(Buffer), C.POINTER(C.c_int), C.POINTER(C.c_uint)],
            "gss_release_buffer": [C.POINTER(C.c_uint), C.POINTER(Buffer)],
            "gss_release_name": [C.POINTER(C.c_uint), C.POINTER(C.c_void_p)],
            "gss_release_cred": [C.POINTER(C.c_uint), C.POINTER(C.c_void_p)],
            "gss_delete_sec_context": [C.POINTER(C.c_uint), C.POINTER(C.c_void_p), C.c_void_p],
        }
        for name, arguments in signatures.items():
            function = getattr(self.lib, name)
            function.argtypes, function.restype = arguments, C.c_uint
        self.oid_bytes = C.create_string_buffer(b"\x2a\x86\x48\x86\xf7\x12\x01\x02\x02")
        self.oid = Oid(9, C.cast(self.oid_bytes, C.c_void_p))
        self.oid_set = OidSet(1, C.pointer(self.oid))
    def prepare(self, root):
        text = ("vnc/" + (root / "hostname").read_text() + "@" + (root / "realm").read_text()).encode()
        raw, buffer = self.input_buffer(text)
        minor, life = C.c_uint(), C.c_uint()
        # The explicit MIT principal syntax is produced by the fixture, not user input.
        name_type = C.POINTER(Oid).in_dll(self.lib, "GSS_KRB5_NT_PRINCIPAL_NAME")
        self.check(self.lib.gss_import_name(C.byref(minor), C.byref(buffer), name_type, C.byref(self.name)))
        self.check(self.lib.gss_acquire_cred(C.byref(minor), self.name, 0, C.byref(self.oid_set), 2, C.byref(self.credential), None, C.byref(life)))
        del raw

    @staticmethod
    def check(major):
        if major != 0:
            raise RuntimeError("controlled MIT operation refused")

    @staticmethod
    def input_buffer(value):
        raw = C.create_string_buffer(value)
        return raw, Buffer(len(value), C.cast(raw, C.c_void_p))

    def release(self, buffer):
        if buffer.value:
            C.memset(buffer.value, 0, buffer.length)
            minor = C.c_uint()
            self.lib.gss_release_buffer(C.byref(minor), C.byref(buffer))

    def accept(self, value):
        raw, token = self.input_buffer(value)
        minor, output, flags, life = C.c_uint(), Buffer(), C.c_uint(), C.c_uint()
        peer, mechanism = C.c_void_p(), C.POINTER(Oid)()
        try:
            self.check(self.lib.gss_accept_sec_context(C.byref(minor), C.byref(self.context), self.credential, C.byref(token), None, C.byref(peer), C.byref(mechanism), C.byref(output), C.byref(flags), C.byref(life), None))
            if not mechanism or mechanism.contents.length != 9 or C.string_at(mechanism.contents.elements, 9) != self.oid_bytes.raw[:9]:
                raise RuntimeError("controlled MIT mechanism refused")
            if flags.value & 46 != 46 or flags.value & (1 | 64 | 32768) or not life.value or life.value == 0xffffffff:
                raise RuntimeError("controlled MIT context refused")
            if not 1 <= output.length <= 16384:
                raise RuntimeError("controlled MIT AP-REP refused")
            return C.string_at(output.value, output.length)
        finally:
            C.memset(raw, 0, len(value))
            self.release(output)
            if peer.value:
                self.lib.gss_release_name(C.byref(minor), C.byref(peer))

    def wrap(self, value, confidential=False):
        raw, plain = self.input_buffer(value)
        minor, output, conf = C.c_uint(), Buffer(), C.c_int()
        try:
            self.check(self.lib.gss_wrap(C.byref(minor), self.context, int(confidential), 0, C.byref(plain), C.byref(conf), C.byref(output)))
            if bool(conf.value) != confidential or not 1 <= output.length <= 16384:
                raise RuntimeError("controlled MIT wrap refused")
            return C.string_at(output.value, output.length)
        finally:
            C.memset(raw, 0, len(value))
            self.release(output)

    def verify_selection(self, value):
        raw, token = self.input_buffer(value)
        minor, plain, conf, qop = C.c_uint(), Buffer(), C.c_int(), C.c_uint()
        try:
            self.check(self.lib.gss_unwrap(C.byref(minor), self.context, C.byref(token), C.byref(plain), C.byref(conf), C.byref(qop)))
            if conf.value or qop.value or plain.length != 4 or C.string_at(plain.value, 4) != b"\x01\0\0\0":
                raise RuntimeError("controlled MIT selection refused")
        finally:
            C.memset(raw, 0, len(value))
            self.release(plain)

    def close(self):
        minor = C.c_uint()
        if self.context.value:
            self.lib.gss_delete_sec_context(C.byref(minor), C.byref(self.context), None)
        if self.credential.value:
            self.lib.gss_release_cred(C.byref(minor), C.byref(self.credential))
        if self.name.value:
            self.lib.gss_release_name(C.byref(minor), C.byref(self.name))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", type=pathlib.Path, required=True)
    parser.add_argument("--mode", choices=["valid", "bad_ap_rep", "bad_mic", "confidential", "no_no_layer", "unknown_layer", "nonzero_maxbuf", "short_offer", "long_offer", "sequence_gap"], required=True)
    args = parser.parse_args()
    acceptor = Acceptor()
    try:
        acceptor.prepare(args.fixture)
        reply = acceptor.accept(read_frame())
        if args.mode == "bad_ap_rep":
            reply = reply[:-1] + bytes([reply[-1] ^ 1])
        write_frame(reply)
        # A nonsecret synchronization byte distinguishes native AP-REP completion
        # from this controlled acceptor's independently protected layer offer.
        if exact(1) != b"\x01":
            raise RuntimeError("controlled MIT completion refused")
        plain = {"no_no_layer": b"\x02\0\0\0", "unknown_layer": b"\x09\0\0\0", "nonzero_maxbuf": b"\x01\0\0\1", "short_offer": b"\x01\0\0", "long_offer": b"\x01\0\0\0\0"}.get(args.mode, b"\x01\0\0\0")
        if args.mode == "sequence_gap":
            acceptor.wrap(plain)  # Deliberately consume the authenticated seq0.
        offer = acceptor.wrap(plain, confidential=args.mode == "confidential")
        if args.mode == "bad_mic":
            offer = offer[:-1] + bytes([offer[-1] ^ 1])
        write_frame(offer)
        acceptor.verify_selection(read_frame())
        write_frame(b"\x01")
    finally:
        acceptor.close()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.exit(1)  # No native causes or fixture credential content.
