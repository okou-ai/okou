#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../../../../.." && pwd)"
export UPGRADE_WORKER="${1:-$REPO_ROOT/crates/runner/tests/behavior/runner-behavior-upgrade-local-remote.sh}"

# Exercise the standalone worker at the runner/systemd command boundary. Queue
# requests, status/result files, FIFO readers/writers and submit processes are
# real local resources; this helper does not replace the native CI lane.
python3 - <<'PYTHON'
import json
from contextlib import ExitStack
import os
from pathlib import Path
import select
import shutil
import signal
import subprocess
import tempfile
import time

fixture = r'''#!/usr/bin/env python3
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

root = Path(os.environ['UPGRADE_CASE'])
scenario = os.environ['UPGRADE_SCENARIO']
args = sys.argv[1:]
command = Path(sys.argv[0]).name
if command == 'sudo':
    command, *args = args
command = Path(command).name

def event(kind, **fields):
    with (root / 'events').open('a') as log:
        log.write(json.dumps({'kind': kind, **fields}) + '\n')

def inject_failure(operation):
    if scenario == operation or (scenario in ('cleanup-failure', 'cleanup-directory-failure') and operation == 'drain-a'):
        (root / 'failed').touch()
        print(f'injected failure: {operation}', file=sys.stderr)
        sys.exit(42)

def mapped(path):
    return str(root / 'host' / path.lstrip('/')) if path.startswith('/var/lib/vm0-runner/') else path

def status_path(owner):
    return Path(mapped(f'/var/lib/vm0-runner/runners/test-upgrade-{owner}/status.json'))

def update(owner, change):
    path = status_path(owner)
    path.parent.mkdir(parents=True, exist_ok=True)
    with (root / f'lock-{owner}').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        status = json.loads(path.read_text()) if path.exists() else {'mode': 'running', 'active_runs': []}
        change(status)
        tmp = path.with_suffix(f'.{os.getpid()}.tmp')
        tmp.write_text(json.dumps(status))
        tmp.replace(path)
        return status

def stop_guest(pid):
    try:
        children = Path(f'/proc/{pid}/task/{pid}/children').read_text().split()
        # Retire the FIFO reader first so its real shell can reap it and exit.
        for child in children or [str(pid)]:
            try:
                os.kill(int(child), signal.SIGTERM)
            except ProcessLookupError:
                pass
    except FileNotFoundError:
        pass

if command == 'sleep':
    # Polling remains bounded, without spending real 1s intervals per fault case.
    time.sleep(0.02)
    sys.exit(0)
if command == 'seq':
    start, end = map(int, args)
    print('\n'.join(str(x) for x in range(start, min(end, 16) + 1)))
    sys.exit(0)
if command == 'journalctl':
    event('journal', owner=args[args.index('--unit') + 1].rsplit('-', 1)[-1])
    sys.exit(65 if scenario == 'cleanup-failure' else 0)
if command == 'rm':
    if '-rf' in args and args[-1].startswith('/tmp/vm0-upgrade.'):
        event('remove-results', path=args[-1])
        if scenario == 'cleanup-directory-failure' and (root / 'failed').exists():
            sys.exit(65)
    sys.exit(subprocess.run(['/usr/bin/rm', *args]).returncode)
if command == 'systemctl':
    action = args[0]
    owner = 'a' if 'upgrade-a' in args[-1] else 'b'
    active, enabled = root / f'active-{owner}', root / f'enabled-{owner}'
    if action == 'enable':
        inject_failure('enable-a')
        assert not active.exists(), 'inactive drain assertion ran while A was active'
        enabled.touch()
        event('enable-inactive', owner=owner)
        sys.exit(0)
    if action == 'is-enabled':
        sys.exit(0 if enabled.exists() else 1)
    if action == 'is-active':
        sys.exit(0 if active.exists() else 3)
    sys.exit(90)
if command in ('find', 'jq', 'test'):
    actual = [mapped(arg) for arg in args]
    result = subprocess.run([f'/usr/bin/{command}', *actual])
    if command == 'jq' and result.returncode == 0 and any('.mode == "draining"' in arg for arg in args):
        (root / 'drain-observed').touch()
        event('drain-observed')
    sys.exit(result.returncode)
host_timeout = None
if command == 'timeout':
    host_timeout = float(args[0])
    command, *args = args[1:]
    command = Path(command).name
if command != 'runner':
    sys.exit(f'unexpected command: {command} {args}')

if args[0] == 'service':
    action = args[1]
    owner = 'a' if args[args.index('--name') + 1].endswith('-a') else 'b'
    event(action, owner=owner)
    counter = root / f'{action}-{owner}-count'
    count = int(counter.read_text()) + 1 if counter.exists() else 1
    counter.write_text(str(count))
    operation = f'{action}-{owner}'
    if action == 'uninstall':
        if count == 1 and scenario == 'residual-uninstall-failure':
            sys.exit(65)
        if scenario == 'cleanup-failure' and (root / 'failed').exists():
            sys.exit(65)
        if count == 2:
            inject_failure(operation)
    else:
        if operation == 'drain-a' and count == 2:
            operation = 'inactive-drain-a'
        inject_failure(operation)
    if action == 'install':
        if owner == 'b':
            assert (root / 'ready-1').exists(), 'B installed before exact job 1 readiness'
            assert not (root / 'released-1').exists(), 'job 1 released before B installed'
        if not (scenario == 'inactive-b' and owner == 'b'):
            (root / f'active-{owner}').touch()
        (root / f'enabled-{owner}').touch()
        update(owner, lambda s: s.update(mode='running', active_runs=[{'run_id': 'unrelated', 'sandbox_id': 'wrong-sandbox', 'phase': 'running'}]))
    elif action == 'drain':
        if owner == 'a' and (root / 'active-a').exists():
            assert (root / 'ready-1').exists() and (root / 'ready-2').exists(), 'drain before both FIFOs ready'
            if scenario != 'missing-drain-mode':
                update(owner, lambda s: s.update(mode='draining', active_runs=[r for r in s['active_runs'] if r['run_id'] != 'unrelated']))
        else:
            (root / f'active-{owner}').unlink(missing_ok=True)
        (root / f'enabled-{owner}').unlink(missing_ok=True)
    elif action == 'uninstall':
        for file in root.glob('client-*.json'):
            client = json.loads(file.read_text())
            if client['owner'] == owner:
                stop_guest(client['guest_pid'])
        (root / f'active-{owner}').unlink(missing_ok=True)
        (root / f'enabled-{owner}').unlink(missing_ok=True)
        if owner == 'a' and (root / 'drain-observed').exists():
            (root / 'retired-a').touch()
    else:
        sys.exit(91)
    sys.exit(0)

if args[:2] == ['local', 'submit']:
    prompt = args[args.index('--prompt') + 1]
    number = int(prompt[-1])
    owner = 'a' if number == 1 or scenario in ('job2-a', 'inactive-b') else 'b'
    if number == 1 and scenario == 'wrong-owner':
        owner = 'b'
    run_id = f'00000000-0000-4000-8000-{number:012d}'
    event('submit', number=number, owner=owner, prompt=prompt, pid=os.getpid())
    inject_failure(f'submit-{number}')
    if number == 3:
        assert (root / 'retired-a').exists() and (root / 'active-b').exists(), 'fresh job did not run with only B left'
        print(json.dumps({'run_id': run_id, 'exit_code': 0}))
        sys.exit(0)
    event('output', path=os.readlink('/proc/self/fd/1'))
    queue = Path(mapped('/var/lib/vm0-runner/groups/vm0/upgrade-test'))
    jobs = queue / 'jobs/vm0/default'
    jobs.mkdir(parents=True, exist_ok=True)
    job = jobs / f'{run_id}.job'
    request = {'job_id': run_id, 'prompt': prompt}
    temporary = job.with_suffix('.tmp')
    temporary.write_text(json.dumps(request))
    if scenario == 'early-exit' and number == 1:
        sys.exit(7)
    claims = queue / 'claims'
    claims.mkdir(exist_ok=True)
    if scenario != 'missing-claim':
        (claims / f'{run_id}.claim').touch()
    sandbox_id = f'sandbox-{number}'
    record = {'run_id': 'unrelated-only' if scenario == 'unrelated-only' else run_id, 'sandbox_id': sandbox_id, 'phase': 'preparing'}
    update(owner, lambda s: s['active_runs'].append(record))
    fifo = prompt.split()[2]
    guest_prompt = prompt
    if scenario == 'missing-fifo':
        guest_prompt = prompt.replace(fifo, str(root / f'other-fifo-{number}'))
    if scenario == 'no-reader-release':
        guest_prompt = f'rm -f {fifo} && mkfifo {fifo}'
    guest = subprocess.Popen(['/bin/sh', '-c', guest_prompt], stdout=subprocess.DEVNULL)
    (root / f'client-{number}.json').write_text(json.dumps({'owner': owner, 'pid': os.getpid(), 'guest_pid': guest.pid, 'fifo': fifo}))
    def interrupted(_signum, _frame):
        stop_guest(guest.pid)
        guest.wait(timeout=3)
        raise SystemExit(143)
    signal.signal(signal.SIGTERM, interrupted)
    if scenario != 'preparing-only':
        update(owner, lambda s: [r.update(phase='running') for r in s['active_runs'] if r['sandbox_id'] == sandbox_id])
    # Publish only after cleanup can retire this submission and its guest.
    if scenario == 'ambiguous-request' and number == 1:
        # Expose both matches together so a poll cannot bind to just one.
        staged = jobs.with_name('ambiguous')
        staged.mkdir()
        temporary.replace(staged / job.name)
        (staged / 'duplicate.job').write_text(json.dumps({'job_id': 'duplicate', 'prompt': prompt}))
        staged.replace(jobs)
    else:
        temporary.replace(job)
    try:
        # FIFO release or worker cleanup owns the held workload's lifetime.
        # A second deadline can turn a missing-FIFO case into an early exit.
        result = guest.wait()
    finally:
        stop_guest(guest.pid)
    if scenario in ('stalled-completion', 'no-reader-release'):
        gate = root / f'completion-gate-{number}'
        os.mkfifo(gate)
        with gate.open() as reader:
            reader.read()
    if scenario == 'failed-submission' and number == 2:
        result = 1
    status = update(owner, lambda s: s.update(active_runs=[r for r in s['active_runs'] if r['sandbox_id'] != sandbox_id]))
    if status['mode'] == 'draining' and not status['active_runs']:
        (root / f'active-{owner}').unlink(missing_ok=True)
    job.unlink(missing_ok=True)
    (claims / f'{run_id}.claim').unlink(missing_ok=True)
    if scenario == 'mismatched-result' and number == 1:
        run_id = 'unrelated-result'
    print(json.dumps({'run_id': run_id, 'exit_code': result}), flush=True)
    event('completed', number=number, result=result)
    sys.exit(0 if result == 0 else 1)

if args[0] == 'exec':
    sandbox = args[args.index('--sandbox') + 1]
    assert sandbox in ('sandbox-1', 'sandbox-2'), f'exec targeted unrelated sandbox {sandbox}'
    number = int(sandbox[-1])
    guest_args = args[args.index('--') + 1:]
    if guest_args[:2] == ['test', '-p']:
        if scenario == 'delayed-ready':
            probe = root / f'probe-{number}'
            attempts = int(probe.read_text()) if probe.exists() else 0
            probe.write_text(str(attempts + 1))
            if attempts == 0:
                event('not-ready', number=number)
                sys.exit(1)
        result = subprocess.run(guest_args)
        if result.returncode == 0:
            (root / f'ready-{number}').touch()
            event('ready', number=number)
        sys.exit(result.returncode)
    assert (root / 'drain-observed').exists(), 'workload released before drain observation'
    event('release', number=number)
    if scenario == 'release-failure':
        sys.exit(23)
    assert host_timeout == 20, 'release omitted host timeout'
    assert guest_args[:2] == ['timeout', '10'], 'release omitted guest timeout'
    # Keep the simulated guest timeout inside the case-owned process group.
    result = subprocess.run([guest_args[0], '--foreground', *guest_args[1:]], timeout=host_timeout)
    if result.returncode == 0:
        (root / f'released-{number}').touch()
    sys.exit(result.returncode)
sys.exit(f'unexpected runner invocation: {args}')
'''

