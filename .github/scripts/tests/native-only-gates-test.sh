#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
python3 - "$repo_root" <<'PY'
import json
import os
from pathlib import Path
import re
import subprocess
import sys

root = Path(sys.argv[1])
def workflow(name):
    return json.loads(subprocess.check_output(
        ['yq', '-o=json', '.', str(root / f'.github/workflows/{name}.yml')], text=True))['jobs']

turbo, security, benchmark = workflow('turbo'), workflow('security'), workflow('benchmark')
script_tests = security['workflow-script-tests']
assert script_tests['strategy']['fail-fast'] is False
assert 'workflow-script-tests' in security['ci-gate-security']['needs']
assert 'codeql' in security['ci-gate-security']['needs']
for action in ['github/codeql-action/init@', 'github/codeql-action/analyze@']:
    assert any(step.get('uses', '').startswith(action) for step in security['codeql']['steps']), \
        'the required CodeQL job must initialize and execute its scanner'
ts_jobs = ['lint-eslint', 'lint-style', 'lint-types', 'lint-type-app', 'lint-type-api',
           'lint-format', 'lint-knip', 'test-cli', 'test-app', 'test-api',
           'test-other']
artifacts = ['deploy-app']

def context(ios=True, ts=False, event='pull_request', release=False):
    values = {
        'github.event_name': event,
        'github.actor': 'developer',
        'github.ref': 'refs/heads/main',
        'github.repository': 'test/repo',
        'github.event.pull_request.head.repo.full_name': 'test/repo',
        'needs.detect-release.outputs.skip': str(release).lower(),
        'needs.detect-turbo-ts-checks.outputs.ios-only': str(ios).lower(),
        'needs.detect-turbo-ts-checks.outputs.turbo-ts-checks-needed': str(ts).lower(),
        'needs.detect-native-only.outputs.ios-only': str(ios).lower(),
        'needs.prepare.outputs.turbo-runner-consumer-needed': 'false',
        'needs.prepare.outputs.playwright-runner-consumer-needed': 'false',
        'needs.prepare.outputs.cli-e2e-consumer-needed': str(not ios and not release).lower(),
        'needs.prepare.outputs.job-ref': 'pr-42',
    }
    for job in set(turbo) | set(security):
        values[f'needs.{job}.result'] = 'success'
    return values

# Evaluate the actual job predicates with GitHub's default success condition.
def condition(job, values, cancelled=False):
    expression = job.get('if', 'True').strip().removeprefix('${{').removesuffix('}}').strip()
    has_status = any(f'{function}(' in expression for function in ['success', 'failure', 'cancelled', 'always'])
    if not has_status and any(values[f'needs.{name}.result'] != 'success' for name in job.get('needs', [])):
        return False
    expression = re.sub(r'\b(?:github|needs)\.[\w.-]+', lambda m: repr(values[m[0]]), expression)
    expression = expression.replace('cancelled()', str(cancelled)).replace('always()', 'True')
    expression = expression.replace('&&', ' and ').replace('||', ' or ')
    expression = re.sub(r'!(?!=)', 'not ', expression)
    return bool(eval('(' + expression + ')', {'__builtins__': {}}, {}))

def gate(jobs, name, values, expected):
    step = next(s for s in jobs[name]['steps'] if s.get('name') == 'Validate CI results')
    def render(text):
        return re.sub(r'\$\{\{\s*(.*?)\s*\}\}', lambda m: (
            values[m[1]] if m[1] in values else str(condition({'if': m[1]}, values)).lower()
        ), str(text))
    env = dict(os.environ)
    env.update({key: render(value) for key, value in step.get('env', {}).items()})
    result = subprocess.run(['bash', '-c', render(step['run'])], env=env, text=True, capture_output=True)
    assert (result.returncode == 0) == expected, result.stdout + result.stderr

native = context()
for event in ['pull_request', 'merge_group', 'push']:
    selected = context(ios=False, ts=True, event=event)
    assert not condition(turbo['cli-e2e-01-serial'], selected, cancelled=True), \
        'host CLI E2E must stop when the workflow is cancelled'
    for name in ['prepare-cli', 'cli-e2e-01-serial']:
        assert condition(turbo[name], selected), name
        for failure in ['failure', 'cancelled', 'skipped']:
            gate(turbo, 'ci-gate-turbo', selected | {f'needs.{name}.result': failure}, False)
