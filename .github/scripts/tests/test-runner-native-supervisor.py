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
