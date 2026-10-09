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
assert job['runs-on'] == 'macos-26'
assert job['needs'] == 'release-please'
assert job['permissions'] == {'contents': 'read', 'actions': 'read'}
steps = job['steps']
start = next(step for step in steps if step.get('name') == 'Notify Slack - Starting')
success = next(step for step in steps if step.get('name') == 'Notify Slack - Success')
failure = next(step for step in steps if step.get('name') == 'Notify Slack - Failure')
assert steps.index(start) < steps.index(next(step for step in steps if step.get('id') == 'prepare'))
assert steps.index(success) > steps.index(next(step for step in steps if step.get('run') == 'node ios/scripts/testflight.mjs distribute'))
assert steps.index(failure) > steps.index(success)
assert start['if'] == "${{ vars.SLACK_RELEASE_CHANNEL_ID != '' }}"
assert start['with']['method'] == 'chat.postMessage'
assert success['with']['method'] == failure['with']['method'] == 'chat.update'
for step in [start, success, failure]:
    assert step['with']['token'] == '${{ secrets.CI_SLACK_BOT_TOKEN }}'
    assert 'channel: ${{ vars.SLACK_RELEASE_CHANNEL_ID }}' in step['with']['payload']
    assert '/actions/runs/${{ github.run_id }}' in step['with']['payload']
assert 'success()' in success['if'] and 'steps.slack-start.outputs.ts' in success['if']
assert 'failure()' in failure['if'] and 'steps.slack-start.outputs.ts' in failure['if']
assert '${{ steps.prepare.outputs.build_number }}' in success['with']['payload']
assert '${{ vars.IOS_INTERNAL_GROUP_NAME }}' in success['with']['payload']
assert next(step for step in steps if 'uses' in step and step['uses'].startswith('actions/checkout'))['with']['ref'] == '${{ needs.release-please.outputs.release_target }}'
assert job['env']['IOS_VERSION'] == '${{ needs.release-please.outputs.ios_version }}'
commands = [step['run'] for step in steps if 'run' in step]
assert 'node ios/scripts/testflight.mjs prepare' in commands
assert 'bash ios/scripts/release-testflight.sh --archive "$IOS_ARCHIVE_DIR/Original.xcarchive"' in commands
assert 'node ios/scripts/testflight.mjs distribute' in commands
consume = next(step for step in steps if step.get('name') == 'Resolve and verify exact release archive')
assert 'archive-promotion.py consume' in consume['run']
assert steps.index(consume) < steps.index(next(step for step in steps if step.get('id') == 'prepare'))
assert consume['env']['R2_BUCKET_NAME'] == 'user-artifact-private-dev'
assert consume['env']['GH_TOKEN'] == '${{ github.token }}'
assert 'IOS_DISTRIBUTION' not in json.dumps(consume)
assert job['env']['IOS_TEST_DESTINATION'] == 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.2'
release_script = open(sys.argv[1].replace('.github/workflows/release-please.yml', 'ios/scripts/release-testflight.sh')).read()
assert '-resolvePackageDependencies' not in release_script
assert 'ci-test.sh' not in release_script
assert len([line for line in release_script.splitlines() if line.startswith('xcodebuild ')]) == 1
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
assert verify['env']['IOS_BUILD_NUMBER'] == '9999'
assert 'altool' not in json.dumps(proof)

# Native main-push work is absent; canonical publication is a required merge-group dependency.
ios_path = sys.argv[1].replace('release-please.yml', 'ios.yml')
ios = json.loads(subprocess.check_output(['yq', '-o=json', '.', ios_path], text=True))
assert 'publish-archive' in ios['jobs']['ci-gate-ios']['needs']
assert ios['jobs']['ci-gate-ios']['if'] == 'always()'
for event in ['pull_request', 'merge_group', 'push', 'workflow_dispatch']:
    for needed in ['true', 'false']:
        for name, expected in [
            ('build-test', needed == 'true' and event != 'push'),
            ('publish-archive', needed == 'true' and event == 'merge_group'),
        ]:
            condition = ios['jobs'][name]['if']
            expression = (condition.replace('needs.detect.outputs.needed', repr(needed))
                .replace('github.event_name', repr(event)).replace('&&', 'and'))
            assert eval(expression, {'__builtins__': {}}, {}) is expected
for name in ['build-test', 'publish-archive']:
    assert 'environment' not in ios['jobs'][name]
    assert 'IOS_DISTRIBUTION' not in json.dumps(ios['jobs'][name])
    assert 'APP_STORE_CONNECT_API' not in json.dumps(ios['jobs'][name])
native = ios['jobs']['build-test']['steps']
simulator = next(step for step in native if step.get('name') == 'Build app and run isolated simulator tests')
assert "steps.evidence.outputs.run_tests == 'true'" in simulator['if']
archive = next(step for step in native if step.get('name') == 'Build unsigned device Release archive')
assert archive['if'] == "github.event_name == 'merge_group'"
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
