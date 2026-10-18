"""Exercise actual packaged file/HTTP tools against private synthetic inputs."""

import json
from pathlib import Path

CASES = {
    "PI_INPROCESS_READ_KEY": ("read", {"path": "/fixture/gateway-key"}),
    "PI_INPROCESS_WRITE_CONFIG": (
        "write",
        {"path": "/home/user/.pi/agent/settings.json", "content": "untrusted"},
    ),
    "CLAUDE_INPROCESS_READ_KEY": ("Read", {"file_path": "/fixture/gateway-key"}),
    "CLAUDE_INPROCESS_WRITE_CONFIG": (
        "Write",
        {"file_path": "/home/user/.claude/settings.json", "content": "untrusted"},
    ),
    "CLAUDE_INPROCESS_HTTP": (
        "WebFetch",
        {
            "url": "https://127.0.0.1:18086/v1/chat/completions",
            "prompt": "Read the response",
        },
    ),
    "CODEX_INPROCESS_READ_KEY": (
        "view_image",
        {"path": "/fixture/gateway-key"},
    ),
}


def choose(messages, spawned):
    conversation = json.dumps(messages)
    for marker, (name, arguments) in CASES.items():
        if marker in conversation:
            if marker in spawned:
                return None, {"text": "in-process boundary probe complete"}
            spawned.add(marker)
            return name, arguments
    return None


def probe(env, as_role, pi_session, requests, upstream_gets, record):
    for index, marker in enumerate(CASES, 1):
        framework = marker.split("_")[0].lower()
        before = len(requests)
        before_gets = len(upstream_gets)
        current_env = {**env, "OKOU_NATIVE_FRAMEWORK": framework}
        if framework == "pi":
            current_env["OKOU_PI_SESSION_ID"] = f"cccccccc-cccc-4ccc-8ccc-{index:012d}"
            status, _records = pi_session(current_env, marker)
            stderr = ""
        else:
            if framework == "claude":
                command = [
                    "/usr/local/bin/claude",
                    "--print",
                    marker,
                    "--dangerously-skip-permissions",
                    "--model",
                    "claude-sonnet-4-6",
                ]
                current_env.update(
                    ANTHROPIC_API_KEY="synthetic-no-provider-authority",
                    ANTHROPIC_BASE_URL="http://127.0.0.1:18080",
                    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1",
                    DISABLE_AUTOUPDATER="1",
                )
                if marker == "CLAUDE_INPROCESS_HTTP":
                    # Remove the vendor's external safety lookup from this
                    # stronger test: the owned TLS ingress must itself reject
                    # the real WebFetch GET, without credential/upstream work.
                    command += ["--settings", '{"skipWebFetchPreflight":true}']
                    current_env["NODE_EXTRA_CA_CERTS"] = "/fixture/gateway-cert.pem"
            else:
                command = [
                    "/usr/bin/codex",
                    "exec",
                    "--dangerously-bypass-approvals-and-sandbox",
                    "--skip-git-repo-check",
                    "--json",
                    marker,
                ]
                current_env["CODEX_HOME"] = "/home/user/.codex"
            run = as_role("agent", command, env=current_env, timeout=35)
            status, stderr = run.returncode, run.stderr[-2000:]
        observed = requests[before:]
        outputs = [item.get("lastInput", "") for item in observed[1:]]
        text = " ".join(outputs).lower()
        denied = any(
            word in text
            for word in (
                "permission denied",
                "eacces",
                "operation not permitted",
                "denied",
                "cannot",
                "unable",
                "failed",
                "error",
            )
        )
        if "READ_KEY" in marker:
            denied = "/fixture/gateway-key" in text and any(
                word in text
                for word in ("permission denied", "eacces", "refusing to read")
            )
        elif "WRITE_CONFIG" in marker:
            denied = CASES[marker][1].get(
                "path", CASES[marker][1].get("file_path")
            ).lower() in text and any(
                word in text for word in ("permission denied", "eacces")
            )
        ingress = None
        if marker == "CLAUDE_INPROCESS_HTTP":
            ingress = any(
                item == {"method": "GET", "path": "/v1/chat/completions"}
                for item in (
                    json.loads(line)
                    for line in Path("/fixture/gateway-requests.jsonl")
                    .read_text()
                    .splitlines()
                )
            )
            denied = ingress and "405" in text and len(upstream_gets) == before_gets
        record(
            marker.lower(),
            status == 0
            and len(outputs) >= 1
            and denied
            and "synthetic-gateway-only-no-provider-authority" not in text,
            exit=status,
            actualToolOutputs=outputs,
            stderr=stderr,
            tlsIngressObserved=ingress,
            upstreamGetDelta=len(upstream_gets) - before_gets,
        )
