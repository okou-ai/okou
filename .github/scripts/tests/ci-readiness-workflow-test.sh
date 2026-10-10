#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
python3 - "$repo_root" <<'PY'
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

root = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location('expressions', root / '.github/scripts/tests/workflow-test-expressions.py')
x = importlib.util.module_from_spec(spec)
spec.loader.exec_module(x)
workflow = lambda name: x.workflow(root, name)
ci = workflow('ci')
jobs = ci['jobs']
assert set(ci['on']) == {'pull_request', 'merge_group', 'workflow_call'}
assert not (root / '.github/scripts/compose-ci-workflow.rb').exists()
assert not any('Generated' in line for line in (root / '.github/workflows/ci.yml').read_text().splitlines())

# Verify real local calls, interfaces, unique ownership and GitHub call limits.
owners = {}
for identifier, job in jobs.items():
    if 'uses' not in job:
        assert identifier in {'ci-admission', 'detect-release', 'detect-turbo-ts-checks', 'validate-release',
                              'image-cancel-superseded', 'ci-gate-turbo', 'ci-gate-crates'}, identifier
        continue
    path = job['uses']
    assert path.startswith('./.github/workflows/ci-')
    callee = workflow(Path(path).stem)
    call = callee['on']['workflow_call']
    assert set(job.get('with', {})) <= set(call.get('inputs', {})), identifier
    assert {k for k, v in call.get('inputs', {}).items() if v.get('required')} <= set(job.get('with', {})), identifier
    assert isinstance(job.get('secrets', {}), dict), identifier
    assert set(job.get('secrets', {})) <= set(call.get('secrets', {})), identifier
    for name, value in job.get('secrets', {}).items():
        assert value == '${{ secrets.' + name + ' }}', (identifier, name)
    assert job['with']['dependencies'] == '${{ toJSON(needs) }}'
    for child_id, child in callee['jobs'].items():
        assert 'uses' not in child, (path, child_id)
        assert child['permissions']['actions'] == 'read', (path, child_id)
        owner_key = (path.split('ci-', 1)[1].split('-', 1)[0], child_id)
        previous = owners.setdefault(owner_key, path)
        assert previous == path, (owner_key, previous, path)
        assert set(x.needs(child)) <= set(callee['jobs']), (path, child_id)
        assert 'needs.' not in json.dumps(child).replace('toJSON(needs)', ''), (path, child_id)
    if 'results' in call.get('outputs', {}):
        assert call['outputs']['results']['value'] == '${{ toJSON(jobs) }}'

assert jobs['image-build-arm64']['uses'] == jobs['image-build-x86_64']['uses']
for logical in ['crates-runner-test-prepare', 'crates-behavior', 'crates-host-cpu-fairness-test', 'crates-guest-rpc-firecracker-test']:
    assert jobs[logical + '-arm64']['uses'] == jobs[logical + '-x86_64']['uses']

for name, surface in [('turbo', 'turbo'), ('crates', 'crates'), ('runner-image', 'images')]:
    entry = workflow(name)
    assert len(entry['jobs']) == 1
    caller = next(iter(entry['jobs'].values()))
    assert caller['uses'] == './.github/workflows/ci.yml'
    assert caller['with'] == {'surface': surface}
    assert not {'pull_request', 'merge_group'} & set(entry['on'])
    assert not any('steps' in job for job in entry['jobs'].values())
    assert isinstance(caller['secrets'], dict)
    if name != 'turbo':
        assert entry['on'] == {'push': {'branches': ['main']}}
staging = workflow('staging')
assert staging['concurrency'] == {'group': 'staging', 'cancel-in-progress': False}
assert next(iter(staging['jobs'].values()))['uses'] == './.github/workflows/turbo.yml'

def calls(name, seen=None, depth=1):
    seen = set() if seen is None else seen
    assert depth <= 10
    for job in workflow(name)['jobs'].values():
        if 'uses' in job:
            child = Path(job['uses']).stem
            if child not in seen:
                seen.add(child)
                calls(child, seen, depth + 1)
    return seen
assert len(calls('staging')) <= 50
assert len(calls('ci')) == 32

# Snapshot every actual direct dependency; no controller cycle or missing ID.
def ancestors(name, active=frozenset()):
    assert name not in active, name
    result = set(x.needs(jobs[name]))
    assert result <= set(jobs), (name, result - set(jobs))
    for dependency in list(result):
        result |= ancestors(dependency, active | {name})
    return result
for name in jobs:
    ancestors(name)
