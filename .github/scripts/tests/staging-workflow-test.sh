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
import tempfile

root = Path(sys.argv[1])


def workflow(name):
    return json.loads(subprocess.check_output(
        ['yq', '-o=json', '.', str(root / f'.github/workflows/{name}.yml')], text=True))


turbo = workflow('turbo')
staging = workflow('staging')
benchmark = workflow('benchmark')
jobs = turbo['jobs']
ts_checks = [
    'lint-eslint', 'lint-style', 'lint-types', 'lint-type-app', 'lint-type-api',
    'lint-format', 'lint-knip', 'test-cli', 'test-app', 'test-api', 'test-other',
]
validation = ts_checks + ['file-size-check', 'test-migrate', 'lint-runtime-api-compat']
deployed = [
    'deploy-api', 'deploy-app', 'deploy-cli', 'deploy-runner-prepare', 'deploy-runner-start',
    'cli-e2e-01-serial', 'cli-e2e-02-browser', 'cli-e2e-02-playwright',
]
finalizers = ['cli-e2e-02-playwright-finalize', 'cli-e2e-03-runner-cleanup']
runner_e2e = ['cli-e2e-03-runner-prepare', 'cli-e2e-03-runner-bootstrap', 'cli-e2e-03-runner']


def needs(job):
    result = job.get('needs', [])
    return [result] if isinstance(result, str) else result


def context(event='push', run_id='100'):
    values = {
        'github.event_name': event,
        'github.actor': 'developer',
        'github.head_ref': 'feature/application' if event == 'pull_request' else '',
        'github.ref': 'refs/heads/main',
        'github.run_id': run_id,
        'github.repository': 'test/repo',
        'github.event.head_commit.message': 'fix: update application',
        'github.event.pull_request.number': 42,
        'github.event.pull_request.head.repo.full_name': 'test/repo',
        'needs.detect-release.outputs.skip': 'false',
        'needs.detect-turbo-ts-checks.outputs.ios-only': 'false',
        'needs.detect-turbo-ts-checks.outputs.turbo-ts-checks-needed': 'true',
        'needs.prepare.outputs.job-ref': 'staging' if event == 'push' else 'pr-42',
        'needs.prepare.outputs.turbo-runner-consumer-needed': 'false' if event == 'push' else 'true',
        'needs.prepare.outputs.playwright-runner-consumer-needed': 'true',
    }
    for changed in ['api', 'cli', 'platform', 'migration', 'crates', 'ci', 'e2e']:
        values[f'needs.prepare.outputs.{changed}-changed'] = 'true'
    for name in set(jobs) | set(benchmark['jobs']):
        values[f'needs.{name}.result'] = 'success'
    return values


def expression(source, values, job=None, cancelled=False):
    source = str(source).strip().removeprefix('${{').removesuffix('}}').strip()
    dependencies = needs(job or {})
    replacements = {
        'always()': True,
        'cancelled()': cancelled,
        'success()': all(values[f'needs.{name}.result'] == 'success' for name in dependencies),
        'failure()': any(values[f'needs.{name}.result'] == 'failure' for name in dependencies),
    }
    for function, value in replacements.items():
        source = source.replace(function, str(value))
    source = re.sub(r'\b(?:github|needs)\.[\w.-]+', lambda m: repr(values[m[0]]), source)
    source = source.replace('&&', ' and ').replace('||', ' or ')
    source = re.sub(r'!(?!=)', 'not ', source)
    return eval('(' + source + ')', {'__builtins__': {}}, {
        'true': True,
        'false': False,
        'startsWith': lambda value, prefix: value.startswith(prefix),
        'format': lambda template, *args: template.format(*args),
    })


def condition(job, values, cancelled=False):
    source = job.get('if', 'true')
    has_status = any(f'{name}(' in source for name in ['success', 'failure', 'cancelled', 'always'])
    if not has_status and any(values[f'needs.{name}.result'] != 'success' for name in needs(job)):
        return False
    return bool(expression(source, values, job, cancelled))


def render(source, values):
    def substitute(match):
        value = expression(match[1], values)
        return str(value).lower() if isinstance(value, bool) else str(value)
    return re.sub(r'\$\{\{\s*(.*?)\s*\}\}', substitute, str(source))


def gate(values, expected):
    job = jobs['ci-gate-turbo']
    assert condition(job, values), 'the result gate must run despite skipped or failed dependencies'
    step = next(step for step in job['steps'] if step.get('name') == 'Validate CI results')
    env = dict(os.environ)
    env.update({key: render(value, values) for key, value in step.get('env', {}).items()})
    result = subprocess.run(['bash', '-c', render(step['run'], values)],
                            env=env, text=True, capture_output=True)
    assert (result.returncode == 0) == expected, result.stdout + result.stderr


