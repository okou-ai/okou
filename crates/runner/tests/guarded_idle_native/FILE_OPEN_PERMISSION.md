# Original-file open-permission controls

`file_open_permission.py` supplies deterministic Linux `FAN_OPEN_PERM`
synchronization for an isolated original regular file. It does not change or
replace the process opening that file. The kernel blocks that open until an
explicit disposition or group/process failure. Requires 64-bit Linux 5.15+,
`CONFIG_FANOTIFY_ACCESS_PERMISSIONS` and `CAP_SYS_ADMIN`, with mandatory
`FAN_REPORT_PIDFD` support. Capability/ABI errors fail; no alternative gate runs.
Python 3.10+ and its standard library are sufficient. No server is needed.

## Ownership and invocation

Keep the controller, original file and every producer outside disposable
observation futures. Use only new private fixture files or an explicitly owned
native fixture's original input; never mark shared mounts/directories, mutate
production inputs or use this as an access-control boundary.

```python
import os
from file_open_permission import FileOpenPermission

fd = os.open(original_path, os.O_RDONLY | os.O_CLOEXEC)
identity = os.fstat(fd)
gate = FileOpenPermission(fd, (identity.st_dev, identity.st_ino))
# Start an independently owned real producer that opens original_path.
event = gate.receive(timeout=10)
disposition = gate.decide(event, allow=True)
# Positively join that producer and verify its actual result.
cleanup = gate.close()
os.close(fd)
```

The caller retains its borrowed original FD. The gate duplicates it and checks
its expected device/inode, regular-file ownership, current filesystem
credentials and immutable creator process/thread/native-task generation. A path
rename/replacement does not redirect its inode mark. The gate never reads or
writes original payload bytes. A caller can close its own FD while the gate
retains its duplicate. Do not close or repurpose the group FD borrowed through
`fileno()`; it is available only for an owned event loop.

Each bounded read retains all actual kernel event FDs and PIDFDs before
semantic validation. A delivered immutable token belongs to that exact gate;
numeric PID lookup is not process authority. `receive` checks the original
event inode and live kernel PIDFD identity. Pending observation proves that
kernel open boundary, not canonical executable identity or semantic helper
acceptance. `decide` accepts one boolean ALLOW/DENY response, checks the write
and closes both event descriptors. Unknown/short response or close errors
make the owner uncertain and prohibit replay.

`close` removes the original mark, explicitly denies known and queued events,
then closes its group and original duplicate. Ordinary context-manager unwind
uses the same retirement. At most 64 events remain pending, each read is at
most 2 KiB, observation deadlines are at most 30 seconds, and retirement permits
at most 256 denies/reads. A bound/error retains the remaining owner and fails.
Do not reinterpret successful mark/group disposal as producer join. Callers
must separately join every original producer and verify its real result, even
after denial. There is no automatic finalizer or uncertain cleanup retry.

Removing the mark allows later opens; closing a group or controller death can
implicitly release unseen requests. Uncontrolled concurrent openers and fatal
controller death therefore cannot establish denial, operation success, Guest
readiness or safe lifecycle reconciliation. On failure preserve original native
owners and uncertainty under their existing policy. This primitive cannot
replace their containment, saving or lease authority.

## Tests

From the repository root:

```sh
python3 -B -m unittest discover \
  -s crates/runner/tests/guarded_idle_native -p 'file_open_permission_test.py'
sudo env OKOU_TEST_OPEN_PERMISSION_KERNEL=1 python3 -B -m unittest discover \
  -s crates/runner/tests/guarded_idle_native -p 'file_open_permission_test.py'
```

The ordinary invocation runs input/CLI consumers and explicitly leaves kernel
cases unselected. The privileged invocation runs every case and fails on missing
root/capability/ABI support. Both are registered in `security.yml`. Real kernel
cases cover allowed exact bytes, denied EPERM, write/truncate opens held before
original bytes change, multiple pending producers,
queued/observed retirement, observer unwind, original rename/replacement,
borrower lifetime, high-numbered kernel PIDFDs and foreign creator/token refusal.
The high-FD case temporarily raises only its own soft file limit within a hard
limit of at least 1200 and retires its owned padding descriptors.
No successful observation
is mocked and no elapsed delay supplies synchronization. The qualification
reader also rejects actual-record corruption and inflated claims.

## Qualification and original replay

Run the committed probe only in a new private directory on an authorized host:

```sh
sudo python3 -B \
  crates/runner/tests/guarded_idle_native/file_open_permission_probe.py \
  --output-dir /absolute/new/private/qualification \
  --source-commit <full-verified-commit-sha>
python3 -B \
  crates/runner/tests/guarded_idle_native/file_open_permission_report.py \
  /absolute/downloaded/record.json \
  --expected-source <full-verified-commit-sha> \
  --expected-capture-sha256 <trusted-original-capture-sha256> \
  --expected-directory /absolute/new/private/qualification
```

The probe never overwrites a directory. It creates one synthetic original and
three independently owned producers for ALLOW, DENY and queued retirement. It
records original metadata, raw kernel events/PIDFDs, process outcomes, ordered
phase clocks, checked event/group/file retirement and positive producer joins.
Success requires exact bytes or actual EPERM, unchanged original payload and no
intervention. Failures write diagnostic `record.json` and exit nonzero; emergency
containment of only its own synthetic producer is never successful evidence.
The record is at most 64 KiB and qualification clocks are bounded to 90 seconds.

Keep the trusted exact source manifest, host/invocation/typed transport receipts
and original capture digest outside the record. Verify every executed source
against the supplied commit, including `file_residency.py` and
`file_residency_report.py` imports; the SHA argument is a binding, not source
attestation. Independently transfer and replay original record bytes using a
separately verified committed reader. Its expected directory binds the original
invocation even when the downloaded path differs. A self-hash or archived
script must never supply trust or be executed for replay. Reader input is
bounded, regular, stable and rejects a final symlink/FIFO.

This new `original-open-permission-v1` record does not alter existing evidence
formats or business persistence. Its claims remain explicitly false for native
Guest execution, canonical-helper semantic acceptance, lifecycle cancellation,
cold/snapshot, required saving, full lease cleanup, original cleanup IO, physical
memory credit and production protection. Actual Guest privileges, a controller
independent of cancelled normal RPCs, canonical-helper binding and complete
fresh/snapshot cancellation/Busy/resume/cleanup matrices remain separate native
integration requirements.
