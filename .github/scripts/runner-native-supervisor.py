#!/usr/bin/env python3
"""Bind real optimized integration executables; no compilation or backend selection."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import stat
import subprocess
import tomllib

ROOT = Path(__file__).resolve().parents[2]
TARGETS = ('x86_64-unknown-linux-musl', 'aarch64-unknown-linux-musl')
PROFILES = ('ci', 'release')
WORKER = {'process': 16, 'parent_death': 1, 'cleanup_unknown': 1}
PEER_GROUPS = ('pinned_native_acquisition', 'pinned_native_renew', 'pinned_completed_gss', 'pinned_rfb_finality')
TEST_TREES = ('crates/kerberos-worker/tests', 'crates/rfb-client/tests')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def regular(path, limit=64 * 1024 * 1024):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and 0 < info.st_size <= limit
            and path.resolve() == path.absolute(), 'invalid bounded optimized input')
    return path.read_bytes()


def toolchain_image():
    contract = ROOT / '.github/scripts/runner-binary-build/contract.env'
    regular(contract, 16384)
    # Use the canonical recipe's Bash semantics without ambient startup files.
    # This producer/consumer is restricted to the same okou-ai repository.
    return subprocess.check_output(
        ['bash', '-eu', '-c', '. "$1"; printf %s "$RUNNER_BINARY_TOOLCHAIN_IMAGE"',
         'runner-toolchain', str(contract)],
        env={'PATH': os.defpath, 'GITHUB_REPOSITORY_OWNER': 'okou-ai'}, text=True)


def git(*args):
    return subprocess.check_output(['git', '-c', f'safe.directory={ROOT}', *args], cwd=ROOT).strip()


def profile_contract(profile):
    require(profile in PROFILES, 'optimized profile required; no local fallback')
    profiles = tomllib.loads((ROOT / 'crates/Cargo.toml').read_text())['profile']
    require(profiles['release'] == {'lto': True, 'strip': True, 'codegen-units': 1}
            and profiles['ci'] == {'inherits': 'release', 'lto': 'thin', 'codegen-units': 4},
            'optimized profile source contract changed')
    return {**profiles['release'], **profiles[profile]}


def test_artifacts(events, names):
    finished = [e for e in events if e.get('reason') == 'build-finished']
    require(len(finished) == 1 and finished[0].get('success') is True, 'optimized compiler did not finish')
    artifacts = [e for e in events if e.get('reason') == 'compiler-artifact' and e.get('executable')]
    require(len(artifacts) == len(names) and {e['target']['name'] for e in artifacts} == set(names),
            'missing or duplicate optimized integration executable')
    for artifact in artifacts:
        profile = artifact['profile']
        require(artifact['target']['kind'] == ['test'] and profile['opt_level'] == '3'
                and profile['debug_assertions'] is False and profile['test'] is True,
                'not an optimized integration test artifact')
    return {e['target']['name']: e for e in artifacts}


def production_library(events):
    libraries = [e for e in events if e.get('reason') == 'compiler-artifact'
                 and e.get('target', {}).get('name') == 'kerberos_worker'
                 and e['target'].get('kind') == ['lib']]
    require(len(libraries) == 1, 'one real production supervisor library required')
    profile = libraries[0]['profile']
    require(profile['opt_level'] == '3' and profile['debug_assertions'] is False
            and profile['test'] is False, 'supervisor dependency is not an optimized production library')
    return libraries[0]


def peer_executable(path, profile, target):
    profile_contract(profile)
    require(target in TARGETS and path.parent == ROOT / 'crates/target' / target / profile / 'deps'
            and re.fullmatch(r'qemu_gssapi-[0-9a-f]+', path.name),
            'peer executable is not the selected optimized target/profile')
    return path


def native_identity(events):
    builds = [e for e in events if e.get('reason') == 'build-script-executed'
              and 'KERBEROS_WORKER_SHA256' in dict(e.get('env', []))]
    require(len(builds) == 1, 'one sealed native compiler identity required')
    env = dict(builds[0]['env'])
    return builds[0], {'nativeTarget': env['KERBEROS_WORKER_TARGET'],
                      'helperSha256': env['KERBEROS_WORKER_SHA256'],
                      'noticesSha256': env['KERBEROS_WORKER_NOTICES_SHA256']}


def required_names(name):
    path = ROOT / 'crates/kerberos-worker/tests' / (name + '.rs')
    # Freeze the exact tests present in this reviewed source, not only a success count.
    return re.findall(r'#\[(?:tokio::)?test[^\n]*\]\n(?:#\[ignore[^\n]*\]\n)?(?:async )?fn (\w+)\(', path.read_text())


def write(path, value):
    with path.open('x') as output:
        output.write(json.dumps(value, indent=2) + '\n')


def test_sources(head):
    records = {}
    for entry in git('ls-tree', '-r', '-z', head, '--', *TEST_TREES).split(b'\0'):
        if not entry:
            continue
        metadata, name = entry.decode().split('\t', 1)
        mode, kind, object_id = metadata.split()
        relative = Path(name)
        require(mode in ('100644', '100755') and kind == 'blob'
                and not relative.is_absolute() and '..' not in relative.parts
                and any(name.startswith(tree + '/') for tree in TEST_TREES), 'invalid committed ci test input')
        payload = regular(ROOT / relative, 2 * 1024 * 1024)
        require(git('hash-object', '--no-filters', '--', str(ROOT / relative)).decode() == object_id,
                'ci test source differs from committed producer input')
        records[name] = (mode, payload)
    require(records, 'committed ci test sources are missing')
    return records


def stage_ci_tests(context_root, head):
    require(context_root.is_dir() and context_root.resolve() == context_root.absolute(),
            'invalid original Runner ci source context')
    records = test_sources(head)
    # The normal Runner inventory deliberately excludes integration tests. Add
    # only exact committed test sources, never a helper/library/output byte.
    for name in records:
        destination = context_root / name
        require(not destination.exists() and not destination.is_symlink()
                and destination.resolve() == destination.absolute(), 'ci test source destination already exists or escaped')
    for name, (mode, payload) in records.items():
        destination = context_root / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        with destination.open('xb') as output:
            output.write(payload)
        destination.chmod(int(mode[-3:], 8))
    return {name: sha(payload) for name, (_, payload) in records.items()}


def prepare_ci(out, target, head):
    require(target in TARGETS and git('rev-parse', 'HEAD').decode() == head
            and not git('status', '--porcelain', '--untracked-files=no')
            and not git('ls-files', '--others', '--exclude-standard', '--', 'crates', '.github'),
            'ci compiler source is not the clean selected producer revision')
    require(not os.environ.get('RUNNER_BINARY_CONTEXT_ROOT'), 'unselected ci source context override')
    env = {**os.environ, 'TARGET_TRIPLE': target, 'RUNNER_BINARY_GIT_REVISION': head,
           'CARGO_TARGET_DIR': str(ROOT / 'crates/target')}
    expected = Path(env.get('RUNNER_TEMP') or env['CARGO_TARGET_DIR']) / ('runner-binary-build-context-' + target)
    result = subprocess.check_output(['bash', str(ROOT / '.github/scripts' / 'runner-binary-build/build.sh'),
                                      'materialize'], cwd=ROOT, env=env, text=True)
    roots = re.findall(r'^context-root=(.+)$', result, re.MULTILINE)
    require(roots == [str(expected)] and expected.resolve() == expected.absolute(),
            'original Runner ci materializer selected another source root')
    hashes = stage_ci_tests(expected, head)
    write(out / 'ci-source-context.json', {'kind': 'runner-ci-materialized', 'root': str(expected),
          'headSha': head, 'treeSha': git('rev-parse', 'HEAD^{tree}').decode(),
          'target': target, 'testInputSha256': hashes})
    print(expected)


def compiler_source(library, build, source_root):
    require(library['target']['src_path'] == str(source_root / 'crates/kerberos-worker/src/lib.rs')
            and library['package_id'].split('#', 1)[0] == 'path+' + (source_root / 'crates/kerberos-worker').as_uri()
            and build['package_id'] == library['package_id'], 'optimized native compiler used another source context')


def check_ci_source_record(record, target, head):
    source_root = Path(record['root'])
    require(source_root.is_absolute() and '..' not in source_root.parts
            and record['headSha'] == head and record['treeSha'] == git('rev-parse', 'HEAD^{tree}').decode()
            and record['target'] == target
            and record['testInputSha256'] == {name: sha(payload) for name, (_, payload) in test_sources(head).items()},
            'original compiler test-source inventory changed')
    require(record['kind'] == 'runner-ci-materialized'
            and source_root.name == 'runner-binary-build-context-' + target, 'ci compiler source kind changed')
    return source_root


def finish(out, profile, target, head):
    require(profile in PROFILES and target in TARGETS and git('rev-parse', 'HEAD').decode() == head,
            'optimized source/target/profile mismatch')
    require(not git('status', '--porcelain', '--untracked-files=no')
            and not git('ls-files', '--others', '--exclude-standard', '--', 'crates', '.github'),
            'optimized source inputs are dirty')
    context_bytes = regular(ROOT / 'crates/target/f5-release-input/context.json', 65536)
    context = json.loads(context_bytes)
    require(context['source']['headSha'] == head and context['target'] == target
            and context['toolchainImage'] == toolchain_image()
            and context['producer']['runId'] == int(os.environ['GITHUB_RUN_ID'])
            and context['producer']['runAttempt'] == int(os.environ['GITHUB_RUN_ATTEMPT'])
            and context['cli']['commitSha'] == head,
            'optimized compiler lost original same-source producer/CLI context')
    compiler_context = json.loads(regular(out / 'ci-source-context.json', 65536)) if profile == 'ci' else None
    compiler_root = check_ci_source_record(compiler_context, target, head) if profile == 'ci' else None
    compilers = {}; artifacts = {}; native = None
    for kind, names in (('worker', set(WORKER)), ('peer', {'qemu_gssapi'})):
        data = regular(out / (kind + '-compiler.json'), 8 * 1024 * 1024)
        events = [json.loads(line) for line in data.splitlines()]
        selected = test_artifacts(events, names)
        library = production_library(events)
        build, identity = native_identity(events)
        if profile == 'ci':
            compiler_source(library, build, compiler_root)
        require(identity['nativeTarget'] == target and (native is None or native == identity),
                'optimized consumers select different native helper builds')
        native = identity
        helper = regular(Path(build['out_dir']) / 'native/kerberos-worker', 16 * 1024 * 1024)
        notices = b'\n'.join(regular(Path(build['out_dir']) / 'native' / n, 128 * 1024)
                             for n in ('NOTICE-MIT', 'NOTICE-musl', 'NOTICE-Zig'))
        require(sha(helper) == identity['helperSha256'] and sha(notices) == identity['noticesSha256'],
                'native compiler bytes differ from the sealed identities')
        compilers[kind] = sha(data)
        for name, artifact in selected.items():
            relative = ('crates/rfb-client/tests/qemu_gssapi/main.rs' if name == 'qemu_gssapi'
                        else 'crates/kerberos-worker/tests/' + name + '.rs')
            if profile == 'ci':
                require(artifact['target']['src_path'] == str(compiler_root / relative), 'optimized integration source path changed')
            path = Path(artifact['executable'])
            require(path.parent == ROOT / 'crates/target' / target / profile / 'deps'
                    and re.fullmatch(re.escape(name) + r'-[0-9a-f]+', path.name),
                    'optimized integration output path mismatch')
            if name == 'qemu_gssapi':
                peer_executable(path, profile, target)
            payload = regular(path)
            require(payload[:6] == b'\x7fELF\x02\x01' and int.from_bytes(payload[18:20], 'little')
                    == (62 if target.startswith('x86_64') else 183), 'optimized test ELF target mismatch')
            require(helper in payload and notices in payload, 'optimized test lost complete sealed native package')
            required = required_names(name) if name in WORKER else []
            require(name not in WORKER or len(required) == WORKER[name], 'reviewed lifecycle test inventory changed')
            with (out / path.name).open('xb') as staged:
                staged.write(payload)
            artifacts[name] = {'file': path.name, 'sha256': sha(payload), 'sizeBytes': len(payload),
                               'compilerPath': str(path), 'requiredTests': required}
    with (out / 'distribution-build-context.json').open('xb') as destination:
        destination.write(context_bytes)
    write(out / 'manifest.json', {'schemaVersion': 1, 'headSha': head,
          'treeSha': git('rev-parse', 'HEAD^{tree}').decode(), 'profile': profile,
          'profileContract': profile_contract(profile), 'target': target,
          'producer': context['producer'], 'compiler': context['compiler'], 'cli': context['cli'],
          'distributionContextSha256': sha(context_bytes), 'compilerSha256': compilers,
          **({'ciCompilerSource': compiler_context} if profile == 'ci' else {}),
          'nativePackage': native, 'executables': artifacts, 'runtimeVerified': False,
          'scope': 'optimized Rust integration consumers; not distributed Runner execution, full QEMU PNG or K3'})


def validate_original_producer(producer, head, expected_attempt):
    # The successful producer job owns this target-specific attempt. The
    # manifest cannot select its own expected identity on a consumer-only rerun.
    current_attempt = os.environ.get('GITHUB_RUN_ATTEMPT')
    require(all(isinstance(value, str) and re.fullmatch(r'[1-9][0-9]*', value)
                for value in (expected_attempt, current_attempt)),
            'original optimized producer attempt unavailable')
    require(int(expected_attempt) <= int(current_attempt), 'original optimized producer attempt is from the future')
    require(producer['repository'] == 'okou-ai/okou' and producer['headSha'] == head
            and producer['runId'] == int(os.environ['GITHUB_RUN_ID'])
            and type(producer['runAttempt']) is int and producer['runAttempt'] == int(expected_attempt)
            and producer['workflowPath'] == '.github/workflows/runner-image.yml', 'original optimized producer mismatch')
    return int(current_attempt)


def validate(out, package, profile, target, head):
    require(target in TARGETS and platform.machine() == target.split('-')[0], 'native matching CPU required')
    require(not git('status', '--porcelain', '--untracked-files=no')
            and not git('ls-files', '--others', '--exclude-standard', '--', 'crates', '.github'),
            'verifier source/fixture inputs are dirty')
    manifest = json.loads(regular(out / 'manifest.json', 65536))
    require(manifest['headSha'] == head == git('rev-parse', 'HEAD').decode()
            and manifest['treeSha'] == git('rev-parse', 'HEAD^{tree}').decode()
            and manifest['profile'] == profile and manifest['target'] == target
            and manifest['profileContract'] == profile_contract(profile), 'optimized consumer source/profile mismatch')
    producer = manifest['producer']
    verifier_attempt = validate_original_producer(producer, head, os.environ.get('OPTIMIZED_PRODUCER_ATTEMPT'))
    context_bytes = regular(out / 'distribution-build-context.json', 65536)
    context = json.loads(context_bytes)
    require(sha(context_bytes) == manifest['distributionContextSha256']
            and context['producer'] == producer and context['cli'] == manifest['cli']
            and context['compiler'] == manifest['compiler']
            and context['toolchainImage'] == toolchain_image(),
            'original optimized compiler/source/CLI context changed')
    compiler_root = check_ci_source_record(manifest['ciCompilerSource'], target, head) if profile == 'ci' else None
    for kind, names in (('worker', set(WORKER)), ('peer', {'qemu_gssapi'})):
        data = regular(out / (kind + '-compiler.json'), 8 * 1024 * 1024)
        events = [json.loads(line) for line in data.splitlines()]
        library = production_library(events)
        if profile == 'ci':
            compiler_source(library, native_identity(events)[0], compiler_root)
        require(sha(data) == manifest['compilerSha256'][kind]
                and native_identity(events)[1] == manifest['nativePackage'], 'original compiler identity changed')
        for name, artifact in test_artifacts(events, names).items():
            relative = ('crates/rfb-client/tests/qemu_gssapi/main.rs' if name == 'qemu_gssapi'
                        else 'crates/kerberos-worker/tests/' + name + '.rs')
            if profile == 'ci':
                require(artifact['target']['src_path'] == str(compiler_root / relative), 'original integration source path changed')
            item = manifest['executables'][name]
            require(artifact['executable'] == item['compilerPath'] and item['file'] == Path(item['compilerPath']).name
                    and re.fullmatch(re.escape(name) + r'-[0-9a-f]+', item['file']), 'compiler/output binding changed')
            path = out / item['file']; data = regular(path)
            require(len(data) == item['sizeBytes'] and sha(data) == item['sha256'], 'optimized executable bytes changed')
            require(name not in WORKER or item['requiredTests'] == required_names(name), 'required lifecycle tests changed')
    receipt_bytes = regular(package / 'receipt.json', 65536); receipt = json.loads(receipt_bytes)
    require(receipt['head'] == head and receipt['target'] == target and receipt['profile'] == profile
            and receipt['runtimeVerified'] is True and receipt['runtimeProfile'] == 'privileged-synthetic'
            and receipt['runtimeUid'] == 0 and receipt['githubRunId'] == str(producer['runId']),
            'matching actual package evidence required before optimized lifecycle execution')
    helper = regular(package / 'helper', 16 * 1024 * 1024); notices = regular(package / 'notices.txt', 128 * 1024)
    identity = {'nativeTarget': target, 'helperSha256': sha(helper), 'noticesSha256': sha(notices)}
    require(identity == manifest['nativePackage']
            and all(receipt['nativePackage'][k] == v for k, v in identity.items()),
            'optimized test helper differs from the actual distributed package; never override it')
    for item in manifest['executables'].values():
        payload = regular(out / item['file'])
        require(helper in payload and notices in payload, 'downloaded optimized test lost original package bytes')
    # Original compiler input, provenance and attribution remain distinct from the verifier.
    write(out / 'validated.json', {'packageReceiptSha256': sha(receipt_bytes), 'packageProducer': receipt['producer'],
                                 'testProducer': producer, 'verifierHeadSha': head, 'profile': profile,
                                 'target': target, 'verifierRunAttempt': verifier_attempt,
                                 'trackedSourceDirty': False, 'runtimeVerified': False})


def check_results(text, expected):
    for name in expected:
        require(len(re.findall(r'^test ' + re.escape(name) + r' \.\.\. (?:[^\n]*\n)?ok$', text, re.MULTILINE)) == 1,
                'required native test absent, ignored or failed: ' + name)
    matches = re.findall(r'test result: ok\. (\d+) passed; 0 failed; 0 ignored; (?:0 measured; )?(\d+) filtered out;', text)
    require(len(matches) == 1 and int(matches[0][0]) == len(expected) and int(matches[0][1]) == 0,
            'native success inventory mismatch')


def required_peer_tests():
    pattern = r'#\[tokio::test\]\n#\[ignore[^\n]*\]\nasync fn (pinned_\w+)\('
    main = re.findall(pattern, (ROOT / 'crates/rfb-client/tests/qemu_gssapi/main.rs').read_text())
    controlled = re.findall(pattern, (ROOT / 'crates/rfb-client/tests/qemu_gssapi/controlled_peer.rs').read_text())
    expected = [name for name in main if name.startswith(PEER_GROUPS)]
    # Rust prints the actual module qualification for these two tests; a bare
    # function name would reject genuine successful finality execution.
    expected += ['controlled_peer::' + name for name in controlled if name.startswith(PEER_GROUPS)]
    require(len(expected) == 7 and len(set(expected)) == 7, 'reviewed controlled-peer inventory changed')
    return expected


def runtime_finish(out, result):
    require(os.geteuid() == 0, 'preselected privileged-synthetic runtime required')
    manifest = json.loads(regular(out / 'manifest.json', 65536))
    for name in WORKER:
        check_results(regular(result / (name + '.txt'), 4 * 1024 * 1024).decode(), manifest['executables'][name]['requiredTests'])
    peer = regular(result / 'peer.txt', 4 * 1024 * 1024).decode()
    expected = required_peer_tests()
    # Require the same four nonzero 1/2/2/2 groups AND every qualified source name.
    for name in expected:
        require(len(re.findall(r'^test ' + re.escape(name) + r' \.\.\. (?:[^\n]*\n)?ok$', peer, re.MULTILINE)) == 1,
                'required real mutual-GSS/authority test absent or failed')
    counts = re.findall(r'test result: ok\. (\d+) passed; 0 failed; 0 ignored;', peer)
    require(counts == ['1', '2', '2', '2'] and 'cleanup verified:' in peer, 'real peer execution/cleanup unconfirmed')
    validated = json.loads(regular(out / 'validated.json', 65536))
    provider = regular(result / 'provider.json', 2 * 1024 * 1024)
    write(result / 'receipt.json', {**validated, 'runtimeVerified': True, 'runtimeUid': os.geteuid(),
          'runtimeProfile': 'privileged-synthetic', 'compilerManifestSha256': sha(regular(out / 'manifest.json', 65536)),
          'fixtureProviderSha256': sha(provider), 'requiredWorkerTests': sum(WORKER.values()), 'requiredPeerTests': len(expected),
          'scope': 'optimized production-library lifecycle/capacity/cancellation and independent signed MIT mutual-GSS/RFC4752/TLS controls; not QEMU PNG, non-root availability or K3'})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('prepare-ci', 'finish', 'validate', 'runtime-finish'))
    parser.add_argument('out', type=Path)
    parser.add_argument('--profile', choices=PROFILES); parser.add_argument('--target', choices=TARGETS)
    parser.add_argument('--source-sha'); parser.add_argument('--package', type=Path); parser.add_argument('--result', type=Path)
    args = parser.parse_args(); out = args.out.absolute()
    if args.action == 'prepare-ci':
        require(args.profile == 'ci', 'ci source preparation cannot relabel another profile')
        prepare_ci(out, args.target, args.source_sha)
    elif args.action == 'finish':
        finish(out, args.profile, args.target, args.source_sha)
    elif args.action == 'validate':
        validate(out, args.package.absolute(), args.profile, args.target, args.source_sha)
    else:
        runtime_finish(out, args.result.absolute())


if __name__ == '__main__':
    main()
