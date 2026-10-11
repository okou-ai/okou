"""Real Cargo/Git feature, reverse-consumer and lint-failure regression cases."""

import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile


SCRIPT = Path(__file__).resolve().parents[1] / "select-clippy-packages.py"
spec = importlib.util.spec_from_file_location("clippy_selection", SCRIPT)
selector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(selector)


def run(args, root, success=True):
    result = subprocess.run(args, cwd=root, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if success:
        assert result.returncode == 0, (args, result.stdout, result.stderr)
    return result


def write(root, path, content):
    file = root / path
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(content)


def commit(root):
    run(["git", "add", "crates"], root)
    run(["git", "commit", "-qm", "fixture"], root)
    return run(["git", "rev-parse", "HEAD"], root).stdout.strip()


def fixture(root):
    run(["git", "init", "-q"], root)
    run(["git", "config", "user.email", "fixture@example.invalid"], root)
    run(["git", "config", "user.name", "Fixture"], root)
    run(["git", "config", "commit.gpgsign", "false"], root)
    write(root, 'crates/.gitignore', '/target/\n')
    manifests = {
        "core-dir": ('fixture-core', '[features]\nwide = []\n',
                     '#[cfg(feature = "wide")] pub const WIDE: bool = true;\n'
                     '#[cfg(not(feature = "wide"))] pub const WIDE: bool = false;\n'),
        "consumer": ('fixture-consumer', '[dependencies]\nrenamed = { package = "fixture-core", path = "../core-dir", default-features = false }\nfixture-macro = { path = "../proc" }\n',
                     'const _: () = assert!(renamed::WIDE);\npub fn value() -> bool { renamed::WIDE }\n'),
        "top": ('fixture-top', '[dependencies]\nfixture-consumer = { path = "../consumer" }\n',
                'pub fn value() -> bool { fixture_consumer::value() }\n'),
        "donor": ('fixture-donor', '[dependencies]\nrenamed = { package = "fixture-core", path = "../core-dir", features = ["wide"] }\n', 'pub fn value() {}\n'),
        "dev": ('fixture-dev', '[dev-dependencies]\nfixture-core = { path = "../core-dir", features = ["wide"] }\n', 'pub fn value() {}\n'),
        "build": ('fixture-build', '[build-dependencies]\nfixture-core = { path = "../core-dir", features = ["wide"] }\n', 'pub fn value() {}\n'),
        "optional": ('fixture-optional', '[dependencies]\nfixture-core = { path = "../core-dir", optional = true }\n', 'pub fn value() {}\n'),
        "conditional": ('fixture-conditional', '[target.\'cfg(any())\'.dependencies]\nfixture-core = { path = "../core-dir" }\n', 'pub fn value() {}\n'),
        "spare": ('fixture-spare', '', 'pub fn value() {}\n'),
        "proc": ('fixture-macro', '[lib]\nproc-macro = true\n',
                 'extern crate proc_macro;\n#[proc_macro] pub fn identity(input: proc_macro::TokenStream) -> proc_macro::TokenStream { input }\n'),
    }
    write(root, 'crates/Cargo.toml', '[workspace]\nresolver = "3"\nmembers = ' + json.dumps(list(manifests)) + '\n')
    for directory, (name, dependencies, source) in manifests.items():
        write(root, f'crates/{directory}/Cargo.toml', f'[package]\nname = "{name}"\nversion = "0.1.0"\nedition = "2024"\n{dependencies}')
        write(root, f'crates/{directory}/src/lib.rs', source)
    write(root, 'crates/build/build.rs', 'const _: () = assert!(fixture_core::WIDE);\nfn main() {}\n')
    write(root, 'crates/dev/tests/feature.rs', '#[test] fn wide() { assert!(fixture_core::WIDE); }\n')
    run(['cargo', 'generate-lockfile', '--offline'], root / 'crates')
    return commit(root)


def metadata(root):
    host = next(line[6:] for line in run(['rustc', '-vV'], root).stdout.splitlines() if line.startswith('host: '))
    return json.loads(run(['cargo', 'metadata', '--offline', '--locked', '--all-features', '--format-version', '1',
                           '--filter-platform', host], root / 'crates').stdout)


def artifacts(result):
    records = set()
    for line in result.stdout.splitlines():
        record = json.loads(line)
        if record.get('reason') == 'compiler-artifact':
            records.add((record['package_id'], record['target']['name'], tuple(record['target']['kind']),
                         record['profile']['test'], tuple(record['features'])))
    return records


with tempfile.TemporaryDirectory(prefix='clippy-selection-') as directory:
    root = Path(directory).resolve()
    base = fixture(root)
    meta = metadata(root)
    selection = selector.select(meta, ['crates/core-dir/src/lib.rs'], root)
    expected = {'fixture-core', 'fixture-consumer', 'fixture-top', 'fixture-donor', 'fixture-dev',
                'fixture-build', 'fixture-optional', 'fixture-conditional'}
    assert set(selection['affected']) == expected, selection
    assert 'fixture-spare' not in selection['selected'], selection

    narrow = selector.select(meta, ['crates/consumer/src/lib.rs'], root)
    assert narrow['mode'] == 'selected' and {'fixture-consumer', 'fixture-top'} <= set(narrow['affected']), narrow
    assert {'fixture-core', 'fixture-build', 'fixture-optional', 'fixture-conditional'} <= set(narrow['anchors'])
    # Plain package selection loses feature donations. The selector must not.
    bad = run(['cargo', 'clippy', '--offline', '--all-targets', '--all-features', '-p', 'fixture-consumer'], root / 'crates', False)
    assert bad.returncode != 0 and 'assertion failed' in bad.stderr, bad.stderr
    command = ['cargo', 'clippy', '--offline', '--all-targets', '--all-features', '--message-format=json']
    baseline = run(command, root / 'crates')
    selected_command = command + [item for name in narrow['selected'] for item in ['-p', name]]
    selected = run(selected_command, root / 'crates')
    assert artifacts(selected) <= artifacts(baseline), (artifacts(selected), artifacts(baseline))
    assert any(record[-1] == ('wide',) for record in artifacts(selected))

    # Existing files, deleted files and both rename paths retain package ownership.
    for paths in (['crates/consumer/src/deleted.rs'],
                  ['crates/consumer/src/old.rs', 'crates/consumer/src/new.rs'],
                  ['crates/consumer/tests/integration.rs'], ['crates/consumer/examples/demo.rs']):
        assert 'fixture-consumer' in selector.select(meta, paths, root)['affected']
    for path in ('crates/Cargo.lock', 'crates/consumer/Cargo.toml', 'crates/build/build.rs',
                 'crates/unknown/src/lib.rs', 'crates/.cargo/config.toml', 'scripts/shared.py'):
        assert selector.select(meta, [path], root)['mode'] == 'full', path
    assert selector.select(meta, [], root)['mode'] == 'full'
    for event in ('push', 'merge_group'):
        assert selector.plan(root, event, base)['mode'] == 'full'
    assert selector.plan(root, 'pull_request', '')['mode'] == 'full'
    assert selector.plan(root, 'pull_request', 'unavailable-base')['mode'] == 'full'

    # The actual git diff is NUL-delimited and does not collapse renames.
    run(['git', 'mv', 'crates/consumer/src/lib.rs', 'crates/consumer/src/old.rs'], root)
    write(root, 'crates/consumer/src/lib.rs', 'include!("old.rs");\n')
    commit(root)
    assert selector.plan(root, 'pull_request', base)['mode'] == 'selected'
    write(root, 'crates/consumer/tests/failure.rs', '#![deny(clippy::unwrap_used)]\n#[test] fn lint() { let _ = std::env::var("FIXTURE").unwrap(); }\n')
    commit(root)
    failed = run(['python3', str(SCRIPT), '--repository', str(root), '--event', 'pull_request', '--base', base], root, False)
    assert failed.returncode != 0 and 'unwrap()' in failed.stderr, failed.stderr
    write(root, 'crates/consumer/tests/failure.rs', '#[test] fn works() {}\n')
    write(root, 'crates/consumer/examples/failure.rs', '#![deny(clippy::unwrap_used)]\nfn main() { let _ = std::env::var("FIXTURE").unwrap(); }\n')
    commit(root)
    failed = run(['python3', str(SCRIPT), '--repository', str(root), '--event', 'pull_request', '--base', base], root, False)
    assert failed.returncode != 0 and 'unwrap()' in failed.stderr, failed.stderr
    # Unsupported resolvers and package removal always retain full checking.
    write(root, 'crates/Cargo.toml', (root / 'crates/Cargo.toml').read_text().replace('resolver = "3"', 'resolver = "2"'))
    commit(root)
    assert selector.plan(root, 'pull_request', base)['mode'] == 'full'
    malformed = dict(meta, resolve=None)
    try:
        selector.select(malformed, ['crates/consumer/src/lib.rs'], root)
    except TypeError:
        pass
    else:
        raise AssertionError('malformed graph must fail, never pass as an empty selection')

    # Actual resolved aliases must participate, while a missing/ambiguous
    # identity cannot donate requests.
    consumer = next(p for p in meta['packages'] if p['name'] == 'fixture-consumer')
    node = next(n for n in meta['resolve']['nodes'] if n['id'] == consumer['id'])
    packages = {p['id']: p for p in meta['packages']}
    requests = selector.dependency_requests(consumer, packages, node)
    assert requests and any(token[-1] == 'active' for token in requests)
    assert selector.dependency_requests(consumer, packages, dict(node, deps=[])) is None
    build = next(p for p in meta['packages'] if p['name'] == 'fixture-build')
    build_node = next(n for n in meta['resolve']['nodes'] if n['id'] == build['id'])
    assert all(token[1] == 'host' for token in selector.dependency_requests(build, packages, build_node))
    core = next(p['id'] for p in meta['packages'] if p['name'] == 'fixture-core')
    assert all(token[1] == 'normal' for token in requests if token[0] == core)
    macro = next(p for p in meta['packages'] if p['name'] == 'fixture-macro')
    assert all(token[1] == 'host' for token in requests if token[0] == macro['id'])
    macro_node = next(n for n in meta['resolve']['nodes'] if n['id'] == macro['id'])
    assert selector.dependency_requests(macro, packages, macro_node) is None

    # A Rust include creates a consumer without a Cargo dependency edge.
    write(root, 'crates/spare/src/lib.rs', 'include!("../../core-dir/src/lib.rs");\n')
    include_selection = selector.select(meta, ['crates/core-dir/src/lib.rs'], root)
    assert 'fixture-spare' in include_selection['anchors']
    assert 'fixture-spare' in include_selection['selected']

print('select-clippy-packages-test: real feature equivalence, reverse consumers, full modes and lint failures ok')
