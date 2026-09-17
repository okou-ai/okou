set -eu
cd /
python3 - <<'PY'
import hashlib
import json
import os
import pathlib
import stat

root = pathlib.Path('/home/user/workspace')
entries = []
for path in sorted(root.rglob('*')):
    rel = str(path.relative_to(root))
    if rel == 'lost+found' or rel.startswith('lost+found/'):
        continue
    info = path.lstat()
    row = {'path': rel, 'mode': stat.S_IMODE(info.st_mode), 'uid': info.st_uid,
           'gid': info.st_gid, 'mtime': int(info.st_mtime)}
    if path.is_symlink():
        row['symlink'] = os.readlink(path)
    elif path.is_file():
        row['size'] = info.st_size
        row['sha256'] = hashlib.file_digest(path.open('rb'), 'sha256').hexdigest()
    else:
        row['directory'] = True
    entries.append(row)
print(json.dumps({'entries': entries, 'hardlink_equal':
    (root / 'data/file-000').stat().st_ino == (root / 'hardlink').stat().st_ino}))
PY
