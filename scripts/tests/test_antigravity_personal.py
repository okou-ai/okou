"""Exercise native CLI enrollment against a disposable protocol peer."""

import importlib.util
import io
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
import antigravity_personal as native
from antigravity_personal import MODELS, personal_environment, signed_in, verify_model

spec = importlib.util.spec_from_file_location(
    "worker", SCRIPTS / "connect-antigravity-subscription.py"
)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

PEER = r"""#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
assert all(k not in os.environ for k in ("AGY_ADC_AUTH", "GEMINI_API_KEY", "OKOU_ANTIGRAVITY_M2M_TOKEN_FILE", "GOOGLE_APPLICATION_CREDENTIALS"))
home = Path(os.environ["HOME"])
state = home / "fixture-keyring"
if os.environ.get("XDG_RUNTIME_DIR") == str(home / ".run"):
    assert not any(k in os.environ for k in ("DBUS_SESSION_BUS_ADDRESS", "DISPLAY", "WAYLAND_DISPLAY"))
    state = home / ".gemini/antigravity-cli/antigravity-oauth-token"
if "-p" in sys.argv:
    model = sys.argv[sys.argv.index("--model")+1]
    hooks = json.loads(Path(".agents/hooks.json").read_text())
    rule = hooks["okou-sign-in-check"]["PreToolUse"][0]
    assert rule["matcher"] == ".*" and '"decision":"deny"' in rule["hooks"][0]["command"]
    print(json.dumps({"event":"init","init":{"model":model}, "conversation_id":"test"}))
    if (Path(os.environ["HOME"]) / "attempted-tool").exists():
        print(json.dumps({"event":"step_update","step_update":{"step_type":"tool"}}))
    print(json.dumps({"event":"result","result":{"conversation_id":"test","status":"SUCCESS","response":"OK"}}))
    sys.exit(0)
if "--login" in sys.argv:
    state.parent.mkdir(parents=True, exist_ok=True)
    state.write_text("fixture", encoding="ascii")
    state.chmod(0o600)
    sys.exit(0)
for line in sys.stdin:
    req = json.loads(line)
    method, params = req["method"], req["params"]
    msg = {"jsonrpc":"2.0", "id":req["id"]}
    if method == "initialize":
        result = {"protocolVersion":1, "agentInfo":{"name":"Antigravity ACP Server","version":"1.5.15"},
                  "authMethods":[{"id":"oauth-personal"}], "agentCapabilities":{"auth":{"logout":{}}, "sessionCapabilities":{"close":{}}}}
    elif method == "logout":
        state.unlink(missing_ok=True)
        result = {}
    elif method == "session/new":
        assert params["mcpServers"] == [] and params["cwd"] == os.getcwd()
        if not state.exists():
            msg["error"] = {"code":-32000,"message":"Authentication required"}
        result = {"sessionId":"fixture-session"}
    elif method == "session/close":
        assert params["sessionId"] == "fixture-session"
        result = {}
    else:
        raise RuntimeError("No inference may be sent during enrollment")
    if "error" not in msg:
        msg["result"] = result
    print(json.dumps(msg),flush=True)
"""


