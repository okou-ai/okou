import glob
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import time

root = pathlib.Path(os.environ['GITHUB_WORKSPACE'])
shard = int(os.environ['LAB_SHARD'])
manifest_path = root / '.github/perf-api-delete/manifest.json'
manifest = json.loads(manifest_path.read_text())
previous = []
receipts = []
for variant, deleted in manifest.items():
    if previous:
        subprocess.run(['git', 'restore', '--source=HEAD', '--', *previous], cwd=root, check=True)
    for relative in deleted:
        path = root / relative
        if not relative.startswith('turbo/apps/api/') or not relative.endswith('.test.ts') or not path.is_file():
            raise ValueError('Invalid test deletion: ' + relative)
        path.unlink()
    previous = deleted
    for cached in (root / 'turbo/node_modules/.vite/vitest').glob('*/results.json'):
        cached.unlink()
    output = root / 'lab-results' / variant
    output.mkdir(parents=True, exist_ok=True)
    with (output / 'database-reset.log').open('w') as log:
        subprocess.run(['pnpm', '--filter', '@okouai/db', 'db:reset'], cwd=root / 'turbo', stdout=log, stderr=subprocess.STDOUT, check=True)
    record = dict(variant=variant, shard=shard, deleted=deleted,
                  base_sha='5bc23f35f00eb26ed74dba887a85c09a2edf4421',
                  commit=os.environ['GITHUB_SHA'],
                  manifest_sha256=hashlib.sha256(manifest_path.read_bytes()).hexdigest())
    env = dict(os.environ, DELETE_LAB_TIMINGS=str(output / 'timings.json'))
    cmd = ['pnpm', 'vitest', 'run', '--project=api', f'--shard={shard}/8', '--coverage.enabled',
           '--coverage.reporter=json', '--reporter=default',
           '--reporter=' + str(root / '.github/perf-api-delete/timing-reporter.mjs')]
    record['command'] = cmd
    start = time.time()
    print('START', variant, shard, flush=True)
    with (output / 'test.log').open('w') as log:
        result = subprocess.run(cmd, cwd=root / 'turbo', env=env, stdout=log, stderr=subprocess.STDOUT)
    record.update(wall_seconds=time.time() - start, exit=result.returncode, start_epoch=start)
    (output / 'receipt.json').write_text(json.dumps(record, indent=2) + '\n')
    receipts.append(record)
    print(json.dumps(record), flush=True)
if previous:
    subprocess.run(['git', 'restore', '--source=HEAD', '--', *previous], cwd=root, check=True)
(root / 'lab-results' / 'summary.json').write_text(json.dumps(receipts, indent=2) + '\n')
sys.exit(1 if any(r['exit'] for r in receipts) else 0)
