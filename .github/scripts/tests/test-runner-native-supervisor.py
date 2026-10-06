#!/usr/bin/env python3
"""Inert optimized-supervisor admission regressions; never native evidence."""
import importlib.util
import json
import os
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[3]


def module():
    spec = importlib.util.spec_from_file_location('optimized_supervisor', ROOT / '.github/scripts/runner-native-supervisor.py')
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


class OptimizedSupervisor(unittest.TestCase):
    def test_optimized_artifact_rejects_debug_duplicate_and_failed_compilers(self):
        parser = module().test_artifacts
        event = {'reason': 'compiler-artifact', 'target': {'name': 'process', 'kind': ['test']},
                 'executable': '/owned/ci/deps/process-inert-record',
                 'profile': {'opt_level': '3', 'debug_assertions': False, 'test': True}}
        finished = {'reason': 'build-finished', 'success': True}
        self.assertEqual(set(parser([event, finished], {'process'})), {'process'})
        for events in ([event], [event, event, finished], [event, {'reason': 'build-finished', 'success': False}]):
            with self.subTest(events=events), self.assertRaises(ValueError):
                parser(events, {'process'})
        for field, value in (('opt_level', '0'), ('debug_assertions', True), ('test', False)):
            changed = json.loads(json.dumps(event)); changed['profile'][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                parser([changed, finished], {'process'})

    def test_requires_optimized_non_test_production_library(self):
        check = module().production_library
        event = {'reason': 'compiler-artifact', 'target': {'name': 'kerberos_worker', 'kind': ['lib']},
                 'profile': {'opt_level': '3', 'debug_assertions': False, 'test': False}}
        self.assertEqual(check([event]), event)
        for events in ([], [event, event]):
            with self.subTest(events=events), self.assertRaises(ValueError):
                check(events)
        for field, value in (('opt_level', '0'), ('debug_assertions', True), ('test', True)):
            changed = json.loads(json.dumps(event)); changed['profile'][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                check([changed])

    def test_exact_ci_and_full_lto_contracts_are_distinct(self):
        self.assertEqual(module().profile_contract('release')['lto'], True)
        self.assertEqual(module().profile_contract('ci')['lto'], 'thin')
        with self.assertRaises(ValueError):
            module().profile_contract('local')

    def test_missing_producer_inputs_refuse_before_any_build(self):
        import subprocess
        result = subprocess.run(['bash', str(ROOT / '.github/scripts/build-runner-native-supervisor.sh')],
                                cwd=ROOT, env={'PATH': '/usr/bin:/bin'}, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b'missing optimized supervisor source SHA', result.stderr)

    def test_real_peer_admission_has_no_generic_binary_or_profile_fallback(self):
        validate = module().peer_executable
        for path, profile, target in (
                (ROOT / 'crates/target/local/deps/qemu_gssapi-inert-record', 'ci', 'x86_64-unknown-linux-musl'),
                (ROOT / 'crates/target/x86_64-unknown-linux-musl/ci/deps/process-inert-record', 'ci', 'x86_64-unknown-linux-musl'),
                (ROOT / 'crates/target/aarch64-unknown-linux-musl/ci/deps/qemu_gssapi-inert-record', 'ci', 'x86_64-unknown-linux-musl')):
            with self.subTest(path=path), self.assertRaises(ValueError):
                validate(path, profile, target)

    def test_native_results_cannot_pass_zero_or_filtered_required_tests(self):
        check = module().check_results
        expected = ['two_actual_processes_hold_capacity_until_owned_close_and_drop_cleanup']
        for text in ('', 'test result: ok. 0 passed; 0 failed; 0 ignored; 1 filtered out;',
                     'test two_actual_processes_hold_capacity_until_owned_close_and_drop_cleanup ... ignored\n',
                     'test result: ok. 1 passed; 0 failed; 0 ignored; 0 filtered out;',
                     'test two_actual_processes_hold_capacity_until_owned_close_and_drop_cleanup ... ok\n'
                     'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out;'):
            with self.subTest(text=text), self.assertRaises(ValueError):
                check(text, expected)
        check('test two_actual_processes_hold_capacity_until_owned_close_and_drop_cleanup ... ok\n'
              'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out;', expected)

    def test_peer_code_is_from_verifier_checkout_not_container_compile_path(self):
        source = (ROOT / 'crates/rfb-client/tests/qemu_gssapi/main.rs').read_text()
        boundary = source.split('fn mit_peer(', 1)[1].split('async fn peer_frame', 1)[0]
        self.assertNotIn('env!("CARGO_MANIFEST_DIR")', boundary)
        self.assertIn('std::env::current_dir()', boundary)
        fixture = (ROOT / 'crates/rfb-client/tests/fixtures/qemu_gssapi.py').read_text()
        self.assertIn('subprocess.Popen(argv, env=env, cwd=REPO, start_new_session=True)', fixture)

    def test_real_peer_result_inventory_keeps_rust_module_qualification(self):
        # Source boundary only: no completed native context or runtime receipt.
        import ast
        implementation = ast.parse((ROOT / '.github/scripts/runner-native-supervisor.py').read_text())
        functions = [node for node in implementation.body if isinstance(node, ast.FunctionDef)]
        inventory = next(node for node in functions if node.name in ('required_peer_tests', 'runtime_finish'))
        self.assertIn('controlled_peer::', ast.unparse(inventory))
        names = module().required_peer_tests()
        self.assertEqual(len(set(names)), 7)
        self.assertEqual({name for name in names if name.startswith('controlled_peer::')}, {
            'controlled_peer::pinned_rfb_finality_padding_and_security_result_use_actual_mutual_gss',
            'controlled_peer::pinned_rfb_finality_stalled_peer_closes_at_acquired_ticket_and_gss_expiry'})

    def test_ci_compiler_uses_original_runner_materializer_not_checkout_native_sources(self):
        source = (ROOT / '.github/scripts/build-runner-native-supervisor.sh').read_text()
        self.assertIn('prepare-ci', source)
        self.assertIn('cd "$compiler_source/crates"', source)
        preparation = source.split('runner-native-supervisor.py prepare-ci', 1)[1].split(')', 1)[0]
        self.assertIn('--profile "$profile"', preparation)
        implementation = (ROOT / '.github/scripts/runner-native-supervisor.py').read_text()
        self.assertIn("'runner-binary-build/build.sh'", implementation)
        self.assertIn("'materialize'", implementation)
        self.assertNotIn('strip-debug', implementation)

    def test_original_materializer_git_lookup_inherits_only_exact_checkout_trust(self):
        import subprocess
        import tempfile
        with tempfile.TemporaryDirectory(dir=ROOT / 'crates/target') as directory:
            parent = Path(directory)
            repo = parent / 'repo'; unrelated = parent / 'unrelated'
            for path in (repo, unrelated):
                subprocess.run(['git', 'init', '-q', str(path)], check=True)
            scripts = repo / '.github/scripts'; scripts.mkdir(parents=True)
            original_config = (repo / '.git/config').read_bytes()
            env = {**os.environ, 'GIT_TEST_ASSUME_DIFFERENT_OWNER': '1',
                   'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_COUNT': '0'}
            env.pop('GIT_CONFIG_PARAMETERS', None)
            refused = subprocess.run(['git', '-C', str(repo), 'rev-parse', '--show-toplevel'],
                                     env=env, capture_output=True, text=True)
            self.assertEqual(refused.returncode, 128)
            self.assertIn('dubious ownership', refused.stderr)
            for name in ('build-runner-native-supervisor.sh', 'build-runner-native-release.sh'):
                source = (ROOT / '.github/scripts' / name).read_text()
                prefix = source.split(': "${SOURCE_SHA', 1)[0]
                script = scripts / name
                # Execute only the real caller startup and nested Git lookup,
                # not a fake materializer/compiler/helper or native outcome.
                script.write_text(prefix + '\nbash -c "git rev-parse --show-toplevel"\n'
                                  + 'if git -C "$1" rev-parse --show-toplevel; then exit 9; fi\n')
                result = subprocess.run(['bash', str(script), str(unrelated)], cwd=scripts,
                                        env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.splitlines(), [str(repo)])
                self.assertIn('dubious ownership', result.stderr)
                self.assertIn(str(unrelated), result.stderr)
                self.assertEqual((repo / '.git/config').read_bytes(), original_config)
                self.assertNotIn('config --global', prefix)
                self.assertNotIn('safe.directory=*', prefix)

    def test_ci_source_inventory_stages_only_exact_committed_test_files(self):
        import hashlib
        import subprocess
        import tempfile
        self.assertTrue(callable(module().stage_ci_tests))
        with tempfile.TemporaryDirectory(dir=ROOT / 'crates/target') as directory:
            repo = Path(directory) / 'repo'; repo.mkdir()
            subprocess.run(['git', 'init', '-q', str(repo)], check=True)
            files = {'crates/kerberos-worker/tests/process.rs': b'public inert test source\n',
                     'crates/rfb-client/tests/qemu_gssapi/main.rs': b'public inert peer source\n'}
            for name, value in files.items():
                path = repo / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(value)
            subprocess.run(['git', '-C', str(repo), 'add', '.'], check=True)
            subprocess.run(['git', '-C', str(repo), '-c', 'user.name=inert', '-c', 'user.email=inert@example.invalid',
                            'commit', '-qm', 'inert source inventory'], check=True)
            head = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip()
            context = Path(directory) / 'runner-binary-build-context-x86_64-unknown-linux-musl'; context.mkdir()
            implementation = module(); implementation.ROOT = repo
            result = implementation.stage_ci_tests(context, head)
            self.assertEqual(result, {name: hashlib.sha256(value).hexdigest() for name, value in files.items()})
            for name, value in files.items(): self.assertEqual((context / name).read_bytes(), value)
            record = {'kind': 'runner-ci-materialized', 'root': str(context), 'headSha': head,
                      'treeSha': subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD^{tree}'], text=True).strip(),
                      'target': 'x86_64-unknown-linux-musl', 'testInputSha256': result}
            implementation.check_ci_source_record(record, record['target'], head)
            record['testInputSha256'] = {**result, next(iter(files)): '0' * 64}
            with self.assertRaises(ValueError): implementation.check_ci_source_record(record, record['target'], head)
            with self.assertRaises(ValueError): implementation.stage_ci_tests(context, head)  # never overwrite
            link = Path(directory) / 'context-link'; link.symlink_to(context, target_is_directory=True)
            with self.assertRaises(ValueError): implementation.stage_ci_tests(link, head)
            # Dirty or symlinked source cannot become a same-source compiler input.
            selected = repo / next(iter(files)); selected.write_bytes(b'changed inert source\n')
            with self.assertRaises(ValueError): implementation.stage_ci_tests(context, head)
            selected.unlink(); selected.symlink_to(context / next(iter(files)))
            with self.assertRaises(ValueError): implementation.stage_ci_tests(context, head)

    def test_ci_compiler_source_refuses_checkout_path_before_receipt_acceptance(self):
        validate = module().compiler_source
        source = Path('/producer/tmp/runner-binary-build-context-x86_64-unknown-linux-musl')
        library = {'package_id': 'path+' + (source / 'crates/kerberos-worker').as_uri() + '#0.1.0',
                   'target': {'src_path': str(source / 'crates/kerberos-worker/src/lib.rs')}}
        build = {'package_id': library['package_id']}
        validate(library, build, source)
        library['target']['src_path'] = '/producer/checkout/crates/kerberos-worker/src/lib.rs'
        with self.assertRaises(ValueError): validate(library, build, source)
        library['target']['src_path'] = str(source / 'crates/kerberos-worker/src/lib.rs')
        build['package_id'] = 'path+file:///producer/other/crates/kerberos-worker#0.1.0'
        with self.assertRaises(ValueError): validate(library, build, source)

    def test_profile_target_matrix_requires_original_package_and_failure_gate(self):
        jobs = json.loads(Path(os.environ['RUNNER_NATIVE_WORKFLOW_JSON']).read_text())['jobs']
        consumer = jobs['native-supervisor-runtime']
        self.assertEqual(consumer['strategy']['matrix']['profile'], ['ci', 'release'])
        self.assertEqual(consumer['strategy']['matrix']['target'],
                         ['x86_64-unknown-linux-musl', 'aarch64-unknown-linux-musl'])
        self.assertEqual(consumer['timeout-minutes'], 15)
        self.assertEqual(consumer['permissions'], {'actions': 'read', 'contents': 'read'})
        self.assertNotIn('environment', consumer)
        self.assertIn('native-package', consumer['needs']); self.assertIn('native-release-package', consumer['needs'])
        steps = consumer['steps']
        self.assertTrue(any(s.get('with', {}).get('name') == 'native-runner-package-${{ matrix.profile }}-${{ matrix.target }}' for s in steps))
        self.assertFalse(any('cargo ' in s.get('run', '') or s.get('uses') == './.github/actions/setup-r2-sccache' for s in steps))
        gate = jobs['native-supervisor-gate']
        self.assertEqual(gate['if'], '${{ always() }}')
        self.assertTrue(any('unexpectedly skipped' in s.get('run', '') for s in gate['steps']))


if __name__ == '__main__':
    unittest.main()
