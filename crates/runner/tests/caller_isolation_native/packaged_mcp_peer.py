"""Benign JSON-RPC peer for the disposable Guest's actual MCP clients."""

import json
import os
import socket
import sys
import traceback
from pathlib import Path


def serve(tag):
    if tag not in {"claude-direct", "claude-lowered", "codex-direct", "codex-lowered"}:
        raise ValueError("unknown owned MCP case")
    root = Path("/home/user/workspace")
    identity = {
        "uid": os.getuid(),
        "context": Path("/proc/self/attr/current").read_text().rstrip("\0"),
        "cgroup": Path("/proc/self/cgroup").read_text().strip(),
        "initialized": False,
        "capEff": next(
            line.split()[1]
            for line in Path("/proc/self/status").read_text().splitlines()
            if line.startswith("CapEff:")
        ),
    }
    with socket.socket() as peer:
        peer.settimeout(3)
        try:
            peer.connect(("127.0.0.1", 18080))
        except OSError as error:
            identity["connectErrno"] = error.errno
        else:
            identity["connectErrno"] = 0
            peer.sendall(f"GET /mcp-{tag} HTTP/1.0\r\nHost: fixture\r\n\r\n".encode())
            peer.recv(1024)
    path = root / f"mcp-{tag}.json"

    def publish():
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(identity))
        temporary.replace(path)

    publish()
    for line in sys.stdin:
        request = json.loads(line)
        method = request.get("method")
        if method == "initialize":
            result = {
                "protocolVersion": request["params"]["protocolVersion"],
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "owned-native-probe", "version": "1"},
            }
        elif method == "tools/list":
            result = {"tools": []}
        elif method == "ping":
            result = {}
        elif method == "notifications/initialized":
            identity["initialized"] = True
            publish()
            continue
        elif "id" not in request:
            continue
        else:
            print(
                json.dumps(
                    {
                        "jsonrpc": "2.0",
                        "id": request["id"],
                        "error": {"code": -32601, "message": "Method not found"},
                    }
                ),
                flush=True,
            )
            continue
        print(
            json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}),
            flush=True,
        )


if __name__ == "__main__":
    try:
        serve(sys.argv[1])
    except Exception:
        Path("/home/user/workspace/mcp-" + sys.argv[1] + ".error").write_text(
            traceback.format_exc()
        )
        raise
