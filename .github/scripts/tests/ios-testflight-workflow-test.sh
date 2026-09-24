#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
workflow=$(yq -o=json '.' "$root/.github/workflows/release-please.yml")
# Exercise the release selector for iOS-only, mixed, and unrelated releases using
# the actual expression, then check the data handed to the publishing commands.
WORKFLOW_JSON="$workflow" python3 - <<'PY'
import json, os
workflow = json.loads(os.environ['WORKFLOW_JSON'])
job = workflow['jobs']['publish-ios-testflight']
condition = job['if'].removeprefix('${{').removesuffix('}}').strip()
for value, expected in [('true', True), ('false', False), ('', False)]:
    expression = condition.replace('needs.release-please.outputs.ios_release_created', repr(value))
    assert eval(expression, {'__builtins__': {}}, {}) is expected
assert job['environment'] == 'production'
assert job['runs-on'] == 'macos-26'
assert job['needs'] == 'release-please'
assert job['permissions'] == {'contents': 'read'}
assert job['steps'][0]['with']['ref'] == '${{ needs.release-please.outputs.release_target }}'
assert job['env']['IOS_VERSION'] == '${{ needs.release-please.outputs.ios_version }}'
commands = [step['run'] for step in job['steps'] if 'run' in step]
assert commands == ['node ios/scripts/testflight.mjs prepare', 'bash ios/scripts/release-testflight.sh', 'node ios/scripts/testflight.mjs distribute']
assert all(not step.get('continue-on-error', False) for step in job['steps'])
assert workflow['jobs']['refresh-release-pull-request']['permissions']['actions'] == 'write'
assert 'publish-ios-testflight' in workflow['jobs']['update-rollback-dashboard']['needs']
PY
# Fail before touching the keychain when release identity is wrong.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
if (cd "$root" && env -i PATH="$PATH" HOME="$HOME" RUNNER_TEMP="$work" bash ios/scripts/release-testflight.sh) >"$work/log" 2>&1; then
  echo 'Missing publishing credentials must fail' >&2
  exit 1
fi
grep -Fq 'IOS_VERSION is required' "$work/log"
echo 'ios-testflight-workflow-test: ok'
