#!/usr/bin/env python3
"""Exercise the cleanup CLI with real files/flocks and external command fixtures."""

import json
import os
import select
import signal
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
TOOLS = ROOT / ".github/scripts/runner"

GH = r"""#!/usr/bin/env python3
import fcntl,json,os,re,sys
from pathlib import Path
root=Path(os.environ['FIXTURE']); data=json.loads((root/'github.json').read_text());args=sys.argv[1:]
with (root/'github.log').open('a') as log:log.write(json.dumps(args)+'\n')
if 'graphql' in args:
 query=next(a[6:] for a in args if a.startswith('query='));numbers=[int(n) for n in re.findall(r'pullRequest\(number:(\d+)\)',query)];pulls={}
 for n in numbers:
  locked=True
  for host in ('metal-a','metal-b'):
   path=root/host/'var/lock'/f'vm0-runner-lifecycle-pr-{n}.lock';path.parent.mkdir(parents=True,exist_ok=True)
   with path.open('a') as lock:
    try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);locked=False
    except BlockingIOError:pass
  state='OPEN' if data.get('reopen')==n and locked else 'CLOSED'
  pulls[f'p{n}']={'number':n,'state':state,'createdAt':'2026-10-01T00:00:00Z','closedAt':'2026-10-02T00:00:00Z','headRefName':'reused','headRepository':{'nameWithOwner':'okou-ai/okou'}}
 print(json.dumps({'data':{'repository':pulls}}))
elif any(a.endswith('/actions/runs') for a in args):
 if data.get('api_error'):sys.exit(1)
 if data.get('reopen_during_owners'):
  data['reopen']=data['reopen_during_owners'];(root/'github.json').write_text(json.dumps(data))
 status=next(a.split('=',1)[1] for a in args if a.startswith('status='))
 if status in data.get('run_pages',{}):
  scans=data['run_pages'][status];pages=scans[0]
  if len(scans)>1:
   scans.pop(0);(root/'github.json').write_text(json.dumps(data))
  print(json.dumps(pages));sys.exit(0)
 runs=[dict(r) for r in data.get('runs',[]) if r['status']==status]
 if data.get('churn'):
  for run in runs:run['id']+=len((root/'github.log').read_text().splitlines())
 pages=[{'total_count':len(runs),'workflow_runs':runs[offset:offset+100]} for offset in range(0,min(len(runs),1000),100)]
 print(json.dumps(pages or [{'total_count':0,'workflow_runs':[]}]))
elif any('/actions/runs/' in a for a in args):
 run_id=next(a.rsplit('/',1)[1] for a in args if '/actions/runs/' in a)
 record=data.get('run_details',{}).get(run_id)
 if record is None:sys.exit(1)
 print(json.dumps(record))
elif any('/commits/' in a for a in args):print(json.dumps([[{'number':n} for n in data.get('associated',[])]]))
else:raise SystemExit('unexpected gh call')
"""

SSH = r"""#!/usr/bin/env python3
import json,os,shlex,signal,subprocess,sys
from pathlib import Path
root=Path(os.environ['FIXTURE']);host=sys.argv[1].split('@')[1];args=sys.argv[2:]
if os.environ.get('OFFLINE')==host:sys.exit(255)
if len(args)==1 and args[0].startswith('sudo flock '):
 namespace=os.environ['JOB_REF'];lock=root/host/'var/lock'/f'vm0-runner-lifecycle-{namespace}.lock';lock.parent.mkdir(parents=True,exist_ok=True)
 command=args[0].removeprefix('sudo ').replace(f'/var/lock/vm0-runner-lifecycle-{namespace}.lock',str(lock))
 status=subprocess.call(['bash','-c',command])
 sys.exit(255 if os.environ.get('RELEASE_ERROR') else status)
os.environ['FIXTURE_HOST']=str(root/host)
if args[2]=='-c':
 command=[sys.executable,'-c',shlex.split(args[3])[0],*args[4:],'--root',str(root/host)]
 if os.environ.get('PARTIAL_RELEASE'):
  with subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,bufsize=1) as worker:
   print(worker.stdout.readline(),end='',flush=True)
   for line in sys.stdin:
    worker.stdin.write(line);worker.stdin.flush()
    if json.loads(line)['operation']=='heartbeat':continue
    reply=worker.stdout.readline()
    if json.loads(reply).get('released'):
     worker.stdin.close();worker.wait(timeout=5)
     sys.stdout.write('{"released":');sys.stdout.flush()
     with (root/'reply-ready').open('w') as ready:ready.write(str(os.getpid())+'\n')
     signal.pause()
    print(reply,end='',flush=True)
   worker.stdin.close();sys.exit(worker.wait())
 if os.environ.get('RELEASE_ERROR'):
  subprocess.call(command);sys.exit(255)
 os.execv(sys.executable,command)
os.execv(sys.executable,[sys.executable,*args[2:],'--root',str(root/host)])
"""

