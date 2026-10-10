#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
ruby "$repo_root/.github/scripts/compose-ci-workflow.rb" --check
# Run the production insertion guard: independently maintained module IDs must
# never silently overwrite an existing native job.
ruby -I "$repo_root/.github/scripts" -e '
  ARGV << "--check"
  require "compose-ci-workflow"
  jobs = {}
  put_job(jobs, "existing", {"name" => "original"})
  begin
    put_job(jobs, "existing", {"name" => "replacement"})
    raise "duplicate CI job accepted"
  rescue => error
    raise unless error.message == "duplicate CI job id: existing"
  end
  raise "job was overwritten" unless jobs.fetch("existing").fetch("name") == "original"
'
python3 - "$repo_root" <<'PY'
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

root = Path(sys.argv[1])
def workflow(name):
    return json.loads(subprocess.check_output(['yq', '-o=json', '.', str(root / f'.github/workflows/{name}.yml')], text=True))

ci = workflow('ci')
jobs = ci['jobs']
assert set(ci['on']) == {'pull_request', 'merge_group'}
for name in ['turbo', 'crates', 'runner-image']:
    assert not {'pull_request', 'merge_group'} & set(workflow(name)['on']), name
assert set(workflow('turbo')['on']) == {'workflow_call'}
for name in ['crates', 'runner-image']:
    assert workflow(name)['on'] == {'push': {'branches': ['main']}}
assert jobs['ci-gate-turbo']['name'] == workflow('turbo')['jobs']['ci-gate-turbo']['name']
assert 'ci-gate-crates' in jobs

def needs(job):
    value = job.get('needs', [])
    return [value] if isinstance(value, str) else value

def ancestors(name):
    result = set(needs(jobs[name]))
    for dependency in list(result):
        result |= ancestors(dependency)
    return result

for name in ['lint-eslint', 'test-api', 'test-cli', 'deploy-api', 'deploy-app',
             'crates-check', 'crates-coverage', 'crates-host-cpu-fairness-build',
             'crates-guest-rpc-firecracker-build']:
    assert not any(id.startswith('image-') for id in ancestors(name)), name
assert {'image-build-arm64', 'image-build-x86_64'} <= set(needs(jobs['deploy-runner-prepare']))
assert not {'image-asset', 'image-prewarm-rust-cache'} & ancestors('deploy-runner-prepare')
assert needs(jobs['image-build-arm64']) == ['image-prepare', 'image-compile', 'image-cancel-superseded']
assert needs(jobs['image-build-x86_64']) == ['image-prepare', 'image-compile', 'image-cancel-superseded']
assert not needs(jobs['image-prepare'])
assert 'image-cancel-superseded' not in ancestors('image-compile')

selected_jobs = ['runner-test-prepare', 'runner-behavior-lane-a', 'runner-behavior-lane-b',
                 'runner-behavior-lane-c', 'runner-behavior-lane-d',
                 'host-cpu-fairness-test', 'guest-rpc-firecracker-test']
targets = {'arm64': 'aarch64-unknown-linux-musl', 'x86_64': 'x86_64-unknown-linux-musl'}
for arch in targets:
    other = next(id for id in targets if id != arch)
    for name in selected_jobs:
        full = f'crates-{name}-{arch}'
        assert f'image-build-{arch}' in ancestors(full)
        assert not {f'image-build-{other}', 'image-asset', 'image-prewarm-rust-cache'} & ancestors(full), full
    for lane in 'abcd':
        assert needs(jobs[f'crates-runner-behavior-lane-{lane}-{arch}']) == [f'crates-runner-test-prepare-{arch}']
for job in jobs.values():
    for step in job.get('steps', []):
        if step.get('run') in ['.github/scripts/wait-runner-image.sh', '.github/scripts/wait-runner-image-groups.sh']:
            assert step['env']['RUNNER_IMAGE_RUN_ID'] == '${{ github.run_id }}'
            assert 'LOOKUP_SHA' not in step['env']

