#!/usr/bin/env python3
"""Sample one child PID's Linux TCP metadata, never payloads or external probes.

Usage: cloudflare-ssh-tcp.py PID OUTPUT. Requires Python 3, procfs and Linux
inet-diag. Optional evidence failures are recorded, not returned to the transport.
The proxy owns termination. OUTPUT retains at most 16 records in a private file.
"""

import collections
import datetime
import errno
import itertools
import json
import os
import socket
import struct
import sys
import time
from pathlib import Path

INTERVAL = 1.0
MAX_SOCKETS = 4
MAX_DUMP_BYTES = 1024 * 1024
NETLINK_SOCK_DIAG = 4
SOCK_DIAG_BY_FAMILY = 20
NLM_F_REQUEST_DUMP = 0x301
NLM_F_DUMP_INTR = 0x10
NLMSG_ERROR = 2
NLMSG_DONE = 3
INET_DIAG_INFO = 2
TCP_FIELDS = {
    "rto_us": ("I", 8),
    "unacked": ("I", 24),
    "last_data_sent_ms": ("I", 44),
    "last_data_received_ms": ("I", 52),
    "rtt_us": ("I", 68),
    "rttvar_us": ("I", 72),
    "total_retrans": ("I", 100),
    "bytes_acked": ("Q", 120),
    "bytes_received": ("Q", 128),
    "bytes_sent": ("Q", 200),
    "bytes_retrans": ("Q", 208),
    "send_window": ("I", 228),
}


def start_ticks(pid):
    # comm may contain spaces and parentheses; starttime is field 22 after it.
    text = Path(f"/proc/{pid}/stat").read_text()
    return int(text[text.rindex(")") + 2 :].split()[19])


def socket_inodes(pid):
    result = set()
    # scandir streams entries; Path.iterdir can materialize the entire table
    # before the observation cap is applied on supported Python versions.
    with os.scandir(f"/proc/{pid}/fd") as entries:
        for entry in itertools.islice(entries, 1024):
            try:
                target = os.readlink(entry.path)
            except FileNotFoundError:
                continue  # A closing descriptor is an ordinary sampling race.
            if target.startswith("socket:[") and target.endswith("]"):
                result.add(int(target[8:-1]))
        if next(entries, None) is not None:
            raise OSError(errno.EOVERFLOW, "descriptor observation limit")
    if len(result) > MAX_SOCKETS:
        raise OSError(errno.EOVERFLOW, "socket observation limit")
    return result


def attributes(data):
    offset = 72  # Linux UAPI struct inet_diag_msg.
    while offset + 4 <= len(data):
        size, kind = struct.unpack_from("=HH", data, offset)
        if size < 4 or offset + size > len(data):
            raise OSError(errno.EPROTO, "incomplete inet-diag attribute")
        yield kind, data[offset + 4 : offset + size]
        offset += (size + 3) & ~3


def tcp_record(data):
    family = data[0]
    address_size = 4 if family == socket.AF_INET else 16
    source_port, peer_port = struct.unpack_from("!HH", data, 4)
    record = {
        "inode": struct.unpack_from("=I", data, 68)[0],
        "family": family,
        "state": data[1],
        "local_ip": socket.inet_ntop(family, data[8 : 8 + address_size]),
        "local_port": source_port,
        "peer_ip": socket.inet_ntop(family, data[24 : 24 + address_size]),
        "peer_port": peer_port,
        "receive_queue": struct.unpack_from("=I", data, 56)[0],
        "send_queue": struct.unpack_from("=I", data, 60)[0],
    }
    for kind, info in attributes(data):
        if kind != INET_DIAG_INFO:  # Contains Linux UAPI struct tcp_info.
            continue
        for name, (format_, offset) in TCP_FIELDS.items():
            if len(info) >= offset + struct.calcsize(format_):
                record[name] = struct.unpack_from("=" + format_, info, offset)[0]
    return record