SYSTEMCTL = r"""#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
root=Path(os.environ['FIXTURE_HOST']);statefile=root/'states.json';states=json.loads(statefile.read_text()) if statefile.exists() else {};args=sys.argv[1:];op=args[0]
with (root/'systemctl.log').open('a') as log:log.write(json.dumps(args)+'\n')
roots=['etc/systemd/system','run/systemd/system','run/systemd/transient']
files={p.name:'/'+str(p.relative_to(root)) for d in roots for p in (root/d).glob('*.service')}
names=[a for a in args[1:] if a.endswith('.service')]
if os.environ.get('MUTATION_ERROR') and op in ('stop','disable','reset-failed'):
 print('manager rejected '+op,file=sys.stderr);sys.exit(1)
if op=='list-units':
 import fnmatch
 patterns=[a for a in args[1:] if not a.startswith('-')]
 for name in sorted(states):
  if any(fnmatch.fnmatch(name,p) for p in patterns):print(name+' loaded inactive dead Fixture')
elif op=='show':
 if os.environ.get('STATE_ERROR') and (root/'stopped').exists():sys.exit(1)
 if os.environ.get('WAIT_DRAIN') and (root/'stopped').exists() and 'populated 1' in (root/'sys/fs/cgroup/system.slice/fixture.service/cgroup.events').read_text():
  fixture=Path(os.environ['FIXTURE'])
  with (fixture/'drain-ready').open('w') as ready:ready.write('observing\n')
  with (fixture/'drain-advance').open() as advance:advance.readline()
 missing=False
 for name in names:
  state={'Id':name,'LoadState':'loaded' if name in files else 'not-found','ActiveState':'inactive','MainPID':'0','ControlGroup':'','FragmentPath':files.get(name,''),'Job':''};state.update(states.get(name,{}))
  missing=missing or state['LoadState']=='not-found'
  print('\n'.join(k+'='+str(v) for k,v in state.items()));print()
 if missing:sys.exit(4)
elif op in ('stop','reset-failed'):
 if op=='stop' and os.environ.get('BLOCK_STOP'):
  import signal
  with (Path(os.environ['FIXTURE'])/'ready').open('w') as ready:ready.write(str(os.getpid())+'\n')
  signal.pause()
 (root/'stopped').touch()
 for name in names:states.setdefault(name,{}).update(ActiveState='inactive',MainPID='0',Job='')
 if op=='stop':
  for name in names:(root/'run/systemd/transient'/name).unlink(missing_ok=True)
 statefile.write_text(json.dumps(states))
elif op=='disable':
 for d in roots:
  for directory in (root/d).glob('*.wants'):
   for name in names:(directory/name).unlink(missing_ok=True)
elif op=='daemon-reload':
 if os.environ.get('RELOAD_ERROR'):
  print('manager rejected daemon-reload',file=sys.stderr);sys.exit(1)
else:raise SystemExit('unexpected systemctl call')
"""