class EnrollmentTest(unittest.TestCase):
    def setUp(self):
        self.directory = self.enterContext(tempfile.TemporaryDirectory())
        self.enterContext(
            patch.dict(
                os.environ,
                {
                    "HOME": self.directory,
                    "PATH": os.defpath,
                    "AGY_ADC_AUTH": "true",
                    "GEMINI_API_KEY": "fixture-unused",
                    "GOOGLE_APPLICATION_CREDENTIALS": "/not/a/key",
                    "OKOU_ANTIGRAVITY_M2M_TOKEN_FILE": "/never/in/child",
                },
                clear=True,
            )
        )
        self.binary = str(Path(self.directory) / "agy")
        Path(self.binary).write_text(PEER)
        Path(self.binary).chmod(0o700)
        self.enterContext(patch.object(worker, "AGY", self.binary))
        self.enterContext(patch.object(sys.stdin, "isatty", return_value=True))
        self.enterContext(patch("sys.stdout", new_callable=io.StringIO))
        self.record = self.enterContext(
            tempfile.TemporaryFile(mode="w+", encoding="ascii")
        )
        self.binding = uuid4()

    def test_file_login_is_restored_only_for_the_assigned_profile(self):
        homes = [Path(self.directory) / name for name in ("member-a", "member-b")]
        for home in homes:
            home.mkdir(mode=0o700)
        os.environ["DBUS_SESSION_BUS_ADDRESS"] = "unix:path=/never/forward"
        os.environ["DISPLAY"] = ":1"
        os.environ["XDG_STATE_HOME"] = self.directory
        os.environ["OKOU_ANTIGRAVITY_FILE_HOME"] = str(homes[0])
        with patch.object(
            worker, "binding_status", side_effect=["pending", "connected"]
        ):
            worker.connect(self.binding, self.record, self.binary)
        os.environ["OKOU_ANTIGRAVITY_FILE_HOME"] = str(homes[1])
        self.assertFalse(signed_in(self.binary, personal_environment()))
        os.environ["OKOU_ANTIGRAVITY_FILE_HOME"] = str(homes[0])
        self.assertTrue(signed_in(self.binary, personal_environment()))
        self.record.seek(0)
        with patch.object(worker, "binding_status", return_value="disconnected"):
            worker.logout(self.binding, self.record)
        self.assertFalse(signed_in(self.binary, personal_environment()))

    def test_file_mode_rejects_shared_home_or_readable_native_credential(self):
        home = Path(self.directory) / "shared"
        home.mkdir(mode=0o700)
        os.environ["OKOU_ANTIGRAVITY_FILE_HOME"] = str(home)
        home.chmod(0o755)
        with self.assertRaisesRegex(ValueError, "private"):
            personal_environment()
        home.chmod(0o700)
        file = home / ".gemini/antigravity-cli/antigravity-oauth-token"
        file.parent.mkdir(parents=True)
        file.write_text("fixture")
        file.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "private"):
            personal_environment()

    def test_file_profile_rejects_redirected_paths_before_login_or_a_session_bus(self):
        home = Path(self.directory) / "member"
        home.mkdir(mode=0o700)
        os.environ["OKOU_ANTIGRAVITY_FILE_HOME"] = str(home)
        (home / ".gemini").symlink_to(self.directory, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "stay in its profile"):
            personal_environment()
        (home / ".gemini").unlink()
        (home / ".run/bus").touch()
        with self.assertRaisesRegex(ValueError, "session bus"):
            personal_environment()

    def test_opening_browser_terminal_needs_an_explicit_action_before_spending_quota(
        self,
    ):
        os.environ["OKOU_ANTIGRAVITY_FILE_HOME"] = self.directory
        with (
            patch.object(sys, "argv", ["worker", "browser", str(self.binding)]),
            patch.object(worker, "connect") as connect,
            patch.object(worker, "test_models") as verify,
            patch("builtins.input", side_effect=EOFError),
            self.assertRaises(SystemExit),
            patch("sys.stderr", new_callable=io.StringIO),
        ):
            worker.main()
        connect.assert_not_called()
        verify.assert_not_called()
        with (
            patch.object(sys, "argv", ["worker", "browser", str(self.binding)]),
            patch.object(worker, "test_models") as verify,
            patch("builtins.input", return_value="verify"),
        ):
            worker.main()
        self.assertEqual(verify.call_args.args[0], self.binding)

    def test_ssh_entry_accepts_only_a_binding_or_scoped_operation(self):
        command = [
            sys.executable,
            "-E",
            "-s",
            str(SCRIPTS / "connect-antigravity-subscription.py"),
        ]
        for original, reason in [
            (str(self.binding), "Configure an HTTPS Okou API origin"),
            (f"verify {self.binding}", "This profile belongs to a different binding"),
            ("sh -c whoami", "invalid UUID"),
        ]:
            with self.subTest(original=original):
                result = subprocess.run(
                    command,
                    env={**os.environ, "SSH_ORIGINAL_COMMAND": original},
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(reason, result.stderr)
        record = Path(self.directory) / ".local/state/okou/antigravity/binding"
        self.assertEqual(record.stat().st_mode & 0o777, 0o600)

    def test_native_login_confirmation_retry_and_logout(self):
        self.assertFalse(signed_in(self.binary, personal_environment()))
        with patch.object(
            worker,
            "binding_status",
            side_effect=["pending", "connected", "connected", "connected"],
        ) as api:
            worker.connect(self.binding, self.record, self.binary)
            self.record.seek(0)
            worker.connect(self.binding, self.record, self.binary)
            self.assertEqual(
                [call.kwargs for call in api.call_args_list],
                [{}, {"method": "POST"}, {}, {"method": "POST"}],
            )
        self.record.seek(0)
        with patch.object(worker, "binding_status", return_value="disconnected") as api:
            worker.logout(self.binding, self.record)
            api.assert_called_once_with(self.binding, method="DELETE")
        self.assertFalse(signed_in(self.binary, personal_environment()))
        self.record.seek(0)
        self.assertEqual(self.record.read(), "")

    def test_preexisting_unbound_login_cannot_be_claimed(self):
        (Path(self.directory) / "fixture-keyring").touch()
        with patch.object(worker, "binding_status", return_value="pending") as api:
            with self.assertRaisesRegex(ValueError, "fresh native profile"):
                worker.connect(self.binding, self.record, self.binary)
            api.assert_called_once_with(self.binding)

    def test_new_grant_requires_fresh_interactive_login(self):
        self.record.write(str(uuid4()))
        self.record.seek(0)
        (Path(self.directory) / "fixture-keyring").touch()
        with (
            patch.object(worker, "binding_status", return_value="pending") as api,
            patch.object(worker.subprocess, "run", side_effect=OSError("interrupted")),
        ):
            with self.assertRaises(OSError):
                worker.connect(self.binding, self.record, self.binary)
            api.assert_called_once_with(self.binding)
        self.assertFalse(signed_in(self.binary, personal_environment()))

    def test_disconnect_during_native_login_is_not_published(self):
        with (
            patch.object(
                worker,
                "binding_status",
                side_effect=["pending", worker.BindingUnavailable("revoked")],
            ),
            self.assertRaisesRegex(ValueError, "revoked"),
        ):
            worker.connect(self.binding, self.record, self.binary)
        self.assertFalse(signed_in(self.binary, personal_environment()))

    def test_fixed_three_model_probe_rejects_any_tool_use(self):
        self.record.write(str(self.binding))
        self.record.seek(0)
        with patch.object(worker, "binding_status", return_value="connected") as api:
            worker.test_models(self.binding, self.record)
            self.assertEqual(api.call_count, len(MODELS))
            for model in MODELS:
                self.assertIn(f"{model}: OK", sys.stdout.getvalue())
        (Path(self.directory) / "attempted-tool").touch()
        with (
            tempfile.TemporaryDirectory() as workspace,
            self.assertRaisesRegex(ValueError, "attempted to use a tool"),
        ):
            verify_model(self.binary, MODELS[0], personal_environment(), workspace)

    def test_missing_model_does_not_hide_results_for_other_enabled_models(self):
        self.record.write(str(self.binding))
        self.record.seek(0)
        with (
            patch.object(
                native,
                "verify_model",
                side_effect=[ValueError("Unavailable"), None, None],
            ) as verify,
            patch.object(worker, "binding_status", return_value="connected"),
            self.assertRaisesRegex(ValueError, MODELS[0]),
        ):
            worker.test_models(self.binding, self.record)
        self.assertEqual([call.args[1] for call in verify.call_args_list], list(MODELS))
        self.assertIn(f"{MODELS[2]}: OK", sys.stdout.getvalue())

    def test_paid_probes_stop_when_revoked_between_models(self):
        self.record.write(str(self.binding))
        self.record.seek(0)
        with (
            patch.object(native, "verify_model") as verify,
            patch.object(
                worker,
                "binding_status",
                side_effect=["connected", ValueError("revoked")],
            ),
        ):
            with self.assertRaisesRegex(ValueError, "revoked"):
                worker.test_models(self.binding, self.record)
            self.assertEqual(verify.call_count, 1)
            self.assertEqual(verify.call_args.args[1], "gemini-4-neon-medium")


if __name__ == "__main__":
    unittest.main()
