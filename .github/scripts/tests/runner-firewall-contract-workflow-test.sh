#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
python3 - "$repo_root" <<'PY'
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

root = Path(sys.argv[1])
jobs = json.loads(subprocess.check_output(
    ['yq', '-o=json', '.', str(root / '.github/workflows/crates.yml')], text=True))['jobs']
detect = next(step for step in jobs['detect']['steps'] if step.get('id') == 'detect')
consumer = next(step for step in jobs['detect']['steps'] if step.get('id') == 'runner-tests')
gate = jobs['ci-gate-crates']
gate_step = next(step for step in gate['steps'] if step.get('name') == 'Validate CI results')
standalone = 'runner-firewall-contract-test'
corpus = 'turbo/packages/connectors/src/__tests__/firewall-base-url-validation-contract.json'


def run(args, cwd, env=None):
    result = subprocess.run(args, cwd=cwd, env=env, text=True, capture_output=True)
    assert result.returncode == 0, f'{args}: {result.stdout}{result.stderr}'
    return result.stdout


def expression(text, values):
    text = text.strip().removeprefix('${{').removesuffix('}}').strip()
    text = re.sub(r'\b(?:github|needs|steps)\.[\w.-]+', lambda match: repr(values[match[0]]), text)
    text = text.replace('always()', 'True').replace('&&', ' and ').replace('||', ' or ')
    return eval('(' + text + ')', {'__builtins__': {}}, {})


def render(text, values):
    def substitute(match):
        value = expression(match[1], values)
        return str(value).lower() if isinstance(value, bool) else value
    return re.sub(r'\$\{\{\s*(.*?)\s*\}\}', substitute, text)


def selected(name, values):
    job = jobs[name]
    # GitHub applies an implicit success() unless a status function is present.
    if any(values[f'needs.{dependency}.result'] != 'success' for dependency in job['needs']):
        return False
    return bool(expression(job['if'], values))


def assert_gate(values, results, expected, label):
    context = values | {f'needs.{name}.result': result for name, result in results.items()}
    assert expression(gate['if'], context), 'the gate must run after failed or skipped dependencies'
    env = os.environ | {name: render(value, context) for name, value in gate_step['env'].items()}
    result = subprocess.run(['bash', '-euo', 'pipefail', '-c', render(gate_step['run'], context)],
                            env=env, text=True, capture_output=True)
    assert (result.returncode == 0) == expected, f'{label}: {result.stdout}{result.stderr}'


qemu_producer = 'native-full-qemu-producer'
assert qemu_producer not in jobs, 'QEMU candidate builds must not be part of routine Crates CI'
assert qemu_producer not in gate['needs'], 'the gate must not wait for an external QEMU build'
assert 'qemu-producer-needed' not in jobs['detect']['outputs']
assert 'QEMU_PRODUCER_NEEDED' not in gate_step['env']
for job in jobs.values():
    for step in job.get('steps', []):
        assert 'check-full-qemu-producer.sh' not in step.get('run', '')
        assert 'prepare-qemu-gssapi-fixture.py' not in step.get('run', '')
for name in ['native-kerberos-runtime', 'native-gssapi-independent-peer']:
    job = jobs[name]
    assert job['strategy']['matrix']['os'] == ['ubuntu-latest', 'ubuntu-24.04-arm']
    assert job['timeout-minutes'] == 15
    assert job.get('container', {}).get('image') == jobs['check']['container']['image'], \
        'native checks must use the project Rust image'
    assert job['container']['options'] == '--cap-add=SYS_ADMIN --security-opt apparmor=unconfined'
    native_step = next(step for step in job['steps'] if 'check-native-' in step.get('run', ''))
    assert native_step['shell'] == 'bash'
    assert native_step['env']['NATIVE_TEST_OWNER'] == 'ubuntu'
    assert not any('rustup toolchain install' in step.get('run', '') for step in job['steps'])