class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        for name, script in (("gh", GH), ("ssh", SSH), ("systemctl", SYSTEMCTL)):
            path = bin_dir / name
            path.write_text(script)
            path.chmod(0o755)
        for host in ("metal-a", "metal-b"):
            (self.root / host).mkdir()
        self.github()
        self.env = {
            **os.environ,
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "FIXTURE": str(self.root),
            "GH_TOKEN": "fixture",
            "GITHUB_REPOSITORY": "okou-ai/okou",
            "GITHUB_RUN_ID": "123",
            "METAL_HOSTS": "metal-a,metal-b",
            "METAL_USER": "ubuntu",
        }

    def github(self, **data):
        (self.root / "github.json").write_text(json.dumps(data))

    def resource(self, path, host="metal-a", contents="fixture"):
        file = self.root / host / path.lstrip("/")
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(contents)
        return file

    def state(self, name, host="metal-a", **fields):
        file = self.root / host / "states.json"
        states = json.loads(file.read_text()) if file.exists() else {}
        states[name] = fields
        file.write_text(json.dumps(states))

    def worker(self, operation, *numbers, host="metal-a", **env):
        if operation == "cleanup":
            args = [
                sys.executable,
                str(TOOLS / "cleanup-metal-resources.py"),
                "session",
                *map(str, numbers),
                "--root",
                str(self.root / host),
            ]
            with subprocess.Popen(
                args,
                env={**self.env, "FIXTURE_HOST": str(self.root / host), **env},
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            ) as process:
                try:
                    self.assertTrue(select.select([process.stdout], [], [], 5)[0])
                    self.assertEqual(
                        json.loads(process.stdout.readline()),
                        {"ready": sorted(numbers)},
                    )
                    process.stdin.write(
                        json.dumps({"operation": "cleanup", "numbers": list(numbers)})
                        + "\n"
                    )
                    process.stdin.flush()
                    self.assertTrue(select.select([process.stdout], [], [], 5)[0])
                    result = json.loads(process.stdout.readline())["results"]
                    process.stdin.write(json.dumps({"operation": "release"}) + "\n")
                    process.stdin.flush()
                    self.assertTrue(select.select([process.stdout], [], [], 5)[0])
                    self.assertEqual(
                        json.loads(process.stdout.readline()), {"released": True}
                    )
                    process.stdin.close()
                    status = process.wait(timeout=5)
                    return subprocess.CompletedProcess(
                        args, status, json.dumps(result), process.stderr.read()
                    ), result
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.wait(timeout=5)
        result = subprocess.run(
            [
                sys.executable,
                str(TOOLS / "cleanup-metal-resources.py"),
                operation,
                *map(str, numbers),
                "--root",
                str(self.root / host),
            ],
            env={**self.env, "FIXTURE_HOST": str(self.root / host), **env},
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        return result, json.loads(result.stdout) if result.returncode == 0 else None

    def controller(self, **env):
        return subprocess.run(
            [sys.executable, str(TOOLS / "cleanup-metal-runners.py")],
            env={**self.env, **env},
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )

    def owner(self, number=42, associated=True):
        return {
            "id": 10,
            "path": ".github/workflows/crates.yml",
            "event": "pull_request",
            "status": "in_progress",
            "head_sha": "a" * 40,
            "created_at": "2026-11-10T00:00:00Z",
            "head_branch": "reused",
            "head_repository": {"full_name": "okou-ai/okou"},
            "pull_requests": [{"number": number}] if associated else [],
        }

    def test_worker_cleans_files_transient_listener_and_exact_namespace(self):
        runner = self.resource("var/lib/vm0-runner/runners/pr-42-api/config")
        listener = self.resource("var/lib/vm0-runner/stripe/pr-42/config")
        unit = self.resource("etc/systemd/system/vm0-stripe-listener-pr-42.service")
        transient = self.resource(
            "run/systemd/transient/vm0-runner-pr-42-native.service"
        )
        bare = self.resource("etc/systemd/system/vm0-runner-pr-42.service")
        binary = self.resource("var/lib/vm0-runner/bin/pr-42-build/runner")
        group = self.resource("var/lib/vm0-runner/groups/vm0/smoke-pr-42-api/config")
        override = self.resource(
            "etc/systemd/system/vm0-runner-pr-42-api.service.d/50-vm0-drain.conf"
        )
        other = self.resource("var/lib/vm0-runner/runners/pr-420-api/config")
        result, payload = self.worker("cleanup", 42)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(payload["42"]["outcome"], "cleaned")
        for path in (runner, listener, unit, transient, bare, binary, group, override):
            self.assertFalse(path.exists(), path)
        self.assertEqual(other.read_text(), "fixture")
        result, payload = self.worker("cleanup", 42)
        self.assertEqual(payload["42"]["outcome"], "already_absent")
        log = (self.root / "metal-a/systemctl.log").read_text()
        self.assertEqual(log.count('"daemon-reload"'), 1)

    def test_metadata_converges_but_cgroup_execution_stays_actionable(self):
        name = "vm0-runner-pr-42-test-systemd-reload-b.service"
        self.state(name, ActiveState="failed")
        result, payload = self.worker("inventory")
        self.assertIn("42", payload)
        result, payload = self.worker("cleanup", 42)
        self.assertEqual(payload["42"]["outcome"], "cleaned")
        result, payload = self.worker("inventory")
        self.assertEqual(payload, {})
        self.state(name, ControlGroup="/system.slice/fixture.service")
        self.resource(
            "sys/fs/cgroup/system.slice/fixture.service/cgroup.events",
            contents="populated 1\nfrozen 0\n",
        )
        result, payload = self.worker("inventory")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(payload["42"]["units"][0]["state"]["busy"])

    def test_unknown_stop_state_preserves_files_and_fails(self):
        unit = self.resource("etc/systemd/system/vm0-runner-pr-42-api.service")
        config = self.resource("var/lib/vm0-runner/runners/pr-42-api/config")
        result, payload = self.worker("cleanup", 42, STATE_ERROR="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(payload["42"]["outcome"], "unverified")
        self.assertTrue(unit.exists())
        self.assertTrue(config.exists())

    def test_unresolved_teardown_retains_command_errors_but_converged_pr_is_clean(self):
        name = "vm0-runner-pr-42-api.service"
        self.state(name, LoadState="loaded", ActiveState="failed")
        sibling = self.resource("etc/systemd/system/vm0-runner-pr-43-api.service")
        self.github(
            run_pages={
                "queued": [
                    [{"total_count": 1, "workflow_runs": []}],
                ]
            }
        )
        result = self.controller(MUTATION_ERROR="1")
        self.assertEqual(result.returncode, 1, result.stderr)
        records = [
            json.loads(line)
            for line in result.stdout.splitlines()
            if line.startswith("{")
        ]
        decisions = {record["pr"]: record for record in records if "pr" in record}
        failed = decisions[42]["hosts"]["metal-a"]
        self.assertEqual(failed["outcome"], "failed")
        self.assertIn("remaining", failed)
        self.assertIn("manager rejected reset-failed", json.dumps(failed))
        self.assertIn(
            {
                "operation": "reset-failed",
                "returncode": 1,
                "stderr": "manager rejected reset-failed",
            },
            failed["command_errors"],
        )
        converged = decisions[43]["hosts"]["metal-a"]
        self.assertEqual(converged["outcome"], "cleaned")
        self.assertFalse(sibling.exists())
        self.assertNotIn("command_errors", converged)

    def test_reload_failure_retains_completed_operations_without_claiming_success(self):
        unit = self.resource("etc/systemd/system/vm0-runner-pr-42-api.service")
        config = self.resource("var/lib/vm0-runner/stripe/pr-42/config")
        result = self.controller(RELOAD_ERROR="1")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertFalse(unit.exists())
        self.assertFalse(config.exists())
        records = [
            json.loads(line)
            for line in result.stdout.splitlines()
            if line.startswith("{")
        ]
        decision = next(record for record in records if record.get("pr") == 42)
        self.assertEqual(decision["outcome"], "unverified")
        failed = decision["hosts"]["metal-a"]
        self.assertIn("manager rejected daemon-reload", failed["error"])
        self.assertEqual(failed["operation_result"]["outcome"], "cleaned")
        self.assertEqual(failed["operation_result"]["units"], 1)
        self.assertEqual(failed["operation_result"]["directories"], 1)

    def test_pending_systemd_job_is_not_an_empty_manager_record(self):
        name = "vm0-runner-pr-42-api.service"
        self.state(name, LoadState="loaded", Job="91")
        result, payload = self.worker("inventory")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("42", payload)
        result, payload = self.worker("cleanup", 42)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(payload["42"]["outcome"], "cleaned")
        result, payload = self.worker("inventory")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(payload, {})

    def test_cleanup_retains_files_until_cgroup_execution_drains(self):
        name = "vm0-runner-pr-42-api.service"
        unit = self.resource(f"etc/systemd/system/{name}")
        config = self.resource("var/lib/vm0-runner/runners/pr-42-api/config")
        self.state(name, ControlGroup="/system.slice/fixture.service")
        cgroup = self.resource(
            "sys/fs/cgroup/system.slice/fixture.service/cgroup.events",
            contents="populated 1\nfrozen 0\n",
        )
        descriptors = []
        for fifo in ("drain-ready", "drain-advance"):
            path = self.root / fifo
            os.mkfifo(path)
            descriptor = os.open(path, os.O_RDWR | os.O_NONBLOCK)
            self.addCleanup(os.close, descriptor)
            descriptors.append(descriptor)
        ready, advance = descriptors
        with (
            (self.root / "drain.log").open("w") as log,
            subprocess.Popen(
                [sys.executable, str(TOOLS / "cleanup-metal-runners.py")],
                env={**self.env, "WAIT_DRAIN": "1"},
                stdout=log,
                stderr=log,
            ) as process,
        ):
            try:
                # Return a populated cgroup once after stop has returned, then
                # hold the next observation until execution actually drains.
                # Advancing the provider state uses FIFOs, not elapsed time.
                for drained in (False, True):
                    self.assertTrue(
                        select.select([ready], [], [], 5)[0],
                        (self.root / "drain.log").read_text(),
                    )
                    self.assertEqual(os.read(ready, 100), b"observing\n")
                    self.assertTrue(unit.exists())
                    self.assertTrue(config.exists())
                    if drained:
                        cgroup.write_text("populated 0\nfrozen 0\n")
                    os.write(advance, b"continue\n")
                self.assertEqual(process.wait(timeout=10), 0, log.name)
                self.assertFalse(unit.exists())
                self.assertFalse(config.exists())
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=10)

    def test_symlink_resource_does_not_delete_external_target(self):
        target = self.root / "external"
        target.mkdir()
        precious = target / "keep"
        precious.write_text("keep")
        root = self.root / "metal-a/var/lib/vm0-runner/runners"
        root.mkdir(parents=True)
        (root / "pr-42").symlink_to(target, target_is_directory=True)
        result, payload = self.worker("cleanup", 42)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(payload["42"]["outcome"], "cleaned")
        self.assertEqual(precious.read_text(), "keep")

    @unittest.skipIf(os.getuid() == 0, "requires normal filesystem permissions")
    def test_permission_failure_keeps_resource_and_other_pr_progresses(self):
        unit = self.resource("etc/systemd/system/vm0-runner-pr-42-api.service")
        config = self.resource("var/lib/vm0-runner/stripe/pr-43/config")
        unit.parent.chmod(0o500)
        self.addCleanup(unit.parent.chmod, 0o700)
        result, payload = self.worker("cleanup", 42, 43)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(payload["42"]["outcome"], "failed")
        self.assertIn("Permission denied", payload["42"]["error"])
        self.assertIn("remaining", payload["42"])
        self.assertEqual(payload["43"]["outcome"], "cleaned")
        self.assertTrue(unit.exists())
        self.assertFalse(config.exists())

    def test_controller_batches_and_repeat_has_no_empty_teardown(self):
        files = [
            self.resource(f"var/lib/vm0-runner/stripe/pr-{n}/config")
            for n in range(41, 50)
        ]
        result = self.controller()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(all(not file.exists() for file in files))
        self.assertIn('"cleaned": 9', result.stdout)
        log = (self.root / "github.log").read_text()
        # This is the external request budget, not a pin to task ordering:
        # Nine namespaces require at most two stabilized status scans per batch.
        self.assertLessEqual(log.count("/actions/runs"), 20)
        result = self.controller()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('"cleaned"', result.stdout)

    def test_exact_old_head_owner_defers_without_deleting(self):
        config = self.resource("var/lib/vm0-runner/stripe/pr-42/config")
        self.github(runs=[self.owner()])
        result = self.controller()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(config.exists())
        self.assertIn('"deferred_owner": 1', result.stdout)

    def test_persistent_count_drift_preserves_cleanup_outcomes(self):
        config = self.resource("var/lib/vm0-runner/stripe/pr-42/config")
        unrelated = {**self.owner(99), "status": "queued"}
        self.github(
            run_pages={
                "queued": [
                    [{"total_count": 2, "workflow_runs": [unrelated]}],
                ]
            }
        )
        result = self.controller()
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertFalse(config.exists())
        decision = next(
            json.loads(line)
            for line in result.stdout.splitlines()
            if line.startswith('{"pr":42,')
        )
        self.assertEqual(decision["outcome"], "cleaned")
        self.assertEqual(decision["hosts"]["metal-a"]["outcome"], "cleaned")
        self.assertEqual(decision["hosts"]["metal-b"]["outcome"], "already_absent")

    def test_disappeared_run_is_rechecked_before_cleanup(self):
        unrelated = {**self.owner(99), "id": 20}
        complete = [{"total_count": 1, "workflow_runs": [unrelated]}]
        initial = [{"total_count": 2, "workflow_runs": [self.owner(), unrelated]}]
        for status in ("queued", "completed", None, "unknown", "wrong_identity"):
            with self.subTest(status=status):
                config = self.resource("var/lib/vm0-runner/stripe/pr-42/config")
                refreshed = {**self.owner(), "status": status}
                if status == "wrong_identity":
                    refreshed.update(id=11, status="queued")
                self.github(
                    run_pages={"in_progress": [initial, complete]},
                    run_details={"10": refreshed} if status else {},
                )
                result = self.controller()
                self.assertEqual(
                    result.returncode,
                    int(status not in {"queued", "completed"}),
                    result.stderr,
                )
                self.assertEqual(config.exists(), status != "completed")
                outcome = {
                    "queued": "deferred_owner",
                    "completed": "cleaned",
                    None: "unverified",
                    "unknown": "unverified",
                    "wrong_identity": "unverified",
                }[status]
                self.assertIn(f'"{outcome}": 1', result.stdout)

    def test_duplicate_pages_with_count_drift_resolve_distinct_owners(self):
        for number in (99, 42):
            with self.subTest(number=number):
                config = self.resource("var/lib/vm0-runner/stripe/pr-42/config")
                owner = {**self.owner(number), "status": "queued"}
                self.github(
                    run_pages={
                        "queued": [
                            [
                                {"total_count": 3, "workflow_runs": [owner]},
                                {"total_count": 3, "workflow_runs": [owner]},
                            ],
                        ]
                    },
                )
                result = self.controller()
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(config.exists(), number == 42)
                decision = next(
                    json.loads(line)
                    for line in result.stdout.splitlines()
                    if line.startswith('{"pr":42,')
                )
                if number == 42:
                    self.assertEqual(decision["outcome"], "deferred_owner")
                    self.assertEqual(decision["runs"], [10])
                else:
                    self.assertEqual(decision["outcome"], "cleaned")

    def test_repeatedly_missing_owner_is_retained_across_changing_sweeps(self):
        configs = [
            self.resource(f"var/lib/vm0-runner/stripe/pr-{number}/config")
            for number in (42, 43)
        ]
        first = self.owner()
        second = {**self.owner(43), "id": 20}
        self.github(
            run_pages={
                "in_progress": [
                    [{"total_count": 1, "workflow_runs": [first]}],
                    [{"total_count": 1, "workflow_runs": [second]}],
                ]
            },
            run_details={"10": {**first, "status": "queued"}},
        )
        result = self.controller()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(all(config.exists() for config in configs))
        records = [
            json.loads(line)
            for line in result.stdout.splitlines()
            if line.startswith('{"pr":')
        ]
        decisions = {record["pr"]: record for record in records}
        self.assertEqual(decisions[42]["outcome"], "deferred_owner")
        self.assertEqual(decisions[42]["runs"], [10])
        self.assertEqual(decisions[43]["outcome"], "deferred_owner")
        self.assertEqual(decisions[43]["runs"], [20])

    def test_selected_owner_churn_is_bounded_and_retains_resources(self):
        config = self.resource("var/lib/vm0-runner/stripe/pr-42/config")
        runs = [{**self.owner(), "id": run_id} for run_id in (10, 20, 30, 40)]
        self.github(
            run_pages={
                "in_progress": [
                    [{"total_count": 1, "workflow_runs": [run]}] for run in runs
                ]
            },
            run_details={
                str(run["id"]): {**run, "status": "completed"} for run in runs
            },
        )
        result = self.controller()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertTrue(config.exists())
        self.assertIn('"unverified": 1', result.stdout)
        self.assertIn("selected owner discovery did not stabilize", result.stdout)

    def test_search_cap_on_later_sweep_retains_resources(self):
        config = self.resource("var/lib/vm0-runner/stripe/pr-42/config")
        self.github(
            run_pages={
                "queued": [
                    [{"total_count": 0, "workflow_runs": []}],
                    [{"total_count": 1000, "workflow_runs": []}],
                ]
            }
        )
        result = self.controller()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertTrue(config.exists())
        self.assertIn('"unverified": 1', result.stdout)

    def test_capped_owner_search_retains_unlisted_owner_resources(self):
        newest = [
            {**self.owner(number=100 + index), "id": 2000 - index}
            for index in range(1000)
        ]
        for reported in (999, 1001):
            with self.subTest(reported=reported):
                config = self.resource("var/lib/vm0-runner/stripe/pr-42/config")
                self.github(
                    run_pages={
                        "in_progress": [
                            [
                                {
                                    "total_count": reported,
                                    "workflow_runs": newest[offset : offset + 100],
                                }
                                for offset in range(0, 1000, 100)
                            ]
                        ]
                    }
                )
                result = self.controller()
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertTrue(config.exists())
                self.assertIn('"unverified": 1', result.stdout)

    def test_unrelated_run_churn_does_not_block_selected_namespace(self):
        config = self.resource("var/lib/vm0-runner/stripe/pr-42/config")
        self.github(runs=[self.owner(99)], churn=True)
        result = self.controller()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(config.exists())

    def test_reused_branch_resolves_new_pr_and_cleans_old_namespace(self):
        configs = [
            self.resource(f"var/lib/vm0-runner/stripe/pr-{number}/config")
            for number in range(41, 50)
        ]
        self.github(runs=[self.owner(associated=False)], associated=[99])
        result = self.controller()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(all(not config.exists() for config in configs))
        self.assertEqual((self.root / "github.log").read_text().count("/commits/"), 1)

    def test_ambiguous_owner_or_api_failure_retains_resources(self):
        for github in ({"runs": [self.owner(associated=False)]}, {"api_error": True}):
            with self.subTest(github=github):
                config = self.resource("var/lib/vm0-runner/stripe/pr-42/config")
                self.github(**github)
                result = self.controller()
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertTrue(config.exists())
                self.assertIn('"unverified": 1', result.stdout)

    def test_historical_run_ambiguity_is_not_overridden_by_new_commit_association(self):
        config = self.resource("var/lib/vm0-runner/stripe/pr-42/config")
        owner = self.owner(associated=False)
        owner["created_at"] = "2026-10-01T12:00:00Z"
        owner["head_branch"] = "branch-before-rename"
        self.github(runs=[owner], associated=[99])
        result = self.controller()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertTrue(config.exists())
        self.assertIn('"unverified": 1', result.stdout)

    def test_reopened_under_lock_keeps_resources(self):
        config = self.resource("var/lib/vm0-runner/stripe/pr-42/config")
        self.github(reopen=42)
        result = self.controller()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(config.exists())
        self.assertIn('"skipped_open": 1', result.stdout)

    def test_reopened_during_owner_discovery_keeps_resources(self):
        reopened = self.resource("var/lib/vm0-runner/stripe/pr-42/config")
        closed = self.resource("var/lib/vm0-runner/stripe/pr-43/config")
        self.github(reopen_during_owners=42)
        result = self.controller()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(reopened.exists())
        self.assertFalse(closed.exists())
        self.assertIn('"skipped_open": 1', result.stdout)

    def test_dry_run_and_missing_host_preserve_resources(self):
        config = self.resource("var/lib/vm0-runner/stripe/pr-42/config")
        result = self.controller(DRY_RUN="true")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(config.exists())
        self.assertIn('"candidates": [42]', result.stdout)
        result = self.controller(OFFLINE="metal-b")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertTrue(config.exists())

    def test_namespace_selection_is_explicit_and_fails_closed(self):
        selected = self.resource("var/lib/vm0-runner/stripe/pr-42/config")
        other = self.resource("var/lib/vm0-runner/stripe/pr-43/config")
        result = self.controller(RUNNER_PR_NUMBERS=" ")
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertTrue(selected.exists())
        self.assertTrue(other.exists())
        result = self.controller(RUNNER_PR_NUMBERS=" 42, 9999 ")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(selected.exists())
        self.assertTrue(other.exists())

    def test_release_failure_does_not_claim_workflow_success(self):
        config = self.resource("var/lib/vm0-runner/stripe/pr-42/config")
        result = self.controller(RELEASE_ERROR="1")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertFalse(config.exists())
        self.assertIn('"unverified": 1', result.stdout)
        self.assertIn('"resource_result":{"hosts":', result.stdout)

    def test_partial_release_reply_obeys_deadline_and_preserves_resource_receipt(self):
        config = self.resource("var/lib/vm0-runner/stripe/pr-42/config")
        ready = self.root / "reply-ready"
        os.mkfifo(ready)
        descriptor = os.open(ready, os.O_RDWR | os.O_NONBLOCK)
        self.addCleanup(os.close, descriptor)
        with (
            (self.root / "partial-reply.log").open("w") as log,
            subprocess.Popen(
                [sys.executable, str(TOOLS / "cleanup-metal-runners.py")],
                env={**self.env, "PARTIAL_RELEASE": "1", "METAL_HOSTS": "metal-a"},
                stdout=log,
                stderr=log,
            ) as process,
        ):
            try:
                self.assertTrue(
                    select.select([descriptor], [], [], 10)[0],
                    (self.root / "partial-reply.log").read_text(),
                )
                proxy = int(os.read(descriptor, 100).decode().strip())
                self.assertEqual(process.wait(timeout=10), 1)
                self.assertFalse(config.exists())
                self.assertFalse(Path(f"/proc/{proxy}").exists())
                subprocess.run(
                    [
                        "flock",
                        "--exclusive",
                        "--timeout",
                        "1",
                        str(
                            self.root
                            / "metal-a/var/lock/vm0-runner-lifecycle-pr-42.lock"
                        ),
                        "true",
                    ],
                    check=True,
                )
                output = (self.root / "partial-reply.log").read_text()
                records = [
                    json.loads(line)
                    for line in output.splitlines()
                    if line.startswith("{")
                ]
                result = next(record for record in records if record.get("pr") == 42)
                self.assertEqual(result["outcome"], "unverified")
                self.assertIn(
                    "worker response deadline exceeded", result["lifecycle_error"]
                )
                self.assertEqual(
                    result["resource_result"]["hosts"]["metal-a"]["outcome"], "cleaned"
                )
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=10)

    def test_cancellation_retires_nested_holders_and_remote_commands(self):
        self.assert_cancellation_retires_resources(signal.SIGTERM)

    def test_interrupt_retires_nested_holders_and_remote_commands(self):
        self.assert_cancellation_retires_resources(signal.SIGINT)

    def assert_cancellation_retires_resources(self, cancellation_signal):
        unit = self.resource("etc/systemd/system/vm0-runner-pr-42-api.service")
        for number in range(41, 49):
            self.resource(f"etc/systemd/system/vm0-runner-pr-{number}-api.service")
        ready = self.root / "ready"
        os.mkfifo(ready)
        descriptor = os.open(ready, os.O_RDWR | os.O_NONBLOCK)
        self.addCleanup(os.close, descriptor)
        with (
            (self.root / "cancel.log").open("w") as log,
            subprocess.Popen(
                [sys.executable, str(TOOLS / "cleanup-metal-runners.py")],
                env={**self.env, "BLOCK_STOP": "1"},
                stdout=log,
                stderr=log,
            ) as process,
        ):
            try:
                readable, _, _ = select.select([descriptor], [], [], 10)
                self.assertTrue(readable, (self.root / "cancel.log").read_text())
                child = int(os.read(descriptor, 100).decode().strip())
                process.send_signal(cancellation_signal)
                self.assertEqual(process.wait(timeout=10), 128 + cancellation_signal)
                self.assertTrue(unit.exists())
                for host in ("metal-a", "metal-b"):
                    for number in range(41, 49):
                        subprocess.run(
                            [
                                "flock",
                                "--exclusive",
                                "--timeout",
                                "1",
                                str(
                                    self.root
                                    / host
                                    / "var/lock"
                                    / f"vm0-runner-lifecycle-pr-{number}.lock"
                                ),
                                "true",
                            ],
                            check=True,
                        )
                state = Path(f"/proc/{child}/stat")
                self.assertTrue(
                    not state.exists() or state.read_text().split()[2] == "Z"
                )
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=10)

    def test_worker_deadline_stops_the_batch_and_reaps_systemctl(self):
        first = self.resource("etc/systemd/system/vm0-runner-pr-41-api.service")
        second = self.resource("var/lib/vm0-runner/stripe/pr-42/config")
        os.mkfifo(self.root / "ready")
        descriptor = os.open(self.root / "ready", os.O_RDWR | os.O_NONBLOCK)
        self.addCleanup(os.close, descriptor)
        with subprocess.Popen(
            [
                sys.executable,
                str(TOOLS / "cleanup-metal-resources.py"),
                "session",
                "41",
                "42",
                "--root",
                str(self.root / "metal-a"),
            ],
            env={
                **self.env,
                "BLOCK_STOP": "1",
                "FIXTURE_HOST": str(self.root / "metal-a"),
            },
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        ) as process:
            try:
                self.assertTrue(select.select([process.stdout], [], [], 5)[0])
                self.assertEqual(
                    json.loads(process.stdout.readline()), {"ready": [41, 42]}
                )
                process.stdin.write(
                    json.dumps({"operation": "cleanup", "numbers": [41, 42]}) + "\n"
                )
                process.stdin.flush()
                readable, _, _ = select.select([descriptor], [], [], 5)
                self.assertTrue(readable)
                child = int(os.read(descriptor, 100).decode().strip())
                process.send_signal(signal.SIGALRM)
                self.assertEqual(process.wait(timeout=5), 124, process.stderr.read())
                self.assertTrue(first.exists())
                self.assertTrue(second.exists())
                self.assertFalse(Path(f"/proc/{child}").exists())
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)

    def test_worker_eof_stops_mutation_before_releasing_its_own_locks(self):
        first = self.resource("etc/systemd/system/vm0-runner-pr-41-api.service")
        second = self.resource("var/lib/vm0-runner/stripe/pr-42/config")
        os.mkfifo(self.root / "ready")
        descriptor = os.open(self.root / "ready", os.O_RDWR | os.O_NONBLOCK)
        self.addCleanup(os.close, descriptor)
        with subprocess.Popen(
            [
                sys.executable,
                str(TOOLS / "cleanup-metal-resources.py"),
                "session",
                "41",
                "42",
                "--root",
                str(self.root / "metal-a"),
            ],
            env={
                **self.env,
                "BLOCK_STOP": "1",
                "FIXTURE_HOST": str(self.root / "metal-a"),
            },
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        ) as process:
            try:
                self.assertTrue(select.select([process.stdout], [], [], 5)[0])
                self.assertEqual(
                    json.loads(process.stdout.readline()), {"ready": [41, 42]}
                )
                process.stdin.write(
                    json.dumps({"operation": "cleanup", "numbers": [41, 42]}) + "\n"
                )
                process.stdin.flush()
                self.assertTrue(select.select([descriptor], [], [], 5)[0])
                child = int(os.read(descriptor, 100).decode().strip())
                process.stdin.close()
                self.assertEqual(process.wait(timeout=5), 143)
                self.assertTrue(first.exists())
                self.assertTrue(second.exists())
                self.assertFalse(Path(f"/proc/{child}").exists())
                for number in (41, 42):
                    subprocess.run(
                        [
                            "flock",
                            "--exclusive",
                            "--timeout",
                            "1",
                            str(
                                self.root
                                / "metal-a/var/lock"
                                / f"vm0-runner-lifecycle-pr-{number}.lock"
                            ),
                            "true",
                        ],
                        check=True,
                    )
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)

    def test_listener_replacement_shares_namespace_exclusion_and_preserves_failure(
        self,
    ):
        ansible = self.root / "bin/ansible-playbook"
        ansible.write_text(r"""#!/usr/bin/env python3
import fcntl,os,sys
from pathlib import Path
root=Path(os.environ['FIXTURE'])
for host in ('metal-a','metal-b'):
 with (root/host/'var/lock'/'vm0-runner-lifecycle-pr-42.lock').open('a') as lock:
  try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:pass
  else:raise SystemExit('listener lifecycle ran outside namespace exclusion')
if 'playbooks/cleanup-stripe-listener.yml' in sys.argv:
 if os.environ.get('FAIL_REPLACEMENT'):sys.exit(1)
else:(root/'listener-started').write_text('started')
""")
        ansible.chmod(0o755)
        args = [
            "bash",
            str(TOOLS / "with-runner-lifecycle-lock.sh"),
            "bash",
            str(TOOLS / "start-stripe-listener.sh"),
        ]
        env = {
            **self.env,
            "JOB_REF": "pr-42",
            "API_PREVIEW_URL": "https://preview.example.test",
            "STRIPE_SECRET_KEY": "fixture",
        }
        result = subprocess.run(
            args,
            env={**env, "FAIL_REPLACEMENT": "1"},
            capture_output=True,
            text=True,
            check=False,
            timeout=10,
        )
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertFalse((self.root / "listener-started").exists())
        result = subprocess.run(
            args, env=env, capture_output=True, text=True, check=False, timeout=10
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / "listener-started").read_text(), "started")


if __name__ == "__main__":
    unittest.main()
