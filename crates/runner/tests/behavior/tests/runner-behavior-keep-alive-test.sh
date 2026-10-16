#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
export KEEP_ALIVE_WORKER="${1:-$repo_root/crates/runner/tests/behavior/runner-behavior-keep-alive-remote.sh}"

# Run the complete worker against controlled external host commands. These
# failure/cleanup checks do not execute Guest commands or replace native CI.
python3 - <<'PYTHON'
import os
from pathlib import Path
import subprocess
import tempfile

fixture = r'''#!/usr/bin/env python3
import json
import os
from pathlib import Path
import shutil
import sys

root = Path(os.environ['KEEP_ALIVE_CASE'])
scenario = os.environ['KEEP_ALIVE_SCENARIO']
command = Path(sys.argv[0]).name
args = sys.argv[1:]
if command == 'sleep':
    sys.exit(0)
assert command == 'sudo', (command, args)
command, *args = args
command = Path(command).name

def increment(name):
    path = root / name
    value = int(path.read_text()) + 1 if path.exists() else 1
    path.write_text(str(value))
    return value

def create_state():
    for name in ('runner-state', 'group-state'):
        (root / name).mkdir(exist_ok=True)

if command == 'runner':
    if args[:2] == ['service', 'stop']:
        stop = increment('stops')
        if stop == 1 and scenario in ('early-failure', 'remove-failure'):
            create_state()
            sys.exit(42)
        if stop > 1 and scenario == 'active-stop':
            sys.exit(65)
        (root / 'active').unlink(missing_ok=True)
    elif args[:2] == ['service', 'start']:
        create_state()
        (root / 'active').touch()
        (root / 'invocation').write_text('owned-invocation')
    elif args[0] == 'benchmark':
        create_state()
    elif args[:2] == ['local', 'submit']:
        turn = increment('turns')
        print(json.dumps({'run_id': f'fixture-turn-{turn}', 'exit_code': turn - 1,
                          'error': None if turn == 1 else 'Agent exited with code 1'}))
        if turn == 2:
            # A later lookup must not replace the identity captured at startup.
            (root / 'invocation').write_text('replacement-invocation')
            sys.exit(1)
    else:
        raise AssertionError(args)
elif command == 'systemctl':
    assert args[0] == 'show', args
    if '--property=ActiveState' in args:
        if scenario == 'state-failure' and int((root / 'stops').read_text()) > 1:
            sys.exit(65)
        print('active' if (root / 'active').exists() else 'inactive')
    else:
        print((root / 'invocation').read_text())
elif command == 'journalctl':
    assert (root / 'runner-state').is_dir(), 'state removed before diagnostics'
    scope = '_SYSTEMD_INVOCATION_ID=owned-invocation'
    if scope not in args:
        print('UNRELATED_INVOCATION_LOG')
        sys.exit(0)
    if scenario == 'journal-failure':
        print('injected journal failure', file=sys.stderr)
        sys.exit(65)
    limit = next(int(arg.split('=', 1)[1]) for arg in args if arg.startswith('--lines='))
    records = ['old-log-must-be-truncated'] + ['x' * 512 for _ in range(400)]
    records += ['run_id=fixture-turn-1 sandbox_id=fixture-sandbox-1',
                'run_id=fixture-turn-2 sandbox_id=fixture-sandbox-2',
                'vm0_official_fixture-secret vm0_sandbox_fixture-secret',
                'vm0_official_' + 'opaque+official/credential~='.ljust(64, 'a'),
                'Authorization: Bearer fixture-bearer-secret']
    print('\n'.join(records[-limit:]))
elif command == 'rm':
    if scenario == 'remove-failure':
        sys.exit(65)
    assert args[0] == '-rf' and len(args) in (2, 3), args
    mapped = {'/var/lib/vm0-runner/groups/vm0/keepalive-fixture': 'group-state',
              '/var/lib/vm0-runner/runners/fixture-keepalive': 'runner-state'}
    for path in args[1:]:
        shutil.rmtree(root / mapped[path], ignore_errors=True)
else:
    raise AssertionError((command, args))
'''

with tempfile.TemporaryDirectory(prefix='keep-alive-diagnostics-') as temporary:
    root = Path(temporary)
    binary_dir = root / 'bin'
    binary_dir.mkdir()
    peer = binary_dir / 'peer'
    peer.write_text(fixture)
    peer.chmod(0o755)
    for name in ('sudo', 'sleep'):
        (binary_dir / name).symlink_to(peer)

    for scenario in ('turn2-failure', 'journal-failure', 'early-failure',
                     'remove-failure', 'active-stop', 'state-failure'):
        case = root / scenario
        case.mkdir()
        env = dict(os.environ, KEEP_ALIVE_CASE=str(case), KEEP_ALIVE_SCENARIO=scenario,
                   PATH=f'{binary_dir}:{os.environ["PATH"]}')
        result = subprocess.run(['bash', os.environ['KEEP_ALIVE_WORKER'], str(binary_dir), 'fixture'],
                                env=env, text=True, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, timeout=20)
        output = result.stdout
        expected = 42 if scenario in ('early-failure', 'remove-failure') else 1
        assert result.returncode == expected, (scenario, result.returncode, output)
        assert 'service=fixture-keepalive chat_thread_id=' in output, (scenario, output)
        assert 'UNRELATED_INVOCATION_LOG' not in output, (scenario, output)
        assert 'fixture-secret' not in output and 'fixture-bearer-secret' not in output
        assert 'official/credential' not in output, 'opaque Runner credential suffix leaked'
        for name in ('runner-state', 'group-state'):
            assert (case / name).exists() == (scenario in ('remove-failure', 'active-stop', 'state-failure')), (scenario, name, output)

        if scenario in ('early-failure', 'remove-failure'):
            assert 'Runner invocation was not captured; no journal queried.' in output
        else:
            assert 'Runner invocation owned-invocation' in output, (scenario, output)
            assert 'replacement-invocation' not in output, (scenario, output)
            assert 'marker checks or execution failed' in output, (scenario, output)
            if scenario == 'journal-failure':
                assert 'Runner invocation journal collection failed.' in output
            else:
                assert 'run_id=fixture-turn-1 sandbox_id=fixture-sandbox-1' in output
                assert 'run_id=fixture-turn-2 sandbox_id=fixture-sandbox-2' in output
                assert 'old-log-must-be-truncated' not in output
                assert output.count('x' * 512) < 130, 'journal byte bound was lost'
                assert '[redacted]' in output
        if scenario == 'active-stop':
            assert (case / 'active').exists()
        else:
            assert not (case / 'active').exists(), (scenario, output)
        if scenario in ('active-stop', 'state-failure'):
            assert 'because service inactivity was not confirmed.' in output
        print(f'PASS: keep-alive diagnostics {scenario}')
PYTHON
