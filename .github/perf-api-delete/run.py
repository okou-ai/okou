import json,os,pathlib,subprocess,time,sys,hashlib
root=pathlib.Path(os.environ['GITHUB_WORKSPACE']); variant=os.environ['LAB_VARIANT']; shard=int(os.environ['LAB_SHARD'])
manifest=json.loads((root/'.github/perf-api-delete/manifest.json').read_text()); deleted=manifest[variant]
for relative in deleted:
    path=root/relative
    if not relative.startswith('turbo/apps/api/') or not relative.endswith('.test.ts') or not path.is_file():
        raise ValueError('Invalid test deletion: '+relative)
    path.unlink()
output=root/'lab-results';output.mkdir(exist_ok=True)
record=dict(variant=variant,shard=shard,deleted=deleted,base_sha='5bc23f35f00eb26ed74dba887a85c09a2edf4421',commit=os.environ['GITHUB_SHA'],manifest_sha256=hashlib.sha256((root/'.github/perf-api-delete/manifest.json').read_bytes()).hexdigest())
env=dict(os.environ,DELETE_LAB_TIMINGS=str(output/'timings.json'))
cmd=['pnpm','vitest','run','--project=api',f'--shard={shard}/8','--coverage.enabled','--coverage.reporter=json','--reporter=default','--reporter='+str(root/'.github/perf-api-delete/timing-reporter.mjs')]
record['command']=cmd;start=time.time()
with (output/'test.log').open('w') as log:
    result=subprocess.run(cmd,cwd=root/'turbo',env=env,stdout=log,stderr=subprocess.STDOUT)
record.update(wall_seconds=time.time()-start,exit=result.returncode,start_epoch=start)
(output/'receipt.json').write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps(record));sys.exit(result.returncode)
