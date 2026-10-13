"""Deterministic acceptance against shipped Codex, a synthetic provider, and Guest.

No provider credentials or user sessions are used. Build the Guest driver with:
  cargo build --manifest-path crates/Cargo.toml --profile local -p guest-agent \
    --example codex_citation_probe
Then run this script with --codex and --guest-probe executable paths.
"""

import argparse
import ctypes
import ctypes.util
import http.server
import json
import os
import pathlib
import queue
import re
import subprocess
import tempfile
import threading

ROOT = pathlib.Path(__file__).resolve().parents[1]
PARSER = ROOT / "crates/guest-agent/src/cli/pi_memory_citation.rs"
OPEN = json.loads(re.search(r'const OPEN: &str = ("[^"]+")', PARSER.read_text())[1])
CLOSE = json.loads(re.search(r'const CLOSE: &str = ("[^"]+")', PARSER.read_text())[1])
PREFIX = "The implementation uses a reserved delimiter, shown here as inline code: ".ljust(113) + "`"
SUFFIX = " SENTINEL_END_OF_REPLY"
TEXT = (PREFIX + OPEN + "` marks internal transport. The explanation continues. ").ljust(872 - len(SUFFIX), "x") + SUFFIX
SAFE = TEXT.replace(OPEN, OPEN.replace("<", "&lt;").replace(">", "&gt;"))
ITEM = "msg_citation_literal_acceptance"
BASELINE = "f222eab48ae3490abd952db26ef1ff51c8074af6"


