#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
python3 - "$root" <<'PY'
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import zipfile

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
assert checkout['with']['fetch-depth'] == 1
assert job['env']['ANDROID_RELEASE_SOURCE_SHA'] == checkout['with']['ref']
history, = (step for step in job['steps'] if step.get('name') == 'Fetch complete history for the release source')
publisher, = (step for step in job['steps'] if 'SENTRY_DSN_ANDROID' in step.get('env', {}))
assert job['steps'].index(checkout) < job['steps'].index(history) < job['steps'].index(publisher)

with tempfile.TemporaryDirectory() as temp:
    origin = Path(temp) / 'origin'
    source = Path(temp) / 'source'

    def git(directory, *args):
        return subprocess.check_output(['git', '-C', str(directory), *args], text=True).strip()

    origin.mkdir()
    git(origin, 'init', '-q', '--initial-branch=main')
    git(origin, 'config', 'uploadpack.allowFilter', 'true')
    for message in ('ancestor', 'release', 'later push'):
        git(origin, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com',
            'commit', '-q', '--allow-empty', '-m', message)
    release_sha = git(origin, 'rev-parse', 'HEAD^')
    git(origin, 'tag', 'later-tag')
    source.mkdir()
    git(source, 'init', '-q')
    git(source, 'remote', 'add', 'origin', origin.as_uri())
    git(source, 'fetch', '-q', '--depth=1', '--no-tags', 'origin', release_sha)
    git(source, 'switch', '-q', '--detach', release_sha)
    subprocess.run(['bash', '-ec', history['run']], cwd=source, check=True,
                   env=dict(os.environ, ANDROID_RELEASE_SOURCE_SHA=release_sha, GITHUB_SHA='invalid'))
    assert git(source, 'rev-parse', 'HEAD') == release_sha
    assert git(source, 'rev-parse', '--is-shallow-repository') == 'false'
    assert git(source, 'rev-list', '--count', 'HEAD') == '2'
    assert git(source, 'for-each-ref', 'refs/remotes', 'refs/tags') == ''

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

# Execute the shared release action and Android's aggregate gate as Actions does.
android = json.loads(subprocess.check_output(
    ['yq', '-o=json', 'explode(.)', str(root / '.github/workflows/android.yml')], text=True))['jobs']
smoke, = (step for step in android['release-smoke']['steps'] if step.get('id') == 'release-smoke')
assert smoke['env']['SENTRY_DSN_ANDROID'] == publisher['env']['SENTRY_DSN_ANDROID']
screenshots = json.loads(subprocess.check_output(
    ['yq', '-o=json', '.', str(root / '.github/workflows/android-screenshots.yml')], text=True))['jobs']['capture']

# A path or pin mismatch changes the Actions cache version even when the key matches.
restores = []
for consumer in (android['build-test'], android['instrumentation'], android['release-smoke'], screenshots, job):
    setup, = (step for step in consumer['steps'] if step.get('uses', '').startswith('gradle/actions/setup-gradle@'))
    assert setup['with']['cache-provider'] == 'external'
    restore, = (step for step in consumer['steps'] if step.get('uses', '').startswith('actions/cache/restore@'))
    restores.append((restore['uses'], restore['with']))
    saves = [step for step in consumer['steps'] if step.get('uses', '').startswith('actions/cache/save@')]
    if consumer is android['instrumentation']:
        save, = saves
        assert save['with']['path'] == restore['with']['path']
        assert save['with']['key'] == '${{ steps.' + restore['id'] + '.outputs.cache-primary-key }}'
        assert "github.event_name == 'push' && github.ref == 'refs/heads/main'" in save['if']
    else:
        assert not saves
assert all(spec == restores[0] for spec in restores)
action = json.loads(subprocess.check_output(
    ['yq', '-o=json', '.', str(root / '.github/actions/detect-release/action.yml')], text=True))