for name in ['turbo-checks', 'prepare', 'test-migrate', 'deploy-api', 'deploy-app', 'deploy-cli',
             'crates-checks', 'crates-host-cpu-fairness-build', 'crates-guest-rpc-firecracker-build']:
    assert not any(d.startswith('image-') for d in ancestors(name)), name
    if name not in ['crates-host-cpu-fairness-build', 'crates-guest-rpc-firecracker-build']:
        assert 'crates-runner-host-groups' not in ancestors(name), name
assert not x.needs(jobs['detect-release'])
assert not {'ci-admission', 'image-cancel-superseded'} & ancestors('image-prepare')
assert 'image-cancel-superseded' not in ancestors('image-compile')
for arch in ['arm64', 'x86_64']:
    assert 'image-cancel-superseded' in x.needs(jobs[f'image-build-{arch}'])
    other = 'x86_64' if arch == 'arm64' else 'arm64'
    for logical in ['crates-runner-test-prepare', 'crates-behavior', 'crates-host-cpu-fairness-test', 'crates-guest-rpc-firecracker-test']:
        full = f'{logical}-{arch}'
        assert f'image-build-{arch}' in ancestors(full), full
        assert not {f'image-build-{other}', 'image-asset', 'image-prewarm-rust-cache'} & ancestors(full), full
    assert 'crates-guest-rpc-firecracker-build' in x.needs(jobs[f'crates-guest-rpc-firecracker-test-{arch}'])
assert {'image-build-arm64', 'image-build-x86_64'} <= ancestors('deploy-runner-prepare')
for name in ['deploy-runner-prepare', 'ci-gate-turbo', 'ci-gate-crates']:
    assert not {'image-asset', 'image-prewarm-rust-cache'} & ancestors(name), name
for finalizer in ['cli-e2e-02-playwright-finalize', 'cli-e2e-03-runner-cleanup']:
    assert finalizer not in ancestors('ci-gate-turbo')

# The mode is a caller contract, not a polling fallback.
for name in ['deploy-runner-prepare', 'crates-runner-test-prepare-arm64', 'crates-runner-test-prepare-x86_64',
             'crates-runner-image-architecture-manifest-arm64', 'crates-runner-image-architecture-manifest-x86_64']:
    assert jobs[name]['with']['image-handoff'] == "${{ github.event_name == 'push' && 'main' || 'current' }}"
assert jobs['image-cancel-superseded']['permissions']['actions'] == 'write'
assert 'github.event.pull_request.head.repo.full_name == github.repository' in jobs['image-cancel-superseded']['if']
for identifier, job in jobs.items():
    if identifier != 'image-cancel-superseded' and 'uses' not in job:
        assert job['permissions']['actions'] == 'read', identifier

targets = {'arm64': 'aarch64-unknown-linux-musl', 'x86_64': 'x86_64-unknown-linux-musl'}
selected = ['crates-runner-test-prepare', 'crates-behavior', 'crates-host-cpu-fairness-test', 'crates-guest-rpc-firecracker-test']

def context(arch='arm64'):
    values = {f'needs.{name}.result': 'success' for name in jobs}
    values.update({
        'inputs.surface': '', 'github.event_name': 'pull_request', 'github.repository': 'test/repo',
        'github.event.pull_request.head.repo.full_name': 'test/repo',
        'needs.detect-release.outputs.skip': 'false',
        'needs.crates-detect.outputs.any-changed': 'true',
        'needs.crates-detect.outputs.runner-firewall-contract-inputs-changed': 'false',
        'needs.crates-detect.outputs.metal-job-ref': 'pr-42-test',
        'needs.crates-detect.outputs.crates-runner-consumer-needed': 'true',
        'needs.crates-detect.outputs.sandbox-firecracker-changed': 'true',
        'needs.crates-detect.outputs.ci-changed': 'true',
        'needs.crates-runner-host-groups.outputs.selected-target': targets[arch],
        'needs.crates-runner-host-groups.outputs.validation-matrix': '[{"target":"other"}]',
        'needs.image-prepare.outputs.current-runner-image-needed': 'true',
        'needs.image-prepare.outputs.runner-binary-miss-count': '1',
        'needs.image-prepare.outputs.image-matrix-arm64': '[{"id":"arm64"}]',
        'needs.image-prepare.outputs.image-matrix-x86_64': '[{"id":"x86_64"}]',
    })
    for group in ['crates-checks', 'crates-host-tests', 'crates-behavior-arm64', 'crates-behavior-x86_64']:
        owner = workflow(Path(jobs[group]['uses']).stem)
        values[f'needs.{group}.outputs.results'] = json.dumps({name: {'result': 'success'} for name in owner['jobs']})
    other = 'x86_64' if arch == 'arm64' else 'arm64'
    for logical in selected:
        values[f'needs.{logical}-{other}.result'] = 'skipped'
    values[f'needs.crates-runner-image-architecture-manifest-{arch}.result'] = 'skipped'
    return values