class Provider(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", 0)))
        item = {"type": "message", "id": ITEM, "role": "assistant", "phase": "final_answer",
                "status": "completed", "content": [{"type": "output_text", "text": TEXT, "annotations": []}]}
        events = [
            {"type": "response.created", "response": {"id": "resp_fixture", "status": "in_progress"}},
            {"type": "response.output_item.added", "output_index": 0, "item": {**item, "content": [], "status": "in_progress"}},
            {"type": "response.output_text.delta", "output_index": 0, "content_index": 0, "item_id": ITEM, "delta": TEXT},
            {"type": "response.output_item.done", "output_index": 0, "item": item},
            {"type": "response.completed", "response": {"id": "resp_fixture", "status": "completed", "output": [item],
             "usage": {"input_tokens": 10, "output_tokens": 20, "total_tokens": 30}}},
        ]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for event in events:
            self.wfile.write(("event: " + event["type"] + "\ndata: " + json.dumps(event) + "\n\n").encode())
            self.wfile.flush()


def protocol_run(codex, home, url, thread_id=None):
    env = {key: value for key, value in os.environ.items() if key in ["PATH", "HOME", "LANG"]}
    env["CODEX_HOME"] = str(home)
    config = '{name="Synthetic fixture",base_url=' + json.dumps(url) + ',wire_api="responses",supports_websockets=false}'
    proc = subprocess.Popen([codex, "app-server", "--stdio", "-c", 'model_provider="fixture"',
                             "-c", 'model="gpt-5.4"', "-c", "model_providers.fixture=" + config],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=env)
    inbox = queue.Queue()

    def read():
        for line in proc.stdout:
            inbox.put(json.loads(line))

    threading.Thread(target=read, daemon=True).start()

    def send(method, params, ident=None):
        value = {"method": method, "params": params}
        if ident is not None:
            value["id"] = ident
        proc.stdin.write(json.dumps(value) + "\n")
        proc.stdin.flush()

    def response(ident):
        while True:
            value = inbox.get(timeout=30)
            if value.get("id") == ident:
                assert "error" not in value, "native protocol request failed"
                return value["result"]

    try:
        send("initialize", {"clientInfo": {"name": "citation_probe", "version": "1"},
                            "capabilities": {"experimentalApi": True}}, 1)
        response(1)
        send("initialized", {})
        params = {"cwd": str(home), "approvalPolicy": "never", "sandbox": "danger-full-access",
                  "config": {"features.memories": True}, "baseInstructions": "Answer without tools."}
        if thread_id:
            params.update(threadId=thread_id, excludeTurns=True)
            method = "thread/resume"
        else:
            params["experimentalRawEvents"] = True
            method = "thread/start"
        send(method, params, 2)
        thread = response(2)["thread"]
        assert not thread_id or thread["id"] == thread_id
        send("turn/start", {"threadId": thread["id"], "input": [{"type": "text", "text": "Explain."}]}, 3)
        turn = response(3)["turn"]["id"]
        order = []
        while True:
            notification = inbox.get(timeout=30)
            method = notification.get("method")
            params = notification.get("params", {})
            item = params.get("item", {})
            if item.get("id") == ITEM and method in ["item/completed", "rawResponseItem/completed"]:
                assert params["threadId"] == thread["id"] and params["turnId"] == turn
                assert item["phase"] == "final_answer"
                if method == "item/completed":
                    assert item["type"] == "agentMessage" and item["text"] == PREFIX
                else:
                    assert item["role"] == "assistant" and item["content"][0]["text"] == TEXT
                order.append(method)
            if method == "turn/completed":
                assert params["turn"]["status"] == "completed"
                break
        expected_order = ["item/completed"] if thread_id else ["item/completed", "rawResponseItem/completed"]
        assert order == expected_order, "unexpected raw/normalized ordering"
        # Native's terminal event is the actual flush barrier, not a timer.
        path = pathlib.Path(thread["path"])
        assert path.is_relative_to(home)
        rows = [json.loads(line) for line in path.read_text().splitlines()]
        matches = [row["payload"] for row in rows if row.get("type") == "response_item"
                   and row["payload"].get("id") == ITEM
                   and row["payload"].get("internal_chat_message_metadata_passthrough", {}).get("turn_id") == turn]
        assert len(matches) == 1 and matches[0]["content"][0]["text"] == TEXT
        return thread["id"]
    finally:
        proc.stdin.close()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.terminate()
            proc.wait(timeout=5)


def guest_run(driver, codex, home, url, thread_id=None):
    args = [driver, str(home), codex, url] + ([thread_id] if thread_id else [])
    result = subprocess.run(args, capture_output=True, text=True, timeout=30, check=True)
    response = json.loads(result.stdout.splitlines()[-1])
    assert response["exitCode"] == 0 and response["visible"] == [SAFE], "Guest did not recover the complete explanation"
    assert "repair unavailable" not in result.stdout + result.stderr, "happy path used fallback"
    assert not thread_id or thread_id == response["threadId"]
    return response["threadId"]


def public_readers():
    baseline = subprocess.check_output(["git", "show", BASELINE + ":turbo/packages/api-contracts/src/contracts/pi-memory-citations.ts"], cwd=ROOT, text=True)
    # Place the temporary old module beside its dependency resolution root.
    with tempfile.NamedTemporaryFile(mode="w", suffix=".mts", prefix=".citation-old-", dir=ROOT / "turbo/packages/api-contracts") as old:
        old.write(baseline)
        old.flush()
        program = """
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { visiblePiMemoryCitationText as current } from './packages/api-contracts/src/contracts/pi-memory-citations.ts';
import { pathToFileURL } from 'node:url';
async function verify() {
  const {visiblePiMemoryCitationText: old} = await import(pathToFileURL(process.argv[1]).href);
  const safe = JSON.parse(fs.readFileSync(0, 'utf8'));
  let text = safe;
  for (let n = 0; n < 20; n++) { text = old(current(text)); assert.equal(text, safe); }
}
verify();
"""
        subprocess.run(["pnpm", "exec", "tsx", "-e", program, old.name], cwd=ROOT / "turbo",
                       input=json.dumps(SAFE), text=True, capture_output=True, check=True, timeout=30)


def compress_synthetic_rollout(home):
    # Simulate restored compressed history only inside this temporary fixture.
    paths = list(home.glob("codex/sessions/*/*/*/*.jsonl"))
    assert len(paths) == 1
    path = paths[0]
    library = ctypes.util.find_library("zstd")
    assert library, "libzstd is required for restored-history acceptance"
    zstd = ctypes.CDLL(library)
    zstd.ZSTD_compressBound.argtypes = [ctypes.c_size_t]
    zstd.ZSTD_compressBound.restype = ctypes.c_size_t
    zstd.ZSTD_compress.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int]
    zstd.ZSTD_compress.restype = ctypes.c_size_t
    zstd.ZSTD_isError.argtypes = [ctypes.c_size_t]
    zstd.ZSTD_isError.restype = ctypes.c_uint
    data = path.read_bytes()
    output = ctypes.create_string_buffer(zstd.ZSTD_compressBound(len(data)))
    length = zstd.ZSTD_compress(output, len(output), data, len(data), 1)
    assert not zstd.ZSTD_isError(length)
    path.with_suffix(".jsonl.zst").write_bytes(output.raw[:length])
    path.unlink()
    return path


def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument("--codex", required=True)
    parser.add_argument("--guest-probe", required=True)
    args = parser.parse_args()
    version = subprocess.check_output([args.codex, "--version"], text=True).strip()
    assert version == "codex-cli 0.153.4", "re-audit the native contract before changing the pinned version"
    assert len(TEXT) == 872 and len(PREFIX) == 114
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_port}/v1"
    try:
        with tempfile.TemporaryDirectory(prefix="citation-native-acceptance-") as directory:
            root = pathlib.Path(directory)
            home = root / "protocol"
            home.mkdir()
            thread = protocol_run(args.codex, home, url)
            protocol_run(args.codex, home, url, thread)
            thread = guest_run(args.guest_probe, args.codex, root / "guest", url)
            guest_run(args.guest_probe, args.codex, root / "guest", url, thread)
            path = compress_synthetic_rollout(root / "guest")
            guest_run(args.guest_probe, args.codex, root / "guest", url, thread)
            assert path.is_file(), "native resume must materialize its active canonical rollout"
        public_readers()
    finally:
        server.shutdown()
    print(json.dumps({"runtime": version, "rawCharacters": len(TEXT), "nativeCharacters": len(PREFIX),
                      "safeCharacters": len(SAFE), "fresh": "pass", "newProcessResume": "pass",
                      "guestFreshResume": "pass", "compressedHistoryResume": "pass",
                      "oldNewPublicReaders": "pass"}))


if __name__ == "__main__":
    main()
