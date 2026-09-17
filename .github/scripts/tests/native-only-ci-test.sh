#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
python3 - "$repo_root" <<'PY'
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

source = Path(sys.argv[1])
script = source / '.github/scripts/detect-native-only.sh'

def run(args, *, cwd, env=None, check=True):
    return subprocess.run(args, cwd=cwd, env=env, text=True, capture_output=True, check=check)

with tempfile.TemporaryDirectory() as temp:
    repo = Path(temp)
    def git(*args):
        return run(['git', *args], cwd=repo).stdout.strip()
    git('init', '--quiet', '--initial-branch=main')
    git('config', 'user.name', 'CI Selection Test')
    git('config', 'user.email', 'ci-selection@example.invalid')
    git('config', 'commit.gpgsign', 'false')
    def write(path, text):
        target = repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
    def commit(message):
        git('add', '--all')
        git('commit', '--quiet', '-m', message)
        return git('rev-parse', 'HEAD')
    for path in ['ios/App.swift', 'crates/lib.rs', 'turbo/app.ts']:
        write(path, 'original')
    base = commit('base')
    def branch(name):
        git('switch', '--quiet', '-C', name, base)
    def detect(event='pull_request', ref=base, checkout='refs/heads/feature', reject=False):
        env = dict(os.environ)
        for key in ['EVENT_NAME', 'GITHUB_EVENT_NAME', 'CHECKOUT_REF', 'GITHUB_REF',
                    'PULL_REQUEST_BASE_SHA', 'MERGE_GROUP_BASE_SHA']:
            env.pop(key, None)
        env.update(EVENT_NAME=event, CHECKOUT_REF=checkout)
        if ref is not None:
            env.update(PULL_REQUEST_BASE_SHA=ref, MERGE_GROUP_BASE_SHA=ref)
        result = run(['bash', str(script)], cwd=repo, env=env, check=False)
        if reject:
            assert result.returncode != 0, result.stdout
            assert 'ios-only=true' not in result.stdout
            return
        assert result.returncode == 0, result.stderr
        return dict(line.split('=', 1) for line in result.stdout.splitlines())
    def expect(ios_only, ts_needed, **args):
        assert detect(**args) == {'ios-only': str(ios_only).lower(),
                                  'turbo-ts-checks-needed': str(ts_needed).lower()}

    expect(False, True)  # Empty diffs are not an exemption.
    branch('ios')
    write('ios/App.swift', 'changed')
    write('ios/name\nwith-newline.swift', 'changed')
    ios_head = commit('ios')
    expect(True, False)
    expect(True, False, event='merge_group')
    expect(False, True, event='push')
    git('rm', '--quiet', 'ios/App.swift')
    commit('delete ios')
    expect(True, False, ref=ios_head)

    branch('crates')
    write('crates/lib.rs', 'changed')
    commit('crates')
    expect(False, False)
    expect(False, False, event='merge_group')
    write('ios/App.swift', 'also changed')
    commit('mixed native')
    expect(False, True)

    branch('rename-out')
    git('mv', 'ios/App.swift', 'turbo/App.swift')
    commit('move out of ios')
    expect(False, True)
    branch('rename-in')
    git('mv', 'turbo/app.ts', 'ios/app.ts')
    commit('move into ios')
    expect(False, True)

    branch('mixed')
    write('turbo/app.ts', 'earlier api change')
    commit('api')
    write('ios/App.swift', 'last native change')
    commit('ios')
    expect(False, True, event='merge_group')  # Include earlier queue entries.
    branch('workflow')
    write('.github/workflows/ios.yml', 'changed')
    write('ios/App.swift', 'changed')
    commit('workflow and native')
    expect(False, True)

    branch('advanced-main')
    write('turbo/app.ts', 'main advanced')
    advanced = commit('main change')
    git('merge', '--quiet', '--no-ff', ios_head, '-m', 'synthetic PR merge')
    expect(True, False, checkout='refs/pull/1/merge')
    git('switch', '--quiet', '--detach', ios_head)
    expect(True, False, ref=advanced)  # Direct PR heads use their merge base.
    detect(event='merge_group', ref=advanced, reject=True)
    detect(event='merge_group', ref='missing-ref', reject=True)
    detect(event='merge_group', ref=None, reject=True)
    detect(ref=None, reject=True)
    detect(event='unexpected', reject=True)

print('native-only change detection: ok')
PY
