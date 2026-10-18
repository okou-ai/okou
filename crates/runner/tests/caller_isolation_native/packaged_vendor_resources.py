"""Captured vendor configuration with separate retained session/data mounts."""

import json
import os
from pathlib import Path

CODEX_CONFIG = 'model = "gpt-5.1-codex-mini"\nmodel_provider = "mock"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n[features]\nmulti_agent = true\n[model_providers.mock]\nname = "mock"\nbase_url = "http://127.0.0.1:18080/v1"\nenv_key = "OPENAI_API_KEY"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\n'


def prepare(fixture, label):
    for framework in ("claude", "codex"):
        source = fixture / (framework + "-resources")
        source.mkdir()
        os.chown(source, 1000, 1000)
        label(source, "runtime_state_t")
        for name in (
            "settings.json",
            "settings.local.json",
            "hooks.json",
            "config.toml",
            "mcp.json",
        ):
            path = source / name
            path.write_text(CODEX_CONFIG if name == "config.toml" else "{}")
            label(path, "resource_config_t")
        for name in ("plugins", "agents", "commands"):
            path = source / name
            path.mkdir()
            label(path, "resource_config_t")
        for name in (
            "sessions",
            "projects",
            "shell-snapshots",
            "shell_snapshots",
            "session-env",
        ):
            original = Path("/home/user/." + framework) / name
            original.mkdir(parents=True, exist_ok=True)
            os.chown(original, 1000, 1000)
            label(original, "workload_data_t")
            (source / name).mkdir()
        anchor = Path("/home/user/." + framework)
        os.chown(anchor, 1000, 1000)
        label(anchor, "resource_anchor_t")
        for parent in ("/home/user/workspace", "/home", "/"):
            path = Path(parent) / ("." + framework)
            path.mkdir(exist_ok=True)
            label(path, "resource_anchor_t")
    project = fixture / "vendor-project-resources"
    project.mkdir()
    label(project, "resource_config_t")
    for name in ("settings.json", "settings.local.json", "config.toml", "mcp.json"):
        (project / name).write_text("" if name.endswith("toml") else "{}")
    # This file also stores executable MCP discovery, so it is captured as one
    # immutable object rather than sharing a writable vendor-wide state file.
    config = fixture / "claude-config.json"
    config.write_text(
        json.dumps(
            {
                "hasCompletedOnboarding": True,
                "mcpServers": {},
                "projects": {"/home/user/workspace": {"hasTrustDialogAccepted": True}},
            }
        )
    )
    Path("/home/user/.claude.json").write_text("{}")
    label("/home/user/.claude.json", "resource_config_t")


def probe(env, as_role, record):
    script = r"""import errno,json,pathlib
paths=[]
for framework in ('claude','codex'):
 for name in ('settings.json','settings.local.json','config.toml','hooks.json'):
  paths.append('/home/user/.'+framework+'/'+name)
 for name in ('plugins/new-plugin','agents/new-agent','commands/new-command'):
  paths.append('/home/user/.'+framework+'/'+name)
 for parent in ('/home/user/workspace','/home','/'):
  paths.append(parent+'/.'+framework+'/settings.json')
for name in paths:
 try: pathlib.Path(name).write_text('untrusted executable configuration')
 except OSError as error: assert error.errno in (errno.EACCES,errno.EPERM,errno.EROFS),error
 else: raise AssertionError('configuration write admitted: '+name)
print(json.dumps({'deniedPaths':paths,'context':pathlib.Path('/proc/self/attr/current').read_text().rstrip('\0')}))
"""
    result = as_role("agent", ["/usr/bin/python3", "-c", script], env=env)
    observed = json.loads(result.stdout) if result.returncode == 0 else {}
    record(
        "vendor_executable_configuration_frozen",
        result.returncode == 0
        and observed.get("context") == "system_u:system_r:agent_t"
        and len(observed.get("deniedPaths", [])) == 20,
        identity=observed,
        stderr=result.stderr[-2000:],
    )


def discovery_probe(fixture, root, env, as_role, record):
    for framework in ("claude", "codex"):
        tag = framework + "-discovery"
        peer = {
            "command": "/usr/bin/python3",
            "args": ["/fixture/packaged_mcp_peer.py", tag],
        }
        current_env = {**env, "OKOU_NATIVE_FRAMEWORK": framework}
        if framework == "claude":
            Path("/home/user/.claude.json").write_text(
                json.dumps({"mcpServers": {"native-probe": {"type": "stdio", **peer}}})
            )
            command = [
                "/usr/local/bin/claude",
                "--print",
                "CLAUDE_CONFIG_DISCOVERY",
                "--dangerously-skip-permissions",
                "--model",
                "claude-sonnet-4-6",
                "--strict-mcp-config",
                "--mcp-config",
                "/home/user/.claude.json",
            ]
            current_env.update(
                ANTHROPIC_API_KEY="synthetic-no-provider-authority",
                ANTHROPIC_BASE_URL="http://127.0.0.1:18080",
                CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1",
                DISABLE_AUTOUPDATER="1",
            )
        else:
            Path("/home/user/.codex/config.toml").write_text(
                CODEX_CONFIG
                + '\n[mcp_servers.native_probe]\ncommand = "/usr/bin/python3"\nargs = '
                + json.dumps(peer["args"])
                + "\nstartup_timeout_sec = 5\n"
            )
            current_env["CODEX_HOME"] = "/home/user/.codex"
            command = [
                "/usr/bin/codex",
                "exec",
                "--dangerously-bypass-approvals-and-sandbox",
                "--skip-git-repo-check",
                "--json",
                "CODEX_CONFIG_DISCOVERY",
            ]
        observations = []
        for role in ("agent-resource-control", "agent"):
            state = root / ("mcp-" + tag + ".json")
            ingress = root / ("mcp-" + tag + "-connected")
            state.unlink(missing_ok=True)
            ingress.unlink(missing_ok=True)
            run = as_role(role, command, env=current_env, timeout=35)
            identity = json.loads(state.read_text()) if state.exists() else None
            observations.append(
                {
                    "role": role,
                    "exit": run.returncode,
                    "identity": identity,
                    "ingressObserved": ingress.exists(),
                    "stderr": run.stderr[-2000:],
                }
            )
        control, protected = observations
        identity = control["identity"] or {}
        record(
            framework + "_configuration_known_load_and_mask",
            control["exit"] == 0
            and identity.get("initialized") is True
            and identity.get("context") == "system_u:system_r:agent_t"
            and identity.get("connectErrno") == 0
            and control["ingressObserved"] is True
            and protected["exit"] == 0
            and protected["identity"] is None
            and protected["ingressObserved"] is False,
            observations=observations,
        )
