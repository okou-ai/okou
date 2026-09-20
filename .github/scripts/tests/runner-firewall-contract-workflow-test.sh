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


scenarios = [
    ('runner', ['crates/runner/src/types.rs'], 'coverage', True, True),
    ('other-crate', ['crates/xtask/src/main.rs'], 'coverage', False, True),
    ('ci', ['.github/workflows/crates.yml'], 'coverage', True, True),
    ('fixture-only', [corpus], standalone, False, True),
    ('fixture-and-rust', [corpus, 'crates/runner/src/types.rs'], 'coverage', True, True),
    ('fixture-and-ci', [corpus, '.github/workflows/crates.yml'], 'coverage', True, True),
    ('unrelated', ['README.md'], None, False, False),
    ('other-shared-fixture', ['turbo/packages/connectors/src/__tests__/firewall-semantics-contract.json'],
     None, False, True),
]

with tempfile.TemporaryDirectory(prefix='firewall-contract-workflow-') as temporary:
    directory = Path(temporary)
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
        destination.write_text('fixture baseline\n')
    run(['git', 'init', '-q', '--initial-branch=main'], repo)
    run(['git', 'config', 'user.name', 'Workflow fixture'], repo)
    run(['git', 'config', 'user.email', 'workflow@example.invalid'], repo)
    run(['git', 'add', '.'], repo)
    run(['git', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'baseline'], repo)
    base = run(['git', 'rev-parse', 'HEAD'], repo).strip()

    # Cargo is the external boundary; dependency traversal and Git change
    # detection still run through the actual repository scripts.
    metadata = directory / 'metadata.json'
    names = ['ably-subscriber', 'api-contracts', 'runner', 'sandbox-firecracker',
             'nbd-cow', 'guest-control-tests', 'xtask']
    metadata.write_text(json.dumps({'packages': [
        {'name': name, 'dependencies': ([{'name': 'api-contracts', 'path': str(repo / 'crates/api-contracts')}]
                                       if name == 'runner' else [])}
        for name in names
    ]}))
    bin_dir = directory / 'bin'
    bin_dir.mkdir()
    cargo = bin_dir / 'cargo'
    cargo.write_text('''#!/usr/bin/env bash
set -euo pipefail
[ "$*" = "metadata --no-deps --format-version 1" ]
cat "$CARGO_METADATA_FIXTURE"
''')
    cargo.chmod(0o755)

    contexts = {}
    for label, paths, owner, image_needed, addon_needed in scenarios:
        run(['git', 'reset', '--hard', base], repo)
        for relative in paths:
            with (repo / relative).open('a') as changed:
                changed.write(f'{label} change\n')
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
            'needs.detect-release.outputs.skip': 'false',
            'needs.detect.outputs.metal-job-ref': 'pr-1-test',
            'needs.runner-host-groups.outputs.validation-matrix': '[]',
        })
        actual_owners = [name for name in ['coverage', standalone] if selected(name, values)]
        assert actual_owners == ([] if owner is None else [owner]), f'{label}: {actual_owners}'
        assert selected('mitm-addon-test', values) == addon_needed, label
        contexts[label] = values
        normal = {name: 'success' if name == owner else 'skipped' for name in ['coverage', standalone]}
        assert_gate(values, normal, True, label)

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
    for name in ['coverage', standalone]:
        for result in ['failure', 'cancelled', '']:
            assert_gate(unrelated, skipped | {name: result}, False, f'unrelated: {name} {result!r}')
    for result in ['failure', 'cancelled', 'skipped', '']:
        assert_gate(unrelated, skipped | {'detect': result}, False, f'detect: {result!r}')
        assert not selected('coverage', unrelated | {'needs.detect.result': result})
        assert not selected(standalone, contexts['fixture-only'] | {'needs.detect.result': result})

    released = unrelated | {'needs.detect-release.outputs.skip': 'true'}
    assert_gate(released, {name: 'skipped' for name in gate['needs']}, True, 'release fast path')

print('runner-firewall-contract-workflow-test: ok')
PY
