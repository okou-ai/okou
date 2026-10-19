"""Reopen histories created by the actual packaged agent commands."""

import json


def probe(fixture, env, as_role, pi_session, requests, record):
    claude = [
        json.loads(line)
        for line in (fixture / "claude.stdout").read_text().splitlines()
        if line.startswith("{")
    ]
    codex = [
        json.loads(line)
        for line in (fixture / "codex.stdout").read_text().splitlines()
        if line.startswith("{")
    ]
    claude_id = next(
        (
            item["session_id"]
            for item in claude
            if item.get("type") == "system" and item.get("subtype") == "init"
        ),
        None,
    )
    codex_id = next(
        (item["thread_id"] for item in codex if item.get("type") == "thread.started"),
        None,
    )
    for framework, session, command in (
        ("pi", env["OKOU_PI_SESSION_ID"], None),
        (
            "claude",
            claude_id,
            [
                "/usr/local/bin/claude",
                "--print",
                "CLAUDE_RETAINED_HISTORY",
                "--resume",
                claude_id,
                "--dangerously-skip-permissions",
                "--model",
                "claude-sonnet-4-6",
            ],
        ),
        (
            "codex",
            codex_id,
            [
                "/usr/bin/codex",
                "exec",
                "--dangerously-bypass-approvals-and-sandbox",
                "--skip-git-repo-check",
                "--json",
                "resume",
                codex_id,
                "CODEX_RETAINED_HISTORY",
            ],
        ),
    ):
        if session is None:
            record(
                framework + "_reopens_real_history",
                False,
                error="main CLI did not publish a session identity",
            )
            continue
        marker = framework.upper() + "_RETAINED_HISTORY"
        current_env = {**env, "OKOU_NATIVE_FRAMEWORK": framework}
        if framework == "pi":
            status, records = pi_session(current_env, marker)
            output = ""
            settled = any(item.get("type") == "agent_settled" for item in records)
        else:
            if framework == "claude":
                current_env.update(
                    ANTHROPIC_API_KEY="synthetic-no-provider-authority",
                    ANTHROPIC_BASE_URL="http://127.0.0.1:18080",
                    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1",
                    DISABLE_AUTOUPDATER="1",
                )
            run = as_role("agent", command, env=current_env, timeout=45)
            status, output, settled = run.returncode, run.stderr[-2500:], True
        observed = [item for item in requests if item.get("historyMarker") == marker]
        record(
            framework + "_reopens_real_history",
            status == 0
            and settled
            and len(observed) == 1
            and observed[0].get("retainedMainObserved") is True,
            exit=status,
            sessionId=session,
            modelObservations=observed,
            stderr=output,
        )