# Execute actual producer partitioning, including invalid/empty plans.
with tempfile.TemporaryDirectory() as directory:
    path = Path(directory) / 'output'
    def partition(needed, matrix, expected):
        path.write_text('')
        result = subprocess.run(['bash', str(root / '.github/scripts/partition-ci-image-matrix.sh')],
            env=dict(os.environ, IMAGE_NEEDED=needed, IMAGE_MATRIX=json.dumps(matrix), GITHUB_OUTPUT=str(path)),
            capture_output=True, text=True)
        assert (result.returncode == 0) == expected, result.stderr
        return dict(line.split('=', 1) for line in path.read_text().splitlines())
    entries = [{'id': id, 'target': target} for id, target in targets.items()]
    output = partition('true', entries, True)
    for arch in targets:
        assert json.loads(output[arch]) == [entry for entry in entries if entry['id'] == arch]
    for entry in entries:
        output = partition('true', [entry], True)
        assert json.loads(output[next(id for id in targets if id != entry['id'])]) == []
    assert partition('false', [], True) == {'arm64': '[]', 'x86_64': '[]'}
    for needed, matrix in [('true', []), ('unknown', []), ('false', entries),
                           ('true', entries + [entries[0]]), ('true', [{'id': 'unknown', 'target': 'unknown'}]),
                           ('true', [{'id': 'arm64', 'target': targets['x86_64']}]), ('true', {})]:
        partition(needed, matrix, False)

# GitHub's dependency barrier and implicit success() are part of readiness.
def evaluate(source, values, job=None, cancelled=False):
    source = str(source).strip().removeprefix('${{').removesuffix('}}').strip()
    deps = needs(job or {})
    for function, value in {
        'always()': True, 'cancelled()': cancelled,
        'success()': all(values[f'needs.{id}.result'] == 'success' for id in deps),
        'failure()': any(values[f'needs.{id}.result'] == 'failure' for id in deps),
    }.items():
        source = source.replace(function, str(value))
    source = re.sub(r'\b(?:github|needs)\.[\w.-]+', lambda match: repr(values[match[0]]), source)
    source = source.replace('&&', ' and ').replace('||', ' or ')
    source = re.sub(r'!(?!=)', 'not ', source)
    return eval('(' + source + ')', {'__builtins__': {}}, {'true': True, 'false': False})

def condition(name, values, cancelled=False):
    job = jobs[name]
    if any(values[f'needs.{id}.result'] not in ['success', 'failure', 'cancelled', 'skipped'] for id in needs(job)):
        return False
    source = job.get('if', 'true')
    if not any(function in source for function in ['always(', 'cancelled(', 'success(', 'failure(']):
        if any(values[f'needs.{id}.result'] != 'success' for id in needs(job)):
            return False
    return bool(evaluate(source, values, job, cancelled))

