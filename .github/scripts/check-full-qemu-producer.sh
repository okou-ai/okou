#!/usr/bin/env bash
# Candidate producer only. Reviewed pins + unchanged full-ten/PNG + complete
# loader attribution remain separate mandatory acceptance, never implied here.
set -euo pipefail
[[ $# == 0 ]] || exit 1
cd "$(git rev-parse --show-toplevel)"
receipt="$PWD/crates/target/full-qemu-producer-receipt"
[[ ! -e "$receipt" && ! -L "$receipt" ]] || exit 1
mkdir -m 700 "$receipt"
python3 -B .github/scripts/tests/test-qemu-gssapi-producer.py
runtime=$(python3 -B .github/scripts/prepare-qemu-gssapi-fixture.py)
python3 -B - "$runtime" "$receipt" <<'PY'
import hashlib,json,os,pathlib,platform,shutil,subprocess,sys
root,out=map(pathlib.Path,sys.argv[1:])
manifest=root/'provider.json'
assert manifest.is_file() and not manifest.is_symlink()
data=json.loads(manifest.read_text());build=data['qemuBuild']
binary=root/'usr/bin/qemu-system-x86_64'
digest=hashlib.sha256(binary.read_bytes()).hexdigest()
assert build['nativeArchitecture']==platform.machine() and build['binarySha256']==build['secondBuildSha256']==digest
assert data['producer']['head']==subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
assert data['producer']['worktreeDirty'] is False
shutil.copyfile(manifest,out/'provider.json')
shutil.copyfile(binary,out/'qemu-system-x86_64')
shutil.copyfile(root.parent/'build.log',out/'build.log')
indexes=out/'signed-indexes'; indexes.mkdir(mode=0o700)
for name,digest in data['signedIndexFiles'].items():
    path=root.parent/name
    assert path.is_file() and not path.is_symlink() and hashlib.sha256(path.read_bytes()).hexdigest()==digest
    shutil.copyfile(path,indexes/path.name)
(out/'candidate.json').write_text(json.dumps({'head':data['producer']['head'],'ownerUid':os.geteuid(),
 'nativeArchitecture':platform.machine(),'binarySha256':digest,'packageLockSha256':data['packageLockSha256'],
 'recipeSha256':build['recipeSha256'],'providerSha256':hashlib.sha256(manifest.read_bytes()).hexdigest(),
 'candidateProducerVerified':True,'runtimeVerified':False,'attributionVerified':False,
 'scope':'two actual private signed-sysroot native QEMU builds; NOT admission, full-ten/PNG, loader or K2 completion'},indent=2)+'\n')
PY
