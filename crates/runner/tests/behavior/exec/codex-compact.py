import json
import os
import shutil
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

summary_token = "CODEX-COMPACT-SUMMARY-TOKEN"
seed_token = "CODEX-COMPACT-SEED-TOKEN"
compacting_turn_token = "CODEX-COMPACTING-TURN-TOKEN"
candidate_turn_token = "CODEX-COMPACT-CANDIDATE-TURN-TOKEN"
append_token = "CODEX-COMPACT-APPEND-TOKEN"
legacy_seed_token = "CODEX-LEGACY-SEED-TOKEN"
usage_token = "CODEX-TOKEN-USAGE-TOKEN"
# [sync:codex-app-server-compatibility-params] Keep in sync with initialize in
# codex_app_server.rs, thread/turn params in codex_app_server_backend.rs, and
# IGNORED_NOTIFICATION_METHODS in codex_app_server_events.rs.
opt_out_notification_methods = [
    "command/exec/outputDelta",
    "process/outputDelta",
    "process/exited",
    "item/agentMessage/delta",
    "item/plan/delta",
    "item/commandExecution/outputDelta",
    "item/commandExecution/terminalInteraction",
    "item/fileChange/outputDelta",
    "item/fileChange/patchUpdated",
    "item/mcpToolCall/progress",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta",
    "thread/realtime/transcript/delta",
    "thread/realtime/outputAudio/delta",
]
requests = []
current_codex = shutil.which("codex")
assert current_codex is not None, "bundled Codex is not on PATH"


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        payload = json.loads(self.rfile.read(length))
        requests.append((self.path, payload))
        if usage_token in json.dumps(payload.get("input", [])):
            events = [
                {
                    "type": "response.created",
                    "response": {"id": "resp-token-usage"},
                },
                {
                    "type": "response.output_item.done",
                    "item": {
                        "type": "message",
                        "role": "assistant",
                        "id": "msg-token-usage",
                        "content": [
                            {
                                "type": "output_text",
                                "text": "token usage probe complete",
                            }
                        ],
                    },
                },
                {
                    "type": "response.completed",
                    "response": {
                        "id": "resp-token-usage",
                        "usage": {
                            "input_tokens": 30,
                            "input_tokens_details": {
                                "cached_tokens": 11,
                                "cache_write_tokens": 2,
                            },
                            "output_tokens": 7,
                            "output_tokens_details": {
                                "reasoning_tokens": 3,
                            },
                            "total_tokens": 37,
                        },
                    },
                },
            ]
            body = "".join(
                "event: "
                + event["type"]
                + "\ndata: "
                + json.dumps(event, separators=(",", ":"))
                + "\n\n"
                for event in events
            ).encode()
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        body = json.dumps(
            {
                "error": {
                    "message": "loopback compatibility probe",
                    "type": "invalid_request_error",
                }
            }
        ).encode()
        self.send_response(400)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format, *_args):
        pass


def write_config(codex_home, port):
    codex_home.mkdir(parents=True)
    (codex_home / "config.toml").write_text(
        f"""
model = "gpt-5.1-codex-mini"
model_provider = "mock"
approval_policy = "never"
sandbox_mode = "read-only"

[model_providers.mock]
name = "mock"
base_url = "http://127.0.0.1:{port}/v1"
env_key = "CODEX_COMPACT_PROBE_TOKEN"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
""".lstrip()
    )


def send_app_server_message(process, message):
    process.stdin.write(json.dumps(message) + "\n")
    process.stdin.flush()


def read_app_server_message(process):
    line = process.stdout.readline()
    assert line, "Codex app-server closed stdout before completing the turn"
    return json.loads(line)


def wait_for_app_server_response(process, response_id, messages):
    while True:
        message = read_app_server_message(process)
        messages.append(message)
        if message.get("id") != response_id:
            continue
        assert "error" not in message, message
        return message["result"]


