#!/usr/bin/env bash
# Candidate producer only. Reviewed pins + unchanged full-ten/PNG + complete
# loader attribution remain separate mandatory acceptance, never implied here.
set -euo pipefail
[[ $# == 0 ]] || exit 1
cd "$(git rev-parse --show-toplevel)"
target="$PWD/crates/target"
[[ ! -L "$target" && ! -L "$PWD/crates" ]] || exit 1
mkdir -p -m 700 "$target"
[[ -d "$target" && $(realpath "$target") == "$target" && $(stat -c %u "$target") == "$(id -u)" ]] || exit 1
git check-ignore -q "$target"
receipt="$target/full-qemu-producer-receipt"
[[ ! -e "$receipt" && ! -L "$receipt" ]] || exit 1
mkdir -m 700 "$receipt"
source_cache="$target/qemu-full-fixture-source"
[[ ! -L "$source_cache" ]] || exit 1
mkdir -p -m 700 "$source_cache"
[[ $(realpath "$source_cache") == "$source_cache" && $(stat -c %u "$source_cache") == "$(id -u)" ]] || exit 1
archive="$source_cache/qemu-9.2.0.tar.xz"
[[ ! -L "$archive" ]] || exit 1
if [[ ! -e "$archive" ]]; then
  bash .github/scripts/download-verified.sh https://download.qemu.org/qemu-9.2.0.tar.xz f859f0bc65e1f533d040bbe8c92bcfecee5af2c921a6687c652fb44d089bd894 "$archive"
fi
printf '%s  %s\n' f859f0bc65e1f533d040bbe8c92bcfecee5af2c921a6687c652fb44d089bd894 "$archive" | sha256sum -c -
python3 -B .github/scripts/tests/test-qemu-gssapi-producer.py
runtime=$(python3 -B .github/scripts/prepare-qemu-gssapi-fixture.py --source-archive "$archive")
python3 -B - "$runtime" "$receipt" <<'PY'
import hashlib,json,os,pathlib,platform,shutil,subprocess,sys
root,out=map(pathlib.Path,sys.argv[1:])
contract=root.parent/'contract'
assert contract.resolve(strict=True)==contract and not contract.is_symlink()
manifest=contract/'provider.json'
assert manifest.is_file() and not manifest.is_symlink() and not (root/'provider.json').exists()
data=json.loads(manifest.read_text());build=data['qemuBuild']
assert data['fullQemuProvider']=='source-pinned-private-noble-v2'
measurement=json.loads(subprocess.check_output([sys.executable,'-I','-S','-B','crates/rfb-client/tests/fixtures/qemu_gssapi.py',
 '--runtime-dir',str(contract),'--inventory-only'],text=True,timeout=300,
 env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8'}))
assert measurement['measurementOnly'] is True and measurement['runtimeVerified'] is False and measurement['attributionVerified'] is False
assert measurement==json.loads((root.parent/'public-evidence/contract-inventory.json').read_text())
binary=root/'usr/bin/qemu-system-x86_64'
digest=hashlib.sha256(binary.read_bytes()).hexdigest()
assert build['nativeArchitecture']==platform.machine() and build['binarySha256']==build['secondBuildSha256']==digest
assert data['producer']['head']==subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
assert data['producer']['worktreeDirty'] is False
shutil.copyfile(manifest,out/'provider.json')
shutil.copyfile(binary,out/'qemu-system-x86_64')
shutil.copyfile(root.parent/'build.log',out/'build.log')
indexes=out/'signed-indexes'; indexes.mkdir(mode=0o700)
for name,index_digest in data['signedIndexFiles'].items():
    path=root.parent/name
    assert path.is_file() and not path.is_symlink() and hashlib.sha256(path.read_bytes()).hexdigest()==index_digest
    shutil.copyfile(path,indexes/path.name)
(out/'candidate.json').write_text(json.dumps({'head':data['producer']['head'],'ownerUid':os.geteuid(),
 'nativeArchitecture':platform.machine(),'binarySha256':digest,'packageLockSha256':data['packageLockSha256'],
 'recipeSha256':build['recipeSha256'],'providerSha256':hashlib.sha256(manifest.read_bytes()).hexdigest(),
 'runtimeInventorySha256':data['runtimeInventorySha256'],'inputClosureSha256':data['inputClosureSha256'],
 'immutableSchemaVersion':data['immutableTree']['schemaVersion'],'immutableMeasurementOnly':True,
 'contractInventorySha256':measurement['treeSha256'],'inputMeasurementSourceSha256':data['inputMeasurementSourceSha256'],
 'sourceAdmission':build['sourceAdmission'],'firmware':build['firmware'],'configure':build['configure'],
 'candidateProducerVerified':True,'runtimeVerified':False,'attributionVerified':False,
 'scope':'two actual private signed-sysroot native QEMU builds; NOT admission, full-ten/PNG, loader or K2 completion'},indent=2)+'\n')
PY
