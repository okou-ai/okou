#!/usr/bin/env python3
"""Exercise the cleanup CLI with real files/flocks and external command fixtures."""

import contextlib
import fcntl
import json
import os
import select
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
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
  reopened = data.get('reopen') == n
  if locked and data.get('reopen_after_recovery') == n:
   reopened = (root / 'metal-a/ssh.log').read_text().count('session\n') == 2
  state = 'OPEN' if locked and reopened else 'CLOSED'
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
 if data.get('hide_owners_after_recovery') and (root / 'metal-a/ssh.log').read_text().count('session\n') == 2:
  runs=[]
 if data.get('churn'):
  for run in runs:run['id']+=len((root/'github.log').read_text().splitlines())
 pages=[{'total_count':len(runs),'workflow_runs':runs[offset:offset+100]} for offset in range(0,min(len(runs),1000),100)]
 print(json.dumps(pages or [{'total_count':0,'workflow_runs':[]}]))
elif any('/actions/runs/' in a for a in args):
 run_id=next(a.rsplit('/',1)[1] for a in args if '/actions/runs/' in a)
 record=data.get('run_details',{}).get(run_id)
 if record is None:sys.exit(1)
 print(record['created_at'] if '--jq' in args else json.dumps(record))
elif any('/commits/' in a for a in args):print(json.dumps([[{'number':n} for n in data.get('associated',[])]]))
else:raise SystemExit('unexpected gh call')
"""

SSH = r"""#!/usr/bin/env python3
import fcntl,json,os,select,shlex,signal,subprocess,sys
from pathlib import Path
root = Path(os.environ['FIXTURE'])
if sys.argv[1:4] == ['-v', '-n', '-T'] and sys.argv[-1] == 'true':
 print(f"debug1: fixture probe for {sys.argv[-2]}", file=sys.stderr)
 sys.exit(0)
host = sys.argv[1].split('@')[1].removesuffix('.vm3.ai')
args = sys.argv[2:]

def await_event(name):
 with (root / name).open() as event:
  assert select.select([event], [], [], 10)[0], name
  assert event.readline() == 'ready\n'

history=root/host/'ssh.log'
if args[:4]==['sudo','python3','-','inventory']:
 with history.open('a') as log:log.write('inventory\n')
 if host=='metal-b':
  failure=os.environ.get('INVENTORY_FAILURE')
  if failure=='reset-once' and history.read_text()=='inventory\n':
   print('{"9999":',flush=True);sys.exit(255)
  if failure=='command':sys.exit(7)
  if failure=='malformed':print('{"9999":');sys.exit(0)
elif args[:3]==['sudo','python3','-c'] and args[4:5]==['session']:
 with history.open('a') as log:log.write('session\n')
if os.environ.get('OFFLINE')==host:sys.exit(255)
if len(args)==1 and args[0].startswith('sudo bash -c '):
 namespace=os.environ['JOB_REF'];lock=root/host/'var/lock'/f'vm0-runner-lifecycle-{namespace}.lock';lock.parent.mkdir(parents=True,exist_ok=True)
 command=args[0].removeprefix('sudo ').replace(f'/var/lock/vm0-runner-lifecycle-{namespace}.lock',str(lock))
 command=command.replace('/run/vm0-runner-lifecycle-receipts',str(root/host/'receipts'))
 status=subprocess.call(['bash','-c',command])
 sys.exit(255 if os.environ.get('RELEASE_ERROR') else status)
