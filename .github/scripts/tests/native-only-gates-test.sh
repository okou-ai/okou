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

turbo, security = workflow('turbo'), workflow('security')
ts_jobs = ['lint-eslint', 'lint-style', 'lint-types', 'lint-type-app', 'lint-type-api',
           'lint-format', 'lint-knip', 'test-cli', 'test-app', 'test-api',
           'test-other']
artifacts = ['deploy-app', 'deploy-cli']

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
    }
    for job in set(turbo) | set(security):
        values[f'needs.{job}.result'] = 'success'
    return values

# Evaluate the actual job predicates with GitHub's default success condition.
def condition(job, values, cancelled=False):
    expression = job.get('if', 'true').strip().removeprefix('${{').removesuffix('}}').strip()
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
for job in ts_jobs + ['bench-api', 'bench-app', 'lint-runtime-api-compat'] + artifacts:
    assert not condition(turbo[job], native), job
for job in ['codeql', 'pnpm-audit']:
    assert not condition(security[job], native), job
for job in ['semgrep', 'gitleaks', 'actionlint', 'pr-title']:
    assert condition(security[job], native), job
for job in ts_jobs:
    assert condition(turbo[job], context(ios=False, ts=True)), job
    assert condition(turbo[job], context(ios=False, ts=True, event='push')), job
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

for job in ts_jobs + artifacts:
    native[f'needs.{job}.result'] = 'skipped'
gate(turbo, 'ci-gate-turbo', native, True)
for job in ts_jobs + artifacts:
    for failure in ['failure', 'cancelled']:
        gate(turbo, 'ci-gate-turbo', native | {f'needs.{job}.result': failure}, False)
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

native = context()
for job in ['codeql', 'pnpm-audit']:
    native[f'needs.{job}.result'] = 'skipped'
gate(security, 'ci-gate-security', native, True)
for job in ['detect-release', 'detect-native-only', 'pr-title', 'semgrep', 'codeql', 'pnpm-audit', 'actionlint', 'gitleaks']:
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
queued['needs.codeql.result'] = 'skipped'
gate(security, 'ci-gate-security', queued, True)
released = context(ios=False, ts=True, event='merge_group', release=True)
for job in ['detect-native-only', 'pr-title', 'semgrep', 'codeql', 'pnpm-audit', 'actionlint', 'gitleaks']:
    released[f'needs.{job}.result'] = 'skipped'
gate(security, 'ci-gate-security', released, True)

print('native-only workflow selection and gates: ok')
PY