def tcp_snapshot(inodes):
    """Read native-endian UAPI messages, publishing only matching child inodes."""
    deadline = time.monotonic() + 0.5
    received = 0
    with socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, NETLINK_SOCK_DIAG) as diag:
        for sequence, family in enumerate((socket.AF_INET, socket.AF_INET6), 1):
            request = struct.pack(
                "=BBBBI",
                family,
                socket.IPPROTO_TCP,
                1 << (INET_DIAG_INFO - 1),
                0,
                0xFFFFFFFF,
            )
            request += bytes(40) + struct.pack("=II", 0xFFFFFFFF, 0xFFFFFFFF)
            diag.send(
                struct.pack(
                    "=IHHII",
                    16 + len(request),
                    SOCK_DIAG_BY_FAMILY,
                    NLM_F_REQUEST_DUMP,
                    sequence,
                    0,
                )
                + request
            )
            done = False
            while not done:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or received >= MAX_DUMP_BYTES:
                    raise OSError(errno.EOVERFLOW, "inet-diag observation limit")
                diag.settimeout(remaining)
                block, _, flags, sender = diag.recvmsg(65536)
                received += len(block)
                if sender[0] != 0:
                    raise OSError(errno.EPROTO, "non-kernel inet-diag response")
                if flags & socket.MSG_TRUNC:
                    raise OSError(errno.EOVERFLOW, "truncated inet-diag response")
                position = 0
                while position + 16 <= len(block):
                    size, kind, flags, seq, _ = struct.unpack_from(
                        "=IHHII", block, position
                    )
                    if size < 16 or position + size > len(block):
                        raise OSError(errno.EPROTO, "incomplete inet-diag message")
                    data = block[position + 16 : position + size]
                    position += (size + 3) & ~3
                    if seq != sequence:
                        continue
                    if kind == NLMSG_ERROR:
                        if len(data) < 4:
                            raise OSError(errno.EPROTO, "incomplete inet-diag status")
                        code = struct.unpack_from("=i", data)[0]
                        if code:
                            raise OSError(-code, "inet-diag query rejected")
                    elif kind == NLMSG_DONE:
                        # NLM_F_DUMP_INTR or a failing terminal dump status must
                        # remain an explicit gap after any already-yielded data.
                        if flags & NLM_F_DUMP_INTR:
                            raise OSError(errno.EINTR, "interrupted inet-diag dump")
                        if len(data) >= 4 and struct.unpack_from("=i", data)[0]:
                            raise OSError(errno.EIO, "failed inet-diag dump")
                        done = True
                    elif kind == SOCK_DIAG_BY_FAMILY and len(data) >= 72:
                        if struct.unpack_from("=I", data, 68)[0] in inodes:
                            yield tcp_record(data)


def write_history(path, history):
    temporary = path.with_name(path.name + ".pending")
    descriptor = os.open(
        temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600
    )
    with os.fdopen(descriptor, "w") as output:
        for record in history:
            output.write(json.dumps(record, separators=(",", ":")) + "\n")
    os.replace(temporary, path)


def monitor(pid, path):
    history = collections.deque(maxlen=16)
    identity = start_ticks(pid)
    while True:
        started = time.monotonic()
        context = {
            "time": datetime.datetime.now(datetime.UTC).isoformat(),
            "monotonic_ns": time.monotonic_ns(),
            "pid": pid,
            "start_ticks": identity,
        }
        try:
            if start_ticks(pid) != identity:
                return
            inodes = socket_inodes(pid)
            records = tcp_snapshot(inodes) if inodes else ()
            observed = 0
            for record in records:
                # Recheck both PID generation and current descriptor ownership;
                # a closed socket inode can be reused before the dump completes.
                owned = socket_inodes(pid)
                if start_ticks(pid) != identity:
                    return
                if record["inode"] not in owned:
                    continue
                observed += 1
                if observed > MAX_SOCKETS:
                    raise OSError(errno.EOVERFLOW, "socket observation limit")
                history.append({**context, "event": "tcp-sample", **record})
            if not observed:
                history.append({**context, "event": "tcp-no-socket-observed"})
        except FileNotFoundError:
            return
        except (OSError, ValueError, AttributeError, struct.error) as error:
            code = errno.errorcode.get(getattr(error, "errno", None), "UNAVAILABLE")
            if isinstance(error, TimeoutError):
                code = "ETIMEDOUT"
            history.append({**context, "event": "tcp-unavailable", "reason": code})
        write_history(path, history)
        time.sleep(max(0, INTERVAL - (time.monotonic() - started)))


if __name__ == "__main__":
    try:
        monitor(int(sys.argv[1]), Path(sys.argv[2]))
    except (OSError, ValueError, IndexError):
        # This process is optional evidence; the proxy publishes missing files.
        sys.exit(0)