for arch in targets:
    values = context(arch)
    other = 'x86_64' if arch == 'arm64' else 'arm64'
    pending = values | {f'needs.image-build-{other}.result': 'in_progress', 'needs.image-asset.result': 'in_progress'}
    for logical in selected:
        assert x.condition(jobs[f'{logical}-{arch}'], pending), logical
    assert not x.condition(jobs[f'crates-runner-test-prepare-{other}'], pending)
    for status in ['failure', 'cancelled', 'skipped']:
        assert not x.condition(jobs[f'crates-runner-test-prepare-{arch}'], values | {f'needs.image-build-{arch}.result': status})
        assert not x.condition(jobs[f'crates-guest-rpc-firecracker-test-{arch}'], values | {'needs.crates-guest-rpc-firecracker-build.result': status})
    handoff = values | {'needs.image-cancel-superseded.result': 'in_progress', 'needs.ci-admission.result': 'in_progress'}
    assert x.condition(jobs['image-prepare'], handoff)
    assert x.condition(jobs['image-compile'], handoff)
    assert not x.condition(jobs[f'image-build-{arch}'], handoff)
    for misses, status in [('0', 'skipped'), ('1', 'success')]:
        producer = values | {'needs.image-prepare.outputs.runner-binary-miss-count': misses, 'needs.image-compile.result': status}
        assert x.condition(jobs[f'image-build-{arch}'], producer)
        for bad in ['failure', 'cancelled', 'skipped']:
            assert not x.condition(jobs[f'image-build-{arch}'], producer | {'needs.image-cancel-superseded.result': bad})
        assert not x.condition(jobs[f'image-build-{arch}'], producer, cancelled=True)
    main = values | {'inputs.surface': 'crates', 'github.event_name': 'push', f'needs.image-build-{arch}.result': 'skipped'}
    assert x.condition(jobs[f'crates-runner-test-prepare-{arch}'], main)

    # Execute the actual current gate, including real nested result receipts.
    gate = jobs['ci-gate-crates']
    x.run_gate(gate, values, True)
    for logical in selected:
        for status in ['failure', 'cancelled', 'skipped']:
            x.run_gate(gate, values | {f'needs.{logical}-{arch}.result': status}, False)
        for status in ['success', 'failure', 'cancelled']:
            x.run_gate(gate, values | {f'needs.{logical}-{other}.result': status}, False)
    for group in ['crates-checks', 'crates-host-tests', f'crates-behavior-{arch}']:
        for status in ['failure', 'cancelled']:
            x.run_gate(gate, values | {f'needs.{group}.result': status}, False)
        receipt = json.loads(values[f'needs.{group}.outputs.results'])
        for member in receipt:
            for status in ['failure', 'cancelled']:
                failed = receipt | {member: {'result': status}}
                x.run_gate(gate, values | {f'needs.{group}.outputs.results': json.dumps(failed)}, False)
        x.run_gate(gate, values | {f'needs.{group}.outputs.results': '{}'}, False)
    for status in ['failure', 'cancelled', 'skipped']:
        x.run_gate(gate, values | {f'needs.crates-runner-image-architecture-manifest-{other}.result': status}, False)
        for logical in ['crates-host-cpu-fairness-build', 'crates-guest-rpc-firecracker-build', 'crates-runner-host-groups']:
            x.run_gate(gate, values | {f'needs.{logical}.result': status}, False)
    for target in ['', 'unsupported']:
        x.run_gate(gate, values | {'needs.crates-runner-host-groups.outputs.selected-target': target}, False)
    single = values | {'needs.crates-runner-host-groups.outputs.validation-matrix': '[]',
                       f'needs.crates-runner-image-architecture-manifest-{other}.result': 'skipped'}
    x.run_gate(gate, single, True)
    cpu_optional = single | {'needs.crates-detect.outputs.ci-changed': 'false', 'needs.crates-detect.outputs.sandbox-firecracker-changed': 'false',
                             'needs.crates-host-cpu-fairness-build.result': 'skipped', f'needs.crates-host-cpu-fairness-test-{arch}.result': 'skipped'}
    x.run_gate(gate, cpu_optional, True)