def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False

def terminate(pid):
    try:
        descriptor = os.pidfd_open(pid)
    except ProcessLookupError:
        return
    try:
        signal.pidfd_send_signal(descriptor, signal.SIGTERM)
        if not select.select([descriptor], [], [], 5)[0]:
            signal.pidfd_send_signal(descriptor, signal.SIGKILL)
            select.select([descriptor], [], [], 5)
    except ProcessLookupError:
        pass
    finally:
        os.close(descriptor)

def cleanup_case(case):
    # Also retire owned resources if an assertion or the outer worker deadline
    # aborts the helper. Normal-path leak assertions run before this fallback.
    for file in case.glob('client-*.json'):
        client = json.loads(file.read_text())
        terminate(client['pid'])
        terminate(client['guest_pid'])
        Path(client['fifo']).unlink(missing_ok=True)
    if (case / 'events').exists():
        for event in map(json.loads, (case / 'events').read_text().splitlines()):
            if event['kind'] == 'remove-results':
                shutil.rmtree(event['path'], ignore_errors=True)

def run_case(scenario, failure, case, binary):
    environment = {**os.environ, 'PATH': f'{binary}:{os.environ["PATH"]}', 'UPGRADE_CASE': str(case), 'UPGRADE_SCENARIO': scenario}
    with subprocess.Popen(
        ['bash', os.environ['UPGRADE_WORKER'], '/fake/bin', 'test'],
        env=environment, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        start_new_session=True,
    ) as result:
        try:
            stdout, stderr = result.communicate(timeout=20)
        except BaseException as error:
            # Stop owned clients/guests before draining inherited output pipes.
            # Normal leak assertions below still run before fallback cleanup.
            try:
                cleanup_case(case)
            finally:
                try:
                    os.killpg(result.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                stdout, stderr = result.communicate()
            if isinstance(error, subprocess.TimeoutExpired):
                raise AssertionError(f'{scenario}: worker exceeded {error.timeout}s case watchdog\n{stdout}{stderr}') from error
            raise
    output = stdout + stderr
    assert (result.returncode == 0) == (failure is None), f'{scenario}: unexpected exit {result.returncode}\n{output}'
    if failure:
        assert failure in output and '=== Upgrade test passed ===' not in output, f'{scenario}: missing failure\n{output}'
        if scenario in error_statuses:
            assert result.returncode == error_statuses[scenario], f'{scenario}: original status replaced: {result.returncode}\n{output}'
            following = following_phases.get(scenario)
            assert not following or following not in output, f'{scenario}: continued after failure\n{output}'
    else:
        assert '=== Upgrade test passed ===' in output, output
    events = [json.loads(line) for line in (case / 'events').read_text().splitlines()]
    if not failure:
        assert sum(e['kind'] == 'submit' for e in events) == 3
        assert sum(e['kind'] == 'install' for e in events) == 2
        assert sum(e['kind'] == 'drain' for e in events) == 3
        assert sum(e['kind'] == 'uninstall' for e in events) == 4
        assert sum(e['kind'] == 'release' for e in events) == 2
        assert not (case / 'enabled-a').exists() and not (case / 'active-b').exists()
        if scenario == 'delayed-ready':
            assert sum(e['kind'] == 'not-ready' for e in events) == 2
        print(f'PASS: {scenario}: 3 submissions, 2 installs, 3 drains, 4 uninstalls, 2 explicit releases')
    else:
        assert sum(e['kind'] == 'uninstall' for e in events) >= 4, f'{scenario}: exit cleanup missing'
        assert {e['owner'] for e in events if e['kind'] == 'journal'} == {'a', 'b'}, f'{scenario}: failure journals missing'
        print(f'PASS: {scenario}: bounded failure and cleanup')
    for event in events:
        if event['kind'] == 'output':
            assert Path(event['path']).parent.exists() == (scenario == 'cleanup-directory-failure'), f'{scenario}: unexpected result directory state'
        if event['kind'] == 'submit':
            assert not alive(event['pid']), f'{scenario}: submit client leaked'
    for file in case.glob('client-*.json'):
        client = json.loads(file.read_text())
        assert not alive(client['guest_pid']), f'{scenario}: FIFO workload leaked'
    if scenario != 'cleanup-failure':
        assert not any((case / f'{kind}-{owner}').exists() for kind in ('active', 'enabled') for owner in ('a', 'b')), f'{scenario}: service state leaked'
    if scenario == 'cleanup-directory-failure':
        assert any(e['kind'] == 'remove-results' for e in events), 'result cleanup not attempted'

error_statuses = {
    'install-a': 42, 'install-b': 42, 'drain-a': 42, 'drain-b': 42,
    'enable-a': 42, 'inactive-drain-a': 1, 'uninstall-a': 42, 'uninstall-b': 42,
    'submit-1': 1, 'submit-2': 1, 'submit-3': 1,
    'cleanup-failure': 42, 'cleanup-directory-failure': 42,
}
following_phases = {
    'install-a': '--- Submit job 1', 'install-b': '--- Submit job 2',
    'drain-a': '--- Waiting for job 1', 'drain-b': '--- Uninstalling runner B',
    'enable-a': 'PASS: inactive drain disabled runner A',
    'inactive-drain-a': '--- Uninstalling runner A',
    'uninstall-a': '--- Submit job 3', 'submit-1': '--- Installing runner B',
    'submit-2': '--- Draining runner A', 'submit-3': '--- Draining runner B',
}

with tempfile.TemporaryDirectory(prefix='upgrade-worker-test-') as temporary:
    root = Path(temporary)
    binary = root / 'bin'
    binary.mkdir()
    helper = binary / 'fake-command'
    helper.write_text(fixture)
    helper.chmod(0o755)
    for name in ('sudo', 'systemctl', 'journalctl', 'sleep', 'seq', 'rm'):
        (binary / name).symlink_to(helper)
    cases = {
        'job2-b': None,
        'job2-a': None,
        'delayed-ready': None,
        'missing-claim': 'not ready within observation budget',
        'wrong-owner': 'not ready within observation budget',
        'unrelated-only': 'not ready within observation budget',
        'preparing-only': 'not ready within observation budget',
        'missing-fifo': 'not ready within observation budget',
        'ambiguous-request': 'ambiguous submission',
        'early-exit': 'submission exited before FIFO readiness',
        'inactive-b': 'runner B is not active during coexistence',
        'missing-drain-mode': 'did not retain job 1 while draining',
        'release-failure': 'failed to release workload',
        'no-reader-release': 'failed to release workload',
        'stalled-completion': 'did not finish after release',
        'failed-submission': 'submission 00000000-0000-4000-8000-000000000002 failed',
        'mismatched-result': 'submission result did not confirm success',
    }
    cases.update({name: f'injected failure: {name}' for name in error_statuses})
    cases['cleanup-failure'] = cases['cleanup-directory-failure'] = 'injected failure: drain-a'
    cases['residual-uninstall-failure'] = None
    for scenario, failure in cases.items():
        case = root / scenario
        case.mkdir()
        with ExitStack() as cleanup:
            cleanup.callback(cleanup_case, case)
            run_case(scenario, failure, case, binary)
    print(f'PASS: {len(cases)} upgrade synchronization/error cases; native lifecycle remains covered by CI')

PYTHON
