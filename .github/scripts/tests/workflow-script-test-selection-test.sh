#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
python3 - "$repo_root" <<'PY'
import os
from pathlib import Path
import subprocess
import sys
import tempfile

selector = Path(sys.argv[1]) / '.github/scripts/checks/detect-workflow-script-tests.sh'

with tempfile.TemporaryDirectory() as temp:
    repo = Path(temp)
    caller = repo / 'caller'
    caller.mkdir()

    def git(*args):
        return subprocess.check_output(['git', *args], cwd=repo, text=True).strip()

    def write(path, text='changed'):
        target = repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)

    def commit():
        git('add', '--all')
        git('commit', '--quiet', '-m', 'fixture')
        return git('rev-parse', 'HEAD')

    git('init', '--quiet', '--initial-branch=main')
    git('config', 'user.name', 'Script Selection Test')
    git('config', 'user.email', 'selection@example.invalid')
    git('config', 'commit.gpgsign', 'false')
    for path in ['docs/guide.md', 'turbo/apps/platform/src/view.tsx',
                 '.github/scripts/tool.sh']:
        write(path, 'original')
    base = commit()

    def reset():
        git('switch', '--quiet', '-C', 'scenario', base)

    def detect(expected, event='pull_request', ref=base,
               checkout='refs/heads/feature', reject=False):
        env = dict(os.environ)
        for key in ['EVENT_NAME', 'GITHUB_EVENT_NAME', 'CHECKOUT_REF', 'GITHUB_REF',
                    'PULL_REQUEST_BASE_SHA', 'MERGE_GROUP_BASE_SHA', 'PUSH_BEFORE_SHA']:
            env.pop(key, None)
        env.update(EVENT_NAME=event, CHECKOUT_REF=checkout)
        if ref is not None:
            env.update(PULL_REQUEST_BASE_SHA=ref, MERGE_GROUP_BASE_SHA=ref,
                       PUSH_BEFORE_SHA=ref)
        # The command resolves the repository root, not the caller's directory.
        result = subprocess.run(['bash', str(selector)], cwd=caller,
                                env=env, text=True, capture_output=True)
        if reject:
            assert result.returncode != 0, result.stdout
            assert 'needed=false' not in result.stdout, result.stdout
        else:
            assert result.returncode == 0, result.stderr
            assert result.stdout == f'needed={str(expected).lower()}\n', result.stdout

    # Real fixture edits test ownership boundaries rather than script spelling.
    for path in ['docs/nested/guide.md', 'docs/name\nwith-newline.md',
                 'turbo/apps/platform/src/views/page.tsx',
                 'turbo/apps/api/src/signals/routes/customer.ts']:
        reset()
        write(path)
        commit()
        detect(False)

    for path in ['.github/workflows/security.yml', '.github/actions/setup/action.yml',
                 '.github/scripts/tests/fixtures/input.json',
                 'ansible/playbooks/provision.yml', 'ops/audit/input.json',
                 'scripts/build.sh', 'crates/runner/src/cmd.rs',
                 'crates/runner/tests/behavior/tests/owned-test.sh',
                 'crates/kerberos-worker/native/build.sh',
                 'turbo/apps/api/src/signals/services/pi-memory-phase2-input-revision.ts',
                 'turbo/apps/api/package.json', 'turbo/apps/platform/index.html',
                 'turbo/apps/platform/public/manifest.webmanifest',
                 'turbo/apps/app-worker/src/worker.js', 'turbo/pnpm-lock.yaml',
                 'turbo/packages/connectors/src/__tests__/firewall-contract.json',
                 'ios/scripts/release-testflight.sh', 'e2e/scripts/setup.sh',
                 '.release-please-manifest.json', 'new-owner/input.json',
                 'docs/executable.py', '.github/scripts/name\nwith-newline.sh']:
        reset()
        write(path)
        commit()
        detect(True)

    reset()
    write('docs/guide.md')
    write('.github/scripts/tool.sh')
    commit()
    detect(True)

    # Deletions and both sides of moves retain applicability.
    for path, expected in [('docs/guide.md', False),
                           ('.github/scripts/tool.sh', True)]:
        reset()
        git('rm', '--quiet', path)
        commit()
        detect(expected)
    reset()
    git('mv', '.github/scripts/tool.sh', 'turbo/apps/platform/src/moved.ts')
    commit()
    detect(True)
    reset()
    git('mv', 'docs/guide.md', '.github/scripts/moved.sh')
    commit()
    detect(True)

    # Entire group/push ranges include a relevant early commit even when the
    # last commit changes only unrelated product source.
    reset()
    write('.github/scripts/tool.sh')
    first = commit()
    write('turbo/apps/platform/src/view.tsx')
    commit()
    detect(False, event='push', ref=first)
    detect(True, event='push')
    detect(True, event='merge_group')

    # A PR merge checkout must exclude changes already in its first parent.
    reset()
    write('turbo/apps/platform/src/view.tsx')
    feature = commit()
    git('switch', '--quiet', '-C', 'target', base)
    write('.github/scripts/tool.sh')
    commit()
    git('merge', '--quiet', '--no-ff', '-m', 'merge fixture', feature)
    detect(False, checkout='refs/pull/123/merge')

    reset()
    detect(True)  # An empty diff cannot exempt retained tests.
    for event in ['pull_request', 'merge_group', 'push']:
        detect(None, event=event, ref=None, reject=True)
        detect(None, event=event, ref='f' * 40, reject=True)
    detect(None, event='workflow_dispatch', reject=True)

    # Available but divergent history is invalid for a queue or push range.
    write('docs/divergent.md')
    divergent = commit()
    reset()
    write('docs/current.md')
    commit()
    for event in ['merge_group', 'push']:
        detect(None, event=event, ref=divergent, reject=True)

print('workflow script selection: ok')
PY
