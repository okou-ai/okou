#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
python3 - "$root" <<'PY'
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

root = Path(sys.argv[1])
workflow = json.loads(subprocess.check_output(
    ['yq', '-o=json', '.', str(root / '.github/workflows/release-please.yml')], text=True))
jobs = workflow['jobs']
release = jobs['release-please']
job = jobs['publish-android']
condition = job['if'].removeprefix('${{').removesuffix('}}').strip()
for value, expected in [('true', True), ('false', False), ('', False)]:
    expression = condition.replace('needs.release-please.outputs.android_release_created', repr(value))
    assert eval(expression, {'__builtins__': {}}, {}) is expected
checkout = next(step for step in job['steps'] if step.get('uses', '').startswith('actions/checkout'))
assert checkout['with']['ref'] == '${{ needs.release-please.outputs.release_target }}'
assert checkout['with']['persist-credentials'] is False
assert job['environment'] == 'production'
assert job['permissions'] == {'contents': 'write'}
assert not any('artifact' in step.get('uses', '') for step in job['steps'])
sign = next(step for step in job['steps'] if 'ANDROID_RELEASE_KEYSTORE_BASE64' in step.get('env', {}))
assert sign['env'] == {
    'ANDROID_RELEASE_KEYSTORE_BASE64': '${{ secrets.ANDROID_RELEASE_KEYSTORE_BASE64 }}',
    'ANDROID_RELEASE_KEYSTORE_PASSWORD': '${{ secrets.ANDROID_RELEASE_KEYSTORE_PASSWORD }}',
    'ANDROID_RELEASE_KEY_ALIAS': '${{ vars.ANDROID_RELEASE_KEY_ALIAS }}',
}
assert not sign.get('continue-on-error', False)
for step in job['steps']:
    if step is not sign:
        assert 'secrets.ANDROID_RELEASE_' not in json.dumps(step)
assert job['env']['ANDROID_VERSION'] == '${{ needs.release-please.outputs.android_version }}'
assert job['env']['ANDROID_TAG'] == '${{ needs.release-please.outputs.android_tag }}'
for output, suffix in [('android_version', 'version'), ('android_tag', 'tag_name'),
                       ('android_release_created', 'release_created')]:
    assert release['outputs'][output] == "${{ steps.release.outputs['android--" + suffix + "'] }}"
assert 'publish-android' in jobs['update-rollback-dashboard']['needs']
publish = next(step for step in job['steps'] if step.get('name') == 'Publish APK on the Android Release')
assert not publish.get('continue-on-error', False)

# Exercise the actual publication step with GitHub at its external CLI boundary.
with tempfile.TemporaryDirectory() as temp:
    work = Path(temp)
    binary = work / 'gh'
    binary.write_text('''#!/usr/bin/env python3
import os
from pathlib import Path
import sys
args = sys.argv[1:]
root = Path(os.environ['RUNNER_TEMP'])
if args[0] == 'api':
    assert args[1] == 'repos/okou-ai/okou/commits/android-v0.2.0'
    if os.environ.get('FAIL_LOOKUP') == 'true':
        sys.exit(17)
    print(os.environ.get('TAG_SOURCE', 'a' * 40))
elif args[:2] == ['release', 'upload']:
    assert args[2] == 'android-v0.2.0'
    assert Path(args[3]).read_bytes() == b'fixture-apk'
    assert '--clobber' not in args
    if os.environ.get('FAIL_UPLOAD') == 'true':
        sys.exit(23)
    with (root / 'uploaded').open('x') as output:
        output.write(args[2])
else:
    raise AssertionError(args)
''')
    binary.chmod(0o755)
    apk_dir = work / 'android-release'
    apk_dir.mkdir()
    (apk_dir / 'okou-android-0.2.0.apk').write_bytes(b'fixture-apk')
    env = dict(os.environ, PATH=str(work) + os.pathsep + os.environ['PATH'],
               RUNNER_TEMP=str(work), GITHUB_REPOSITORY='okou-ai/okou',
               ANDROID_VERSION='0.2.0', ANDROID_TAG='android-v0.2.0',
               ANDROID_RELEASE_SOURCE_SHA='a' * 40)
    def run(**overrides):
        return subprocess.run(['bash', '-e', '-c', publish['run']], env=env | overrides,
                              text=True, capture_output=True)
    result = run()
    assert result.returncode == 0, result.stderr
    assert (work / 'uploaded').read_text() == 'android-v0.2.0'
    result = run()
    assert result.returncode != 0
    assert (work / 'uploaded').read_text() == 'android-v0.2.0'
    (work / 'uploaded').unlink()
    result = run(FAIL_UPLOAD='true')
    assert result.returncode == 23, result.stderr
    assert not (work / 'uploaded').exists()
    result = run(ANDROID_TAG='android-v0.3.0')
    assert result.returncode != 0
    assert not (work / 'uploaded').exists()
    result = run(TAG_SOURCE='b' * 40)
    assert result.returncode != 0
    assert not (work / 'uploaded').exists()
    result = run(FAIL_LOOKUP='true')
    assert result.returncode == 17, result.stderr
    assert not (work / 'uploaded').exists()

print('Android release selection, publication and failure propagation: ok')
PY