def run_codex_app_server(
    codex_home,
    prompt,
    resume_id=None,
    expected_history_mode="paginated",
):
    env = os.environ.copy()
    env.update(
        {
            "HOME": str(codex_home.parent),
            "CODEX_HOME": str(codex_home),
            "CODEX_COMPACT_PROBE_TOKEN": "test-token",
            "NO_PROXY": "127.0.0.1,localhost",
            "no_proxy": "127.0.0.1,localhost",
        }
    )
    with tempfile.TemporaryFile(mode="w+", encoding="utf-8") as stderr_file:
        process = subprocess.Popen(
            [
                current_codex,
                "app-server",
                "--listen",
                "stdio://",
            ],
            cwd="/home/user/workspace",
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=stderr_file,
            text=True,
        )
        try:
            messages = []
            send_app_server_message(
                process,
                {
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "clientInfo": {
                            "name": "vm0-guest-agent",
                            "title": None,
                            "version": "0",
                        },
                        "capabilities": {
                            "experimentalApi": True,
                            "requestAttestation": False,
                            "optOutNotificationMethods": (
                                opt_out_notification_methods
                            ),
                        },
                    },
                },
            )
            wait_for_app_server_response(process, 1, messages)
            send_app_server_message(
                process,
                {"method": "initialized", "params": None},
            )

            thread_params = {
                "cwd": "/home/user/workspace",
                "approvalPolicy": "never",
                "approvalsReviewer": "user",
                "sandbox": "danger-full-access",
                "config": {"features.memories": True},
                "model": "gpt-5.1-codex-mini",
                "modelProvider": "mock",
            }
            thread_method = "thread/start"
            if resume_id is not None:
                thread_method = "thread/resume"
                thread_params["threadId"] = resume_id
                thread_params["excludeTurns"] = True
            send_app_server_message(
                process,
                {"id": 2, "method": thread_method, "params": thread_params},
            )
            thread_result = wait_for_app_server_response(process, 2, messages)
            thread = thread_result["thread"]
            thread_id = thread["id"]
            assert thread["historyMode"] == expected_history_mode, thread
            if resume_id is not None:
                assert thread["turns"] == [], thread

            send_app_server_message(
                process,
                {
                    "id": 3,
                    "method": "turn/start",
                    "params": {
                        "threadId": thread_id,
                        "input": [
                            {
                                "type": "text",
                                "text": prompt,
                                "text_elements": [],
                            }
                        ],
                        "cwd": "/home/user/workspace",
                        "approvalPolicy": "never",
                        "approvalsReviewer": "user",
                        "sandboxPolicy": {"type": "dangerFullAccess"},
                        "model": "gpt-5.1-codex-mini",
                    },
                },
            )
            turn_result = wait_for_app_server_response(process, 3, messages)
            turn_id = turn_result["turn"]["id"]
            while True:
                message = read_app_server_message(process)
                messages.append(message)
                if (
                    message.get("method") == "turn/completed"
                    and message.get("params", {}).get("threadId") == thread_id
                    and message.get("params", {}).get("turn", {}).get("id")
                    == turn_id
                ):
                    break

            process.stdin.close()
            return_code = process.wait(timeout=10)
            stderr_file.seek(0)
            stderr = stderr_file.read()
            assert return_code == 0, stderr
            return {
                "thread_id": thread_id,
                "messages": messages,
                "stderr": stderr,
            }
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
            process.stdin.close()
            process.stdout.close()


def app_server_output(result):
    return json.dumps(result["messages"]) + "\n" + result["stderr"]


def response_request_for_prompt(prompt):
    prompt_content = [{"type": "input_text", "text": prompt}]
    matching_requests = [
        payload
        for path, payload in requests
        if path == "/v1/responses"
        and payload["input"][-1].get("role") == "user"
        and payload["input"][-1].get("content") == prompt_content
    ]
    assert len(matching_requests) == 1, (
        "expected exactly one Responses request for the probe prompt, "
        f"found {len(matching_requests)} among {len(requests)} requests"
    )
    return matching_requests[0]


def probe_token_usage(codex_home, port):
    write_config(codex_home, port)
    requests.clear()
    result = run_codex_app_server(codex_home, usage_token)
    response_request_for_prompt(usage_token)
    messages = result["messages"]
    turn_response = next(
        message
        for message in messages
        if message.get("id") == 3
    )
    turn_id = turn_response["result"]["turn"]["id"]
    usage_notifications = [
        (index, message)
        for index, message in enumerate(messages)
        if (
            message.get("method") == "thread/tokenUsage/updated"
            and message.get("params", {}).get("threadId")
            == result["thread_id"]
            and message.get("params", {}).get("turnId") == turn_id
        )
    ]
    assert usage_notifications, (
        "Codex did not emit thread/tokenUsage/updated on success\n"
        + app_server_output(result)
    )
    usage_index, usage_message = usage_notifications[-1]
    expected_usage = {
        "inputTokens": 30,
        "cachedInputTokens": 11,
        "cacheWriteInputTokens": 2,
        "outputTokens": 7,
        "reasoningOutputTokens": 3,
        "totalTokens": 37,
    }
    token_usage = usage_message["params"]["tokenUsage"]
    assert token_usage["total"] == expected_usage, token_usage
    assert token_usage["last"] == expected_usage, token_usage
    completion_index, completion = next(
        (index, message)
        for index, message in enumerate(messages)
        if (
            message.get("method") == "turn/completed"
            and message.get("params", {}).get("threadId")
            == result["thread_id"]
            and message.get("params", {}).get("turn", {}).get("id")
            == turn_id
        )
    )
    assert usage_index < completion_index, (
        "token usage notification must precede turn completion"
    )
    assert "usage" not in completion.get("params", {}), completion


