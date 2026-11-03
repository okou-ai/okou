#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
# Exercise the release selector for iOS-only, mixed, and unrelated releases using
# the actual expression, then check the data handed to the publishing commands.
# Read the workflow inside Python: the serialized YAML may exceed Linux's
# per-argument environment size when passed as WORKFLOW_JSON.
python3 - "$root/.github/workflows/release-please.yml" "$root/.github/workflows/ios-archive-proof.yml" <<'PY'
import json, subprocess, sys
workflow = json.loads(subprocess.check_output(['yq', '-o=json', '.', sys.argv[1]], text=True))
job = workflow['jobs']['publish-ios-testflight']
condition = job['if'].removeprefix('${{').removesuffix('}}').strip()
for value, expected in [('true', True), ('false', False), ('', False)]:
    expression = condition.replace('needs.release-please.outputs.ios_release_created', repr(value))
    assert eval(expression, {'__builtins__': {}}, {}) is expected
assert job['environment'] == 'production'
assert job['needs'] == 'release-please'
assert job['permissions'] == {'contents': 'read', 'actions': 'read'}
steps = job['steps']
assert next(step for step in steps if 'uses' in step and step['uses'].startswith('actions/checkout'))['with']['ref'] == '${{ needs.release-please.outputs.release_target }}'
assert job['env']['IOS_VERSION'] == '${{ needs.release-please.outputs.ios_version }}'
commands = [step['run'] for step in steps if 'run' in step]
assert 'node ios/scripts/testflight.mjs prepare' in commands
assert 'bash ios/scripts/release-testflight.sh --archive "$IOS_ARCHIVE_DIR/Original.xcarchive"' in commands
assert 'node ios/scripts/testflight.mjs distribute' in commands
consume = next(step for step in steps if 'archive-promotion.py consume' in step.get('run', ''))
assert 'archive-promotion.py consume' in consume['run']
assert steps.index(consume) < steps.index(next(step for step in steps if step.get('id') == 'prepare'))
symbols = next(step for step in steps if 'upload-sentry-symbols.py' in step.get('run', ''))
assert symbols['env'] == {
    'SENTRY_AUTH_TOKEN': '${{ secrets.SENTRY_AUTH_TOKEN }}',
    'SENTRY_ORG': '${{ vars.SENTRY_ORG }}',
    'SENTRY_PROJECT': '${{ vars.SENTRY_PROJECT_IOS }}',
}
assert '"$IOS_ARCHIVE_DIR/Original.xcarchive"' in symbols['run']
assert steps.index(consume) < steps.index(symbols) < steps.index(next(step for step in steps if step.get('id') == 'prepare'))
assert 'continue-on-error' not in symbols
artifact_env = {
    'AWS_ACCESS_KEY_ID': '${{ secrets.R2_STATIC_ACCESS_KEY_ID }}',
    'AWS_SECRET_ACCESS_KEY': '${{ secrets.R2_STATIC_SECRET_ACCESS_KEY }}',
    'AWS_DEFAULT_REGION': 'auto',
    'R2_ACCOUNT_ID': '${{ vars.R2_ACCOUNT_ID }}',
    'R2_BUCKET_NAME': '${{ vars.R2_STATIC_BUCKET_NAME }}',
}
for key, value in artifact_env.items():
    assert consume['env'][key] == value
assert consume['env']['GH_TOKEN'] == '${{ github.token }}'
assert 'IOS_DISTRIBUTION' not in json.dumps(consume)
release_script = open(sys.argv[1].replace('.github/workflows/release-please.yml', 'ios/scripts/release-testflight.sh')).read()
assert '-resolvePackageDependencies' not in release_script
assert 'ci-test.sh' not in release_script
assert 'xcodebuild -exportArchive' in release_script
assert 'verify-export "$archive"' in release_script
assert 'codesign --verify --deep --strict' in release_script
assert all(not step.get('continue-on-error', False) for step in steps)
assert workflow['jobs']['refresh-release-pull-request']['permissions']['actions'] == 'write'
assert 'publish-ios-testflight' in workflow['jobs']['update-rollback-dashboard']['needs']

