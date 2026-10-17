import copy
import errno
import json
import os
import select
import signal
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import run as fixture


def transcript():
    checks = [
        {
            "name": name,
            "uid": uid,
            "capEff": "000001ffffffffff" if uid == 0 else "0000000000000000",
            "context": f"system_u:system_r:{domain}",
            "allowed": allowed,
            "result": 0 if allowed else -1,
            "errno": 0 if allowed else errno.EACCES,
            "passed": True,
        }
        for name, (uid, domain, allowed) in fixture.EXPECTED.items()
    ]
    return [
        "OKOU_CALLER_KERNEL "
        + json.dumps(
            {"machine": "x86_64", "release": "fixture", "lsm": "capability,selinux"}
        ),
        *("OKOU_CALLER_CASE " + json.dumps(check) for check in checks),
        "OKOU_CALLER_DONE "
        + json.dumps({"cases": len(checks), "failures": 0, "enforcing": True}),
    ]


class ReceiptTest(unittest.TestCase):
    def test_duplicate_fields_and_non_object_records_fail(self):
        good = transcript()
        for bad in [
            "OKOU_CALLER_KERNEL []",
            'OKOU_CALLER_KERNEL {"machine":"aarch64","machine":"x86_64"}',
        ]:
            with self.subTest(record=bad), self.assertRaises(ValueError):
                fixture.parse_receipt("\n".join([bad, *good[1:]]), "x86_64")

    def test_dropped_root_capabilities_cannot_claim_confinement(self):
        good = transcript()
        index = next(
            i for i, line in enumerate(good) if "root_model_connect_denied" in line
        )
        check = json.loads(good[index].split(" ", 1)[1])
        check["capEff"] = "0000000000000000"
        good[index] = "OKOU_CALLER_CASE " + json.dumps(check)
        with self.assertRaisesRegex(ValueError, "effective capabilities"):
            fixture.parse_receipt("\n".join(good), "x86_64")

    def test_complete_primitive_transcript_is_accepted(self):
        result = fixture.parse_receipt("\n".join(transcript()), "x86_64")
        self.assertEqual(len(result["checks"]), 24)

    def test_missing_duplicate_unknown_and_unfinished_results_fail(self):
        good = transcript()
        variants = [
            good[:-1],
            good[:1] + good[2:],
            good + [good[-1]],
            good[:2] + [good[1]] + good[2:],
        ]
        unknown = json.loads(good[1].split(" ", 1)[1])
        unknown["name"] = "unknown"
        variants.append([good[0], "OKOU_CALLER_CASE " + json.dumps(unknown), *good[2:]])
        variants.append(
            [*good, 'OKOU_CALLER_FATAL {"operation":"failed_setup","errno":13}']
        )
        for lines in variants:
            with self.subTest(lines=lines), self.assertRaises(ValueError):
                fixture.parse_receipt("\n".join(lines), "x86_64")

    def test_access_errors_cannot_masquerade_as_security_denial(self):
        good = transcript()
        denied = next(
            i for i, line in enumerate(good) if "root_model_connect_denied" in line
        )
        allowed = next(
            i for i, line in enumerate(good) if "agent_model_connect" in line
        )
        for index, mutation in [
            (denied, {"errno": errno.ENOENT}),
            (denied, {"result": 0, "errno": 0}),
            (allowed, {"result": -1, "errno": errno.EACCES}),
            (denied, {"uid": 1000}),
            (denied, {"uid": False}),
            (denied, {"context": "system_u:system_r:agent_t"}),
            (denied, {"passed": False}),
            (denied, {"allowed": True}),
        ]:
            lines = copy.copy(good)
            check = json.loads(lines[index].split(" ", 1)[1])
            check.update(mutation)
            lines[index] = "OKOU_CALLER_CASE " + json.dumps(check)
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                fixture.parse_receipt("\n".join(lines), "x86_64")

    def test_summary_and_architecture_must_be_actual_and_complete(self):
        good = transcript()
        for mutation in [
            {"cases": True},
            {"failures": False},
            {"cases": 20},
            {"failures": 1},
            {"enforcing": False},
        ]:
            summary = {"cases": 24, "failures": 0, "enforcing": True, **mutation}
            lines = [*good[:-1], "OKOU_CALLER_DONE " + json.dumps(summary)]
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                fixture.parse_receipt("\n".join(lines), "x86_64")
        with self.assertRaises(ValueError):
            fixture.parse_receipt("\n".join(good), "aarch64")

    def test_copied_bytes_must_match_the_owned_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            source.write_bytes(b"wrong artifact")
            with self.assertRaisesRegex(ValueError, "identity mismatch"):
                fixture.copy_artifact(source, root / "copy", (14, "0" * 64))
            self.assertEqual((root / "copy").read_bytes(), source.read_bytes())