for wrapper in ['check-native-kerberos.sh', 'check-native-gssapi-peer.sh']:
    source = (root / '.github/scripts' / wrapper).read_text()
    assert not re.search(r'^python3\s', source, re.MULTILINE), \
        f'{wrapper}: receipt metadata must use the ordinary build owner'

# label, paths, contract owner, image needed, addon needed, worker needed, peer needed
scenarios = [
    ('runner-types', ['crates/runner-types/src/types.rs'], 'coverage', True, True, False, False),
    ('rfb-client', ['crates/rfb-client/src/qemu_gssapi.rs'], 'coverage', True, True, False, True),
    ('kerberos-worker', ['crates/kerberos-worker/src/lib.rs'], 'coverage', True, True, True, True),
    ('credentials', ['crates/kerberos-credentials/src/lib.rs'], 'coverage', True, True, True, True),
    ('other-crate', ['crates/xtask/src/main.rs'], 'coverage', False, True, False, False),
    ('workspace-lock', ['crates/Cargo.lock'], 'coverage', True, True, True, True),
    ('workspace-config', ['crates/.cargo/config.toml'], 'coverage', True, True, True, True),
    ('ci', ['.github/workflows/crates.yml'], 'coverage', True, True, True, True),
    ('worker-harness', ['.github/scripts/check-native-kerberos.sh'], 'coverage', True, True, True, False),
    ('peer-harness', ['.github/scripts/check-native-gssapi-peer.sh'], 'coverage', True, True, False, True),
    ('peer-provision', ['.github/scripts/prepare-kerberos-peer-fixture.py'], 'coverage', True, True, False, True),
    ('native-environment', ['.github/scripts/native-test-environment.sh'], 'coverage', True, True, True, True),
    ('native-routing-tests', ['.github/scripts/tests/runner-firewall-contract-workflow-test.sh'],
     'coverage', True, True, True, True),
    ('base-selector', ['.github/scripts/changed-base-ref.sh'], 'coverage', True, True, True, True),
    ('crate-selector', ['scripts/crate-changed.sh'], None, False, False, True, True),
    ('toolchain', ['docker/toolchain/Dockerfile'], None, False, False, True, True),
    ('qemu-producer', ['.github/scripts/prepare-qemu-gssapi-fixture.py'], 'coverage', True, True, False, False),
    ('qemu-wrapper', ['.github/scripts/check-full-qemu-producer.sh'], 'coverage', True, True, False, False),
    ('qemu-download', ['.github/scripts/download-verified.sh'], 'coverage', True, True, False, False),
    ('qemu-producer-tests', ['.github/scripts/tests/test-qemu-gssapi-producer.py'], 'coverage', True, True, False, False),
    ('qemu-runtime', ['crates/rfb-client/tests/fixtures/qemu_gssapi.py'], 'coverage', True, True, False, True),
    ('qemu-pins', ['crates/rfb-client/tests/fixtures/qemu_gssapi_full_pins.json'], 'coverage', True, True, False, True),
    ('fixture-only', [corpus], standalone, False, True, False, False),
    ('fixture-and-rust', [corpus, 'crates/runner-types/src/types.rs'], 'coverage', True, True, False, False),
    ('fixture-and-ci', [corpus, '.github/workflows/crates.yml'], 'coverage', True, True, True, True),
    ('unrelated', ['README.md'], None, False, False, False, False),
    ('firewall-semantics-fixture',
     ['turbo/packages/connectors/src/__tests__/firewall-semantics-contract.json'],
     standalone, False, True, False, False),
]