for name in ['prepare-cli', 'cli-e2e-01-serial']:
    assert not condition(turbo[name], native), name
    gate(turbo, 'ci-gate-turbo', native | {f'needs.{name}.result': 'skipped'}, True)

for result in ['failure', 'cancelled', 'skipped']:
    blocked = context(ios=False, ts=True) | {'needs.ci-admission.result': result}
    assert not condition(turbo['detect-release'], blocked)
    assert condition(turbo['ci-gate-turbo'], blocked)
    gate(turbo, 'ci-gate-turbo', blocked, False)
    # Release classification cannot turn a rejected admission into a pass.
    gate(turbo, 'ci-gate-turbo', blocked | {'needs.detect-release.outputs.skip': 'true'}, False)

for job in ts_jobs + ['lint-runtime-api-compat'] + artifacts:
    assert not condition(turbo[job], native), job
for job in ['bench-app']:
    assert not condition(benchmark[job], native), job
    assert condition(benchmark[job], context(ios=False, ts=True)), job
    assert condition(benchmark[job], context(ios=False, ts=True, event='push')), job
for job in ['codeql', 'pnpm-audit']:
    assert not condition(security[job], native), job
for job in ['action-pins', 'cdp-viewer-pin', 'semgrep', 'gitleaks', 'actionlint', 'workflow-script-tests', 'pr-title']:
    assert condition(security[job], native), job
for job in ts_jobs:
    assert condition(turbo[job], context(ios=False, ts=True)), job
    assert condition(turbo[job], context(ios=False, ts=True, event='merge_group')), job
    assert not condition(turbo[job], context(ios=False, ts=True, event='push')), job
    assert not condition(turbo[job], context(ios=False, ts=False)), job
for job in artifacts:
    assert 'detect-turbo-ts-checks' in turbo[job]['needs']
    assert condition(turbo[job], context(ios=False, ts=True)), job
    assert condition(turbo[job], context(ios=False, ts=False)), job  # crates-only is unchanged.
    assert condition(turbo[job], context(ios=False, ts=True, event='push')), job
    released = context(ios=False, ts=True, event='merge_group', release=True)
    released['needs.detect-turbo-ts-checks.result'] = 'skipped'
    released['needs.detect-turbo-ts-checks.outputs.ios-only'] = ''
    assert condition(turbo[job], released), job
    assert not condition(turbo[job], released, cancelled=True), job
    for result in ['failure', 'cancelled', 'skipped']:
        broken = context(ios=False, ts=True)
        broken['needs.detect-turbo-ts-checks.result'] = result
        assert not condition(turbo[job], broken), (job, result)

for job in ts_jobs + ['lint-runtime-api-compat'] + artifacts:
    native[f'needs.{job}.result'] = 'skipped'
gate(turbo, 'ci-gate-turbo', native, True)
for job in ts_jobs + ['lint-runtime-api-compat'] + artifacts:
    for failure in ['failure', 'cancelled']:
        gate(turbo, 'ci-gate-turbo', native | {f'needs.{job}.result': failure}, False)
# The runtime API compatibility lint is required whenever it is selected.
assert 'lint-runtime-api-compat' in turbo['ci-gate-turbo']['needs']
assert 'continue-on-error' not in turbo['lint-runtime-api-compat']
for event in ['pull_request', 'merge_group']:
    selected = context(ios=False, ts=True, event=event)
    assert condition(turbo['lint-runtime-api-compat'], selected)
    gate(turbo, 'ci-gate-turbo', selected, True)
    for result in ['failure', 'cancelled', 'skipped']:
        gate(turbo, 'ci-gate-turbo', selected | {'needs.lint-runtime-api-compat.result': result}, False)
for failure in ['failure', 'cancelled', 'skipped']:
    gate(turbo, 'ci-gate-turbo', native | {'needs.detect-turbo-ts-checks.result': failure}, False)
for ios in ['false', '']:
    gate(turbo, 'ci-gate-turbo', native | {'needs.detect-turbo-ts-checks.outputs.ios-only': ios}, False)