def context(arch):
    values = {f'needs.{id}.result': 'success' for id in jobs}
    values.update({
        'needs.crates-detect-release.outputs.skip': 'false',
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
    other = next(id for id in targets if id != arch)
    for name in selected_jobs:
        values[f'needs.crates-{name}-{other}.result'] = 'skipped'
    values[f'needs.crates-runner-image-architecture-manifest-{arch}.result'] = 'skipped'
    return values

for arch in targets:
    values = context(arch)
    other = next(id for id in targets if id != arch)
    values[f'needs.image-build-{other}.result'] = 'in_progress'
    values['needs.image-asset.result'] = 'in_progress'
    assert condition(f'crates-runner-test-prepare-{arch}', values)
    for lane in 'abcd':
        assert condition(f'crates-runner-behavior-lane-{lane}-{arch}', values)
    assert not condition(f'crates-runner-test-prepare-{other}', values)
    for result in ['failure', 'cancelled', 'skipped']:
        failed = values | {f'needs.image-build-{arch}.result': result}
        assert not condition(f'crates-runner-test-prepare-{arch}', failed)
    assert not condition(f'crates-runner-test-prepare-{arch}', values, cancelled=True)
    pending_handoff = values | {'needs.image-cancel-superseded.result': 'in_progress'}
    assert condition('image-prepare', pending_handoff)
    assert condition('image-compile', pending_handoff)
    assert not condition(f'image-build-{arch}', pending_handoff)
    for misses, compile_result in [('0', 'skipped'), ('1', 'success')]:
        producer = context(arch) | {'needs.image-prepare.outputs.runner-binary-miss-count': misses,
                                  'needs.image-compile.result': compile_result}
        assert condition(f'image-build-{arch}', producer)
        for result in ['failure', 'cancelled', 'skipped']:
            assert not condition(f'image-build-{arch}', producer | {'needs.image-cancel-superseded.result': result})
        assert not condition(f'image-build-{arch}', producer, cancelled=True)
        assert not condition(f'image-build-{arch}', producer | {'needs.image-prepare.outputs.image-matrix-' + arch: '[]'})

# Execute the composed required gate, rather than trusting its static shape.
def render(source, values):
    return re.sub(r'\$\{\{\s*(.*?)\s*\}\}', lambda match: str(evaluate(match[1], values)).lower()
                  if isinstance(evaluate(match[1], values), bool) else str(evaluate(match[1], values)), str(source))

def gate(values, expected):
    step = next(step for step in jobs['ci-gate-crates']['steps'] if step.get('name') == 'Validate CI results')
    env = dict(os.environ)
    env.update({key: render(value, values) for key, value in step['env'].items()})
    result = subprocess.run(['bash', '-e', '-o', 'pipefail', '-c', render(step['run'], values)],
                            env=env, text=True, capture_output=True)
    assert (result.returncode == 0) == expected, result.stdout + result.stderr

for arch in targets:
    values = context(arch)
    other = next(id for id in targets if id != arch)
    gate(values, True)
    for name in selected_jobs + [f'runner-image-architecture-manifest']:
        variant = other if name == 'runner-image-architecture-manifest' else arch
        # The selected branch/complement may never hide a failed or cancelled run.
        for result in ['failure', 'cancelled']:
            gate(values | {f'needs.crates-{name}-{variant}.result': result}, False)
    for result in ['failure', 'cancelled', 'success']:
        gate(values | {f'needs.crates-runner-behavior-lane-a-{other}.result': result}, False)
        gate(values | {f'needs.crates-runner-image-architecture-manifest-{arch}.result': result}, False)
    for name in ['runner-test-prepare', 'guest-rpc-firecracker-test', 'runner-behavior-lane-a',
                 'runner-behavior-lane-b', 'runner-behavior-lane-c', 'runner-behavior-lane-d']:
        gate(values | {f'needs.crates-{name}-{arch}.result': 'skipped'}, False)
    gate(values | {f'needs.crates-runner-image-architecture-manifest-{other}.result': 'skipped'}, False)
    gate(values | {'needs.crates-runner-host-groups.outputs.selected-target': ''}, False)
    gate(values | {'needs.crates-runner-host-groups.outputs.selected-target': 'unsupported'}, False)
    single = values | {'needs.crates-runner-host-groups.outputs.validation-matrix': '[]',
                      f'needs.crates-runner-image-architecture-manifest-{other}.result': 'skipped'}
    gate(single, True)

no_images = context('arm64') | {
    'needs.crates-detect.outputs.metal-job-ref': '',
    'needs.crates-detect.outputs.crates-runner-consumer-needed': 'false',
    'needs.crates-runner-host-groups.outputs.selected-target': '',
    'needs.crates-runner-host-groups.outputs.validation-matrix': '',
}
for arch in targets:
    for name in selected_jobs + ['runner-image-architecture-manifest']:
        no_images[f'needs.crates-{name}-{arch}.result'] = 'skipped'
for name in ['runner-host-groups', 'host-cpu-fairness-build', 'guest-rpc-firecracker-build',
             'nbd-cow-test', 'runner-rootfs-process-test']:
    no_images[f'needs.crates-{name}.result'] = 'skipped'
gate(no_images, True)
release = {f'needs.{id}.result': 'skipped' for id in jobs}
gate(no_images | release | {'needs.crates-detect-release.outputs.skip': 'true'}, True)

print('ci-readiness-workflow-test: ok')
PY