# The shared implementation must have one push owner. The caller's workflow lock
# remains held until every called job, including both finalizers, has completed.
assert set(turbo['on']) == {'pull_request', 'merge_group', 'workflow_call'}
assert set(staging['on']) == {'push'}
assert staging['on']['push']['branches'] == ['main']
assert staging['concurrency'] == {'group': 'staging', 'cancel-in-progress': False}
assert len(staging['jobs']) == 1, 'staging must own the entire deployment lifecycle in one reusable call'
caller = next(iter(staging['jobs'].values()))
assert caller['uses'] == './.github/workflows/turbo.yml'
passed_secrets = caller['secrets']
assert isinstance(passed_secrets, dict), 'staging must explicitly scope its secrets'
declared_secrets = turbo['on']['workflow_call']['secrets']
assert set(passed_secrets) <= set(declared_secrets), 'passed secrets must be accepted by the callee'
for name, value in passed_secrets.items():
    assert value == '${{ secrets.' + name + ' }}', f'{name} must retain its credential identity'
required_secrets = set()
for name in deployed + finalizers:
    required_secrets.update(re.findall(r'secrets\.([A-Z_0-9]+)', json.dumps(jobs[name])))
required_secrets.discard('GITHUB_TOKEN')  # GitHub provides this to reusable workflows.
assert required_secrets <= set(passed_secrets), 'retain deployment and cleanup credentials'

# Exercise the actual preview renderer with synthetic repository credentials.
# Comparing its output catches indirect secrets selected through toJSON(secrets),
# including provider suffixes, without mocking the renderer's own accessors.
action = json.loads(subprocess.check_output([
    'yq', '-o=json', '.', str(root / '.github/actions/web-api-env/action.yml'),
], text=True))
renderer = action['runs']['steps'][0]['run']
names = set(re.findall(r'\b[A-Z][A-Z_0-9]*\b', renderer))
names.update('OKOU_' + name for name in list(names))
synthetic_secrets = {name: 'fixture-secret-' + name for name in names}
doppler = {name + suffix: 'fixture-oauth-' + name + suffix
           for name in names for suffix in ['_OAUTH_CLIENT_ID', '_OAUTH_CLIENT_SECRET']}
with tempfile.TemporaryDirectory() as temporary:
    environment = dict(os.environ, RUNNER_TEMP=temporary,
                       GITHUB_OUTPUT=str(Path(temporary) / 'outputs'),
                       INPUT_APP='api', INPUT_ENVIRONMENT='preview',
                       INPUT_DATABASE_URL='postgres://database.invalid/staging',
                       INPUT_JOB_REF='staging', INPUT_WEB_URL='https://staging.invalid',
                       INPUT_APP_URL='https://staging-app.invalid',
                       INPUT_API_BACKEND_URL='https://staging-api.invalid',
                       INPUT_CLI_PKG_URL='https://static.invalid/cli/package.tgz',
                       REPO_VARS_JSON='{}', DOPPLER_SECRETS_JSON=json.dumps(doppler))

    def render_preview(secrets):
        result = subprocess.run(['bash', '-c', renderer], cwd=root,
                                env=environment | {'REPO_SECRETS_JSON': json.dumps(secrets)},
                                text=True, capture_output=True)
        assert 'fixture-secret-' not in result.stdout + result.stderr, 'renderer exposed a credential'
        assert result.returncode == 0, result.stdout + result.stderr
        return dict(line.split('=', 1) for line in
                    (Path(temporary) / 'web-api-api-preview.env').read_text().splitlines())

    fallback_keys = {'R2_USER_ARTIFACTS_ACCESS_KEY_ID', 'R2_USER_ARTIFACTS_SECRET_ACCESS_KEY',
                     'SENTRY_DSN_API'}
    scenarios = [(set(), 'postgres://database.invalid/staging'), (fallback_keys, ''),
                 (fallback_keys | {'SENTRY_DSN_WEB'}, 'postgres://database.invalid/staging')]
    for absent, database_url in scenarios:
        environment['INPUT_DATABASE_URL'] = database_url
        fixture = {name: value for name, value in synthetic_secrets.items() if name not in absent}
        original = render_preview(fixture)
        scoped = render_preview({name: value for name, value in fixture.items()
                                 if name in passed_secrets})
        changed_keys = [name for name in original if original[name] != scoped.get(name)]
        assert not changed_keys, f'staging secret scoping changed preview configuration: {changed_keys}'