os.environ['FIXTURE_HOST']=str(root/host)
if args[2]=='-c':
 source=shlex.split(args[3])[0]
 if os.environ.get('STOP_CLOCK_STEP'):
  source='import runpy;runpy.run_path('+repr(str(root/'clock.py'))+');'+source
 command=[sys.executable,'-c',source,*args[4:],'--root',str(root/host)]
 failure = os.environ.get('READY_FAILURE')
 prior_lost = failure in ('prior-lost', 'prior-lost-command', 'prior-lost-repeat')
 session_count = history.read_text().count('session\n')
 if prior_lost and host == 'metal-a' and session_count == 1:
  with subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True) as worker:
   print(worker.stdout.readline(), end='', flush=True)
   await_event('disconnect-a')
   worker.stdin.close()
   worker.wait(timeout=5)
  sys.exit(7 if failure == 'prior-lost-command' else 255)
 if prior_lost and host == 'metal-a':
  # Reacquiring the first host while retaining B would invert lock order.
  for number in args[5:]:
   path = root / 'metal-b/var/lock' / f'vm0-runner-lifecycle-pr-{number}.lock'
   with path.open() as lock:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
  if failure == 'prior-lost-repeat':
   sys.exit(255)
 failure = failure if host == 'metal-b' else None
 if failure == 'invalid':
  print('{"ready":[]}')
  sys.exit(255)
 if failure == 'command':
  sys.exit(7)
 if failure == 'reset-always' or (
  (failure == 'reset-once' or (prior_lost and host == 'metal-b')) and session_count == 1
 ):
  with subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True) as worker:
   assert json.loads(worker.stdout.readline()) == {'ready': [int(n) for n in args[5:]]}
   sys.stdout.write('{"ready":')
   sys.stdout.flush()
   worker.stdin.close()
   worker.wait(timeout=5)
  sys.exit(255)
 retiring_b = prior_lost and host == 'metal-b' and session_count == 2
 if retiring_b:
  (root / 'disconnect-a').write_text('ready\n')
  await_event('diagnosing-a')
 if retiring_b or os.environ.get('PARTIAL_RELEASE'):
  with subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,bufsize=1) as worker:
   print(worker.stdout.readline(),end='',flush=True)
   for line in sys.stdin:
    worker.stdin.write(line);worker.stdin.flush()
    if json.loads(line)['operation']=='heartbeat':continue
    reply=worker.stdout.readline()
    if json.loads(reply).get('released'):
     if retiring_b:
      (root / 'released-b').touch()
      drop_receipt = os.environ.get('DROP_RESTART_RELEASE')
      if not drop_receipt:
       print(reply, end='', flush=True)
      worker.stdin.close()
      status = worker.wait(timeout=5)
      sys.exit(255 if drop_receipt else status)
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

BLOCKED_DIAGNOSTICS = r"""
import os
import sys
import time
from pathlib import Path

args = sys.argv[1:]
if len(args) == 3 and args[1] == "master":
    probe = Path(args[2]).read_text()
    failure = os.environ.get("READY_FAILURE")
    if failure in ("prior-lost", "prior-lost-command", "prior-lost-repeat") and "metal-a.vm3.ai" in probe:
        root = Path(os.environ["FIXTURE"])
        (root / "diagnosing-a").write_text("ready\n")
        # Keep the wrapper alive briefly after the native command closes.
        time.sleep(1.5)
    elif failure == "reset-once" and "metal-b.vm3.ai" in probe:
        # Reproduce diagnostics finishing after the former five-second exit wait.
        time.sleep(6)
os.execv(sys.executable, [sys.executable, *args])
"""

CLOCK = r"""import os,sys,threading,time
from pathlib import Path
clock=Path(os.environ['FIXTURE_HOST'])/'clock';clock.write_text('0')
real_monotonic=time.monotonic;real_sleep=time.sleep;owner=threading.current_thread()
def controlled():
 # Keep subprocess transport and heartbeat clocks real while advancing the CLI.
 return threading.current_thread() is owner and sys._getframe(2).f_globals.get('__name__')=='__main__'
def monotonic():
 return real_monotonic()+float(clock.read_text()) if controlled() else real_monotonic()
def sleep(seconds):
 if controlled():
  clock.write_text(str(float(clock.read_text())+max(seconds,float(os.environ['STOP_CLOCK_STEP']))))
 else:real_sleep(seconds)
time.monotonic=monotonic;time.sleep=sleep
"""