target = root / 'crates/target'
assert not target.is_symlink() and target.resolve() == target
assert subprocess.run(['git', 'check-ignore', '-q', str(target)], cwd=root).returncode == 0
target.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix='firewall-contract-workflow-', dir=target) as temporary:
    directory = Path(temporary)
    # This public, synthetic fixture must be traversable by the container's
    # unprivileged build owner; no production directory permissions are changed.
    directory.chmod(0o755)
    native = directory / 'native-environment'
    native.mkdir()
    (native / 'crates').mkdir()
    helper = str(root / '.github/scripts/native-test-environment.sh')
    host_env = os.environ | {'NATIVE_TEST_OWNER': ''}
    host_check = '''source "$1"
[[ $native_uid == "$(id -u)" && $native_gid == "$(id -g)" ]]
[[ ${#native_build_command[@]} == 0 && ${native_privileged_command[*]} == sudo ]]
[[ $(native_build id -u) == "$(id -u)" ]]
'''
    run(['bash', '-euo', 'pipefail', '-c', host_check, 'bash', helper], native, host_env)
    invalid = subprocess.run(
        ['bash', '-euo', 'pipefail', '-c', 'source "$1"', 'bash', helper],
        cwd=native, env=host_env | {'NATIVE_TEST_OWNER': 'native-fixture-missing-user'},
        text=True, capture_output=True)
    assert invalid.returncode != 0, 'unknown container owner must refuse'
    if os.geteuid() == 0:
        owner = run(['id', '-un', '1000'], native).strip()
        root_command = []
    else:
        owner = run(['id', '-un'], native).strip()
        root_command = ['sudo', '-n']
    # Bootstrap each real wrapper prefix from an unrelated working directory,
    # with a root caller but an ordinary-owned Git repository. No compiler,
    # signed provider, KDC or native runtime is invoked by this canary.
    bootstrap_repo = directory / 'bootstrap-repo'
    bootstrap_repo.mkdir()
    (bootstrap_repo / 'crates').mkdir()
    scripts = bootstrap_repo / '.github/scripts'
    scripts.mkdir(parents=True)
    shutil.copy2(helper, scripts / 'native-test-environment.sh')
    run(['git', 'init', '-q', '--initial-branch=main'], bootstrap_repo)
    bootstrap_uid = int(run(['id', '-u', owner], native).strip())
    bootstrap_gid = int(run(['id', '-g', owner], native).strip())
    assert bootstrap_uid != 0
    if os.geteuid() == 0:
        for path in (bootstrap_repo, bootstrap_repo / '.git'):
            assert not path.is_symlink() and path.is_dir()
            os.chown(path, bootstrap_uid, bootstrap_gid, follow_symlinks=False)
    assert bootstrap_repo.stat().st_uid == bootstrap_uid
    assert (bootstrap_repo / '.git').stat().st_uid == bootstrap_uid
    bootstrap_home = directory / 'bootstrap-home'
    bootstrap_home.mkdir()
    bootstrap_env = host_env | {'HOME': str(bootstrap_home), 'GIT_CONFIG_NOSYSTEM': '1',
                               'GIT_CONFIG_GLOBAL': '/dev/null'}
    for wrapper in ['check-native-kerberos.sh', 'check-native-gssapi-peer.sh']:
        source = (root / '.github/scripts' / wrapper).read_text()
        prefix, separator, _ = source.partition('source .github/scripts/native-test-environment.sh\n')
        assert separator, f'{wrapper}: native environment bootstrap missing'
        program = scripts / wrapper
        program.write_text(prefix + separator + '''
[[ $PWD == "$EXPECTED_BOOTSTRAP_ROOT" ]]
[[ $(native_build git rev-parse --show-toplevel) == "$EXPECTED_BOOTSTRAP_ROOT" ]]
native_build python3 - "$native_uid" "$native_gid" <<'BOOTSTRAP'
import os
from pathlib import Path
import sys
assert os.geteuid() == int(sys.argv[1]) != 0
assert os.getegid() == int(sys.argv[2])
assert os.getgroups() == []
status = dict(line.split(':', 1) for line in Path('/proc/self/status').read_text().splitlines())
for name in ('CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'):
    assert int(status[name].strip(), 16) == 0
assert int(status['NoNewPrivs'].strip()) == 1
BOOTSTRAP
''')
        result = subprocess.run(root_command + [
            'env', '-i', f'PATH={os.environ["PATH"]}', f'HOME={bootstrap_home}',
            'GIT_CONFIG_NOSYSTEM=1', 'GIT_CONFIG_GLOBAL=/dev/null',
            f'NATIVE_TEST_OWNER={owner}', f'EXPECTED_BOOTSTRAP_ROOT={bootstrap_repo}',
            'bash', str(program)], cwd=directory, env=bootstrap_env, text=True, capture_output=True)
        assert result.returncode == 0 and 'fatal:' not in result.stderr, \
            f'{wrapper}: root bootstrap refused or hid a Git ownership error: exit={result.returncode}: {result.stderr}'

    # Exercise the actual setpriv/UID/capability/environment boundary, not a
    # fabricated compiler or a namespace mock. This is not Docker/native success.
    container_check = '''source "$1"
[[ $native_uid != 0 && ${#native_privileged_command[@]} == 0 ]]
printf 'synthetic caller receipt\\n' > crates/target/caller-receipt.txt
chmod 0644 crates/target/caller-receipt.txt
native_build python3 - "$native_uid" <<'CHECK'
import json
import os
from pathlib import Path
import sys
assert os.geteuid() == int(sys.argv[1]) != 0
status = dict(line.split(':', 1) for line in Path('/proc/self/status').read_text().splitlines())
for name in ('CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'):
    assert int(status[name].strip(), 16) == 0
assert int(status['NoNewPrivs'].strip()) == 1
for name in ('HOME', 'CARGO_HOME'):
    path = Path(os.environ[name])
    assert path.is_dir() and path.stat().st_uid == os.geteuid()
    (path / 'owner-canary').write_text('synthetic owner canary\\n')
receipt = Path('crates/target/caller-receipt.txt')
assert receipt.stat().st_uid == 0
assert receipt.read_text() == 'synthetic caller receipt\\n'
metadata = Path('crates/target/owner-metadata.json')
metadata.write_text(json.dumps({'synthetic': True, 'owner': os.geteuid()}))
assert metadata.stat().st_uid == os.geteuid()
data = json.loads(metadata.read_text())
data['roundTrip'] = True
metadata.write_text(json.dumps(data))
assert json.loads(metadata.read_text())['roundTrip'] is True
CHECK
'''
    run(root_command + ['env', f'NATIVE_TEST_OWNER={owner}', 'bash', '-euo', 'pipefail',
                        '-c', container_check, 'bash', helper], native, host_env)
    refused = subprocess.run(root_command + [
        'env', 'NATIVE_TEST_OWNER=root', 'bash', '-euo', 'pipefail',
        '-c', 'source "$1"', 'bash', helper], cwd=native, env=host_env,
        text=True, capture_output=True)
    assert refused.returncode != 0 and 'must be unprivileged' in refused.stderr
    repo = directory / 'repo'
    repo.mkdir()
    for relative in ['scripts/crate-changed.sh', '.github/scripts/changed-base-ref.sh',
                     '.github/scripts/runner-image-context.sh', '.github/scripts/runner-image-target.sh']:
        destination = repo / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / relative, destination)
    for relative in {path for _, paths, *_ in scenarios for path in paths}:
        destination = repo / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        if not destination.exists():
            destination.write_text('fixture baseline\n')
    run(['git', 'init', '-q', '--initial-branch=main'], repo)
    run(['git', 'config', 'maintenance.auto', 'false'], repo)
    run(['git', 'config', 'user.name', 'Workflow fixture'], repo)
    run(['git', 'config', 'user.email', 'workflow@example.invalid'], repo)
    run(['git', 'add', '.'], repo)
    run(['git', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'baseline'], repo)
    base = run(['git', 'rev-parse', 'HEAD'], repo).strip()

    # Cargo is the external boundary; dependency traversal and Git change
    # detection still run through the actual repository scripts.
    metadata = directory / 'metadata.json'
    names = ['ably-subscriber', 'api-contracts', 'runner', 'runner-types', 'sandbox-firecracker',
             'nbd-cow', 'guest-control-tests', 'xtask', 'rfb-client', 'kerberos-worker',
             'kerberos-credentials']
    dependencies = {
        'runner': ['runner-types', 'rfb-client'],
        'runner-types': ['api-contracts'],
        'rfb-client': ['kerberos-worker', 'kerberos-credentials'],
        'kerberos-worker': ['kerberos-credentials'],
    }
    metadata.write_text(json.dumps({'packages': [
        {'name': name, 'dependencies': [
            {'name': dependency, 'path': str(repo / 'crates' / dependency)}
            for dependency in dependencies.get(name, [])]}
        for name in names
    ]}))
    bin_dir = directory / 'bin'
    bin_dir.mkdir()
    cargo = bin_dir / 'cargo'
    cargo.write_text('''#!/usr/bin/env bash
set -euo pipefail
[ "$*" = "metadata --no-deps --format-version 1" ]
if [[ -n ${CARGO_METADATA_FAILURE_AT:-} ]]; then
  count=0
  [[ ! -f "$CARGO_METADATA_CALLS" ]] || read -r count < "$CARGO_METADATA_CALLS"
  count=$((count + 1))
  printf '%s\\n' "$count" > "$CARGO_METADATA_CALLS"
  [[ $count != "$CARGO_METADATA_FAILURE_AT" ]] || exit 37
fi
cat "$CARGO_METADATA_FIXTURE"
''')
    cargo.chmod(0o755)

    contexts = {}
    for label, paths, owner, image_needed, addon_needed, worker_needed, peer_needed in scenarios:
        run(['git', 'reset', '--hard', base], repo)
        for relative in paths:
            with (repo / relative).open('a') as changed:
                changed.write(f'# {label} change\n')
        run(['git', 'add', '.'], repo)
        run(['git', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', label], repo)
        output = directory / f'{label}.output'
        output.write_text('')
        env = os.environ | {
            'PATH': f'{bin_dir}:{os.environ["PATH"]}', 'CARGO_METADATA_FIXTURE': str(metadata),
            'EVENT_NAME': 'pull_request', 'CHECKOUT_REF': 'refs/heads/fixture',
            'PULL_REQUEST_BASE_SHA': base, 'GITHUB_OUTPUT': str(output),
        }
        run(['bash', '-euo', 'pipefail', '-c', render(detect['run'], {'github.event_name': 'pull_request'})], repo, env)
        outputs = dict(line.split('=', 1) for line in output.read_text().splitlines())
        values = {f'steps.detect.outputs.{name}': value for name, value in outputs.items()}
        env.update({name: render(value, values) for name, value in consumer['env'].items()})
        run(['bash', '-euo', 'pipefail', '-c', consumer['run']], repo, env)
        outputs = dict(line.split('=', 1) for line in output.read_text().splitlines())
        assert outputs['crates-runner-consumer-needed'] == str(image_needed).lower(), label
        values.update({f'needs.detect.outputs.{name}': value for name, value in outputs.items()})
        values.update({f'needs.{name}.result': 'success' for name in gate['needs']})
        values.update({
            'github.event_name': 'pull_request',
            'needs.detect-release.outputs.skip': 'false',
            'needs.detect.outputs.metal-job-ref': 'pr-1-test',
            'needs.runner-host-groups.outputs.validation-matrix': '[]',
        })
        actual_owners = [name for name in ['coverage', standalone] if selected(name, values)]
        assert actual_owners == ([] if owner is None else [owner]), f'{label}: {actual_owners}'
        assert selected('mitm-addon-test', values) == addon_needed, label
        assert 'qemu-producer-needed' not in outputs, label
        native_selection = {'native-kerberos-runtime': worker_needed,
                            'native-gssapi-independent-peer': peer_needed}
        assert outputs['native-kerberos-needed'] == str(worker_needed).lower(), label
        assert outputs['native-gssapi-peer-needed'] == str(peer_needed).lower(), label
        for name, needed in native_selection.items():
            assert selected(name, values) == needed, f'{label}: {name}'
        contexts[label] = values
        normal = {name: 'success' if name == owner else 'skipped' for name in ['coverage', standalone]}
        normal.update({name: 'success' if needed else 'skipped' for name, needed in native_selection.items()})
        assert_gate(values, normal, True, label)
        for name, needed in native_selection.items():
            for result in ['failure', 'cancelled', 'skipped', '']:
                assert_gate(values, normal | {name: result}, result == 'skipped' and not needed,
                            f'{label}: {name} {result!r}')

        if owner:
            for result in ['failure', 'cancelled', 'skipped', '']:
                assert_gate(values, normal | {owner: result}, False, f'{label}: {owner} {result!r}')
            # A successful wrong owner cannot hide a failed or skipped owner.
            other = standalone if owner == 'coverage' else 'coverage'
            assert_gate(values, {owner: 'skipped', other: 'success'}, False, f'{label}: wrong owner')

    # Optional jobs may skip, but their failures must still fail the gate.
    unrelated = contexts['unrelated']
    skipped = {name: 'skipped' for name in gate['needs'] if name != 'detect'}
    assert_gate(unrelated, skipped, True, 'unrelated jobs skip')
    for name in ['coverage', standalone, 'native-kerberos-runtime', 'native-gssapi-independent-peer']:
        for result in ['failure', 'cancelled', '']:
            assert_gate(unrelated, skipped | {name: result}, False, f'unrelated: {name} {result!r}')
    for result in ['failure', 'cancelled', 'skipped', '']:
        assert_gate(unrelated, skipped | {'detect': result}, False, f'detect: {result!r}')
        assert not selected('coverage', unrelated | {'needs.detect.result': result})
        assert not selected(standalone, contexts['fixture-only'] | {'needs.detect.result': result})

    for name in ['native-kerberos-needed', 'native-gssapi-peer-needed']:
        for invalid in ['', 'TRUE', 'false ', '1']:
            assert_gate(unrelated | {f'needs.detect.outputs.{name}': invalid}, skipped, False,
                        f'invalid {name}: {invalid!r}')

    # Optional tooling changes keep the existing CI-change routing policy.
    # Neither deletion nor moving the tool can recreate a QEMU job/dependency.
    for operation in ['delete', 'rename']:
        run(['git', 'reset', '--hard', base], repo)
        source = '.github/scripts/prepare-qemu-gssapi-fixture.py'
        if operation == 'delete':
            (repo / source).unlink()
        else:
            run(['git', 'mv', source, 'renamed-qemu-fixture.py'], repo)
        run(['git', 'add', '-A'], repo)
        run(['git', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', operation], repo)
        output = directory / f'{operation}.output'
        output.write_text('')
        run(['bash', '-euo', 'pipefail', '-c', render(detect['run'], {'github.event_name': 'pull_request'})],
            repo, env | {'GITHUB_OUTPUT': str(output)})
        operation_outputs = dict(line.split('=', 1) for line in output.read_text().splitlines())
        assert 'qemu-producer-needed' not in operation_outputs, operation
        # Detect already selects a deletion in .github; a pure rename
        # outside .github is not a Rust/CI change under its existing contract.
        expected_native = operation == 'delete'
        assert operation_outputs['ci-changed'] == operation_outputs['any-changed'] == str(expected_native).lower(), operation
        values = contexts['qemu-producer'] | {
            f'needs.detect.outputs.{name}': value for name, value in operation_outputs.items()}
        assert selected('coverage', values) == expected_native, operation
        for name in ['native-kerberos-runtime', 'native-gssapi-independent-peer']:
            assert not selected(name, values), operation
        results = {'coverage': 'success' if expected_native else 'skipped',
                   'native-kerberos-runtime': 'skipped', 'native-gssapi-independent-peer': 'skipped'}
        assert_gate(values, results | {standalone: 'skipped'}, True, operation)

    # Charge actual deleted/renamed harness and transitive crate inputs.
    required_inputs = [
        ('.github/scripts/check-native-kerberos.sh', True, False),
        ('.github/scripts/check-native-gssapi-peer.sh', False, True),
        ('crates/kerberos-credentials/src/lib.rs', True, True),
    ]
    for source, worker_needed, peer_needed in required_inputs:
        for operation in ['delete', 'rename']:
            run(['git', 'reset', '--hard', base], repo)
            if operation == 'delete':
                (repo / source).unlink()
            else:
                run(['git', 'mv', source, 'retired-native-input.txt'], repo)
            run(['git', 'add', '-A'], repo)
            run(['git', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', operation], repo)
            output.write_text('')
            run(['bash', '-euo', 'pipefail', '-c', render(detect['run'], {'github.event_name': 'pull_request'})],
                repo, env | {'GITHUB_OUTPUT': str(output)})
            changed = dict(line.split('=', 1) for line in output.read_text().splitlines())
            assert changed['native-kerberos-needed'] == str(worker_needed).lower(), (source, operation)
            assert changed['native-gssapi-peer-needed'] == str(peer_needed).lower(), (source, operation)

    # Main/merge queue use the same precise native selection, never QEMU builds.
    for event in ['push', 'merge_group']:
        output = directory / f'{event}.output'
        output.write_text('')
        # The last synthetic commit is unrelated; make a real Rust delta again.
        run(['git', 'reset', '--hard', base], repo)
        with (repo / 'crates/xtask/src/main.rs').open('a') as changed:
            changed.write(f'{event} Rust change\n')
        run(['git', 'add', '.'], repo)
        run(['git', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', event], repo)
        event_env = env | {
            'EVENT_NAME': event, 'CHECKOUT_REF': 'refs/heads/main' if event == 'push' else 'refs/heads/gh-readonly-queue/main/fixture',
            'MERGE_GROUP_BASE_SHA': base, 'GITHUB_OUTPUT': str(output),
        }
        run(['bash', '-euo', 'pipefail', '-c', render(detect['run'], {'github.event_name': event})], repo, event_env)
        event_outputs = dict(line.split('=', 1) for line in output.read_text().splitlines())
        assert event_outputs['any-changed'] == 'true', event
        assert 'qemu-producer-needed' not in event_outputs, event
        values = contexts['other-crate'] | {'github.event_name': event} | {
            f'needs.detect.outputs.{name}': value for name, value in event_outputs.items()}
        assert selected('coverage', values), event
        assert not selected('native-kerberos-runtime', values), event
        assert not selected('native-gssapi-independent-peer', values), event
        native_skipped = {'native-kerberos-runtime': 'skipped', 'native-gssapi-independent-peer': 'skipped'}
        assert_gate(values, native_skipped, True, f'{event}: unrelated native jobs skip')
        for result in ['failure', 'cancelled', 'skipped', '']:
            assert_gate(values, native_skipped | {'coverage': result}, False, f'{event}: Rust {result!r}')
        for name in native_skipped:
            for result in ['failure', 'cancelled', '']:
                assert_gate(values, native_skipped | {name: result}, False, f'{event}: native {result!r}')

    # Fail the eighth metadata operation: the first newly selected native
    # dependency closure, after generic detection has already written outputs.
    output = directory / 'metadata-error.output'
    output.write_text('')
    failed = subprocess.run(
        ['bash', '-euo', 'pipefail', '-c', render(detect['run'], {'github.event_name': 'pull_request'})],
        cwd=repo, env=env | {'GITHUB_OUTPUT': str(output), 'CARGO_METADATA_FAILURE_AT': '8',
                            'CARGO_METADATA_CALLS': str(directory / 'metadata-calls')},
        text=True, capture_output=True)
    assert failed.returncode == 2, 'native metadata failure must fail detect'
    partial = dict(line.split('=', 1) for line in output.read_text().splitlines())
    assert 'native-kerberos-needed' not in partial and 'native-gssapi-peer-needed' not in partial

    released = unrelated | {'needs.detect-release.outputs.skip': 'true'}
    assert_gate(released, {name: 'skipped' for name in gate['needs']}, True, 'release fast path')

print('runner-firewall-contract-workflow-test: ok')
PY
