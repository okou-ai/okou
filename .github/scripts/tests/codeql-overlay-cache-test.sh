#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
python3 - "$repo_root" <<'PY'
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile

root = Path(sys.argv[1])
script = root / '.github/scripts/checks/codeql-overlay-cache.sh'
workflow = root / '.github/workflows/security.yml'

def write_exec(path: Path, content: str):
    path.write_text(content)
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

def parse_kv(path: Path):
    if not path.exists():
        return {}
    out = {}
    for line in path.read_text().splitlines():
        if '=' in line:
            k, v = line.split('=', 1)
            out[k] = v
    return out

with tempfile.TemporaryDirectory() as tmp:
    base = Path(tmp)
    bin_dir = base / 'bin'
    bin_dir.mkdir()
    r2_dir = base / 'r2'
    r2_dir.mkdir()
    db_dir = base / 'codeql_databases'
    codeql_log = base / 'codeql.log'

    # Minimal local fake AWS CLI backed by a directory so real tar/zstd/sha256 run end to end.
    write_exec(bin_dir / 'aws', f'''#!/usr/bin/env python3
import os, shutil, sys
from pathlib import Path

root = Path({str(r2_dir)!r})
args = sys.argv[1:]
if args[:2] == ['s3api', 'get-object']:
    bucket = key = None
    dest = args[-1]
    i = 2
    while i < len(args) - 1:
        if args[i] == '--bucket':
            bucket = args[i + 1]; i += 2
        elif args[i] == '--key':
            key = args[i + 1]; i += 2
        else:
            i += 1
    src = root / bucket / key
    if not src.exists():
        sys.stderr.write('NoSuchKey\\n')
        sys.exit(254)
    Path(dest).parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dest)
    sys.exit(0)
elif args[:2] == ['s3api', 'put-object']:
    bucket = key = body = None
    i = 2
    while i < len(args):
        if args[i] == '--bucket':
            bucket = args[i + 1]; i += 2
        elif args[i] == '--key':
            key = args[i + 1]; i += 2
        elif args[i] == '--body':
            body = args[i + 1]; i += 2
        else:
            i += 1
    dst = root / bucket / key
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(body, dst)
    sys.exit(0)
elif args[:2] == ['s3api', 'delete-object']:
    bucket = key = None
    i = 2
    while i < len(args):
        if args[i] == '--bucket':
            bucket = args[i + 1]; i += 2
        elif args[i] == '--key':
            key = args[i + 1]; i += 2
        else:
            i += 1
    dst = root / bucket / key
    if dst.exists():
        dst.unlink()
    sys.exit(0)
elif args[:2] == ['s3', 'cp']:
    src, dst = args[-2], args[-1]
    if src.startswith('s3://'):
        rel = src[len('s3://'):]
        p = root / rel
        if not p.exists():
            sys.stderr.write('NotFound\\n')
            sys.exit(1)
        Path(dst).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(p, dst)
    elif dst.startswith('s3://'):
        rel = dst[len('s3://'):]
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, p)
    else:
        sys.exit(2)
    sys.exit(0)
sys.stderr.write(f'unsupported aws args: {{args}}\\n')
sys.exit(2)
''')

    # Fake CodeQL CLI verifying resolve database and --cache-cleanup=overlay invocation.
    codeql_bin = bin_dir / 'codeql'
    write_exec(codeql_bin, f'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path

log = Path({str(codeql_log)!r})
args = sys.argv[1:]
with log.open('a') as f:
    f.write(' '.join(args) + '\\n')

if args[:2] == ['resolve', 'database']:
    if os.environ.get('FAKE_CODEQL_NO_SPECIFIER') == '1':
        print(json.dumps({{'sourceLocationPrefix': '/repo'}}))
    else:
        print(json.dumps({{'overlayBaseSpecifier': 'spec-123'}}))
    sys.exit(0)
if args[:2] == ['database', 'cleanup']:
    assert '--cache-cleanup=overlay' in args, args
    db_path = Path(args[2])
    (db_path / 'cleaned.marker').write_text('overlay')
    sys.exit(0)
sys.exit(2)
''')

    def make_db():
        if db_dir.exists():
            shutil.rmtree(db_dir)
        (db_dir / 'javascript').mkdir(parents=True)
        (db_dir / 'base-database-oids.json').write_text(json.dumps({'turbo/index.ts': 'a' * 40}))
        (db_dir / 'javascript' / 'codeql-database.yml').write_text('primaryLanguage: javascript\n')

    def run_cache(subcmd, **extra_env):
        gh_env = base / f'gh_env_{subcmd}.txt'
        gh_out = base / f'gh_out_{subcmd}.txt'
        for p in (gh_env, gh_out):
            if p.exists():
                p.unlink()
        env = dict(os.environ)
        env['PATH'] = f"{bin_dir}:{env['PATH']}"
        env.update({
            'DB_LOCATION': str(db_dir),
            'GITHUB_REPOSITORY': 'okou-ai/okou',
            'GITHUB_SHA': '1' * 40,
            'GITHUB_RUN_ID': '100',
            'GITHUB_RUN_ATTEMPT': '1',
            'CODEQL_PATH': str(codeql_bin),
            'CODEQL_CLI_VERSION': '2.27.4',
            'SECURITY_WORKFLOW_PATH': str(workflow),
            'R2_ACCOUNT_ID': 'acct123',
            'R2_BUCKET_NAME': 'ci-cache-bucket',
            'AWS_ACCESS_KEY_ID': 'ak',
            'AWS_SECRET_ACCESS_KEY': 'sk',
            'CODEQL_OVERLAY_NOW_EPOCH': '1700000000',
            'GITHUB_ENV': str(gh_env),
            'GITHUB_OUTPUT': str(gh_out),
        })
        for k, v in extra_env.items():
            if v is None:
                env.pop(k, None)
            else:
                env[k] = str(v)
        res = subprocess.run(['bash', str(script), subcmd], cwd=root, env=env, text=True, capture_output=True)
        return res, parse_kv(gh_env), parse_kv(gh_out)

    # 1. Missing credentials on PR -> fail-safe fallback to mode=none.
    res, env_out, step_out = run_cache('prepare', EVENT_NAME='pull_request', AWS_ACCESS_KEY_ID=None)
    assert res.returncode == 0, res.stderr
    assert env_out['CODEQL_OVERLAY_DATABASE_MODE'] == 'none'
    assert step_out == {'mode': 'none', 'publish': 'false', 'status': 'unavailable'}

    # 2. Initial push on empty R2 -> schedules overlay-base rebuild.
    res, env_out, step_out = run_cache('prepare', EVENT_NAME='push')
    assert res.returncode == 0, res.stderr
    assert env_out['CODEQL_OVERLAY_DATABASE_MODE'] == 'overlay-base'
    assert step_out == {'mode': 'overlay-base', 'publish': 'true', 'status': 'rebuild'}

    # 3. Publish refuses a database missing overlayBaseSpecifier without writing to R2.
    make_db()
    res, _, step_out = run_cache('publish', FAKE_CODEQL_NO_SPECIFIER='1')
    assert res.returncode == 0, res.stderr
    assert step_out['status'] == 'not-overlay-base'
    assert list(r2_dir.rglob('*')) == []

    # 4. Valid publish (gen 1) runs overlay cleanup and writes payload + manifest.
    make_db()
    res, _, step_out = run_cache('publish', GITHUB_RUN_ID='101', CODEQL_OVERLAY_NOW_EPOCH='1700000000')
    assert res.returncode == 0, res.stderr
    assert step_out['status'] == 'published'
    manifest_files = list(r2_dir.rglob('manifest.json'))
    assert len(manifest_files) == 1
    manifest_path = manifest_files[0]
    m1 = json.loads(manifest_path.read_text())
    assert m1['previousPayloadKey'] is None
    assert m1['codeqlCliVersion'] == '2.27.4'
    gen1_blob = r2_dir / 'ci-cache-bucket' / m1['payloadKey']
    assert gen1_blob.exists()

    # 5. Push within refresh window -> stays mode=none, publish=false.
    res, env_out, step_out = run_cache('prepare', EVENT_NAME='push', CODEQL_OVERLAY_NOW_EPOCH='1700003600')
    assert res.returncode == 0, res.stderr
    assert env_out['CODEQL_OVERLAY_DATABASE_MODE'] == 'none'
    assert step_out == {'mode': 'none', 'publish': 'false', 'status': 'fresh'}

    # 6. PR restore succeeds, unpacks verified overlay DB, and sets mode=overlay.
    res, env_out, step_out = run_cache('prepare', EVENT_NAME='pull_request', CODEQL_OVERLAY_NOW_EPOCH='1700003600')
    assert res.returncode == 0, res.stderr
    assert env_out['CODEQL_OVERLAY_DATABASE_MODE'] == 'overlay'
    assert step_out == {'mode': 'overlay', 'publish': 'false', 'status': 'hit'}
    assert (db_dir / 'base-database-oids.json').is_file()
    assert (db_dir / 'javascript' / 'cleaned.marker').read_text() == 'overlay'

    # 7. Stale push (>= 7200s) triggers gen 2 + gen 3; gen 3 prunes gen 1 while keeping gen 2 and gen 3.
    res, env_out, step_out = run_cache('prepare', EVENT_NAME='push', CODEQL_OVERLAY_NOW_EPOCH='1700008000')
    assert res.returncode == 0 and step_out['publish'] == 'true'
    make_db()
    res, _, step_out = run_cache('publish', GITHUB_RUN_ID='102', CODEQL_OVERLAY_NOW_EPOCH='1700008000')
    assert res.returncode == 0 and step_out['status'] == 'published'
    m2 = json.loads(manifest_path.read_text())
    assert m2['previousPayloadKey'] == m1['payloadKey']
    assert gen1_blob.exists()  # Still retained as previous generation.

    make_db()
    res, _, step_out = run_cache('publish', GITHUB_RUN_ID='103', CODEQL_OVERLAY_NOW_EPOCH='1700016000')
    assert res.returncode == 0 and step_out['status'] == 'published'
    m3 = json.loads(manifest_path.read_text())
    assert m3['previousPayloadKey'] == m2['payloadKey']
    assert not gen1_blob.exists(), 'obsolete grandparent payload must be pruned'
    assert (r2_dir / 'ci-cache-bucket' / m2['payloadKey']).exists()
    assert (r2_dir / 'ci-cache-bucket' / m3['payloadKey']).exists()

    # 8. Expired PR manifest (> MAX_AGE_SECONDS) falls back cleanly to mode=none.
    res, env_out, step_out = run_cache('prepare', EVENT_NAME='pull_request', CODEQL_OVERLAY_NOW_EPOCH='1700700000')
    assert res.returncode == 0
    assert env_out['CODEQL_OVERLAY_DATABASE_MODE'] == 'none'
    assert step_out['status'] == 'expired'
    assert not db_dir.exists()

    # 9. Corrupted archive fails integrity check and falls back to mode=none.
    gen3_blob = r2_dir / 'ci-cache-bucket' / m3['payloadKey']
    good_bytes = gen3_blob.read_bytes()
    gen3_blob.write_bytes(b'corrupted' + good_bytes[9:])
    res, env_out, step_out = run_cache('prepare', EVENT_NAME='pull_request', CODEQL_OVERLAY_NOW_EPOCH='1700017000')
    assert res.returncode == 0
    assert env_out['CODEQL_OVERLAY_DATABASE_MODE'] == 'none'
    assert step_out['status'] == 'checksum-mismatch'
    assert not db_dir.exists()

    # 10. Archive with parent-directory traversal is rejected before extraction.
    evil_tar = base / 'evil.tar'
    with tarfile.open(evil_tar, 'w') as tf:
        payload_file = base / 'src_escape.txt'
        payload_file.write_text('bad')
        tf.add(payload_file, arcname='../escape.txt')
    subprocess.run(['zstd', '-q', '-f', str(evil_tar), '-o', str(gen3_blob)], check=True)
    evil_bytes = gen3_blob.read_bytes()
    m3_evil = dict(m3)
    m3_evil['compressedSizeBytes'] = len(evil_bytes)
    m3_evil['sha256'] = hashlib.sha256(evil_bytes).hexdigest()
    manifest_path.write_text(json.dumps(m3_evil))
    res, env_out, step_out = run_cache('prepare', EVENT_NAME='pull_request', CODEQL_OVERLAY_NOW_EPOCH='1700017000')
    assert res.returncode == 0
    assert env_out['CODEQL_OVERLAY_DATABASE_MODE'] == 'none'
    assert step_out['status'] == 'unsafe-archive'
    assert not (base / 'escape.txt').exists()
    assert not db_dir.exists()

    # 11. Rotating pinned codeql-action SHA isolates cache namespace cleanly.
    res, env_out, step_out = run_cache(
        'prepare',
        EVENT_NAME='pull_request',
        CODEQL_ACTION_SHA='f' * 40,
        CODEQL_OVERLAY_NOW_EPOCH='1700017000',
    )
    assert res.returncode == 0
    assert env_out['CODEQL_OVERLAY_DATABASE_MODE'] == 'none'
    assert step_out['status'] == 'miss'

print('codeql overlay cache: ok')
PY
