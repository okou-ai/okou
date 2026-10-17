"""Pi resource admission probes for the disposable native Guest only."""

import json
import os
from pathlib import Path

PI_ANCHORS = (
    "/home",
    "/home/user",
    "/home/user/workspace",
    "/home/user/.pi",
    "/home/user/.pi/agent",
    "/home/user/.pi/agent/sessions",
    "/home/user/workspace/.pi",
    "/home/.pi",
    "/.pi",
)


def prepare(fixture, label):
    """Freeze discovery roots while retaining ordinary files and session data."""
    for name in PI_ANCHORS:
        path = Path(name)
        path.mkdir(parents=True, exist_ok=True)
        if name != "/home":
            os.chown(path, 1000, 1000)
        label(path, "resource_anchor_t")
    home = fixture / "pi-resources"
    project = fixture / "project-resources"
    for path in (
        home / "agent" / "sessions",
        home / "agent" / "extensions",
        project / "extensions",
    ):
        path.mkdir(parents=True)
    for path in (home / "agent", project):
        os.chown(path, 1000, 1000)
        label(path, "resource_config_t")
    auth = home / "agent" / "auth.json"
    auth.write_text("{}")
    os.chown(auth, 1000, 1000)
    os.chmod(auth, 0o600)
    label(auth, "agent_state_t")
    (home / "agent/settings.json").write_text(
        json.dumps({"extensions": [], "packages": [], "projectTrusted": True})
    )
    (project / "settings.json").write_text(
        json.dumps({"extensions": [], "packages": []})
    )
    bootstrap = fixture / "bundled-loader-control.mjs"
    bootstrap.write_text("globalThis.PI_BUNDLED_NODE=true;\n")


def loader_script():
    return """globalThis.PI_BUNDLED_NODE=true;
const {createAgentSessionServices}=await import("/usr/local/lib/okou-cli/9.400.3/chunk-D5UXOEXQ.js");
const services=await createAgentSessionServices({cwd:process.cwd(),agentDir:"/home/user/.pi/agent",modelRuntime:{refresh:async()=>{}}});
const result=services.resourceLoader.getExtensions();
console.log(JSON.stringify({extensions:result.extensions.map(e=>e.path),errors:result.errors}));"""