classify = action['runs']['steps'][0]['run']
gate = android['ci-gate-android']['steps'][0]['run']
assert android['detect-release']['permissions']['pull-requests'] == 'read'
assert android['detect']['needs'] == ['detect-release']
assert android['detect']['outputs']['shallow-discovery'] == '${{ steps.changes.outputs.shallow-discovery }}'
build_steps = android['build-test']['steps']
shallow = next(step for step in build_steps if step.get('name') == 'Verify dependency discovery with shallow history')
history = next(step for step in build_steps if step.get('name') == 'Fetch complete history for versioned builds')
assert shallow['if'] == "needs.detect.outputs.shallow-discovery == 'true'"
assert 'if' not in history
assert build_steps.index(shallow) < build_steps.index(history)
assert 'detect-release' in android['ci-gate-android']['needs']
assert android['ci-gate-android']['if'] == 'always()'
for native in ['build-test', 'instrumentation', 'release-smoke']:
    assert android[native]['needs'] == 'detect'
retrace = android['retrace-failure']
assert retrace['needs'] == 'release-smoke'
assert '!cancelled()' in retrace['if']
assert "needs.release-smoke.result == 'failure'" in retrace['if']
assert 'retrace-failure' not in android['ci-gate-android']['needs']
download, = (step for step in retrace['steps'] if step.get('uses', '').startswith('actions/download-artifact@'))
assert download['with']['artifact-ids'] == '${{ needs.release-smoke.outputs.retrace-artifact-id }}'