assert condition(caller, context())
permissions = caller.get('permissions', staging.get('permissions', {}))
for permission, level in {
    'actions': 'read', 'contents': 'read', 'pull-requests': 'write',
    'issues': 'write', 'deployments': 'write', 'id-token': 'write',
}.items():
    assert permissions.get(permission) == level, (permission, permissions)

inner_group = render(turbo['concurrency']['group'], context())
assert inner_group != staging['concurrency']['group'], 'nested concurrency must not deadlock staging'
assert inner_group != render(turbo['concurrency']['group'], context(run_id='101'))
assert not expression(turbo['concurrency']['cancel-in-progress'], context())
assert expression(turbo['concurrency']['cancel-in-progress'], context('pull_request'))
assert not expression(turbo['concurrency']['cancel-in-progress'], context('merge_group'))
assert render(jobs['ci-gate-turbo']['name'], context()) == 'staging-result'
for event in ['pull_request', 'merge_group']:
    assert render(jobs['ci-gate-turbo']['name'], context(event)) == 'ci-gate-turbo'

push = context()
for name in validation:
    assert not condition(jobs[name], push), f'main push must not repeat {name}'
    push[f'needs.{name}.result'] = 'skipped'
    for event in ['pull_request', 'merge_group']:
        assert condition(jobs[name], context(event)), f'{event} must retain {name}'
for name in runner_e2e + ['deploy-stripe-listener']:
    push[f'needs.{name}.result'] = 'skipped'
    assert not condition(jobs[name], push), f'push must retain the existing {name} selection'

# A deployment still reaches actual environment tests when every code-validation
# job is skipped. In particular serial E2E must not inherit their default success().
for name in deployed + finalizers:
    assert condition(jobs[name], push), f'staging must still execute {name}'
assert not set(needs(jobs['cli-e2e-01-serial'])) & set(validation)
gate(push, True)
for name in deployed + [name for name in validation if name in needs(jobs['ci-gate-turbo'])]:
    for failure in ['failure', 'cancelled']:
        gate(push | {f'needs.{name}.result': failure}, False)
for name in ['deploy-app', 'deploy-cli', 'deploy-runner-prepare', 'deploy-runner-start']:
    gate(push | {f'needs.{name}.result': 'skipped'}, False)
for name in finalizers:
    assert condition(jobs[name], push | {'needs.cli-e2e-02-playwright.result': 'failure'})

# Cleanup stays inside the staging lock without becoming a PR/merge-group gate
# dependency, including through an indirect needs chain.
def ancestors(name):
    result = set(needs(jobs[name]))
    for dependency in list(result):
        result.update(ancestors(dependency))
    return result


assert not set(finalizers) & ancestors('ci-gate-turbo')
for event in ['pull_request', 'merge_group']:
    gate(context(event), True)
    for name in ts_checks + ['file-size-check']:
        gate(context(event) | {f'needs.{name}.result': 'skipped'}, False)

# Main baselines run independently of staging; merge groups do not run benches.
assert set(benchmark['on']) == {'pull_request', 'push'}
assert benchmark['on']['push']['branches'] == ['main']
benchmark_group = render(benchmark['concurrency']['group'], context())
assert benchmark_group not in [staging['concurrency']['group'], inner_group]
assert benchmark_group != render(benchmark['concurrency']['group'], context(run_id='101'))
assert not expression(benchmark['concurrency']['cancel-in-progress'], context())
benchmark_detector = benchmark['jobs']['detect-turbo-ts-checks']
release_contexts = [
    context('pull_request') | {'github.head_ref': 'release-please--branches--main'},
    context() | {'github.event.head_commit.message': 'chore: release main'},
]
for values in release_contexts:
    assert not condition(benchmark_detector, values), 'release commits must not create new baselines'
for name in ['bench-api', 'bench-app']:
    assert name not in jobs, 'benchmarks must not hold the staging workflow lock'
    job = benchmark['jobs'][name]
    assert 'prepare' not in needs(job), 'baselines must not wait for deployment preparation'
    for event in ['push', 'pull_request']:
        assert condition(job, context(event)), f'{event} must retain {name}'
        assert not condition(job, context(event) | {
            'needs.detect-turbo-ts-checks.outputs.turbo-ts-checks-needed': 'false',
        }), f'{name} must retain native-only skips'
    for values in release_contexts:
        assert not condition(job, values | {
            'needs.detect-turbo-ts-checks.result': 'skipped',
        }), f'{name} must remain skipped after release detection'
    artifact = next(step for step in job['steps']
                    if step.get('uses', '').startswith('actions/upload-artifact@'))
    assert artifact['with']['name'] == f'{name}-results'

print('staging workflow selection, isolation, and failure gates: ok')
PY
