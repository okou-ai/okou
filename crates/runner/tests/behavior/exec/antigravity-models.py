"""Exercise the installed CLI's model selection and NDJSON protocol entirely on loopback."""

import json
import os
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit


class InferenceHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        path = urlsplit(self.path).path
        effort = body["generationConfig"]["thinkingConfig"]["thinkingLevel"]
        self.server.requests.append((path, effort))
        self.server.last_contents = body["contents"]
        response = {
            "candidates": [
                {
                    "content": {
                        "role": "model",
                        "parts": [{"text": self.server.reply}],
                    },
                    "finishReason": "STOP",
                }
            ],
            "usageMetadata": {
                "promptTokenCount": 12,
                "candidatesTokenCount": 4,
                "totalTokenCount": 16,
            },
        }
        payload = ("data: " + json.dumps(response) + "\n\n").encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, _format, *_args):
        pass


def run_turn(slug, home, endpoint, *extra_args):
    # This synthetic key selects the local Gemini protocol fixture. Never inherit
    # a real key, a Google account, a keyring session, or a remote model endpoint.
    env = {
        "PATH": os.environ["PATH"],
        "HOME": home,
        "AGY_CLI_DISABLE_AUTO_UPDATE": "true",
        "GEMINI_API_KEY": "loopback-fixture",
        "GOOGLE_GEMINI_BASE_URL": endpoint,
        "HTTP_PROXY": endpoint,
        "HTTPS_PROXY": endpoint,
        "NO_PROXY": "127.0.0.1",
    }
    completed = subprocess.run(
        [
            "agy",
            *extra_args,
            "--settings",
            '{"modelProvider":"gemini"}',
            "--model",
            slug,
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
        ],
        check=False,
        env=env,
        cwd=home,
        input=json.dumps({"event": "user", "message": {"content": "Reply briefly."}})
        + "\n",
        capture_output=True,
        text=True,
        timeout=15,
    )
    events = [json.loads(line) for line in completed.stdout.splitlines()]
    return completed.returncode, events


with ThreadingHTTPServer(("127.0.0.1", 0), InferenceHandler) as server:
    server.requests = []
    server.reply = "fixture answer"
    threading.Thread(target=server.serve_forever, daemon=True).start()
    endpoint = f"http://127.0.0.1:{server.server_port}"
    for family in ("neon", "carbon", "hydrogen"):
        model = f"gemini-4-{family}"
        for effort in ("low", "medium", "high", "xhigh"):
            slug = f"{model}-{effort}"
            server.requests.clear()
            with tempfile.TemporaryDirectory(prefix="agy-model-") as home:
                status, events = run_turn(slug, home, endpoint)
            results = [e["result"] for e in events if e["event"] == "result"]
            assert len(results) == 1 and events[-1]["event"] == "result", slug
            result = results[0]
            if family == "carbon" and effort == "xhigh":
                assert status != 0 and result["status"] == "ERROR", slug
                assert not server.requests, server.requests
                continue
            assert status == 0 and result["status"] == "SUCCESS", (slug, result)
            assert (
                events[0]["event"] == "init" and events[0]["init"]["model"] == slug
            ), slug
            assert (
                result["conversation_id"]
                and result["conversation_id"] == events[0]["conversation_id"]
            ), slug
            assert any(
                e.get("step_update", {}).get("step_type") == "agent_response"
                for e in events
            ), slug
            assert result["response"].strip() == "fixture answer", slug
            assert result["usage"]["total_tokens"] == 16, slug
            assert server.requests == [
                (f"/v1beta/models/{model}:streamGenerateContent", effort.upper())
            ], server.requests
    # A fresh process with the explicitly selected conversation must receive
    # the previous answer, even if another conversation was started meanwhile.
    with tempfile.TemporaryDirectory(prefix="agy-resume-") as home:
        slug = "gemini-4-neon-medium"
        server.reply = "original conversation"
        status, first = run_turn(slug, home, endpoint)
        assert status == 0, first
        conversation = first[-1]["result"]["conversation_id"]
        server.reply = "other conversation"
        status, other = run_turn(slug, home, endpoint)
        assert status == 0 and other[-1]["result"]["conversation_id"] != conversation, (
            other
        )
        status, resumed = run_turn(slug, home, endpoint, "--conversation", conversation)
        terminal = resumed[-1]["result"]
        assert status == 0 and terminal["status"] == "SUCCESS", terminal
        assert (
            terminal["conversation_id"] == conversation and terminal["num_turns"] == 2
        ), terminal
        assert any(
            part.get("text", "").strip() == "original conversation"
            for content in server.last_contents
            if content.get("role") == "model"
            for part in content["parts"]
        ), "the resumed model request did not include the earlier answer"
    server.shutdown()