# The optional proof must never expose signing credentials to PR/branch code or upload builds.
proof = json.loads(subprocess.check_output(['yq', '-o=json', '.', sys.argv[2]], text=True))
assert proof['on']['workflow_dispatch']['inputs']['signing_export']['default'] is False
assert proof['permissions'] == {'contents': 'read'}
unsigned = proof['jobs']['unsigned-archive']
assert 'environment' not in unsigned
assert 'secrets.' not in json.dumps(unsigned)
export = proof['jobs']['distribution-export']
assert export['environment'] == 'production'
assert export['needs'] == 'unsigned-archive'
condition = export['if'].removeprefix('${{').removesuffix('}}').strip()
for event in ['pull_request', 'workflow_dispatch']:
    for ref in ['refs/heads/main', 'refs/heads/untrusted']:
        for enabled in [False, True]:
            expression = (condition.replace('github.event_name', repr(event))
                .replace('github.ref', repr(ref))
                .replace('inputs.signing_export', repr(enabled)).replace('&&', 'and'))
            expected = event == 'workflow_dispatch' and ref == 'refs/heads/main' and enabled
            assert eval(expression, {'__builtins__': {}}, {}) is expected
for job in [unsigned, export]:
    checkout = next(step for step in job['steps'] if step.get('uses', '').startswith('actions/checkout'))
    assert checkout['with']['ref'] == '${{ github.sha }}'
assert 'APP_STORE_CONNECT_API' not in json.dumps(proof)
verify = next(step for step in export['steps'] if '--verify-archive' in step.get('run', ''))
assert 'altool' not in json.dumps(proof)

# Native main-push work is absent; canonical publication is a required merge-group dependency.
ios_path = sys.argv[1].replace('release-please.yml', 'ios.yml')
ios = json.loads(subprocess.check_output(['yq', '-o=json', '.', ios_path], text=True))
assert 'publish-archive' in ios['jobs']['ci-gate-ios']['needs']
assert ios['jobs']['ci-gate-ios']['if'] == 'always()'
def selected(name, event, needed='true', release_only='false', evidence='skipped',
             run_tests='', sources='success', build='success', cancelled=False, **results):
    context = {
        'github.event_name': event,
        'needs.detect.outputs.needed': needed,
        'needs.detect.outputs.release-only': release_only,
        'needs.resolve-test-evidence.outputs.run-tests': run_tests,
    }
    statuses = dict.fromkeys(['detect', 'script-checks', 'test-packages', 'build-archive'], 'success')
    statuses.update({'resolve-test-evidence': evidence, 'prepare-package-sources': sources, 'build-test': build})
    statuses.update(results)
    context.update({f'needs.{job}.result': result for job, result in statuses.items()})
    condition = ios['jobs'][name]['if']
    # Jobs without an explicit status function retain Actions' success() default.
    if '!cancelled()' not in condition and 'always()' not in condition:
        needs = ios['jobs'][name]['needs']
        if any(statuses[job] != 'success' for job in ([needs] if isinstance(needs, str) else needs)):
            return False
    expression = condition.replace('!cancelled()', repr(not cancelled))
    for key, value in context.items():
        expression = expression.replace(key, repr(value))
    expression = expression.replace('&&', 'and').replace('||', 'or')
    return eval(expression, {'__builtins__': {}}, {})

for event in ['pull_request', 'merge_group', 'push', 'workflow_dispatch']:
    for needed in ['true', 'false']:
        simulator_needed = needed == 'true' and event != 'push'
        for name, expected in [
            ('resolve-test-evidence', False),
            ('prepare-package-sources', simulator_needed),
            ('test-packages', simulator_needed),
            ('build-test', simulator_needed),
            ('build-archive', needed == 'true' and event == 'merge_group'),
            ('publish-archive', needed == 'true' and event == 'merge_group'),
        ]:
            result = 'success' if simulator_needed else 'skipped'
            assert selected(name, event, needed, sources=result, build=result) is expected, (name, event, needed)

# A verified hit skips the entire simulator job while preserving archive publication.
# A missing record runs the simulator; failed or incomplete resolution blocks both paths.
for evidence_result, decision, run_simulator, publish in [
    ('success', 'false', False, True),
    ('success', 'true', True, True),
    ('success', '', False, False),
    ('failure', '', False, False),
    ('cancelled', '', False, False),
    ('skipped', '', False, False),
]:
    values = dict(event='merge_group', release_only='true', evidence=evidence_result,
                  run_tests=decision, sources='success' if run_simulator else 'skipped',
                  build='success' if run_simulator else 'skipped')
    assert selected('resolve-test-evidence', **values)
    for name in ['prepare-package-sources', 'build-test']:
        assert selected(name, **values) is run_simulator, (name, evidence_result, decision)
    assert selected('build-archive', **values)
    assert selected('test-packages', **values)
    assert selected('publish-archive', **values) is publish, (evidence_result, decision)

for producer in ['detect', 'script-checks', 'test-packages', 'build-archive', 'build-test']:
    for result in ['failure', 'cancelled', 'skipped']:
        assert not selected('publish-archive', 'merge_group', **{producer: result})
for result in ['failure', 'cancelled']:
    assert not selected('publish-archive', 'merge_group', evidence=result)
