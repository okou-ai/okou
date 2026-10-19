#!/usr/bin/env python3
"""Render bounded, sanitized local SSH/proxy evidence; never perform network IO."""

import hashlib
import ipaddress
import json
import os
import re
import stat
import sys
from pathlib import Path
from urllib.parse import urlsplit

MAX_BYTES = 64 * 1024
MAX_LINES = 384
MAX_PROXIES = 4
TCP_NUMBERS = {
    "monotonic_ns",
    "pid",
    "start_ticks",
    "inode",
    "family",
    "state",
    "local_port",
    "peer_port",
    "receive_queue",
    "send_queue",
    "unacked",
    "rto_us",
    "last_data_sent_ms",
    "last_data_received_ms",
    "rtt_us",
    "rttvar_us",
    "total_retrans",
    "bytes_acked",
    "bytes_received",
    "bytes_sent",
    "bytes_retrans",
    "send_window",
}
TCP_EVENTS = {"tcp-sample", "tcp-no-socket-observed", "tcp-unavailable"}
HEADER = re.compile(
    r"(?im)\b(?:cf-access-client-(?:id|secret)|cf-access-token|"
    r"cf-access-jwt-assertion|authorization|proxy-authorization|cookie|set-cookie)"
    r"\s*:\s*[^\r\n]*"
)
ASSIGNMENT = re.compile(
    r"\b((?:CF_ACCESS_CLIENT_(?:ID|SECRET)|TUNNEL_SERVICE_TOKEN_(?:ID|SECRET)|"
    r"R2_(?:ACCOUNT_ID|ACCESS_KEY_ID|SECRET_ACCESS_KEY))=)"
    r"(?:\"[^\"]*\"|'[^']*'|\S+)",
    re.IGNORECASE,
)
REMOTE_COMMAND = re.compile(r"(?m)(\bdebug[123]: Sending command:)[^\r\n]*")
ARGUMENT = re.compile(r"(--(?:secret|id)(?:=|\s+))\S+")
QUERY_SECRET = re.compile(
    r"(?i)([?&](?:access_token|token|client_secret|secret|password|authorization)=)"
    r"[^&#\s]+"
)
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


def sanitize(line):
    """Native request dumps are discarded, not heuristically partially redacted."""
    if line.lstrip().startswith(("{", "[")):
        try:
            record = json.loads(line)
        except (ValueError, RecursionError):
            return "[omitted malformed structured diagnostic]"
        if not isinstance(record, dict):
            return "[omitted non-event structured diagnostic]"
        extra = {}
        if isinstance(record.get("event"), str) and record["event"] in TCP_EVENTS:
            extra["event"] = record["event"]
            for key in TCP_NUMBERS:
                value = record.get(key)
                if type(value) is int and value >= 0:
                    extra[key] = value
            for key in ("local_ip", "peer_ip"):
                try:
                    if isinstance(record.get(key), str):
                        extra[key] = str(ipaddress.ip_address(record[key]))
                except ValueError:
                    # Invalid optional address metadata is omitted at publication.
                    pass
            reason = record.get("reason")
            if isinstance(reason, str) and re.fullmatch(r"[A-Z_]{1,32}", reason):
                extra["reason"] = reason
        if isinstance(record.get("originURL"), str):
            try:
                host = urlsplit(record["originURL"]).hostname
                if host and re.fullmatch(r"[A-Za-z0-9._:-]{1,253}", host):
                    extra["origin_host"] = host
            except ValueError:
                # Malformed optional URLs cannot contribute a safe origin hostname.
                pass
        record = {
            key: value
            for key, value in record.items()
            if key in {"time", "level", "message", "error"}
            and isinstance(value, (str, int, float, bool))
        }
        if "Websocket request:" in str(record.get("message", "")):
            record["message"] = "[request dump omitted]"
        # Decode embedded newlines before redacting header values.
        record = {key: redact(str(value)) for key, value in record.items()}
        record.update(extra)
        return json.dumps(record, ensure_ascii=True, separators=(",", ":"))
    if "Websocket request:" in line:
        return "[request dump omitted]"
    return redact(line)


def redact(text):
    text = ANSI.sub("", text)
    # Native SSH command logs contain arbitrary caller credentials, including
    # Ansible's sudo environment. Keep transport evidence, not command payloads.
    text = REMOTE_COMMAND.sub(r"\1 [remote command omitted]", text)
    text = ASSIGNMENT.sub(r"\1[redacted]", text)
    text = ARGUMENT.sub(r"\1[redacted]", text)
    text = HEADER.sub(lambda m: m.group().split(":", 1)[0] + ": [redacted]", text)
    text = QUERY_SECRET.sub(r"\1[redacted]", text)
    text = re.sub(r"(?i)(https?://)[^\s/@]+@", r"\1[redacted]@", text)
    text = re.sub(r"(?m)^::[^\r\n]*?::", "", text)
    return "".join(c if c >= " " or c in "\n\t" else "?" for c in text)


