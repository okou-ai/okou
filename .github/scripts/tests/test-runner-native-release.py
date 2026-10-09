#!/usr/bin/env python3
"""Pre-merge release graph/input regressions, not compiler/native evidence."""
import importlib.util
import json
import os
import pathlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[3]


def workflow_jobs():
    # Existing workflow-test yq owns YAML parsing; this suite needs no new module.
    return json.loads(pathlib.Path(os.environ['RUNNER_NATIVE_WORKFLOW_JSON']).read_text())['jobs']


class ReleaseConsumerGraph(unittest.TestCase):
    def test_both_premerge_release_targets_have_owned_producer_and_native_consumer(self):
        jobs = workflow_jobs()
        producer = jobs['native-release-build']
        self.assertEqual(producer['timeout-minutes'], 25)
        # Compare the actual two producer boundaries, not two independently
        # updated image literals. Their ci helper bytes must remain identical.
        self.assertEqual(producer['container']['image'], jobs['compile']['container']['image'])
        self.assertEqual(producer['env']['RUNNER_RELEASE_TOOLCHAIN_IMAGE'],
                         jobs['compile']['env']['RUNNER_BINARY_ACTUAL_TOOLCHAIN_IMAGE'])
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

    def test_native_consumers_share_event_source_with_the_actual_runner(self):
        jobs = workflow_jobs()
        build_revision = '${{ needs.prepare.outputs.head-sha }}'
        self.assertEqual(jobs['compile']['env']['RUNNER_BINARY_GIT_REVISION'], build_revision)
        self.assertEqual(jobs['prepare']['outputs']['producer-head-sha'],
                         '${{ steps.identity.outputs.producer-head-sha }}')
        self.assertEqual(jobs['prepare']['outputs']['head-sha'],
                         '${{ steps.identity.outputs.head-sha }}')
        identity = next(s for s in jobs['prepare']['steps'] if s.get('id') == 'identity')
        self.assertEqual(identity['env']['HEAD_SHA'], '${{ github.sha }}')
        self.assertEqual(identity['env']['PRODUCER_HEAD_SHA'],
                         '${{ github.event.pull_request.head.sha || github.sha }}')
        for name in ('native-package', 'native-release-build', 'native-release-package',
                     'native-supervisor-runtime'):
            with self.subTest(job=name):
                checkouts = [s for s in jobs[name]['steps']
                             if s.get('uses', '').startswith('actions/checkout@')]
                self.assertEqual(len(checkouts), 1)
                self.assertEqual(checkouts[0]['with']['ref'], build_revision)
        digest = next(s for s in jobs['native-package']['steps'] if s.get('id') == 'binary-input')
        self.assertEqual(digest['env']['RUNNER_BINARY_GIT_REVISION'], build_revision)
        for name in ('native-release-build', 'native-supervisor-runtime'):
            self.assertEqual(jobs[name]['env']['SOURCE_SHA'], build_revision)
        validation = next(s for s in jobs['native-release-package']['steps']
                          if s.get('name') == 'Validate original release compiler/source/profile/target before execution')
        self.assertIn('--source-sha "' + build_revision + '"', validation['run'])

    def test_release_image_admission_uses_the_canonical_runner_contract(self):
        path = ROOT / '.github/scripts/runner-native-release.py'
        spec = importlib.util.spec_from_file_location('native_release_image', path)
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        canonical = subprocess.check_output(
            ['bash', '-eu', '-c', '. "$1"; printf %s "$RUNNER_BINARY_TOOLCHAIN_IMAGE"',
             'contract', str(ROOT / '.github/scripts/runner-binary-build/contract.env')],
            env={'PATH': os.defpath, 'GITHUB_REPOSITORY_OWNER': 'okou-ai'}, text=True)
        # The correct image advances to the real source-HEAD gate; a stale or
        # unrelated image must refuse before Git/CLI/compiler input admission.
        with self.assertRaisesRegex(ValueError, 'release source HEAD mismatch'):
            module.prepare(ROOT / 'crates/target/unused-release-input', '0' * 40,
                           'x86_64-unknown-linux-musl', canonical)
        for image in ('ghcr.io/okou-ai/vm0-toolchain-rust:20260825', 'unselected-image'):
            with self.subTest(image=image), self.assertRaisesRegex(ValueError, 'release toolchain or target mismatch'):
                module.prepare(ROOT / 'crates/target/unused-release-input', '0' * 40,
                               'x86_64-unknown-linux-musl', image)

    def test_workflow_resolves_the_selected_head_not_the_checkout_recipe(self):
        jobs = workflow_jobs()
        self.assertEqual(jobs['prepare']['outputs']['runner-toolchain-image'], '${{ steps.toolchain.outputs.image }}')
        step = next(s for s in jobs['prepare']['steps'] if s.get('id') == 'toolchain')
        self.assertEqual(step['shell'], 'bash')
        self.assertEqual(step['if'], "steps.identity.outputs.release-skip != 'true'")
        self.assertEqual(step['env']['SOURCE_SHA'], '${{ steps.identity.outputs.head-sha }}')
        for job, field in (('compile', 'RUNNER_BINARY_ACTUAL_TOOLCHAIN_IMAGE'),
                           ('native-release-build', 'RUNNER_RELEASE_TOOLCHAIN_IMAGE')):
            self.assertEqual(jobs[job]['container']['image'], '${{ needs.prepare.outputs.runner-toolchain-image }}')
            self.assertEqual(jobs[job]['env'][field], jobs[job]['container']['image'])
        original = (ROOT / '.github/scripts/runner-binary-build/contract.env').read_text()
        image = subprocess.check_output(
            ['bash', '-eu', '-c', '. "$1"; printf %s "$RUNNER_BINARY_TOOLCHAIN_IMAGE"',
             'contract', str(ROOT / '.github/scripts/runner-binary-build/contract.env')],
            env={'PATH': os.defpath, 'GITHUB_REPOSITORY_OWNER': 'okou-ai'}, text=True)
        future = image.rsplit(':', 1)[0] + ':regression-fixture'
        assignment = next(line for line in original.splitlines() if line.startswith('RUNNER_BINARY_TOOLCHAIN_IMAGE='))
        with tempfile.TemporaryDirectory(dir=ROOT / 'crates/target') as directory:
            repo = pathlib.Path(directory) / 'repo'; repo.mkdir()
            contract = repo / '.github/scripts/runner-binary-build/contract.env'
            contract.parent.mkdir(parents=True)
            subprocess.run(['git', 'init', '-q', str(repo)], check=True)
            heads = []
            future_assignment = assignment.rsplit(':', 1)[0] + ':regression-fixture'
            for content in (original, original.replace(assignment, future_assignment)):
                contract.write_text(content)
                subprocess.run(['git', '-C', str(repo), 'add', '.'], check=True)
                subprocess.run(['git', '-C', str(repo), '-c', 'user.name=Fixture',
                                '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'recipe'], check=True)
                heads.append(subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip())
            output = pathlib.Path(directory) / 'github-output'
            # HEAD/checkout remains the future recipe while both original and
            # future selected commits execute through the actual workflow step.
            for head, expected in zip(heads, (image, future)):
                for owner in ('okou-ai', 'fixture-owner'):
                    with self.subTest(head=head, owner=owner):
                        output.write_text('')
                        result = subprocess.run(['bash', '-e', '-o', 'pipefail', '-c', step['run']], cwd=repo,
                                                env={'PATH': os.defpath, 'SOURCE_SHA': head, 'GITHUB_OUTPUT': str(output),
                                                     'RUNNER_TEMP': directory, 'GITHUB_REPOSITORY_OWNER': owner},
                                                capture_output=True, text=True)
                        self.assertEqual(result.returncode, 0, result.stderr)
                        owned_image = expected.replace('ghcr.io/okou-ai/', 'ghcr.io/' + owner + '/')
                        self.assertEqual(output.read_text(), 'image=' + owned_image + '\n')
                        self.assertEqual(list(pathlib.Path(directory).glob('runner-toolchain.*')), [])
            output.write_text('')
            result = subprocess.run(['bash', '-e', '-o', 'pipefail', '-c', step['run']], cwd=repo,
                                    env={'PATH': os.defpath, 'SOURCE_SHA': '0' * 40, 'GITHUB_OUTPUT': str(output),
                                         'RUNNER_TEMP': directory, 'GITHUB_REPOSITORY_OWNER': 'okou-ai'},
                                    capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(output.read_text(), '')  # no checkout or latest fallback
            self.assertEqual(list(pathlib.Path(directory).glob('runner-toolchain.*')), [])

    def test_both_context_validators_follow_recipe_changes_without_ambient_startup(self):
        original = (ROOT / '.github/scripts/runner-binary-build/contract.env').read_text()
        assignment = next(line for line in original.splitlines() if line.startswith('RUNNER_BINARY_TOOLCHAIN_IMAGE='))
        with tempfile.TemporaryDirectory(dir=ROOT / 'crates/target') as directory:
            root = pathlib.Path(directory)
            contract = root / '.github/scripts/runner-binary-build/contract.env'
            contract.parent.mkdir(parents=True)
            startup = root / 'ambient-bash'; startup.write_text('echo unselected-startup; exit 9\n')
            for name in ('runner-native-release.py', 'runner-native-supervisor.py'):
                spec = importlib.util.spec_from_file_location('native_contract', ROOT / '.github/scripts' / name)
                module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); module.ROOT = root
                contract.write_text(original)
                image = module.toolchain_image()
                future = image.rsplit(':', 1)[0] + ':regression-fixture'
                contract.write_text(original.replace(assignment, 'RUNNER_BINARY_TOOLCHAIN_IMAGE=' + future))
                with patch.dict(os.environ, {'BASH_ENV': str(startup), 'GITHUB_REPOSITORY_OWNER': 'unselected-owner'}):
                    self.assertEqual(module.toolchain_image(), future)
                contract.unlink(); contract.symlink_to(startup)
                with self.assertRaises(ValueError): module.toolchain_image()
                contract.unlink()
        spec = importlib.util.spec_from_file_location('native_input_contract', ROOT / '.github/scripts/runner-native-release.py')
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        self.assertIn('.github/scripts/runner-binary-build/contract.env', module.INPUTS)

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
