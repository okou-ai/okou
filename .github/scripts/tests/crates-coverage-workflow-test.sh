#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
python3 - "$repo_root" <<'PY'
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

root = Path(sys.argv[1])
relative = '.github/scripts/checks/crates-coverage-needed.sh'
exempt = [
    '.github/scripts/tests/clerk-test-resource-workflow-test.sh',
    '.github/scripts/tests/app-preview-ingress-workflow-test.sh',
    '.github/scripts/tests/turbo-playwright-runner-workflow-test.sh',
]
manifest = (root / '.github/scripts/workflow-script-test-shards.txt').read_text()
for script in exempt:
    assert len(re.findall(r'^\d+ ' + re.escape(Path(script).name) + r'$', manifest, re.M)) == 1, \
        f'{script}: exempt workflow tests must retain their independent Security owner'


def run(args, cwd, **kwargs):
    result = subprocess.run(args, cwd=cwd, text=True, capture_output=True, **kwargs)
    assert result.returncode == 0, f'{args}: {result.stdout}{result.stderr}'
    return result.stdout.strip()


target = root / 'crates/target'
assert target.resolve() == target and not target.is_symlink()
target.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix='coverage-inputs-', dir=target) as temporary:
    directory = Path(temporary)
    repo = directory / 'repo'
    repo.mkdir()
    script = repo / relative
    script.parent.mkdir(parents=True)
    shutil.copy2(root / relative, script)
    required = [
        'crates/new-private-tests/tests/input.rs',
        'crates/runner/mitm-addon/uv.lock',
        'crates/Cargo.toml',
        'crates/Cargo.lock',
        'crates/.cargo/config.toml',
        'rust-toolchain.toml',
        '.cargo/config.toml',
        'docker/toolchain/Dockerfile',
        'scripts/crate-changed.sh',
        '.github/workflows/crates.yml',
        '.github/workflows/runner-image-architecture.yml',
        '.github/actions/setup-r2-sccache/action.yml',
        '.github/actions/report-memory-peak/report.sh',
        'ansible/files/shared.py',
        '.github/scripts/checks/changed-base-ref.sh',
        '.github/scripts/tests/unknown-web-workflow-test.sh',
        '.github/scripts/tests/clerk-test-resource-workflow-test.sh.new',
        '.github/scripts/tests/path with\nnewline.sh',
    ]
    for path in [*exempt, *required, 'README.md']:
        destination = repo / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text('baseline\n')
    run(['git', 'init', '-q', '--initial-branch=main'], repo)
    run(['git', 'config', 'user.name', 'Coverage fixture'], repo)
    run(['git', 'config', 'user.email', 'coverage@example.invalid'], repo)
    run(['git', 'config', 'maintenance.auto', 'false'], repo)

    def commit():
        run(['git', 'add', '-A'], repo)
        run(['git', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture'], repo)

    commit()
    base = run(['git', 'rev-parse', 'HEAD'], repo)
    cases = 0

    def check(expected):
        global cases
        actual = run(['bash', str(script), base], directory)
        assert actual == str(expected).lower(), (expected, actual)
        cases += 1

    check(False)
    for paths, expected in [
        *[([path], False) for path in exempt],
        (exempt, False),
        (['README.md'], False),
        *[([path], True) for path in required],
        ([exempt[0], required[0]], True),
        ([exempt[0], required[-3]], True),
    ]:
        run(['git', 'reset', '--hard', base], repo)
        for path in paths:
            with (repo / path).open('a') as changed:
                changed.write('changed\n')
        commit()
        check(expected)

    # Preserve removed Rust inputs and new unknown destinations of audited files.
    for source, destination in [
        (required[0], None),
        (required[0], 'retired.txt'),
        (exempt[0], '.github/scripts/new-shared-helper.sh'),
        ('README.md', 'crates/new-private-tests/new.rs'),
    ]:
        run(['git', 'reset', '--hard', base], repo)
        if destination is None:
            (repo / source).unlink()
        else:
            run(['git', 'mv', source, destination], repo)
        commit()
        check(True)

    for invalid in ['missing-coverage-base', '--stat']:
        result = subprocess.run(['bash', str(script), invalid], cwd=directory,
                                text=True, capture_output=True)
        assert result.returncode != 0 and not result.stdout, result

    # A valid base followed by a failed diff must never publish false.
    bin_dir = directory / 'bin'
    bin_dir.mkdir()
    git = bin_dir / 'git'
    git.write_text('''#!/usr/bin/env bash
set -euo pipefail
if [[ ${3:-} == diff ]]; then exit 37; fi
exec "$COVERAGE_REAL_GIT" "$@"
''')
    git.chmod(0o755)
    failed = subprocess.run(['bash', str(script), base], cwd=directory,
                            env=os.environ | {'PATH': f'{bin_dir}:{os.environ["PATH"]}',
                                              'COVERAGE_REAL_GIT': shutil.which('git')},
                            text=True, capture_output=True)
    assert failed.returncode == 37 and not failed.stdout, failed

print(f'crates-coverage-workflow-test: ok ({cases} real Git decisions; errors refuse)')
PY
