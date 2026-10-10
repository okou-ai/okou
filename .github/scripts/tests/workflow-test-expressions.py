"""Bounded GitHub expression/step fixture helpers; never execute a workflow."""
import json
import os
import re
import subprocess
from pathlib import Path
from functools import lru_cache


@lru_cache(maxsize=None)
def workflow(root, name):
    return json.loads(subprocess.check_output(['yq', '-o=json', '.', str(Path(root) / f'.github/workflows/{name}.yml')], text=True))


def needs(job):
    value = job.get('needs', [])
    return [value] if isinstance(value, str) else value


def expression(source, values, job=None, cancelled=False):
    source = str(source).strip().removeprefix('${{').removesuffix('}}').strip()
    dependencies = needs(job or {})
    for function, value in {
        'always()': True, 'cancelled()': cancelled,
        'success()': all(values.get(f'needs.{d}.result', '') == 'success' for d in dependencies),
        'failure()': any(values.get(f'needs.{d}.result', '') == 'failure' for d in dependencies),
    }.items():
        source = source.replace(function, str(value))
    source = re.sub(r'fromJSON\(([^()]*)\)((?:\.[\w-]+)+)',
                    lambda m: f"get(fromJSON({m[1]}), {m[2][1:]!r})", source)
    source = re.sub(r'\b(?:github|needs|inputs)\.[\w.-]+', lambda m: repr(values.get(m[0], '')), source)
    source = source.replace('&&', ' and ').replace('||', ' or ')
    source = re.sub(r'!(?!=)', 'not ', source)
    def get(value, path):
        for key in path.split('.'):
            value = value.get(key, '') if isinstance(value, dict) else ''
        return value
    return eval('(' + source + ')', {'__builtins__': {}}, {
        'true': True, 'false': False, 'fromJSON': json.loads, 'get': get,
        'startsWith': lambda value, prefix: value.startswith(prefix),
        'contains': lambda value, part: part in value,
        'format': lambda template, *args: template.format(*args),
    })


def condition(job, values, cancelled=False):
    if any(values.get(f'needs.{d}.result', '') not in ['success', 'failure', 'cancelled', 'skipped'] for d in needs(job)):
        return False
    source = job.get('if', 'true')
    if not any(f'{f}(' in source for f in ['success', 'failure', 'cancelled', 'always']):
        if any(values.get(f'needs.{d}.result', '') != 'success' for d in needs(job)):
            return False
    return bool(expression(source, values, job, cancelled))


def render(source, values):
    def replace(match):
        value = expression(match[1], values)
        return str(value).lower() if isinstance(value, bool) else str(value)
    return re.sub(r'\$\{\{\s*(.*?)\s*\}\}', replace, str(source))


def run_gate(job, values, expected):
    step = next(s for s in job['steps'] if s.get('name') == 'Validate CI results')
    env = dict(os.environ)
    env.update({key: render(value, values) for key, value in step.get('env', {}).items()})
    result = subprocess.run(['bash', '-e', '-o', 'pipefail', '-c', render(step['run'], values)], env=env, text=True, capture_output=True)
    assert (result.returncode == 0) == expected, result.stdout + result.stderr


def logical_gate_context(root, values):
    """Bind existing logical child status fixtures to real reusable receipts."""
    result = dict(values)
    controller = workflow(root, 'ci')
    for caller_id, caller in controller['jobs'].items():
        path = caller.get('uses', '')
        if not path.startswith('./.github/workflows/ci-turbo-'):
            continue
        owner = workflow(root, Path(path).stem)
        if 'results' not in owner['on']['workflow_call'].get('outputs', {}):
            continue
        receipt = {name: {'result': values.get(f'needs.{name}.result', '')} for name in owner['jobs']}
        statuses = {row['result'] for row in receipt.values()}
        result[f'needs.{caller_id}.result'] = ('skipped' if statuses == {'skipped'} else
                                                'failure' if 'failure' in statuses else
                                                'cancelled' if 'cancelled' in statuses else 'success')
        result[f'needs.{caller_id}.outputs.results'] = json.dumps(receipt)
    # Native gate fixtures have logical step names, while the live controller
    # owns prefixed callers and selected architecture variants. Bind only data.
    needed = values.get('needs.detect.outputs.crates-runner-consumer-needed') == 'true' and values.get('needs.detect.outputs.metal-job-ref', '') != ''
    target = values.get('needs.runner-host-groups.outputs.selected-target', 'aarch64-unknown-linux-musl' if needed else '')
    arch = 'arm64' if target == 'aarch64-unknown-linux-musl' else 'x86_64'
    other = 'x86_64' if arch == 'arm64' else 'arm64'
    for key, value in values.items():
        match = re.fullmatch(r'needs\.([\w-]+)(\..+)', key)
        if match and match[1] not in {'detect-release', 'ci-admission'} and not match[1].startswith('crates-'):
            result['needs.crates-' + match[1] + match[2]] = value
    result['needs.crates-runner-host-groups.outputs.selected-target'] = target
    for identifier, caller in controller['jobs'].items():
        if not identifier.startswith('crates-'):
            continue
        name = identifier[len('crates-'):]
        path = caller.get('uses', '')
        if not path:
            continue
        owner = workflow(root, Path(path).stem)
        if name in {'checks', 'host-tests'} or name.startswith('behavior-'):
            receipt = {member: {'result': values.get(f'needs.{member}.result', 'success')} for member in owner['jobs']}
            statuses = {row['result'] for row in receipt.values()}
            result[f'needs.{identifier}.result'] = ('skipped' if statuses == {'skipped'} else
                'failure' if 'failure' in statuses else 'cancelled' if 'cancelled' in statuses else 'success')
            result[f'needs.{identifier}.outputs.results'] = json.dumps(receipt)
    for name in ['runner-test-prepare', 'behavior', 'host-cpu-fairness-test', 'guest-rpc-firecracker-test']:
        result[f'needs.crates-{name}-{arch}.result'] = values.get(f'needs.{name}.result', 'success') if needed else 'skipped'
        result[f'needs.crates-{name}-{other}.result'] = 'skipped'
    result[f'needs.crates-runner-image-architecture-manifest-{arch}.result'] = 'skipped'
    result[f'needs.crates-runner-image-architecture-manifest-{other}.result'] = (values.get('needs.runner-image-architecture-manifest.result',
        'skipped' if values.get('needs.runner-host-groups.outputs.validation-matrix') == '[]' else 'success') if needed else 'skipped')
    for name in ['runner-host-groups', 'host-cpu-fairness-build', 'guest-rpc-firecracker-build']:
        result[f'needs.crates-{name}.result'] = values.get(f'needs.{name}.result', 'success' if needed else 'skipped')
    return result