no_images = context() | {'needs.crates-detect.outputs.metal-job-ref': '',
                         'needs.crates-detect.outputs.crates-runner-consumer-needed': 'false',
                         'needs.crates-runner-host-groups.outputs.selected-target': '',
                         'needs.crates-runner-host-groups.outputs.validation-matrix': ''}
for arch in targets:
    for logical in selected + ['crates-runner-image-architecture-manifest']:
        no_images[f'needs.{logical}-{arch}.result'] = 'skipped'
for name in ['crates-runner-host-groups', 'crates-host-cpu-fairness-build', 'crates-guest-rpc-firecracker-build', 'crates-host-tests']:
    no_images[f'needs.{name}.result'] = 'skipped'
x.run_gate(jobs['ci-gate-crates'], no_images, True)
release = {f'needs.{name}.result': 'skipped' for name in jobs} | {'needs.detect-release.result': 'success', 'needs.detect-release.outputs.skip': 'true'}
x.run_gate(jobs['ci-gate-crates'], no_images | release, True)
for status in ['failure', 'cancelled', 'skipped']:
    x.run_gate(jobs['ci-gate-crates'], no_images | release | {'needs.detect-release.result': status}, False)

# Execute the production matrix partitioner; no guessed or duplicate target.
with tempfile.TemporaryDirectory() as directory:
    output = Path(directory) / 'output'
    def partition(needed, matrix, expected):
        output.write_text('')
        result = subprocess.run(['bash', str(root / '.github/scripts/partition-ci-image-matrix.sh')],
            env=dict(os.environ, IMAGE_NEEDED=needed, IMAGE_MATRIX=json.dumps(matrix), GITHUB_OUTPUT=str(output)), capture_output=True, text=True)
        assert (result.returncode == 0) == expected, result.stderr
        return dict(line.split('=', 1) for line in output.read_text().splitlines())
    entries = [{'id': arch, 'target': target} for arch, target in targets.items()]
    for matrix in [entries, entries[:1], entries[1:]]:
        result = partition('true', matrix, True)
        for arch in targets:
            assert json.loads(result[arch]) == [row for row in matrix if row['id'] == arch]
    assert partition('false', [], True) == {'arm64': '[]', 'x86_64': '[]'}
    for needed, matrix in [('true', []), ('unknown', []), ('false', entries), ('true', entries + entries[:1]),
                           ('true', [{'id': 'unknown', 'target': 'unknown'}]),
                           ('true', [{'id': 'arm64', 'target': targets['x86_64']}]), ('true', {})]:
        partition(needed, matrix, False)

# Test explicit transport dispatch with stub workers, never a real artifact API.
with tempfile.TemporaryDirectory() as directory:
    directory = Path(directory)
    for name in ['wait-runner-image.sh', 'wait-runner-image-groups.sh']:
        path = directory / name
        path.write_text('#!/usr/bin/env bash\nprintf "%s:%s\\n" "${RUNNER_IMAGE_RUN_ID-unset}" "' + name + '"\n')
        path.chmod(0o755)
    handoff = directory / 'ci-image-handoff.sh'
    handoff.write_bytes((root / '.github/scripts/ci-image-handoff.sh').read_bytes())
    for mode, event, ref, run_id, success, expected in [
        ('current', 'pull_request', 'refs/pull/1/merge', '42', True, '42'),
        ('main', 'push', 'refs/heads/main', '42', True, 'unset'),
        ('main', 'pull_request', 'refs/heads/main', '42', False, ''),
        ('main', 'push', 'refs/heads/feature', '42', False, ''),
        ('unknown', 'push', 'refs/heads/main', '42', False, ''),
        ('current', 'pull_request', 'refs/pull/1/merge', '', False, ''),
    ]:
        result = subprocess.run(['bash', str(handoff), 'single'], env=dict(os.environ, IMAGE_HANDOFF=mode,
            GITHUB_EVENT_NAME=event, GITHUB_REF=ref, GITHUB_RUN_ID=run_id, RUNNER_IMAGE_RUN_ID='stale'), capture_output=True, text=True)
        assert (result.returncode == 0) == success, result.stderr
        if success:
            assert result.stdout == expected + ':wait-runner-image.sh\n'
        else:
            assert not result.stdout

print('ci-readiness-workflow-test: ok')
PY
