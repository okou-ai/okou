import json
import os
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

session_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
boundary_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
summary_id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
requests = []


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        self.rfile.read(length)
        requests.append(self.path)
        body = json.dumps(
            {
                "type": "error",
                "error": {
                    "type": "invalid_request_error",
                    "message": "loopback compatibility probe",
                },
            }
        ).encode()
        self.send_response(400)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format, *_args):
        pass


with tempfile.TemporaryDirectory(prefix="claude-compact-smoke-") as root:
    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        port = server.server_port
        env = os.environ.copy()
        env.update(
            {
                "HOME": root,
                "CLAUDE_CONFIG_DIR": f"{root}/.claude",
                "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{port}",
                "ANTHROPIC_API_KEY": "test-token",
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
                "DISABLE_AUTOUPDATER": "1",
                "NO_PROXY": "127.0.0.1,localhost",
                "no_proxy": "127.0.0.1,localhost",
            }
        )

        def run_claude(*args):
            return subprocess.run(
                [
                    "/usr/local/bin/claude",
                    *args,
                    "--output-format",
                    "stream-json",
                    "--verbose",
                ],
                cwd="/home/user/workspace",
                env=env,
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )

        # Let Claude create its isolated config metadata, then replace only the
        # session JSONL with the compact generation under test.
        run_claude(
            "--session-id",
            session_id,
            "--print",
            "seed compatibility metadata",
        )
        project_dir = Path(root) / ".claude/projects/-home-user-workspace"
        history_file = project_dir / f"{session_id}.jsonl"
        assert history_file.is_file(), (
            "Claude metadata seed did not create session history"
        )
        version = subprocess.check_output(
            ["/usr/local/bin/claude", "--version"],
            text=True,
        ).split()[0]
        records = [
            {
                "parentUuid": None,
                "isSidechain": False,
                "userType": "external",
                "cwd": "/home/user/workspace",
                "sessionId": session_id,
                "version": version,
                "gitBranch": "",
                "type": "system",
                "subtype": "compact_boundary",
                "content": "Conversation compacted",
                "isMeta": False,
                "uuid": boundary_id,
                "timestamp": "2026-01-01T00:00:00.000Z",
                "logicalParentUuid": (
                    "11111111-1111-4111-8111-111111111111"
                ),
                "compactMetadata": {"trigger": "auto", "preTokens": 100},
            },
            {
                "parentUuid": boundary_id,
                "isSidechain": False,
                "userType": "external",
                "cwd": "/home/user/workspace",
                "sessionId": session_id,
                "version": version,
                "gitBranch": "",
                "type": "user",
                "message": {
                    "role": "user",
                    "content": "Synthetic compacted conversation summary.",
                },
                "isMeta": False,
                "uuid": summary_id,
                "timestamp": "2026-01-01T00:00:00.001Z",
                "isCompactSummary": True,
            },
        ]
        history_file.write_text(
            "".join(
                json.dumps(record, separators=(",", ":")) + "\n"
                for record in records
            )
        )

        requests.clear()
        resumed = run_claude(
            "--resume",
            session_id,
            "--print",
            "append compatibility turn",
        )
        output = resumed.stdout + resumed.stderr
        assert "No conversation found with session ID" not in output, output
        assert any(
            path.startswith("/v1/messages") for path in requests
        ), f"Claude did not reach messages endpoint:\n{output}"

        retained = [
            json.loads(line)
            for line in history_file.read_text().splitlines()
        ]
        appended = retained[2:]
        assert appended, "Claude did not append to the compact generation"
        assert any(
            record.get("sessionId") == session_id
            for record in appended
        ), "Claude appended no record for the resumed session"
        assert all(
            record.get("sessionId", session_id) == session_id
            for record in retained
        ), "Claude changed the session ID while appending"

        server.shutdown()
        server_thread.join()