for needed in ['true', '']:
    gate(turbo, 'ci-gate-turbo', native | {'needs.detect-turbo-ts-checks.outputs.turbo-ts-checks-needed': needed}, False)
released = context(ios=False, ts=True, event='merge_group', release=True)
gate(turbo, 'ci-gate-turbo', released, True)
for job in artifacts:
    for failure in ['failure', 'cancelled', 'skipped']:
        gate(turbo, 'ci-gate-turbo', released | {f'needs.{job}.result': failure}, False)

# Exercise the actual E2E gate instead of pinning check_result command spelling.
e2e = ['cli-e2e-02-browser', 'cli-e2e-02-playwright',
       'cli-e2e-03-runner-prepare', 'cli-e2e-03-runner-bootstrap', 'cli-e2e-03-runner']
runner_e2e = e2e[2:]
for needed in ['false', 'true']:
    selected = context(ios=False, ts=True) | {
        'needs.prepare.outputs.turbo-runner-consumer-needed': needed,
    }
    for job in e2e:
        for failure in ['failure', 'cancelled']:
            gate(turbo, 'ci-gate-turbo', selected | {f'needs.{job}.result': failure}, False)
    for job in runner_e2e:
        gate(turbo, 'ci-gate-turbo', selected | {f'needs.{job}.result': 'skipped'}, needed == 'false')
    for job in ['cli-e2e-02-playwright-finalize', 'cli-e2e-03-runner-cleanup']:
        for failure in ['failure', 'cancelled']:
            gate(turbo, 'ci-gate-turbo', selected | {f'needs.{job}.result': failure}, True)

native = context()
for job in ['codeql', 'pnpm-audit']:
    native[f'needs.{job}.result'] = 'skipped'
gate(security, 'ci-gate-security', native, True)
for job in ['detect-release', 'action-pins', 'cdp-viewer-pin', 'detect-native-only', 'pr-title', 'semgrep', 'codeql', 'pnpm-audit',
            'actionlint', 'workflow-script-tests', 'gitleaks']:
    for failure in ['failure', 'cancelled']:
        gate(security, 'ci-gate-security', native | {f'needs.{job}.result': failure}, False)
gate(security, 'ci-gate-security', native | {'needs.detect-native-only.result': 'skipped'}, False)
for ios in ['false', '']:
    gate(security, 'ci-gate-security', native | {'needs.detect-native-only.outputs.ios-only': ios}, False)
normal = context(ios=False, ts=True)
gate(security, 'ci-gate-security', normal, True)
for job in ['codeql', 'pnpm-audit']:
    assert condition(security[job], normal)
    assert condition(security[job], context(ios=False, ts=True, event='push'))

queued = context(ios=False, ts=True, event='merge_group')
assert not condition(security['codeql'], queued)
queued['needs.codeql.result'] = 'skipped'
gate(security, 'ci-gate-security', queued, True)
released = context(ios=False, ts=True, event='merge_group', release=True)
for job in ['cdp-viewer-pin', 'detect-native-only', 'pr-title', 'semgrep', 'codeql', 'pnpm-audit', 'actionlint',
            'workflow-script-tests', 'gitleaks']:
    released[f'needs.{job}.result'] = 'skipped'
gate(security, 'ci-gate-security', released, True)
assert condition(security['action-pins'], released)
assert 'action-pins' in security['ci-gate-security']['needs']
for event in ['pull_request', 'merge_group', 'push']:
    for result in ['failure', 'cancelled', 'skipped']:
        for release in [False, True]:
            values = context(event=event, release=release)
            values['needs.action-pins.result'] = result
            assert condition(security['action-pins'], values)
            gate(security, 'ci-gate-security', values, False)

assert 'cdp-viewer-pin' in security['ci-gate-security']['needs']
for event in ['pull_request', 'merge_group', 'push']:
    selected = context(event=event)
    assert condition(security['cdp-viewer-pin'], selected)
    assert not condition(security['cdp-viewer-pin'], context(event=event, release=True))
    for result in ['failure', 'cancelled', 'skipped']:
        gate(security, 'ci-gate-security', selected | {'needs.cdp-viewer-pin.result': result}, False)

print('native-only workflow selection and gates: ok')
PY