assert not selected('publish-archive', 'merge_group', evidence='success', run_tests='false', build='success')
assert not selected('build-test', 'merge_group', sources='failure')
assert not selected('publish-archive', 'merge_group', cancelled=True)
for name in ['resolve-test-evidence', 'prepare-package-sources', 'test-packages', 'build-test', 'build-archive', 'publish-archive']:
    assert 'environment' not in ios['jobs'][name]
    assert 'IOS_DISTRIBUTION' not in json.dumps(ios['jobs'][name])
    assert 'APP_STORE_CONNECT_API' not in json.dumps(ios['jobs'][name])
native = ios['jobs']['build-test']['steps']
evidence = next(step for step in ios['jobs']['resolve-test-evidence']['steps'] if step.get('id') == 'evidence')
for env in [evidence['env'], ios['jobs']['publish-archive']['env']]:
    for key, value in artifact_env.items():
        assert env[key] == value
test_job = ios['jobs']['build-test']
archive_job = ios['jobs']['build-archive']
package_job = ios['jobs']['test-packages']
assert test_job['needs'] == ['detect', 'prepare-package-sources']
assert archive_job['needs'] == package_job['needs'] == 'detect'
source_upload = next(step for step in ios['jobs']['prepare-package-sources']['steps'] if step.get('uses', '').startswith('actions/upload-artifact'))['with']
source_download = next(step for step in native if step.get('uses', '').startswith('actions/download-artifact'))['with']
for upload_attempt, download_attempt in [(1, 1), (1, 2), (2, 2)]:
    uploaded = source_upload['name'].replace('${{ github.run_attempt }}', str(upload_attempt))
    downloaded = source_download['name'].replace('${{ github.run_attempt }}', str(download_attempt))
    assert uploaded == downloaded
assert source_upload['overwrite'] is True
assert test_job['env']['IOS_BUILD_CACHE_ENABLED'] == 'true'
assert archive_job['env']['IOS_ARCHIVE_CACHE_ENABLED'] == 'true'
assert {key: value for key, value in test_job['env'].items() if key not in {'IOS_BUILD_CACHE_ENABLED', 'IOS_XCODE_STARTUP_SAMPLING'}} == {key: value for key, value in archive_job['env'].items() if key != 'IOS_ARCHIVE_CACHE_ENABLED'} == package_job['env']
# Startup observations are confined to explicit manual runs, not native release evidence.
assert ios['on']['workflow_dispatch']['inputs']['sample_xcode_startup']['default'] is False
sampling = test_job['env']['IOS_XCODE_STARTUP_SAMPLING'].removeprefix('${{').removesuffix('}}').strip()
upload = next(step for step in native if step.get('name') == 'Upload Xcode startup observations')
for event in ['pull_request', 'merge_group', 'push', 'workflow_dispatch']:
    for enabled in [False, True]:
        def evaluate(condition):
            expression = (condition.replace('github.event_name', repr(event))
                .replace('inputs.sample_xcode_startup', repr(enabled))
                .replace('always()', 'True').replace('&&', 'and').replace('||', 'or'))
            return eval(expression, {'__builtins__': {}}, {})
        expected = event == 'workflow_dispatch' and enabled
        assert evaluate(sampling) == ('true' if expected else 'false')
        assert evaluate(upload['if']) is expected
assert 'script-checks' in ios['jobs']['ci-gate-ios']['needs']
assert 'test-packages' in ios['jobs']['ci-gate-ios']['needs']
gate = ios['jobs']['ci-gate-ios']['steps'][-1]
assert gate['env']['PACKAGES_RESULT'] == '${{ needs.test-packages.result }}'
assert gate['env']['SCRIPT_CHECKS_RESULT'] == '${{ needs.script-checks.result }}'
assert 'build-archive' in ios['jobs']['ci-gate-ios']['needs']
archive = next(step for step in archive_job['steps'] if 'build-archive.sh' in step.get('run', ''))
assert 'build-archive.sh' in archive['run']
PY
# Fail before touching the keychain when release identity is wrong.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
if (cd "$root" && env -i PATH="$PATH" HOME="$HOME" RUNNER_TEMP="$work" bash ios/scripts/release-testflight.sh --archive "$work/missing.xcarchive") >"$work/log" 2>&1; then
  echo 'Missing publishing credentials must fail' >&2
  exit 1
fi
grep -Fq 'IOS_VERSION is required' "$work/log"
if (cd "$root" && bash ios/scripts/release-testflight.sh) >"$work/log" 2>&1; then
  echo 'Publishing without an explicit canonical archive must fail' >&2
  exit 1
fi
grep -Fq 'usage: release-testflight.sh' "$work/log"
echo 'ios-testflight-workflow-test: ok'
