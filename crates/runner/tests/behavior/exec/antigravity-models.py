"""Exercise the installed CLI's model selection and NDJSON protocol entirely on loopback."""

import json
import os
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


class InferenceHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        path = urlsplit(self.path).path
        effort = (
            body.get("generationConfig", {})
            .get("thinkingConfig", {})
            .get("thinkingLevel")
        )
        self.server.requests.append((path, effort))
        self.server.last_contents = body["contents"]
        parts = [{"text": self.server.reply}]
        if self.server.tool_script is not None:
            if not body.get("tools"):
                # The real CLI can request a secondary safety assessment.
                parts = [{"text": "{}"}]
            else:
                self.server.system_instructions.append(
                    body.get("systemInstruction", {})
                )
                if self.server.tool_script:
                    parts = [{"functionCall": self.server.tool_script.pop(0)}]
        response = {
            "candidates": [
                {
                    "content": {
                        "role": "model",
                        "parts": parts,
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


def run_turn(slug, home, endpoint, *extra_args, workspace=None, settings=None):
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
    # Each process submits one turn, even when it continues a conversation.
    completed = subprocess.run(
        [
            "agy",
            *extra_args,
            "--settings",
            json.dumps({"modelProvider": "gemini", **(settings or {})}),
            "--model",
            slug,
            "--print",
            "Reply briefly.",
            "--output-format",
            "stream-json",
        ],
        check=False,
        env=env,
        cwd=workspace or home,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=15,
    )
    events = [json.loads(line) for line in completed.stdout.splitlines()]
    return completed.returncode, events


with ThreadingHTTPServer(("127.0.0.1", 0), InferenceHandler) as server:
    server.tool_script = None
    server.system_instructions = []
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
            # A headless turn can deliver its answer only in the terminal result.
            response = result.get("response")
            assert isinstance(response, str) and response.strip() == "fixture answer", {
                "model": slug,
                "expected_response": "fixture answer",
                "result": result,
                "events": [
                    event.get("step_update", event["event"]) for event in events
                ],
                "fixture_requests": server.requests,
            }
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
    for family in ("neon", "carbon", "hydrogen"):
        with tempfile.TemporaryDirectory(prefix="agy-tools-") as root:
            # Match the Guest ordering where /home/user/workspace precedes /tmp.
            work = Path(root, "a-workspace")
            rules = Path(root, "z-instructions")
            home = Path(root, "home")
            for directory in (work, rules, home):
                directory.mkdir()
            (rules / "AGENTS.md").write_text("Use the Okou fixture system rule.")
            (work / "test_answer.py").write_text(
                "from unittest import TestCase\nfrom answer import answer\n"
                "class Check(TestCase):\n    def test_answer(self):\n        self.assertEqual(answer, 42)\n"
            )
            server.tool_script = [
                {
                    "name": "write_file",
                    "args": {
                        "Path": str(work / "answer.py"),
                        "Content": "answer = 42\n",
                    },
                },
                {
                    "name": "run_command",
                    "args": {
                        "CommandLine": "python3 -B -m unittest -q test_answer && echo AGY_TEST_PASSED",
                        "toolSummary": "Run workspace test",
                        "WaitMsBeforeAsync": 5000,
                    },
                },
            ]
            server.reply = "Finished the workspace test."
            server.system_instructions.clear()
            status, events = run_turn(
                f"gemini-4-{family}-medium",
                str(home),
                endpoint,
                "--mode",
                "accept-edits",
                "--disable-slash-commands",
                "--add-dir",
                str(rules),
                "--add-dir",
                str(work),
                workspace=str(work),
                settings={
                    "toolPermission": "proceed-in-sandbox",
                    "enableTerminalSandbox": True,
                    "allowNonWorkspaceAccess": False,
                    "useG1Credits": False,
                },
            )
            assert status == 0 and events[-1]["result"]["status"] == "SUCCESS", family
            assert (work / "answer.py").read_text().strip() == "answer = 42", family
            assert not server.tool_script, family
            assert any(
                "Use the Okou fixture system rule." in json.dumps(s)
                for s in server.system_instructions
            ), family
            assert any(
                step.get("tool_name") == "run_command"
                and step.get("state") == "DONE"
                and "AGY_TEST_PASSED" in step.get("tool_info", {}).get("output", "")
                for event in events
                if (step := event.get("step_update"))
            ), family
    server.shutdown()