class OwnerTest(unittest.TestCase):
    def test_launch_cancellation_is_delivered_after_process_ownership(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "state.json"
            script = (
                "import json,os,signal,sys; from pathlib import Path; sys.path.insert(0,"
                + repr(str(fixture.HERE))
                + "); import run; state={}; armed=True\ndef audit(event,args):\n global armed\n if event=='subprocess.Popen' and armed:\n  armed=False\n  os.kill(os.getpid(),signal.SIGTERM)\nsys.addaudithook(audit)\ntry: run.run_vm([sys.executable,'-c','print(1)'],Path("
                + repr(str(root / "console"))
                + "),state)\nexcept InterruptedError: pass\nfinally: Path("
                + repr(str(state))
                + ").write_text(json.dumps(state))"
            )
            result = subprocess.run(
                [sys.executable, "-c", script],
                check=False,
                capture_output=True,
                text=True,
                timeout=5,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            observed = json.loads(state.read_text())
            self.assertEqual(observed["cleanup"], "vmm_joined")
            self.assertGreater(observed["vmmPid"], 0)

    def test_exec_restores_the_original_child_and_parent_signal_masks(self):
        with tempfile.TemporaryDirectory() as directory:
            original = signal.pthread_sigmask(signal.SIG_BLOCK, [signal.SIGUSR1])
            try:
                expected = signal.pthread_sigmask(signal.SIG_BLOCK, [])
                log = Path(directory) / "console"
                code = "import json,signal; print(json.dumps(sorted(signal.pthread_sigmask(signal.SIG_BLOCK,[]))))"
                fixture.run_vm([sys.executable, "-c", code], log, {})
                self.assertEqual(json.loads(log.read_text()), sorted(expected))
                self.assertEqual(signal.pthread_sigmask(signal.SIG_BLOCK, []), expected)
            finally:
                signal.pthread_sigmask(signal.SIG_SETMASK, original)

    def test_success_failure_and_timeout_reap_the_owned_process(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for index, code in enumerate(
                [
                    "print('done')",
                    "raise SystemExit(23)",
                    "import signal; signal.pause()",
                ]
            ):
                state = {}
                error = (
                    None if index == 0 else ValueError if index == 1 else TimeoutError
                )
                if error is None:
                    fixture.run_vm(
                        [sys.executable, "-c", code],
                        root / str(index),
                        state,
                        timeout=1,
                    )
                else:
                    with self.assertRaises(error):
                        fixture.run_vm(
                            [sys.executable, "-c", code],
                            root / str(index),
                            state,
                            timeout=1,
                        )
                self.assertEqual(state["cleanup"], "vmm_joined")
                with self.assertRaises(ChildProcessError):
                    os.waitpid(state["vmmPid"], os.WNOHANG)

    def test_log_growth_is_bounded_by_the_child_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "console"
            state = {}
            with self.assertRaises(ValueError):
                fixture.run_vm(
                    [
                        sys.executable,
                        "-c",
                        "import os; os.write(1, b'x' * 262144); os.write(1, b'x')",
                    ],
                    log,
                    state,
                )
            self.assertLessEqual(log.stat().st_size, 131072)
            self.assertEqual(state["cleanup"], "vmm_joined")

    def owner_signal(self, number):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fifo = root / "ready"
            os.mkfifo(fifo)
            ready = os.open(fifo, os.O_RDONLY | os.O_NONBLOCK)
            self.addCleanup(os.close, ready)
            child = (
                "import os,signal\nwith open("
                + repr(str(fifo))
                + ",'w') as ready:\n ready.write(str(os.getpid()))\nsignal.pause()"
            )
            state_path = root / "state.json"
            owner = (
                "import json,sys; from pathlib import Path; sys.path.insert(0,"
                + repr(str(fixture.HERE))
                + "); import run; state={};\ntry: run.run_vm([sys.executable,'-c',"
                + repr(child)
                + "],Path("
                + repr(str(root / "console"))
                + "),state)\nfinally: Path("
                + repr(str(state_path))
                + ").write_text(json.dumps(state))"
            )
            process = subprocess.Popen(
                [sys.executable, "-c", owner],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            try:
                self.assertTrue(
                    select.select([ready], [], [], 10)[0],
                    "native child never reached readiness",
                )
                pid = int(os.read(ready, 128))
                pidfd = os.pidfd_open(pid)
                try:
                    process.send_signal(number)
                    process.wait(timeout=5)
                    self.assertTrue(
                        select.select([pidfd], [], [], 5)[0],
                        "owned child survived owner termination",
                    )
                finally:
                    os.close(pidfd)
                if number != signal.SIGKILL:
                    self.assertEqual(
                        json.loads(state_path.read_text())["cleanup"], "vmm_joined"
                    )
            finally:
                if process.poll() is None:
                    process.kill()
                process.wait(timeout=5)

    def test_owner_cancellation_joins_the_child(self):
        self.owner_signal(signal.SIGTERM)

    def test_owner_sigkill_also_kills_the_execed_vmm(self):
        self.owner_signal(signal.SIGKILL)


if __name__ == "__main__":
    unittest.main()
