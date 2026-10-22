# Cancellation-independent Guest permission control

This test component qualifies a real Guest kernel permission event inside an
unfinished canonical `GuestStateRestore`. It does not reconcile Runner lifecycle
owners. Parent #41527 retains Fresh/matching-Snapshot, final-exec/quiesce,
failure/unwind, original capsule/data/full lease, saving, contention/cleanup IO,
and final combined-source acceptance.

`guest_permission_control.py` runs as root in an isolated test Guest. It opens the
original `/etc/timezone` and canonical `/sbin/guest-state-restore` before arming
the [original-inode gate](FILE_OPEN_PERMISSION.md). The event retains its kernel
PIDFD while the controller checks the producer's open executable descriptor
against the original canonical executable. Live PIDFD checks bracket that
inspection and every held-state acknowledgement. An executable match proves the
actual blocked producer, not an application readiness or lifecycle result.

The controller connects to Host CID 2, private vsock port 52010, before restore
starts. Firecracker forwards it to the independently owned Host
`{vsock_path}_52010` listener. Normal `ExecControl`, exec and file writes reserve
the normal client tracker; they cannot release the gate after restore observer
cancellation makes that tracker NotParkable. The dedicated stream remains usable
without changing production admission or protocol.

Each control frame is a positive big-endian u32 byte length followed by at most
16 KiB of JSON. The invocation's 32-hex nonce and strictly increasing IDs bind
each request/reply. Duplicate keys, unexpected fields, wrong IDs/nonce, oversized
or truncated input, uncertain IO and missing acknowledgements fail the run. The
single task owns the gate throughout. `observe` retains one event, `status`
acknowledges live held work and unchanged original bytes, `decide` explicitly
allows/denies that exact event once, and `retire` checks gate/descriptor cleanup
after the decision. At most eight commands and 30 seconds per stream operation
bound failures; deadlines are never readiness evidence. No response is retried.

EOF/error cleanup attempts explicit denial and descriptor retirement, then the
controller exits unsuccessfully. Group/controller death can implicitly release
opens. Neither EOF nor a successful permission response proves producer
completion: the Host must join the actual request terminal and the controller
exec it already owns. Failed/uncertain cleanup cannot count as successful
retirement.

The Host retains the controller's decoded exec terminal before asserting its
exit and capture completeness. Ordinary root exec may include shell diagnostics;
captured, untruncated stdout/stderr are retained rather than required to be empty.
The dedicated control acknowledgements and canonical helper outcome remain
separate checks.

## Verification

Ordinary protocol tests and explicit privileged kernel/process tests run in
Security CI. Locally, from the repository root:

```bash
python3 -B -m unittest discover -s crates/runner/tests/guarded_idle_native -p 'guest_permission_control_test.py'
sudo env OKOU_TEST_OPEN_PERMISSION_KERNEL=1 python3 -B -m unittest discover -s crates/runner/tests/guarded_idle_native -p 'guest_permission_control_test.py'
```

The opt-in `guest-control-client` integration test boots two independently owned
VMs (allow/deny) using exclusively created writable copies of supplied current
packaged rootfs. Supply absolute Firecracker/kernel/rootfs paths using
`OKOU_TEST_RPC_FIRECRACKER`, `OKOU_TEST_RPC_KERNEL`, and `OKOU_TEST_RPC_ROOTFS`.
Supply a nonexistent short absolute output directory using
`OKOU_TEST_GUEST_PERMISSION_DIR` (Unix socket paths must fit 107 bytes). Build with
`OKOU_TEST_BUILD_SOURCE_SHA` set to the exact committed source SHA; retain original
source/build/input hashes and compiler artifact receipts outside the fixture.

```bash
cd crates
OKOU_TEST_BUILD_SOURCE_SHA="$reviewed_commit" cargo test --profile local --locked \
  -p guest-control-client --features test-support --test native_guest_permission --no-run
# Run the compiler-reported test executable as root with the inputs above:
"$native_test_executable" --ignored --exact \
  native_guest_permission_survives_restore_observer_cancellation --nocapture
```