def tail(path, limit=MAX_LINES):
    """Read regular files without following symlinks, with a byte and line cap."""
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, "rb") as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode):
                return ["[diagnostic is not a regular file]"]
            offset = max(0, info.st_size - MAX_BYTES)
            source.seek(offset)
            raw = source.read(MAX_BYTES)
        if offset:
            # A partial JSON/header record must never be treated as plain text.
            raw = raw.partition(b"\n")[2]
        lines = raw.decode("utf-8", errors="replace").splitlines()
        if not lines:
            return ["[diagnostic empty or partial record omitted]"]
        result = [sanitize(line) for line in lines[-limit:]]
        if offset or len(lines) > limit:
            result.insert(0, "[earlier diagnostic content truncated]")
        return result
    except OSError:
        return ["[diagnostic unavailable or unsafe path]"]


def directories(path):
    try:
        if path.is_symlink():
            return []
        with os.scandir(path) as entries:
            candidates = [
                (entry.stat(follow_symlinks=False).st_mtime_ns, Path(entry.path))
                for entry in entries
                if entry.name.startswith("proxy.")
                and entry.is_dir(follow_symlinks=False)
            ]
        return [p for _, p in sorted(candidates, reverse=True)]
    except OSError:
        return []


def bounded(lines, byte_limit, line_limit):
    """Reserve each source's own budget, retaining its newest sanitized evidence."""
    result = []
    used = 0
    omitted = len(lines) > line_limit
    for line in reversed(lines[-line_limit:]):
        encoded = line.encode("utf-8")
        if len(encoded) > byte_limit - 128:
            encoded = encoded[-(byte_limit - 128) :]
            line = "[record truncated] " + encoded.decode("utf-8", "ignore")
        size = len(line.encode("utf-8")) + 1
        if used + size > byte_limit - 80:
            omitted = True
            break
        result.append(line)
        used += size
    if omitted:
        result.append("[earlier source evidence omitted: section budget]")
    return list(reversed(result))


def proxy_evidence(directory):
    result = [f"----- Cloudflare proxy {directory.name} (source event times) -----"]
    result += bounded(
        ["lifecycle: " + line for line in tail(directory / "events.log", 12)], 2048, 14
    )
    application_lines = []
    application = directory / "application"
    try:
        if application.is_symlink():
            raise OSError("unsafe application log directory")
        files = sorted(
            (p for p in application.glob("cloudflared*.log") if not p.is_symlink()),
            key=lambda p: p.stat().st_mtime_ns,
            reverse=True,
        )
        for path in reversed(files[:2]):
            application_lines += ["application: " + line for line in tail(path, 12)]
        if not files:
            application_lines.append("application: [native log unavailable]")
        if len(files) > 2:
            application_lines.insert(0, "application: [older rotated files omitted]")
    except OSError:
        application_lines.append("application: [native log unavailable or unsafe path]")
    result += bounded(application_lines, 4096, 28)
    result += bounded(
        ["tcp: " + line for line in tail(directory / "tcp.log", 16)], 4096, 18
    )
    result += bounded(
        ["stderr: " + line for line in tail(directory / "stderr.log", 8)], 1024, 10
    )
    if not any("event=proxy-exit " in line for line in result):
        result.append("lifecycle: [no final proxy status observed in this snapshot]")
    return result


def publish(lines):
    truncated = len(lines) > MAX_LINES
    text = "\n".join(lines[:MAX_LINES])
    encoded = text.encode("utf-8")
    if len(encoded) > MAX_BYTES - 80:
        encoded = encoded[: MAX_BYTES - 80]
        truncated = True
    text = encoded.decode("utf-8", errors="ignore")
    if truncated:
        text += "\n[diagnostic output truncated: 384 lines / 64 KiB limit]"
    print(text)


def main():
    mode, argument = sys.argv[1:]
    if mode == "sanitize":
        if argument == "-":
            raw = sys.stdin.buffer.read(MAX_BYTES)
            publish(
                [sanitize(line) for line in raw.decode("utf-8", "replace").splitlines()]
            )
        else:
            publish(tail(Path(argument)))
        return
    if mode == "proxy":
        publish(proxy_evidence(Path(argument)))
        return
    if mode != "master":
        raise ValueError("expected sanitize, proxy, or master")
    master = Path(argument)
    master_id = hashlib.sha256(argument.encode()).hexdigest()[:24]
    proxies = directories(Path(argument + ".proxies"))
    lines = []
    for directory in proxies[:MAX_PROXIES]:
        lines += proxy_evidence(directory)
    if len(proxies) > MAX_PROXIES:
        lines.append("[older proxy instances omitted]")
    if not proxies:
        lines.append("Cloudflare proxy evidence unavailable for this master.")
    lines.append(
        f"----- SSH master stderr (master={master_id}; including probes; bounded redacted tail) -----"
    )
    lines += bounded(tail(master, 45), 12288, 47)
    publish(lines)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError):
        print("SSH diagnostics unavailable; no raw evidence was published.")