SYSTEMCTL = r"""#!/usr/bin/env python3
import fcntl,json,os,sys,time
from pathlib import Path
root=Path(os.environ['FIXTURE_HOST']);statefile=root/'states.json';states=json.loads(statefile.read_text()) if statefile.exists() else {};args=sys.argv[1:];op=args[0]
jobsfile=root/'stop-jobs.json';jobs=json.loads(jobsfile.read_text()) if jobsfile.exists() else {}
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
 if '--property=LoadState,FragmentPath,NeedDaemonReload' in args:
  name,=names
  print('LoadState=loaded')
  print('FragmentPath='+str(root/files[name].lstrip('/')))
  print('NeedDaemonReload='+('yes' if os.environ.get('STALE_STRIPE_UNIT') else 'no'))
  sys.exit(0)
 if os.environ.get('STATE_ERROR') and (root/'stopped').exists():sys.exit(1)
 if os.environ.get('WAIT_DRAIN') and (root/'stopped').exists() and 'populated 1' in (root/'sys/fs/cgroup/system.slice/fixture.service/cgroup.events').read_text():
  fixture=Path(os.environ['FIXTURE'])
  with (fixture/'drain-ready').open('w') as ready:ready.write('observing\n')
  with (fixture/'drain-advance').open() as advance:advance.readline()
 for name in names:
  if name in jobs and jobs[name] is not None and float((root/'clock').read_text())>=jobs[name]:
   states[name].update(ActiveState='inactive',MainPID='0',Job='')
   (root/'run/systemd/transient'/name).unlink(missing_ok=True)
   del jobs[name]
 statefile.write_text(json.dumps(states));jobsfile.write_text(json.dumps(jobs))
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
 delaysfile=root/'stop-delays.json';delays=json.loads(delaysfile.read_text()) if delaysfile.exists() else {}
 for name in names:
  if op=='stop' and name in delays:
   states.setdefault(name,{}).update(ActiveState='deactivating',Job='91')
   jobs[name]=None if delays[name] is None else float((root/'clock').read_text())+delays[name]
  else:states.setdefault(name,{}).update(ActiveState='inactive',MainPID='0',Job='')
 if op=='stop':
  for name in names:
   if name not in jobs:(root/'run/systemd/transient'/name).unlink(missing_ok=True)
 statefile.write_text(json.dumps(states));jobsfile.write_text(json.dumps(jobs))
 if op=='reset-failed' and os.environ.get('PAUSE_CLEANUP_BEFORE_RELOAD'):
  (root/'cleanup-wrote-unit-files').touch()
  deadline=time.monotonic()+4
  while not (root/'cleanup-can-reload').exists():
   assert time.monotonic()<deadline
   time.sleep(.02)
elif op=='disable':
 for d in roots:
  for directory in (root/d).glob('*.wants'):
   for name in names:(directory/name).unlink(missing_ok=True)
elif op=='start':
 name,=names
 ref=name.removeprefix('vm0-stripe-listener-').removesuffix('.service')
 directory=root/'var/lib/vm0-runner/stripe'/ref
 with (root/'var/lock'/f'vm0-runner-lifecycle-{ref}.lock').open() as lock:
  try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:pass
  else:raise SystemExit('Stripe listener started outside the lifecycle lock')
 assert (directory/'bin/stripe').is_file()
 assert not states.get(name,{}).get('Job')
 states[name]={'ActiveState':'active','MainPID':'123'}
 statefile.write_text(json.dumps(states))
 (directory/'stripe-listen.log').write_text('Ready! Your webhook signing secret is fixture\n')
elif op=='is-active':
 sys.exit(0 if all(states[name]['ActiveState']=='active' for name in names) else 3)
elif op=='daemon-reload':
 if os.environ.get('RELOAD_ERROR'):
  print('manager rejected daemon-reload',file=sys.stderr);sys.exit(1)
else:raise SystemExit('unexpected systemctl call')
"""

STRIPE_SSH = r"""#!/usr/bin/env python3
import json,os,shlex,subprocess,sys
from pathlib import Path
fixture=Path(os.environ['FIXTURE'])
assert sys.argv[1:3]==['-T','ubuntu@metal-b']
args=shlex.split(sys.argv[3])
assert args[:5]==['sudo','-n','/usr/bin/python3','-I','-c']
root=fixture/'metal-b'
submit=len(args)==7
with (root/'stripe-ssh.log').open('a') as log:
 log.write(('submit' if submit else 'observe')+'\n')
result=subprocess.run(
 [sys.executable,*args[3:6],str(root),*args[7:]],
 stdout=subprocess.PIPE,text=True,check=False,
 env={**os.environ,'FIXTURE_HOST':str(root),'PATH':str(fixture/'stripe-bin')+':'+os.environ['PATH']},
)
if not result.returncode:
 if submit and os.environ.get('DROP_STRIPE_REPLIES'):
  print('{"operation":',end='')
  sys.exit(255)
 if not submit and os.environ.get('DROP_STRIPE_REPLIES'):
  record=json.loads(result.stdout)['record']
  lost=root/'ready-reply-lost'
  if record and record['status']=='ready' and not lost.exists():
   lost.touch()
   sys.exit(255)
print(result.stdout,end='')
sys.exit(result.returncode)
"""

STRIPE_SYSTEMD_RUN = r"""#!/usr/bin/env python3
import os,subprocess,sys
from pathlib import Path
root=Path(os.environ['FIXTURE_HOST'])
args=sys.argv[sys.argv.index('/usr/bin/python3'):]
with (root/'stripe-worker.log').open('a') as log:
 subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
"""