Bound the invocation and its owned descendants externally, retain every failed
attempt, and never automatically replay an uncertain invocation. The fixture
uses the production client and canonical helper; ConnectionScope retains the
actual original request/terminal wire producers. It verifies the running-helper
event before terminal completion, drops the restore observer, checks normal
rejection and NotParkable, obtains independent status/decision/retirement
acknowledgements, and joins the real terminal exchange, controller exec and
connection. Late completion must preserve NotParkable. It writes original
control/request/terminal frames plus per-case qualification records, and keeps
failed VM console/image evidence. Success removes the private writable image.
Inspect/replay original packets against the committed protocol and source/input
bindings; a summary alone is insufficient. Native unsupported privilege,
Python, kernel or vsock capability is a failed qualification, never a native
success inferred from Host-kernel tests.

VM kill/wait is explicit containment after component verification or on failure.
It is not positive Runner retirement, required saving, private-runtime removal,
full lease release, snapshot coverage, physical relief or production protection.
No production RPC, helper, tracker, policy/P1, schema or dependency is changed.

## Same-operation preparation component

`guest_preparation_control.py` owns the unchanged canonical
`/usr/local/bin/guest-agent prepare-for-reuse` as its direct child inside the
controller's existing supervised workload operation. The helper's real
sole-operation cgroup checks remain enabled. Its original runtime-parent
directory permission event must identify the live child, canonical executable,
exact argv and same workload cgroup. A second ordinary controller exec would
violate this helper's containment requirement.

The six strict commands are `start`, `observe`, `status`, `decide`, `join` and
`retire`. Before the one explicit decision, the owner removes its original mark
while retaining the held event. Later helper opens can then proceed without
being mistaken for the selected boundary. The gate closes before child wait;
original descriptors close after the child is positively joined. EOF/error
disposes the gate before attempting that same join, retains original descriptors
until the child is joined, and exits unsuccessfully.
Uncertain cleanup or a failed wait cannot produce a successful retirement.

The component owns synthetic current, retained and stale payloads below an
exclusively created private parent. Allow requires the actual cleanup report,
preserved current/retained bytes and removed stale child. Deny requires the
helper's cleanup-failure exit4 before deletion and all original payloads intact.
The Host also joins the original accepted controller exec, selected wire exchange
and connection. It retains original control/exec frames and helper stdin/output;
VM kill/wait remains containment only.

Build the `native_guest_permission` target above at the committed source and run
its `preparation::native_same_operation_preparation_allow_deny_and_eof` ignored test,
setting a nonexistent short absolute `OKOU_TEST_GUEST_PREPARATION_DIR` in addition
to the three packaged-input variables. Run the existing restore test at that
same source when shared control/permission code changes. Install and read back
all current packaged Guest binaries before claiming current-source execution.

For each successful case, retain `capture.json` containing exactly
`source_commit` and `files`, the latter mapping every name in
`guest_preparation_control_report.FILES` to its original SHA256. Pin the capture
hash separately from the capture itself and replay. The EOF case instead uses
`EOF_FILES` and explicit `--eof`: it requires the actual exit1/EOF terminal and
the fixture's captured failure audit proving explicit denial, child wait and
descriptor disposal. It cannot pass as successful control retirement.

```bash
python3 -B crates/runner/tests/guarded_idle_native/guest_preparation_control_report.py \
  <case-directory> --expected-source <commit> --expected-capture-sha256 <capture-hash>
python3 -B -m unittest discover -s crates/runner/tests/guarded_idle_native \
  -p 'guest_preparation_control_report_test.py'
```

The reader checks complete original files, strict typed identities, actual raw
kernel event/decision, cgroup/argv, phase clocks, helper bytes/outcomes, accepted
exec request/terminal and all joins. Synthetic reader tests do not qualify a
Guest. This component command is not Runner's composed final-exec/fence/quiesce;
it establishes no observer-cancellation reconciliation, Fresh/Snapshot capsule,
full lease, saving, cleanup IO, physical relief or parent combined-source gate.
