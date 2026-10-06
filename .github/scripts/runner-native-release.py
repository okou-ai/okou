#!/usr/bin/env python3
"""Record/validate a real pre-merge release build; never build or impersonate it."""
import argparse
import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess
import tomllib

ROOT = pathlib.Path(__file__).resolve().parents[2]
IMAGE = 'ghcr.io/okou-ai/vm0-toolchain-rust:20260825'
TARGETS = ('x86_64-unknown-linux-musl', 'aarch64-unknown-linux-musl')
INPUTS = ('crates/Cargo.toml', 'crates/Cargo.lock', 'crates/.cargo/config.toml',
          'crates/runner/guest-binaries.json', 'crates/runner/build.rs',
          'crates/kerberos-worker/build.rs', 'crates/kerberos-worker/native/build.sh',
          '.github/scripts/build-runner-native-release.sh',
          '.github/scripts/runner-native-release.py', '.github/workflows/runner-image.yml',
          '.github/actions/setup-r2-sccache/action.yml')


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def regular(path, limit):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and 0 < info.st_size <= limit, 'invalid bounded release input')
    require(path.resolve() == path.absolute(), 'release input has a noncanonical ancestor')
    return path.read_bytes()


def git(*args):
    return subprocess.check_output(['git', '-c', f'safe.directory={ROOT}', *args], cwd=ROOT).strip()


def release_contract():
    profile = tomllib.loads((ROOT / 'crates/Cargo.toml').read_text())['profile']['release']
    require(profile == {'lto': True, 'strip': True, 'codegen-units': 1}, 'full-LTO release contract changed')
    return profile


def source(head):
    require(re.fullmatch('[0-9a-f]{40}', head) and git('rev-parse', 'HEAD').decode() == head,
            'release source HEAD mismatch')
    require(not git('status', '--porcelain', '--untracked-files=no'), 'tracked release source is dirty')
    require(not git('ls-files', '--others', '--exclude-standard', '--', 'crates', '.github', '.cargo'),
            'untracked release source input')
    return {'headSha': head, 'treeSha': git('rev-parse', 'HEAD^{tree}').decode(),
            'trackedDirty': False, 'inputSha256': {p: sha(regular(ROOT / p, 2 * 1024 * 1024)) for p in INPUTS}}


def runner_artifact(events):
    artifacts = [e for e in events if e.get('reason') == 'compiler-artifact'
                 and e.get('target', {}).get('name') == 'runner' and e.get('executable')]
    require(len(artifacts) == 1, 'release compiler did not produce exactly one Runner')
    artifact = artifacts[0]; profile = artifact['profile']
    require(artifact['target']['kind'] == ['bin'] and profile['opt_level'] == '3'
            and profile['debug_assertions'] is False and profile['test'] is False,
            'Runner compiler profile is not an optimized non-test distribution')
    finished = [e for e in events if e.get('reason') == 'build-finished']
    require(len(finished) == 1 and finished[0]['success'] is True, 'release compiler did not complete successfully')
    return artifact


def compiler(path):
    data = regular(path, 4 * 1024 * 1024)
    return data, [json.loads(line) for line in data.splitlines()]


def write(path, value):
    with path.open('x') as output:
        output.write(json.dumps(value, indent=2) + '\n')