with tempfile.TemporaryDirectory() as temp:
    work = Path(temp)
    gh = work / 'gh'
    gh.write_text('''#!/usr/bin/env python3
import os
import sys
assert sys.argv[1:] == ['pr', 'view', '47986', '--repo', 'okou-ai/okou',
                        '--json', 'headRefName', '--jq', '.headRefName']
if os.environ.get('FAIL_LOOKUP') == 'true':
    sys.exit(23)
print(os.environ['QUEUED_BRANCH'])
''')
    gh.chmod(0o755)
    env = dict(os.environ, PATH=str(work) + os.pathsep + os.environ['PATH'],
               HEAD_REF='', COMMIT_MSG='', MQ_HEAD_REF='', REPO='okou-ai/okou',
               QUEUED_BRANCH='feature/android', FAIL_LOOKUP='false',
               GITHUB_OUTPUT=str(work / 'output'))

    def execute(script, values):
        return subprocess.run(['bash', '--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script],
                              env=env | values, text=True, capture_output=True)

    queued = 'refs/heads/gh-readonly-queue/main/pr-47986-0123456789abcdef'
    for event, values, expected in [
        ('pull_request', {'HEAD_REF': 'release-please--branches--main'}, 'true'),
        ('pull_request', {'HEAD_REF': 'feature/android'}, 'false'),
        ('pull_request', {'HEAD_REF': 'release-please-imitation'}, 'false'),
        ('push', {'COMMIT_MSG': 'chore: release main (#47986)'}, 'true'),
        ('push', {'COMMIT_MSG': 'feat(android): update chat'}, 'false'),
        ('merge_group', {'MQ_HEAD_REF': queued, 'QUEUED_BRANCH': 'release-please--branches--main'}, 'true'),
        ('merge_group', {'MQ_HEAD_REF': queued}, 'false'),
        ('workflow_dispatch', {}, 'false'),
    ]:
        Path(env['GITHUB_OUTPUT']).write_text('')
        result = execute(classify, values | {'EVENT_NAME': event})
        assert result.returncode == 0, result.stderr
        decision = Path(env['GITHUB_OUTPUT']).read_text().strip()
        assert decision == 'skip=' + expected, (event, decision)
        condition = android['detect']['if'].replace('needs.detect-release.outputs.skip', repr(expected))
        assert eval(condition, {'__builtins__': {}}, {}) is (expected == 'false')
    Path(env['GITHUB_OUTPUT']).write_text('')
    failed = execute(classify, {'EVENT_NAME': 'merge_group', 'MQ_HEAD_REF': queued, 'FAIL_LOOKUP': 'true'})
    assert failed.returncode == 0, failed.stderr
    assert Path(env['GITHUB_OUTPUT']).read_text().splitlines() == ['lookup-failed=true', 'skip=false']
    failed = execute(classify, {'EVENT_NAME': 'merge_group', 'MQ_HEAD_REF': 'unexpected-ref'})
    assert failed.returncode != 0, failed.stderr

    gate_env = dict(RELEASE_DETECT='success', IS_RELEASE='false', DETECT='success',
                    NEEDED='true', BUILD='success', INSTRUMENTATION='success', RELEASE_SMOKE='success')
    for values, passed in [
        ({}, True),
        ({'IS_RELEASE': 'true', 'DETECT': 'skipped', 'NEEDED': '', 'BUILD': 'skipped', 'INSTRUMENTATION': 'skipped', 'RELEASE_SMOKE': 'skipped'}, True),
        ({'NEEDED': 'false', 'BUILD': 'skipped', 'INSTRUMENTATION': 'skipped', 'RELEASE_SMOKE': 'skipped'}, True),
        ({'RELEASE_DETECT': 'failure', 'IS_RELEASE': 'true'}, False),
        ({'RELEASE_DETECT': 'cancelled'}, False),
        ({'IS_RELEASE': ''}, False),
        ({'IS_RELEASE': 'unknown'}, False),
        ({'DETECT': 'failure'}, False),
        ({'BUILD': 'failure'}, False),
        ({'INSTRUMENTATION': 'cancelled'}, False),
        ({'INSTRUMENTATION': 'skipped'}, False),
        ({'RELEASE_SMOKE': 'failure'}, False),
        ({'RELEASE_SMOKE': 'skipped'}, False),
    ]:
        result = execute(gate, gate_env | values)
        assert (result.returncode == 0) is passed, (values, result.stdout, result.stderr)

publish = next(step for step in job['steps'] if step.get('name') == 'Publish APK on the Android Release')
verify = next(step for step in job['steps'] if step.get('name') == 'Verify Android release tag')
assert not publish.get('continue-on-error', False)

# Exercise the actual publication step with GitHub at its external CLI boundary.
with tempfile.TemporaryDirectory() as temp:
    work = Path(temp)
    binary = work / 'gh'
    binary.write_text('''#!/usr/bin/env python3
import hashlib
import json
import os
from pathlib import Path
import sys
args = sys.argv[1:]
root = Path(os.environ['RUNNER_TEMP'])
if args[0] == 'api':
    if args[1] == 'repos/okou-ai/okou/commits/android-v0.2.0':
        if os.environ.get('FAIL_LOOKUP') == 'true':
            sys.exit(17)
        print(os.environ.get('TAG_SOURCE', 'a' * 40))
    else:
        assert args[1] == 'repos/okou-ai/okou/releases/tags/android-v0.2.0'
        mapping = root / 'archived-map'
        print(json.dumps({'assets': [{'name': 'okou-android-0.2.0-mapping.txt.gz',
              'digest': 'sha256:' + hashlib.sha256(mapping.read_bytes()).hexdigest()}] if mapping.exists() else []}))
elif args[:2] == ['release', 'upload']:
    assert args[2] == 'android-v0.2.0'
    assert '--clobber' not in args
    if args[3].endswith('-mapping.txt.gz'):
        assert Path(args[3]).read_bytes() == (
            root / 'android-release' / 'okou-android-0.2.0-mapping.txt.gz').read_bytes()
        if os.environ.get('FAIL_MAPPING_UPLOAD') == 'true':
            sys.exit(29)
        with (root / 'archived-map').open('xb') as output:
            output.write(Path(args[3]).read_bytes())
        if os.environ.get('UNKNOWN_MAPPING_UPLOAD') == 'true':
            sys.exit(31)  # Commit happened before the caller lost the receipt.
        sys.exit(0)
    assert Path(args[3]).read_bytes() == (
        root / 'android-release' / 'okou-android-0.2.0.apk').read_bytes()
    if os.environ.get('FAIL_UPLOAD') == 'true':
        sys.exit(23)
    with (root / 'uploaded').open('x') as output:
        output.write(args[2])
elif args[:2] == ['release', 'view']:
    assert args[2] == 'android-v0.2.0'
    print('Fixture release notes')
else:
    raise AssertionError(args)
''')
    binary.chmod(0o755)
    apk_dir = work / 'android-release'
    apk_dir.mkdir()
    apk_path = apk_dir / 'okou-android-0.2.0.apk'
    map_uuid = 'e1ae3b30-0b1d-3184-a915-040836dd85bd'
    with zipfile.ZipFile(apk_path, 'w') as apk:
        apk.writestr('classes.dex', '~~R8{"version":"fixture","pg-map-id":"fixture-map"}')
        apk.writestr('assets/sentry-debug-meta.properties', f'io.sentry.ProguardUuids={map_uuid}\n')
    map_body = b'fixture-r8-mapping'
    mapping = (f'# compiler_version: fixture\n# pg_map_id: fixture-map\n'
               f'# pg_map_hash: SHA-256 {hashlib.sha256(map_body).hexdigest()}\n').encode() + map_body
    (apk_dir / 'okou-android-0.2.0-mapping.txt.gz').write_bytes(gzip.compress(mapping, mtime=0))
    cli = work / 'sentry-cli'
    cli.write_text('''#!/usr/bin/env python3
import gzip
import os
from pathlib import Path
import sys
archived = Path(os.environ['RUNNER_TEMP']) / 'archived-map'
assert sys.argv[1:5] == ['upload-proguard', '--require-one', '--uuid', os.environ['FIXTURE_MAP_UUID']]
assert Path(sys.argv[5]).read_bytes() == gzip.decompress(archived.read_bytes())
sys.exit(37 if os.environ.get('FAIL_SENTRY_UPLOAD') == 'true' else 0)
''')
    cli.chmod(0o755)
    env = dict(os.environ, PATH=str(work) + os.pathsep + os.environ['PATH'],
               RUNNER_TEMP=str(work), GITHUB_REPOSITORY='okou-ai/okou',
               ANDROID_VERSION='0.2.0', ANDROID_TAG='android-v0.2.0',
               ANDROID_RELEASE_SOURCE_SHA='a' * 40, FIXTURE_MAP_UUID=map_uuid,
               SENTRY_AUTH_TOKEN='fixture', SENTRY_ORG='okou', SENTRY_PROJECT='android')
    def run(**overrides):
        for step in [verify, publish]:
            result = subprocess.run(['bash', '-e', '-c', step['run']], env=env | overrides,
                                    text=True, capture_output=True)
            if result.returncode:
                break
        return result
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

    # Exercise the real R2 publisher and actual workflow ordering. GitHub is a
    # secondary copy: a previous upload must not prevent repairing discovery.
    aws = work / 'aws'
    aws.write_text('''#!/usr/bin/env python3
import hashlib
import json
import os
from pathlib import Path
import sys
args = sys.argv[1:]
assert args[0] == 's3api'
key = args[args.index('--key') + 1]
path = Path(os.environ['RUNNER_TEMP']) / 'r2' / key
def etag():
    return '"' + hashlib.sha256(path.read_bytes()).hexdigest() + '"'
if args[1] == 'get-object':
    if not path.exists():
        print(json.dumps({'Error': {'Code': 'NoSuchKey'}}), file=sys.stderr)
        sys.exit(1)
    Path(args[args.index('--key') + 2]).write_bytes(path.read_bytes())
    print(json.dumps({'ETag': etag()}))
elif args[1] == 'put-object':
    if key.endswith('manifest.json') and os.environ.get('FAIL_R2') == 'true':
        sys.exit(19)
    if '--if-none-match' in args:
        if path.exists():
            sys.exit(12)
    elif not path.exists() or args[args.index('--if-match') + 1] != etag():
        sys.exit(12)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(Path(args[args.index('--body') + 1]).read_bytes())
    print(json.dumps({'ETag': etag()}))
else:
    raise AssertionError(args)
''')
    aws.chmod(0o755)
    # The release job has full history, while this suite also runs in shallow
    # CI checkouts. Give the publisher its own complete, real source history.
    source = work / 'source'
    for relative in ['.github/scripts/release/publish-android-update.py',
                     '.github/scripts/release/archive-android-mapping.py',
                     'android/scripts/release_mapping.py',
                     'android/scripts/upload-sentry-mapping.py',
                     'android/scripts/version-code.sh']:
        target = source / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(root / relative, target)
    subprocess.run(['git', 'init', '--initial-branch=main', str(source)],
                   check=True, capture_output=True)
    subprocess.run(['git', '-C', str(source), 'add', '.'], check=True, capture_output=True)
    subprocess.run(['git', '-C', str(source), '-c', 'user.name=Release Fixture',
                    '-c', 'user.email=release-fixture@example.com', 'commit', '-m', 'fixture'],
                   check=True, capture_output=True)
    tools = work / 'sdk/build-tools/37.0.0'
    tools.mkdir(parents=True)
    for name in ['apksigner', 'aapt2']:
        tool = tools / name
        tool.write_text('''#!/usr/bin/env python3
import os
from pathlib import Path
import sys
if Path(sys.argv[0]).name == 'aapt2':
    print("package: name='ai.okou.android' versionCode='" + os.environ['FIXTURE_VERSION_CODE'] + "' versionName='0.2.0' ")
    print("minSdkVersion:'24'")
else:
    assert sys.argv[1] == 'verify'
''')
        tool.chmod(0o755)
    env |= dict(ANDROID_HOME=str(work / 'sdk'), R2_BUCKET_NAME='fixture-static',
                R2_ACCOUNT_ID='fixture-account', FIXTURE_VERSION_CODE=subprocess.check_output(
                    ['bash', str(source / 'android/scripts/version-code.sh')], text=True).strip())
    steps = [step for step in job['steps'] if step.get('name') in {
        'Verify Android release tag', 'Publish verified Android update',
        'Publish APK on the Android Release', 'Archive Android release mapping',
        'Upload Android R8 mapping to Sentry',
    }]
    def run_publication(**overrides):
        for step in steps:
            result = subprocess.run(['bash', '-e', '-c', step['run']], cwd=source,
                                    env=env | overrides, text=True, capture_output=True)
            if result.returncode:
                break
        return result

    (work / 'uploaded').write_text('android-v0.2.0')
    result = run_publication()
    assert result.returncode != 0  # The immutable GitHub copy still refuses overwrite.
    manifest = work / 'r2/android-updates/manifest.json'
    assert manifest.exists(), f'R2 manifest was not published before the GitHub APK upload: {result.stderr}'
    data = json.loads(manifest.read_text())
    assert data['release']['version'] == '0.2.0'
    assert data['release']['minimumSdk'] == 24
    assert (work / 'r2' / data['release']['url'].removeprefix('https://static.okou.io/')).read_bytes() == apk_path.read_bytes()
    assert (work / 'uploaded').read_text() == 'android-v0.2.0'
    assert (work / 'archived-map').read_bytes() == (apk_dir / 'okou-android-0.2.0-mapping.txt.gz').read_bytes()

    shutil.rmtree(work / 'r2')
    (work / 'uploaded').unlink()
    result = run_publication(TAG_SOURCE='b' * 40)
    assert result.returncode != 0
    assert not (work / 'r2').exists(), 'Wrong release source reached R2'
    assert not (work / 'uploaded').exists()
    result = run_publication(FAIL_SENTRY_UPLOAD='true')
    assert result.returncode != 0
    assert not manifest.exists(), 'Failed Sentry upload allowed update discovery'
    assert not (work / 'uploaded').exists()
    result = run_publication(FAIL_R2='true')
    assert result.returncode != 0
    assert not manifest.exists()
    assert not (work / 'uploaded').exists()

    (work / 'archived-map').unlink()
    result = run_publication(FAIL_MAPPING_UPLOAD='true')
    assert result.returncode != 0
    assert not manifest.exists(), 'Unarchived mapping allowed update discovery'
    result = run_publication(UNKNOWN_MAPPING_UPLOAD='true')
    assert result.returncode == 0, result.stderr
    assert manifest.exists(), 'Committed mapping was not recovered by readback'
    shutil.rmtree(work / 'r2')
    (work / 'uploaded').unlink()
    (work / 'archived-map').write_bytes(b'wrong-version-mapping')
    result = run_publication()
    assert result.returncode != 0
    assert not manifest.exists(), 'A mismatched same-name mapping allowed publication'

print('Android release selection, publication and failure propagation: ok')
PY
python3 "$root/.github/scripts/tests/android-update-publication.test.py"