def zstd_compress(history_bytes):
    result = subprocess.run(
        [
            "node",
            "-e",
            (
                "const fs=require('node:fs');"
                "const zlib=require('node:zlib');"
                "process.stdout.write("
                "zlib.zstdCompressSync(fs.readFileSync(0)));"
            ),
        ],
        input=history_bytes,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr.decode(errors="replace")
    return result.stdout


def event_type(record):
    if record.get("type") != "event_msg":
        return None
    return record.get("payload", {}).get("type")


def normalize_probe_input(value, root):
    if isinstance(value, str):
        return value.replace(str(root), "$PROBE_ROOT")
    if isinstance(value, list):
        return [normalize_probe_input(item, root) for item in value]
    if isinstance(value, dict):
        # Synthetic context messages receive fresh IDs on each resume.
        # Preserve the field while ignoring its non-semantic random value.
        return {
            key: (
                "$MESSAGE_ID"
                if (
                    key == "id"
                    and isinstance(item, str)
                    and item.startswith("msg_")
                )
                else normalize_probe_input(item, root)
            )
            for key, item in value.items()
        }
    return value


def resume_history(
    root,
    candidate_relative_path,
    history_bytes,
    session_id,
    port,
    expected_history_mode="paginated",
):
    codex_home = root / ".codex"
    write_config(codex_home, port)
    history_file = codex_home / "sessions" / candidate_relative_path
    history_file.parent.mkdir(parents=True)
    history_file.write_bytes(history_bytes)
    assert not list(codex_home.glob("*.sqlite")), (
        "probe must begin without Codex SQLite state"
    )
    original_size = history_file.stat().st_size

    requests.clear()
    resumed = run_codex_app_server(
        codex_home,
        append_token,
        session_id,
        expected_history_mode=expected_history_mode,
    )
    output = app_server_output(resumed)
    assert (
        f"no rollout found for thread id {session_id}" not in output.lower()
    ), output
    response_request = response_request_for_prompt(append_token)
    return resumed, history_file, original_size, response_request


def probe_legacy_resume(root, port):
    session_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    turn_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

    def record(record_type, payload):
        return json.dumps(
            {
                "timestamp": "2026-01-01T00:00:00Z",
                "type": record_type,
                "payload": payload,
            },
            separators=(",", ":"),
        ) + "\n"

    history_bytes = "".join(
        [
            record(
                "session_meta",
                {
                    "id": session_id,
                    "session_id": session_id,
                    "timestamp": "2026-01-01T00:00:00Z",
                    "cwd": "/home/user/workspace",
                    "originator": "vm0-guest-agent",
                    "cli_version": "0.150.1",
                    "source": "vscode",
                    "model_provider": "mock",
                    "history_mode": "legacy",
                },
            ),
            record(
                "event_msg",
                {
                    "type": "task_started",
                    "turn_id": turn_id,
                    "started_at": 1767225600,
                    "model_context_window": 258400,
                    "collaboration_mode_kind": "default",
                },
            ),
            record(
                "turn_context",
                {
                    "turn_id": turn_id,
                    "cwd": "/home/user/workspace",
                    "approval_policy": "never",
                    "sandbox_policy": {"type": "danger-full-access"},
                    "model": "gpt-5.1-codex-mini",
                    "summary": "auto",
                },
            ),
            record(
                "response_item",
                {
                    "type": "message",
                    "role": "user",
                    "content": [
                        {
                            "type": "input_text",
                            "text": legacy_seed_token,
                        }
                    ],
                },
            ),
            record(
                "event_msg",
                {
                    "type": "user_message",
                    "message": legacy_seed_token,
                    "images": [],
                    "local_images": [],
                    "audio": [],
                    "local_audio": [],
                    "text_elements": [],
                },
            ),
            record(
                "event_msg",
                {
                    "type": "task_complete",
                    "turn_id": turn_id,
                    "last_agent_message": None,
                    "started_at": 1767225600,
                    "completed_at": 1767225601,
                    "duration_ms": 1000,
                },
            ),
        ]
    ).encode()
    candidate_relative_path = Path(
        "2026/01/01/"
        f"rollout-2026-01-01T00-00-00-{session_id}.jsonl"
    )

    requests.clear()
    resumed, history_file, original_size, response_request = resume_history(
        root,
        candidate_relative_path,
        history_bytes,
        session_id,
        port,
        expected_history_mode="legacy",
    )
    assert resumed["thread_id"] == session_id, (
        "Codex changed the legacy thread ID"
    )
    assert legacy_seed_token in json.dumps(response_request["input"]), (
        "Codex did not restore the legacy session context"
    )
    assert history_file.stat().st_size > original_size, (
        "Codex did not append to the legacy rollout"
    )


def probe_current_codex(
    root,
    candidate_relative_path,
    full_bytes,
    candidate_bytes,
    session_id,
    port,
):
    full_root = root / "full"
    _, _, _, full_request = resume_history(
        full_root,
        candidate_relative_path,
        full_bytes,
        session_id,
        port,
    )
    candidate_root = root / "candidate"
    resumed, history_file, original_size, candidate_request = resume_history(
        candidate_root,
        candidate_relative_path,
        candidate_bytes,
        session_id,
        port,
    )
    full_input = normalize_probe_input(full_request["input"], full_root)
    candidate_input = normalize_probe_input(
        candidate_request["input"],
        candidate_root,
    )
    assert full_input == candidate_input, (
        "Codex reconstructed different model input from the compact generation"
    )
    request_json = json.dumps(candidate_request)
    assert summary_token in request_json, (
        "Codex did not reconstruct compact replacement history"
    )

    assert resumed["thread_id"] == session_id, (
        "Codex changed the resumed thread ID"
    )

    candidate_home = candidate_root / ".codex"
    histories = list((candidate_home / "sessions").rglob("*.jsonl"))
    assert histories == [history_file], (
        f"Codex created a different rollout path: {histories}"
    )
    assert history_file.stat().st_size > original_size, (
        "Codex did not append to the compact generation"
    )

    records = [
        json.loads(line)
        for line in history_file.read_text().splitlines()
    ]
    assert records[0]["payload"]["id"] == session_id
    turn_starts = [
        record["payload"]["turn_id"]
        for record in records
        if event_type(record) in {"task_started", "turn_started"}
    ]
    turn_completions = [
        record["payload"]["turn_id"]
        for record in records
        if event_type(record) in {"task_complete", "turn_complete"}
    ]
    assert (
        len(turn_completions) >= 2
        and turn_starts[-1] == turn_completions[-1]
    ), "Codex did not append a complete turn"


def probe_zstd_materialization(
    root,
    candidate_relative_path,
    candidate_bytes,
    session_id,
    port,
):
    codex_home = root / ".codex"
    write_config(codex_home, port)
    history_file = codex_home / "sessions" / candidate_relative_path
    compressed_history_file = Path(f"{history_file}.zst")
    compressed_history_file.parent.mkdir(parents=True)
    compressed_history_file.write_bytes(zstd_compress(candidate_bytes))

    requests.clear()
    resumed = run_codex_app_server(
        codex_home,
        append_token,
        session_id,
    )
    output = app_server_output(resumed)
    assert (
        f"no rollout found for thread id {session_id}" not in output.lower()
    ), output
    response_request_for_prompt(append_token)
    assert not compressed_history_file.exists(), (
        "Codex left the compressed rollout after append"
    )
    assert history_file.is_file(), (
        "Codex did not materialize the compressed rollout as plain JSONL"
    )
    materialized = history_file.read_bytes()
    assert materialized.startswith(candidate_bytes), (
        "Codex changed the retained history while materializing zstd"
    )
    assert len(materialized) > len(candidate_bytes), (
        "Codex did not append to the materialized rollout"
    )

    assert resumed["thread_id"] == session_id, (
        "Codex changed the zstd-restored thread ID"
    )


with tempfile.TemporaryDirectory(prefix="codex-compact-smoke-") as temp_root:
    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        server_thread = threading.Thread(
            target=server.serve_forever,
            daemon=True,
        )
        server_thread.start()
        root = Path(temp_root)
        port = server.server_port

        probe_token_usage(root / "usage" / ".codex", port)

        seed_home = root / "seed" / ".codex"
        write_config(seed_home, port)
        run_codex_app_server(
            seed_home,
            seed_token,
        )
        source = next((seed_home / "sessions").rglob("*.jsonl"))
        records = [
            json.loads(line)
            for line in source.read_text().splitlines()
        ]
        session_id = records[0]["payload"]["id"]
        candidate_relative_path = source.relative_to(
            seed_home / "sessions"
        )
        compacting_turn = run_codex_app_server(
            seed_home,
            compacting_turn_token,
            session_id,
        )
        compacting_output = app_server_output(compacting_turn)
        assert (
            f"no rollout found for thread id {session_id}"
            not in compacting_output.lower()
        ), compacting_output
        records = [
            json.loads(line)
            for line in source.read_text().splitlines()
        ]
        complete_index = max(
            index
            for index, record in enumerate(records)
            if event_type(record) in {"task_complete", "turn_complete"}
        )
        records.pop(complete_index)
        records.insert(
            complete_index,
            {
                "timestamp": "2026-01-01T00:00:00.000Z",
                "type": "compacted",
                "payload": {
                    "message": summary_token,
                    "replacement_history": [
                        {
                            "type": "message",
                            "role": "user",
                            "content": [
                                {
                                    "type": "input_text",
                                    "text": seed_token,
                                }
                            ],
                        },
                        {
                            "type": "message",
                            "role": "assistant",
                            "content": [
                                {
                                    "type": "output_text",
                                    "text": summary_token,
                                }
                            ],
                        },
                    ],
                    "window_number": 2,
                    "first_window_id": (
                        "019c0000-0000-7000-8000-000000000001"
                    ),
                    "previous_window_id": (
                        "019c0000-0000-7000-8000-000000000002"
                    ),
                    "window_id": (
                        "019c0000-0000-7000-8000-000000000003"
                    ),
                },
            },
        )
        for ordinal, record in enumerate(records):
            record["ordinal"] = ordinal
        source.write_bytes(
            "".join(
                json.dumps(record, separators=(",", ":")) + "\n"
                for record in records
            ).encode()
        )

        candidate_turn = run_codex_app_server(
            seed_home,
            candidate_turn_token,
            session_id,
        )
        candidate_output = app_server_output(candidate_turn)
        assert (
            f"no rollout found for thread id {session_id}"
            not in candidate_output.lower()
        ), candidate_output
        candidate_records = [
            json.loads(line)
            for line in source.read_text().splitlines()
        ]
        candidate_starts = [
            record["payload"]["turn_id"]
            for record in candidate_records
            if event_type(record) in {"task_started", "turn_started"}
        ]
        candidate_completions = [
            record["payload"]["turn_id"]
            for record in candidate_records
            if event_type(record) in {"task_complete", "turn_complete"}
        ]
        assert (
            len(candidate_starts) >= 3
            and len(candidate_completions) == 2
            and candidate_starts[-1] == candidate_completions[-1]
        ), (
            "failed to build a compacting turn delimited by the next turn\n"
            f"{candidate_output}"
        )
        full_lines = source.read_bytes().splitlines(keepends=True)
        full_records = [json.loads(line) for line in full_lines]
        compact_index = max(
            index
            for index, record in enumerate(full_records)
            if record.get("type") == "compacted"
        )
        candidate_start_index = max(
            index
            for index, record in enumerate(full_records[:compact_index])
            if event_type(record) in {"task_started", "turn_started"}
        )
        full_bytes = b"".join(full_lines)
        candidate_bytes = b"".join(
            [full_lines[0], *full_lines[candidate_start_index:]]
        )
        assert len(candidate_bytes) < len(full_bytes), (
            "probe candidate must discard history superseded by compaction"
        )

        probe_current_codex(
            root / "current",
            candidate_relative_path,
            full_bytes,
            candidate_bytes,
            session_id,
            port,
        )
        probe_zstd_materialization(
            root / "zstd",
            candidate_relative_path,
            candidate_bytes,
            session_id,
            port,
        )
        probe_legacy_resume(root / "legacy", port)

        server.shutdown()
        server_thread.join()