def prepare(out, head, target, image):
    require(image == IMAGE and target in TARGETS, 'release toolchain or target mismatch')
    for name in os.environ:
        if (name in ('RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'CARGO_BUILD_RUSTFLAGS', 'RUSTC', 'RUSTC_WORKSPACE_WRAPPER')
                or name.startswith('CARGO_PROFILE_') or (name.startswith('CARGO_TARGET_') and name.endswith('_RUSTFLAGS'))):
            require(not os.environ[name], 'compiler/profile override is not accepted')
    require(os.environ.get('RUSTC_WRAPPER') in (None, '', 'sccache'), 'unselected compiler wrapper')
    src = source(head)
    cli = ROOT / 'runner-cli-intermediate'
    package = regular(cli / 'package.tgz', 64 * 1024 * 1024)
    manifest_bytes = regular(cli / 'manifest.json', 16384); manifest = json.loads(manifest_bytes)
    require(manifest['commitSha'] == head, 'release CLI is not from the selected source HEAD')
    subprocess.run(['bash', str(ROOT / '.github/scripts/verify-okou-cli-artifact.sh'), str(cli), head], check=True)
    require(os.environ['GITHUB_REPOSITORY'] == 'okou-ai/okou', 'release producer repository mismatch')
    workflow = os.environ['GITHUB_WORKFLOW_REF'].split('@', 1)[0]
    require(workflow == 'okou-ai/okou/.github/workflows/runner-image.yml', 'release producer workflow mismatch')
    run = int(os.environ['GITHUB_RUN_ID']); attempt = int(os.environ['GITHUB_RUN_ATTEMPT'])
    event = os.environ['GITHUB_EVENT_NAME']
    require(run > 0 and attempt > 0 and event in ('pull_request', 'push', 'merge_group'), 'invalid release producer identity')
    require(not out.exists() and not out.is_symlink() and out.parent.resolve() == out.parent.absolute(),
            'release output must be new and canonical')
    out.mkdir(mode=0o700)
    write(out / 'context.json', {'schemaVersion': 1, 'profile': 'release', 'target': target,
          'toolchainImage': image, 'source': src, 'releaseContract': release_contract(),
          'cli': {'commitSha': head, 'sha256': sha(package), 'sizeBytes': len(package),
                  'manifestSha256': sha(manifest_bytes), 'readySha256': sha(regular(cli / 'ready.json', 16384))},
          'producer': {'repository': 'okou-ai/okou', 'workflowPath': '.github/workflows/runner-image.yml',
                       'headSha': head, 'runId': run, 'runAttempt': attempt, 'event': event},
          'compiler': {'rustc': subprocess.check_output(['rustc', '-Vv'], text=True),
                       'cargo': subprocess.check_output(['cargo', '-V'], text=True),
                       'rustcWrapper': os.environ.get('RUSTC_WRAPPER')}})


def finish(out):
    context_bytes = regular(out / 'context.json', 65536); context = json.loads(context_bytes)
    require(source(context['source']['headSha']) == context['source'], 'release source changed during build')
    require(release_contract() == context['releaseContract'], 'release profile changed during build')
    compiler_bytes, events = compiler(out / 'compiler.json'); artifact = runner_artifact(events)
    guest_bytes, guest_events = compiler(out / 'guest-compiler.json')
    inventory = json.loads((ROOT / 'crates/runner/guest-binaries.json').read_text())
    guest_artifacts = {e['target']['name']: e for e in guest_events
                       if e.get('reason') == 'compiler-artifact' and e.get('executable')}
    require(set(guest_artifacts) == {g['binary'] for g in inventory}, 'release guest inventory mismatch')
    require(any(e.get('reason') == 'build-finished' and e.get('success') is True for e in guest_events),
            'release guest compilation did not finish')
    target = context['target']; directory = ROOT / 'crates/target' / target / 'release'
    require(pathlib.Path(artifact['executable']) == directory / 'runner', 'release Runner executable path mismatch')
    runner = regular(directory / 'runner', 128 * 1024 * 1024)
    require(runner[:6] == b'\x7fELF\x02\x01' and int.from_bytes(runner[18:20], 'little')
            == (62 if target.startswith('x86_64') else 183), 'release Runner ELF target mismatch')
    guests = {}
    for guest in inventory:
        path = directory / guest['binary']
        require(pathlib.Path(guest_artifacts[guest['binary']]['executable']) == path, 'release guest path mismatch')
        profile = guest_artifacts[guest['binary']]['profile']
        require(profile['opt_level'] == '3' and profile['debug_assertions'] is False and profile['test'] is False,
                'release guest compiler profile mismatch')
        data = regular(path, 128 * 1024 * 1024)
        require(data in runner, 'release Runner did not embed the actual release guest')
        guests[guest['binary']] = sha(data)
    cli = ROOT / 'runner-cli-intermediate'
    package = regular(cli / 'package.tgz', 64 * 1024 * 1024)
    require(sha(package) == context['cli']['sha256'] and package in runner
            and sha(regular(cli / 'manifest.json', 16384)) == context['cli']['manifestSha256'],
            'release Runner did not embed the verified same-head CLI')
    builds = [dict(e.get('env', [])) for e in events if e.get('reason') == 'build-script-executed']
    require(any(e.get('BUNDLED_OKOU_CLI_SHA256') == context['cli']['sha256'] for e in builds),
            'release compiler did not bind the actual CLI')
    natives = [e for e in builds if e.get('KERBEROS_WORKER_SHA256')]
    require(len(natives) == 1 and natives[0]['KERBEROS_WORKER_TARGET'] == target
            and re.fullmatch('[0-9a-f]{64}', natives[0]['KERBEROS_WORKER_SHA256'])
            and re.fullmatch('[0-9a-f]{64}', natives[0]['KERBEROS_WORKER_NOTICES_SHA256']),
            'release compiler did not bind exactly one complete native package')
    native = {'nativeTarget': target, 'helperSha256': natives[0]['KERBEROS_WORKER_SHA256'],
              'noticesSha256': natives[0]['KERBEROS_WORKER_NOTICES_SHA256']}
    identity = {'sha256': sha(runner), 'sizeBytes': len(runner)}
    write(out / 'metadata.json', {'schemaVersion': 1, 'profile': 'release', 'target': target,
                                 'runnerSha256': identity['sha256'], 'runnerSizeBytes': len(runner)})
    write(out / 'manifest.json', {**context, 'runner': identity, 'guestSha256': guests,
          'compilerReceiptSha256': sha(compiler_bytes), 'guestCompilerReceiptSha256': sha(guest_bytes),
          'compilerRunnerPath': artifact['executable'], 'nativeCompilerIdentity': native,
          'contextSha256': sha(context_bytes)})
    with (out / 'runner').open('xb') as output:
        output.write(runner)


def validate(out, head, target):
    manifest = json.loads(regular(out / 'manifest.json', 65536))
    require(manifest['profile'] == 'release' and manifest['target'] == target
            and manifest['toolchainImage'] == IMAGE and manifest['source'] == source(head)
            and manifest['releaseContract'] == release_contract()
            and manifest['cli']['commitSha'] == head, 'release source/profile/target/CLI identity mismatch')
    producer = manifest['producer']
    require(producer['repository'] == 'okou-ai/okou' and producer['headSha'] == head
            and producer['workflowPath'] == '.github/workflows/runner-image.yml'
            and producer['runId'] == int(os.environ['GITHUB_RUN_ID'])
            and type(producer['runAttempt']) is int and producer['runAttempt'] > 0,
            'release consumer has a different original producer')
    context_bytes = regular(out / 'context.json', 65536); context = json.loads(context_bytes)
    require(sha(context_bytes) == manifest['contextSha256']
            and all(manifest[k] == v for k, v in context.items()), 'release build context identity mismatch')
    compiler_bytes, events = compiler(out / 'compiler.json'); artifact = runner_artifact(events)
    require(sha(compiler_bytes) == manifest['compilerReceiptSha256']
            and artifact['executable'] == manifest['compilerRunnerPath'], 'release compiler receipt mismatch')
    natives = [dict(e.get('env', [])) for e in events if e.get('reason') == 'build-script-executed'
               and 'KERBEROS_WORKER_SHA256' in dict(e.get('env', []))]
    require(len(natives) == 1 and manifest['nativeCompilerIdentity'] == {
        'nativeTarget': natives[0]['KERBEROS_WORKER_TARGET'],
        'helperSha256': natives[0]['KERBEROS_WORKER_SHA256'],
        'noticesSha256': natives[0]['KERBEROS_WORKER_NOTICES_SHA256']}, 'release native compiler identity mismatch')
    guest_bytes, _ = compiler(out / 'guest-compiler.json')
    require(sha(guest_bytes) == manifest['guestCompilerReceiptSha256'], 'release guest compiler receipt mismatch')
    runner = regular(out / 'runner', 128 * 1024 * 1024)
    require({'sha256': sha(runner), 'sizeBytes': len(runner)} == manifest['runner'], 'release payload identity mismatch')
    metadata = json.loads(regular(out / 'metadata.json', 65536))
    require(metadata == {'schemaVersion': 1, 'profile': 'release', 'target': target,
                         'runnerSha256': sha(runner), 'runnerSizeBytes': len(runner)}, 'release metadata mismatch')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('prepare', 'finish', 'validate'))
    parser.add_argument('out', type=pathlib.Path)
    parser.add_argument('--source-sha'); parser.add_argument('--target', choices=TARGETS)
    parser.add_argument('--toolchain-image')
    args = parser.parse_args(); out = args.out.absolute()
    if args.action == 'prepare':
        prepare(out, args.source_sha, args.target, args.toolchain_image)
    elif args.action == 'finish':
        finish(out)
    else:
        validate(out, args.source_sha, args.target)


if __name__ == '__main__':
    main()
