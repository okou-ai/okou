#!/usr/bin/env python3
"""Pre-merge release graph/input regressions, not compiler/native evidence."""
import importlib.util
import json
import os
import pathlib
import subprocess
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[3]


def workflow_jobs():
    # Existing workflow-test yq owns YAML parsing; this suite needs no new module.
    return json.loads(pathlib.Path(os.environ['RUNNER_NATIVE_WORKFLOW_JSON']).read_text())['jobs']


class ReleaseConsumerGraph(unittest.TestCase):
    def test_both_premerge_release_targets_have_owned_producer_and_native_consumer(self):
        jobs = workflow_jobs()
        producer = jobs['native-release-build']
        self.assertEqual(producer['timeout-minutes'], 25)
        self.assertEqual(producer['container']['image'],
                         'ghcr.io/${{ github.repository_owner }}/vm0-toolchain-rust:20260825')
        self.assertNotIn('environment', producer)
        self.assertEqual(producer['permissions'], {'actions': 'read', 'contents': 'read'})
        self.assertEqual(producer['needs'], ['prepare'])
        self.assertIn('current-runner-image-needed', producer['if'])
        steps = producer['steps']
        self.assertTrue(any(s.get('run') == 'bash .github/scripts/build-runner-native-release.sh' for s in steps))
        self.assertFalse(any('release-please' in str(s) or 'gh release' in str(s) for s in steps))
        consumer = jobs['native-release-package']
        self.assertEqual(consumer['timeout-minutes'], 15)
        self.assertEqual(consumer['needs'], ['prepare', 'native-release-build'])
        self.assertIn("needs.native-release-build.result == 'success'", consumer['if'])
        self.assertEqual(consumer['runs-on'],
                         "${{ matrix.id == 'arm64' && 'ubuntu-24.04-arm' || 'ubuntu-latest' }}")
        self.assertTrue(any('--profile release' in s.get('run', '')
                            and '--compiler-receipt' in s.get('run', '')
                            for s in consumer['steps']))
        self.assertTrue(any(s.get('with', {}).get('if-no-files-found') == 'error'
                            for s in consumer['steps']))

    def test_native_ci_job_requires_native_preinstalled_aws_without_x86_installer(self):
        job = workflow_jobs()['native-package']
        self.assertFalse(any(s.get('uses') == './.github/actions/setup-aws-cli' for s in job['steps']))
        self.assertTrue(any(s.get('run') == 'aws --version' for s in job['steps']))

    def test_compiler_contract_rejects_nonrelease_flags_and_incomplete_build(self):
        path = ROOT / '.github/scripts/runner-native-release.py'
        spec = importlib.util.spec_from_file_location('native_release', path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        # Inert parser records. No executable/helper is constructed or launched.
        profile = {'opt_level': '3', 'debug_assertions': False, 'test': False}
        event = {'reason': 'compiler-artifact', 'target': {'name': 'runner', 'kind': ['bin']},
                 'executable': '/owned/release/runner', 'profile': profile}
        self.assertEqual(module.runner_artifact([event, {'reason': 'build-finished', 'success': True}])['executable'],
                         '/owned/release/runner')
        for events in ([event], [event, {'reason': 'build-finished', 'success': False}],
                       [event, event, {'reason': 'build-finished', 'success': True}]):
            with self.subTest(events=events), self.assertRaises(ValueError):
                module.runner_artifact(events)
        for field, value in (('opt_level', '0'), ('debug_assertions', True), ('test', True)):
            changed = json.loads(json.dumps(event)); changed['profile'][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                module.runner_artifact([changed, {'reason': 'build-finished', 'success': True}])

    def test_release_profile_is_full_lto_not_an_override_of_ci_contract(self):
        path = ROOT / '.github/scripts/runner-native-release.py'
        spec = importlib.util.spec_from_file_location('native_release_contract', path)
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        self.assertEqual(module.release_contract(), {'lto': True, 'strip': True, 'codegen-units': 1})
        self.assertIn('RUNNER_BINARY_PROFILE=ci',
                      (ROOT / '.github/scripts/runner-binary-build/contract.env').read_text())

    def test_producer_fails_before_build_when_same_head_inputs_are_absent(self):
        completed = subprocess.run(['bash', str(ROOT / '.github/scripts/build-runner-native-release.sh')],
                                   cwd=ROOT, env={'PATH': '/usr/bin:/bin'}, capture_output=True)
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn(b'missing release source SHA', completed.stderr)


if __name__ == '__main__':
    unittest.main()
