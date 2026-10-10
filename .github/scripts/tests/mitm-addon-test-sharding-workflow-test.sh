#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
python3 - "$repo_root" <<'PY'
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys

root = Path(sys.argv[1])
import importlib.util
spec = importlib.util.spec_from_file_location('workflow_expressions', root / '.github/scripts/tests/workflow-test-expressions.py')
x = importlib.util.module_from_spec(spec)
spec.loader.exec_module(x)
jobs = json.loads(subprocess.check_output(
    ['python3', str(root / '.github/scripts/tests/load-workflow-test-owners.py'), '-o=json', '.', str(root / '.github/workflows/crates.yml')], text=True))['jobs']
addon = jobs['mitm-addon-test']
gate = jobs['ci-gate-crates']
assert addon['needs'] == ['detect']
assert addon['strategy'] == {'fail-fast': False, 'matrix': {'shard': ['1/2', '2/2']}}
assert not addon.get('continue-on-error', False)
assert 'crates-checks' in gate['needs']
assert 'always()' in gate['if']

test = next(step for step in addon['steps'] if step.get('name') == 'Run mitm-addon tests')
assert not test.get('continue-on-error', False)
for shard in addon['strategy']['matrix']['shard']:
    command = test['run'].replace('${{ matrix.shard }}', shard)
    assert shlex.split(command) == [
        'uv', 'run', '--no-sync', 'python', '-m', 'pytest', 'tests/', '-q',
        '--durations=30', '--durations-min=0.1', f'--test-shard={shard}',
    ], command

validate = next(step for step in gate['steps'] if step.get('name') == 'Validate CI results')
texts = [addon['if'], validate['run'], *validate['env'].values()]
values = {
    name: 'success' if name.endswith('.result') else 'false'
    for name in re.findall(r'\bneeds\.[\w.-]+', '\n'.join(texts))
}
values.update({f'needs.{name}.result': 'success' for name in jobs})
values['needs.runner-host-groups.outputs.validation-matrix'] = '[]'
values['needs.detect-release.outputs.skip'] = 'false'
values['needs.detect.outputs.metal-job-ref'] = ''
values['needs.detect.outputs.crates-runner-consumer-needed'] = 'false'


def expression(text, context):
    text = text.strip().removeprefix('${{').removesuffix('}}').strip()
    text = re.sub(r'\bneeds\.[\w.-]+', lambda match: repr(context[match[0]]), text)
    text = text.replace('always()', 'True').replace('&&', ' and ').replace('||', ' or ')
    return eval('(' + text + ')', {'__builtins__': {}}, {})


def render(text, context):
    def substitute(match):
        value = expression(match[1], context)
        return str(value).lower() if isinstance(value, bool) else value
    return re.sub(r'\$\{\{\s*(.*?)\s*\}\}', substitute, text)


assert not expression(addon['if'], values), 'unrelated changes must not select either shard'
for signal in ['any-changed', 'mitm-addon-test-inputs-changed', 'mitm-addon-pricing-seed-changed']:
    context = values | {f'needs.detect.outputs.{signal}': 'true'}
    assert expression(addon['if'], context), f'{signal} must select both shards'
    for status in ['success', 'failure', 'cancelled', '']:
        context['needs.mitm-addon-test.result'] = status
        x.run_gate(gate, x.logical_gate_context(root, context), status == 'success')


print('mitm-addon-test-sharding-workflow-test: ok')
PY