STRIPE_INSTALL = r"""#!/usr/bin/env python3
import os,sys
from pathlib import Path
assert len(sys.argv)==2 and Path(sys.argv[1]).name=='ensure-stripe-cli.sh'
directory=Path(os.environ['STRIPE_CLI_INSTALL_DIR'])
directory.mkdir()
(directory/'stripe').touch()
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
        (self.root / "clock.py").write_text(CLOCK)
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
                        json.dumps(
                            {
                                "operation": "cleanup",
                                "closedAt": dict.fromkeys(
                                    numbers, "2026-10-02T00:00:00Z"
                                ),
                            }
                        )
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

    def guarded_controller(self, **env):
        bin_dir = self.root / "bin"
        fake_ssh = (bin_dir / "ssh").rename(bin_dir / "real-ssh")
        (bin_dir / "ssh").symlink_to(TOOLS / "cloudflare-ssh-command.sh")
        python = bin_dir / "python3"
        python.write_text(f"#!{sys.executable}\n{BLOCKED_DIAGNOSTICS}")
        python.chmod(0o755)
        transport_state = self.root / "transport"
        transport_state.mkdir()
        return self.controller(
            METAL_HOSTS="metal-a.vm3.ai,metal-b.vm3.ai",
            RUNNER_TEMP=str(self.root),
            OKOU_CLOUDFLARE_SSH_REAL_SSH=str(fake_ssh),
            OKOU_CLOUDFLARE_SSH_SCRIPTS_DIR=str(TOOLS),
            OKOU_CLOUDFLARE_SSH_STATE_DIR=str(transport_state),
            **env,
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

    def test_image_unit_associates_exact_namespace_and_retires_execution(self):
        for number, digit in ((42, "a"), (420, "b")):
            identity = digit * 64
            name = f"vm0-ci-image-pr-{number}-{identity}.service"
            self.resource("run/systemd/transient/" + name)
            self.resource(f"var/lib/vm0-runner/bin/pr-{number}/runner")
            self.state(
                name,
                ActiveState="active",
                MainPID="123",
                Job="91",
            )
        result, payload = self.worker("cleanup", 42)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(payload["42"]["outcome"], "cleaned")
        self.assertEqual(payload["42"]["units"], 1)
        result, payload = self.worker("inventory")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(set(payload), {"420"})
        self.assertTrue(payload["420"]["units"][0]["state"]["busy"])

    def test_unattributed_running_image_preserves_namespaces(self):
        self.state(
            "vm0-ci-image-" + "a" * 64 + ".service", ActiveState="active", MainPID="123"
        )
        resource = self.resource("var/lib/vm0-runner/bin/pr-42/runner")
        result = self.controller(RUNNER_PR_NUMBERS="42")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("image unit ownership unavailable", result.stderr)
        self.assertTrue(resource.exists())

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
        result, payload = self.worker("cleanup", 42)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(payload["42"]["outcome"], "already_absent")
        log = (self.root / "metal-a/systemctl.log").read_text()
        self.assertEqual(log.count('"daemon-reload"'), 2)

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

    def test_short_and_long_stop_jobs_complete_before_files_are_removed(self):
        delays = {}
        files = []
        for pr, delay in ((41, 1), (42, 96)):
            name = f"vm0-runner-pr-{pr}-1.service"
            files.append(self.resource(f"run/systemd/transient/{name}"))
            files.append(self.resource(f"var/lib/vm0-runner/runners/pr-{pr}/config"))
            self.state(name, ActiveState="active", MainPID="77")
            delays[name] = delay
        (self.root / "metal-a/stop-delays.json").write_text(json.dumps(delays))

        # Advance only the worker's standard clock; the real controller, worker,
        # files/locks and systemctl boundary run unchanged. No wall-clock wait.
        result = self.controller(STOP_CLOCK_STEP="1")
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertTrue(all(not file.exists() for file in files))
        decisions = {
            record["pr"]: record
            for line in result.stdout.splitlines()
            if line.startswith('{"pr":')
            if (record := json.loads(line)).get("pr")
        }
        for pr in (41, 42):
            self.assertEqual(decisions[pr]["outcome"], "cleaned")
            self.assertEqual(decisions[pr]["hosts"]["metal-a"]["outcome"], "cleaned")
        self.assertEqual(
            json.loads((self.root / "metal-a/stop-jobs.json").read_text()), {}
        )

    def test_stuck_stop_jobs_share_deadline_retain_resources_and_exit_one(self):
        delays = {}
        retained = []
        for pr in (41, 42, 43):
            name = f"vm0-runner-pr-{pr}-1.service"
            unit = self.resource(f"run/systemd/transient/{name}")
            config = self.resource(f"var/lib/vm0-runner/runners/pr-{pr}/config")
            self.state(name, ActiveState="active", MainPID="77")
            delays[name] = 1 if pr == 43 else None
            if pr != 43:
                retained.extend((unit, config))
                retained.append(
                    self.resource(f"var/lib/vm0-runner/groups/vm0/test-pr-{pr}/config")
                )
        (self.root / "metal-a/stop-delays.json").write_text(json.dumps(delays))

        result = self.controller(STOP_CLOCK_STEP="60")
        self.assertEqual(result.returncode, 1, result.stderr + result.stdout)
        self.assertTrue(all(file.exists() for file in retained))
        decisions = {
            record["pr"]: record
            for line in result.stdout.splitlines()
            if line.startswith('{"pr":')
            if (record := json.loads(line)).get("pr")
        }
        for pr in (41, 42):
            self.assertEqual(
                decisions[pr]["outcome"], "failed", result.stderr + result.stdout
            )
            failed = decisions[pr]["hosts"]["metal-a"]
            self.assertEqual(failed["error"], "service execution remains after stop")
            state = failed["remaining"]["units"][0]["state"]
            self.assertEqual(state["ActiveState"], "deactivating")
            self.assertTrue(state["busy"])
            self.assertEqual(state["Job"], "91")
        self.assertEqual(decisions[43]["outcome"], "cleaned")
        self.assertFalse(config.exists())
        self.assertFalse(unit.exists())
        # Two stuck namespaces consume one 330s budget, plus one clock step.
        self.assertLessEqual(float((self.root / "metal-a/clock").read_text()), 390)

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

    def test_unsafe_image_admission_path_fails_only_its_namespace(self):
        target = self.root / "external-image"
        target.mkdir()
        marker = target / (".image-owner-" + "a" * 64)
        marker.touch()
        root = self.root / "metal-a/var/lib/vm0-runner/bin"
        root.mkdir(parents=True)
        (root / "pr-42-image-1234").symlink_to(target, target_is_directory=True)
        sibling = self.resource("var/lib/vm0-runner/stripe/pr-43/config")

        result, payload = self.worker("cleanup", 42, 43)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(payload["42"]["outcome"], "failed")
        self.assertIn("resource ancestor is a symlink", payload["42"]["error"])
        self.assertTrue(marker.is_file())
        self.assertEqual(payload["43"]["outcome"], "cleaned")
        self.assertFalse(sibling.exists())

        unit = self.resource("etc/systemd/system/vm0-runner-pr-43.service")
        result, payload = self.worker("cleanup", 42, 43, RELOAD_ERROR="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(payload["42"]["outcome"], "failed")
        self.assertIn("resource ancestor is a symlink", payload["42"]["error"])
        self.assertTrue(marker.is_file())
        self.assertEqual(payload["43"]["outcome"], "unverified")
        self.assertEqual(payload["43"]["operation_result"]["outcome"], "cleaned")
        self.assertFalse(unit.exists())

    def test_initial_inventory_failure_preserves_image_revocation_failure(self):
        marker = self.resource("external-image/.image-owner-" + "a" * 64)
        sibling_marker = self.resource(
            "var/lib/vm0-runner/bin/pr-43-image-1234/.image-owner-" + "b" * 64
        )
        (sibling_marker.parent.parent / "pr-42-image-1234").symlink_to(
            marker.parent, target_is_directory=True
        )
        unit = self.resource("etc/systemd/system/vm0-runner-pr-43.service")
        legacy = "vm0-ci-image-" + "c" * 64 + ".service"
        self.resource("run/systemd/transient/" + legacy)
        self.state(legacy, ActiveState="active", MainPID="123")

        result, payload = self.worker("cleanup", 42, 43)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(payload["42"]["outcome"], "failed")
        self.assertIn("resource ancestor is a symlink", payload["42"]["error"])
        self.assertTrue(marker.is_file())
        self.assertEqual(payload["43"]["outcome"], "unverified")
        self.assertIn("image unit ownership unavailable", payload["43"]["error"])
        self.assertFalse(sibling_marker.exists())
        self.assertTrue(unit.exists())

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
                    self.assertEqual(decision["hosts"]["metal-a"]["outcome"], "cleaned")
                    self.assertEqual(
                        decision["hosts"]["metal-b"]["outcome"], "already_absent"
                    )

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
        config = self.resource("var/lib/vm0-runner/stripe/pr-42/config")
        pages = [
            {"total_count": 999, "workflow_runs": newest[offset : offset + 100]}
            for offset in range(0, 1000, 100)
        ]
        self.github(run_pages={"in_progress": [pages]})
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
        for host in ("metal-a", "metal-b"):
            self.assertEqual((self.root / host / "ssh.log").read_text(), "inventory\n")
        result = self.controller(OFFLINE="metal-b")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertTrue(config.exists())
        self.assertEqual((self.root / "metal-a/ssh.log").read_text(), "inventory\n" * 2)
        self.assertEqual((self.root / "metal-b/ssh.log").read_text(), "inventory\n" * 3)

    def test_inventory_recovers_single_disconnect_before_cleanup(self):
        config = self.resource("var/lib/vm0-runner/stripe/pr-42/config")
        result = self.controller(INVENTORY_FAILURE="reset-once")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(config.exists())
        self.assertIn('"cleaned": 1', result.stdout)
        self.assertEqual(
            (self.root / "metal-a/ssh.log").read_text(), "inventory\nsession\n"
        )
        self.assertEqual(
            (self.root / "metal-b/ssh.log").read_text(),
            "inventory\ninventory\nsession\n",
        )

    def test_inventory_command_and_json_failures_stop_without_retry(self):
        config = self.resource("var/lib/vm0-runner/stripe/pr-42/config")
        for calls, failure in enumerate(("command", "malformed"), start=1):
            with self.subTest(failure=failure):
                result = self.controller(INVENTORY_FAILURE=failure)
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertTrue(config.exists())
                for host in ("metal-a", "metal-b"):
                    self.assertEqual(
                        (self.root / host / "ssh.log").read_text(),
                        "inventory\n" * calls,
                    )

    def test_lock_readiness_recovers_after_lost_reply_and_slow_diagnostics(self):
        files = [
            self.resource("var/lib/vm0-runner/stripe/pr-42/config", host=host)
            for host in ("metal-a", "metal-b")
        ]
        result = self.guarded_controller(READY_FAILURE="reset-once")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(all(not file.exists() for file in files))
        self.assertIn('"cleaned": 1', result.stdout)
        self.assertEqual(
            (self.root / "metal-a/ssh.log").read_text(), "inventory\nsession\n"
        )
        self.assertEqual(
            (self.root / "metal-b/ssh.log").read_text(), "inventory\nsession\nsession\n"
        )

    def test_lock_readiness_failure_preserves_all_host_resources(self):
        files = [
            self.resource("var/lib/vm0-runner/stripe/pr-42/config", host=host)
            for host in ("metal-a", "metal-b")
        ]
        for failure, sessions in (("reset-always", 2), ("command", 1), ("invalid", 1)):
            with self.subTest(failure=failure):
                history = self.root / "metal-b/ssh.log"
                history.unlink(missing_ok=True)
                result = self.controller(READY_FAILURE=failure)
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertTrue(all(file.is_file() for file in files))
                self.assertEqual(
                    history.read_text(), "inventory\n" + "session\n" * sessions
                )

    def pre_dispatch_loss(self, failure, **env):
        files = [
            self.resource("var/lib/vm0-runner/stripe/pr-42/config", host=host)
            for host in ("metal-a", "metal-b")
        ]

        def open_event(path, flags):
            return os.open(path, flags | os.O_RDWR | os.O_NONBLOCK)

        with contextlib.ExitStack() as events:
            for name in ("disconnect-a", "diagnosing-a"):
                event = self.root / name
                os.mkfifo(event)
                events.enter_context(open(event, "rb", opener=open_event))
            return files, self.guarded_controller(READY_FAILURE=failure, **env)

    def test_restarts_lock_preparation_after_ready_host_disconnects(self):
        files, result = self.pre_dispatch_loss("prior-lost")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(all(not file.exists() for file in files), result.stdout)
        self.assertTrue((self.root / "released-b").is_file(), result.stderr)
        self.assertIn('"cleaned": 1', result.stdout)
        self.assertEqual(
            (self.root / "metal-a/ssh.log").read_text(), "inventory\nsession\nsession\n"
        )
        self.assertEqual(
            (self.root / "metal-b/ssh.log").read_text(),
            "inventory\nsession\nsession\nsession\n",
        )

    def test_reacquires_locks_when_old_release_receipt_is_lost(self):
        files, result = self.pre_dispatch_loss("prior-lost", DROP_RESTART_RELEASE="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.root / "released-b").is_file(), result.stderr)
        self.assertTrue(all(not file.exists() for file in files), result.stdout)
        self.assertIn('"cleaned": 1', result.stdout)

    def test_rechecks_github_authority_after_pre_dispatch_restart(self):
        self.github(reopen_after_recovery=42)
        files, result = self.pre_dispatch_loss("prior-lost")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(all(file.is_file() for file in files), result.stdout)
        self.assertIn('"skipped_open": 1', result.stdout)

    def test_rechecks_a_previously_seen_owner_after_pre_dispatch_restart(self):
        owner = self.owner()
        self.github(
            runs=[owner],
            hide_owners_after_recovery=True,
            run_details={str(owner["id"]): owner},
        )
        selected = [
            self.resource("var/lib/vm0-runner/stripe/pr-43/config", host=host)
            for host in ("metal-a", "metal-b")
        ]
        owned, result = self.pre_dispatch_loss("prior-lost")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(all(file.is_file() for file in owned), result.stdout)
        self.assertTrue(all(not file.exists() for file in selected), result.stdout)
        self.assertIn('"deferred_owner": 1', result.stdout)

    def test_pre_dispatch_command_failure_keeps_all_host_resources(self):
        files, result = self.pre_dispatch_loss("prior-lost-command")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertTrue(all(file.is_file() for file in files), result.stdout)
        self.assertIn(
            "namespace lock worker unavailable on metal-a.vm3.ai", result.stdout
        )
        self.assertEqual(
            (self.root / "metal-b/ssh.log").read_text(), "inventory\nsession\nsession\n"
        )

    def test_pre_dispatch_restart_does_not_retry_a_second_disconnect(self):
        files, result = self.pre_dispatch_loss("prior-lost-repeat")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertTrue(all(file.is_file() for file in files), result.stdout)
        self.assertEqual(
            (self.root / "metal-a/ssh.log").read_text(), "inventory\nsession\nsession\n"
        )

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
        # A close event must fence a first claim even with no resources yet.
        for host in ("metal-a", "metal-b"):
            cutoff = self.root / host / "var/lock/vm0-runner-lifecycle-pr-9999.lock"
            self.assertTrue(cutoff.is_file(), result.stdout)
            self.assertEqual(cutoff.read_text(), "2026-10-02T00:00:00Z\n")

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
                    json.dumps(
                        {
                            "operation": "cleanup",
                            "closedAt": dict.fromkeys([41, 42], "2026-10-02T00:00:00Z"),
                        }
                    )
                    + "\n"
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
                    json.dumps(
                        {
                            "operation": "cleanup",
                            "closedAt": dict.fromkeys([41, 42], "2026-10-02T00:00:00Z"),
                        }
                    )
                    + "\n"
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

    def stripe_fixture(self):
        (self.root / "stripe-bin").mkdir()
        for name, contents in (
            ("bin/ssh", STRIPE_SSH),
            ("stripe-bin/systemd-run", STRIPE_SYSTEMD_RUN),
            ("stripe-bin/bash", STRIPE_INSTALL),
        ):
            path = self.root / name
            path.write_text(contents)
            path.chmod(0o755)
        self.github(run_details={"123": {"created_at": "2026-10-01T01:00:00Z"}})
        self.stripe_host = self.root / "metal-b"
        self.stripe_state = self.stripe_host / "run/vm0-ci-stripe-deployments/pr-42"
        self.stripe_unit = self.resource(
            "etc/systemd/system/vm0-stripe-listener-pr-42.service", host="metal-b"
        )
        self.state(
            self.stripe_unit.name, host="metal-b", ActiveState="inactive", Job="91"
        )
        self.stripe_lock = self.resource(
            "var/lock/vm0-runner-lifecycle-pr-42.lock", host="metal-b", contents=""
        )
        self.stripe_env = {
            **self.env,
            "JOB_REF": "pr-42",
            "METAL_HOSTS": "metal-b",
            "GITHUB_RUN_ATTEMPT": "1",
            "API_PREVIEW_URL": "https://preview.example.test",
            "STRIPE_SECRET_KEY": "sk_test_stripefixture",
            "VERCEL_AUTOMATION_BYPASS_SECRET": "fixture/bypass+",
        }

    @contextlib.contextmanager
    def stripe_controller(self, **options):
        with subprocess.Popen(
            ["bash", str(TOOLS / "start-stripe-listener.sh")],
            env={**self.stripe_env, **options},
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        ) as process:
            try:
                yield process
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)

    def wait_for_stripe_worker(self, process):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            record_file = self.stripe_state / "current.json"
            if record_file.is_file():
                record = json.loads(record_file.read_text())
                stage = self.stripe_state / record["operation"]
                if stage.is_dir() and not (stage / "settings.json").exists():
                    return
            if process.poll() is not None:
                self.fail(str(process.communicate()))
            time.sleep(0.02)
        self.fail("worker did not consume its inputs before waiting for the lock")

    def stripe_unit_mutations(self):
        lines = (self.stripe_host / "systemctl.log").read_text().splitlines()
        return [
            args[0] for args in map(json.loads, lines) if self.stripe_unit.name in args
        ]

    def test_stripe_recovers_original_listener_after_both_reply_losses(self):
        self.stripe_fixture()
        with self.stripe_lock.open("r+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            with self.stripe_controller(DROP_STRIPE_REPLIES="1") as process:
                self.wait_for_stripe_worker(process)
                self.assertEqual(self.stripe_unit.read_text(), "fixture")
                self.assertFalse((self.stripe_host / "systemctl.log").exists())
                fcntl.flock(lock, fcntl.LOCK_UN)
                output, errors = process.communicate(timeout=20)
                self.assertEqual(process.returncode, 0, output + errors)
        self.assertIn("submission response unavailable", output)
        self.assertIn("observation unavailable", output)
        self.assertIn("listener is ready on metal-b", output)
        self.assertEqual(
            (self.stripe_host / "stripe-ssh.log")
            .read_text()
            .splitlines()
            .count("submit"),
            1,
        )
        mutations = self.stripe_unit_mutations()
        self.assertLess(mutations.index("stop"), mutations.index("start"))
        self.assertEqual(mutations.count("start"), 1)
        self.assertEqual(
            list(self.stripe_state.iterdir()), [self.stripe_state / "current.json"]
        )
        directory = self.stripe_host / "var/lib/vm0-runner/stripe/pr-42"
        self.assertIn("fixture%2Fbypass%2B", (directory / "env").read_text())
        self.assertNotIn(
            "fixture/bypass+", self.stripe_unit.read_text() + output + errors
        )
        self.assertNotIn("sk_test_stripefixture", output + errors)

        # A legacy replacement can retire the installed listener even while
        # the old operation result remains on host tmpfs.
        (directory / ".deployment").unlink()
        with self.stripe_controller() as process:
            output, errors = process.communicate(timeout=10)
            self.assertNotEqual(process.returncode, 0, output + errors)
            self.assertIn("receipt no longer matches", errors)
        self.assertEqual(self.stripe_unit_mutations().count("start"), 1)

    def test_stripe_stop_failure_preserves_the_original_listener_files(self):
        self.stripe_fixture()
        with self.stripe_controller(MUTATION_ERROR="1") as process:
            output, errors = process.communicate(timeout=10)
            self.assertNotEqual(process.returncode, 0, output + errors)
        self.assertIn("failed to retire original listener", errors)
        self.assertEqual(self.stripe_unit.read_text(), "fixture")
        self.assertNotIn("start", self.stripe_unit_mutations())

    def test_stripe_refuses_to_start_if_manager_still_needs_reload(self):
        self.stripe_fixture()
        with self.stripe_controller(STALE_STRIPE_UNIT="1") as process:
            output, errors = process.communicate(timeout=10)
            self.assertNotEqual(process.returncode, 0, output + errors)
        self.assertNotIn("start", self.stripe_unit_mutations())

    def test_stripe_startup_and_cleanup_share_the_reload(self):
        self.stripe_fixture()
        removed = self.resource(
            "etc/systemd/system/vm0-stripe-listener-pr-43.service", host="metal-b"
        )
        host = self.stripe_host

        def wait_for(path):
            deadline = time.monotonic() + 3
            while not path.exists() and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(path.exists(), str(path))

        with ThreadPoolExecutor(max_workers=1) as pool:
            cleanup = pool.submit(
                self.worker,
                "cleanup",
                43,
                host="metal-b",
                PAUSE_CLEANUP_BEFORE_RELOAD="1",
            )
            try:
                wait_for(host / "cleanup-wrote-unit-files")
                self.assertFalse(removed.exists())
                with self.stripe_controller() as process:
                    wait_for(host / "var/lib/vm0-runner/stripe/pr-42/.deployment")
                    (host / "cleanup-can-reload").touch()
                    output, errors = process.communicate(timeout=10)
                    self.assertEqual(process.returncode, 0, output + errors)
            finally:
                (host / "cleanup-can-reload").touch()
            result, payload = cleanup.result(timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(payload["43"]["outcome"], "cleaned")
        self.assertEqual(
            (host / "systemctl.log").read_text().count('"daemon-reload"'), 1
        )
        self.assertEqual(self.stripe_unit_mutations().count("start"), 1)

    def test_stripe_queued_worker_checks_closure_and_cleanup_retires_receipt(self):
        self.stripe_fixture()
        with self.stripe_lock.open("r+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            with self.stripe_controller() as process:
                self.wait_for_stripe_worker(process)
                os.pwrite(lock.fileno(), b"2026-10-02T00:00:00Z\n", 0)
                fcntl.flock(lock, fcntl.LOCK_UN)
                output, errors = process.communicate(timeout=10)
                self.assertNotEqual(process.returncode, 0, output + errors)
                self.assertIn("failed to check admission", errors)
        self.assertEqual(self.stripe_unit.read_text(), "fixture")
        self.assertFalse((self.stripe_host / "systemctl.log").exists())
        result, payload = self.worker("cleanup", 42, host="metal-b")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(payload["42"]["outcome"], "cleaned")
        self.assertFalse(self.stripe_state.exists())
        with self.stripe_controller() as process:
            _, errors = process.communicate(timeout=10)
            self.assertNotEqual(process.returncode, 0, errors)
            self.assertIn("predates PR closure", errors)

    def test_closed_pr_cleanup_preserves_a_newer_staged_stripe_operation(self):
        path = self.resource(
            "run/vm0-ci-stripe-deployments/pr-42/current.json",
            contents=json.dumps(
                {
                    "operation": "a" * 64,
                    "generation": ["2026-10-03T00:00:00Z", 123, 1],
                    "status": "pending",
                }
            ),
        )
        path.parent.parent.chmod(0o700)
        _, payload = self.worker("cleanup", 42)
        self.assertEqual(payload["42"]["outcome"], "failed")
        self.assertEqual(payload["42"]["error"], "resources remain after cleanup")
        self.assertTrue(path.is_file())


if __name__ == "__main__":
    unittest.main()
