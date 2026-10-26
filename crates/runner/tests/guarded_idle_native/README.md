# Guarded idle terminal fixture

Unguarded startup-reader cases below retain a test-support-only experimental
baseline. The admitting production startup performs no eager snapshot warming;
guarded runtime installation and measured policy remain P4 acceptance gates.
The production reactor carries no startup prefetch owner; these fixture readers
are owned and joined by their callers.

## Original-file open-permission controls

[The owned Linux permission gate](FILE_OPEN_PERMISSION.md) holds actual original
inode opens using kernel permission events and PIDFD identity. It supplies
explicit allow/deny and retirement controls for isolated test producers. Its
qualification does not establish actual Guest/helper execution or any native
transition, saving, lease or cleanup-IO acceptance below.

Explicit `directory=True` / probe-and-reader `--directory` additionally controls
the exact original directory inode using mark mask FAN_OPEN_PERM|FAN_ONDIR,
without child or mount marks. Returned classic FD events remain exactly
FAN_OPEN_PERM, with directory type/inode verified on the actual descriptors.
Its distinct strict record binds configured mark and original directory/child data,
actual process results and completed retirement. Existing file defaults and
records remain unchanged. This Host capability does not establish Guest support
or canonical final preparation: that helper requires a sole exec operation,
while the current ordinary-exec controller occupies another operation. Genuine
compatible control ownership and all semantic Runner matrices remain required.

[Cancellation-independent Guest control](GUEST_PERMISSION_CONTROL.md) adds a
dedicated test vsock owner and an opt-in canonical-helper allow/deny fixture.
It qualifies actual Guest capability and joined wire/controller completion;
the broader Runner capsule, saving, lease and matrix gates remain required.

The same guide's [preparation component](GUEST_PERMISSION_CONTROL.md#same-operation-preparation-component)
uses a controller parent and canonical helper child within one supervised exec
operation, retaining the helper's real containment check. Its native allow/deny
fixture and strict original-record reader qualify that component separately
from Runner's composed final-exec/fence/quiesce and cancellation custody.

## Running fixed restore inside the original Runner capsule

`running_restore::native_running_restore_loss_retains_original_uncertainty`
starts the delivered independent controller inside the actual speculative
prepare callback after unpark and before production restore. Its process waiter
and control stream remain owned outside cancelled preparation observation.
Original inode/live kernel PIDFD/executable/argv and absent terminal identify
the actual unfinished canonical helper. Independent held-state acknowledgement,
explicit allow/deny, real helper/exchange/controller joins preserve the original
Runner capsule/data/full lease and sticky Uncertain/NotParkable cleanup refusal.

Select `OKOU_TEST_RUNNING_RESTORE_DECISION=allow|deny`,
`OKOU_TEST_RUNNING_RESTORE_FAULT=drop|observer-unwind` and
`OKOU_TEST_RUNNING_RESTORE_MODE=fresh|snapshot`. Use exact committed Host/all
current Guests, a newly matching snapshot, unchanged supplied policy/P1 and the
existing native collector. Preserve original failed driver101/collector1 and
complete retained image after confirmed containment; run
`running_restore_report.py <p1-directory>` against those originals. The strict
reader checks raw control/request/terminal and complete original data, with
ordinary synthetic/real CLI regressions in `running_restore_report_test.py`.
This running boundary does not establish positive saving, private-runtime
removal, full-lease release, cleanup IO/physical relief or the parent's remaining
final-exec/quiesce/production-recovery matrices. Containment remains containment.

`OKOU_TEST_RUNNING_RESTORE_FAULT=producer-unwind` adds four allow/deny x
Fresh/Snapshot cases. Preparation observation is dropped while the actual helper
is held. After its real terminal, positively retire and join the independent
controller before delivering the held response and triggering the actual relay
panic. The controller has a separate control stream, but its contained process
is connection-owned; disconnect cleanup cannot substitute for that join. The
strict reader requires the Host join-before-delivery clock, failed exchange and
actual connection panic, retaining the original complete custody and uncertainty.
The earlier eight cases keep their existing ordering and format. This late
transport fault does not establish transport loss while a helper remains blocked.

## Guest quiesce cancellation and retained Dirty custody

`quiesce::native_quiesce_loss_retains_original_uncertainty` exercises the
actual empty quiesce request inside the original public speculative `repark`.
Genuine unpark/fixed restore and the successful canonical final-exec/fence
precede this authority; ReadyForPark and physical pause follow it. The original
empty `OperationsQuiesced` terminal proves the Guest dispatcher fenced
admission, observed zero pending and checked process containment. A Busy/error
terminal is never interpreted as that acknowledgement.

Select each combination with `OKOU_TEST_QUIESCE_BOUNDARY=capture|terminal`,
`OKOU_TEST_QUIESCE_FAULT=drop|observer-unwind|producer-unwind` and
`OKOU_TEST_QUIESCE_MODE=fresh|snapshot`. Capture precedes dispatch; a held
terminal proves completed dispatch, never a preterminal acceptance interval.
Transport producer unwind occurs only after actual terminal delivery and is
not a successful exchange join.

Unlike normal exec cancellation, this lifecycle RPC does not itself make the
normal tracker NotParkable. The actual park guard marks policy Dirty after
quiesce starts, retaining its original normal-operation fence in park custody.
The shared fixture preserves Uncertain commit/repark/incoming refusal, actual
Dirty terminal-cleanup refusal, complete original capsule/backing/promotion,
Executor session/physical history/private/home/payload, full lease and both
uncertain growth allowances. It sends no recovery resume to reopen this owner.
Independent observation/acknowledged heartbeat and actual pool/status waits
remain progress witnesses; required original cleanup IO is not credited.

Preserve original failed driver101/collector1, raw
`native_quiesce_policy_json`, source/artifact/new matching-snapshot bindings and
the complete retained original home image. The `native-quiesce-custody-v1`
consumer checks these actual files and original empty request/ack bytes with
strict identity, sequence, phase, clock, data, producer and lease contracts.
Existing fixed-restore/final-exec formats remain compatible.

```sh
<native-test-binary> quiesce::native_quiesce_loss_retains_original_uncertainty \
  --ignored --exact --nocapture --test-threads=1
python3 crates/runner/tests/guarded_idle_native/quiesce_report.py <p1-directory>
```

Require exact committed Host/all current canonical Guests, installed RootFS
readback/fsck and a new matching snapshot, unchanged supplied policy/P1/guards,
and independent original source/artifact/evidence replay. Copy original images
only after positively confirmed collector containment; containment is not
required saving. Real client/server Busy/admission/resume regressions remain
ordinary evidence. Native Busy/preterminal/resume and original cleanup IO
remain unproven. No saving/private-runtime removal/positive exit/full-lease
release/physical relief, production OOM/shutdown/D/E/P4 or ancestor completion
follows from these retained uncertainty probes.

## Final preparation exec cancellation and retained uncertainty

`final_exec::native_final_exec_loss_retains_original_uncertainty` exercises the
real speculative `repark` and its `IdleReusePreparation` fenced capture exec.
It completes genuine unpark/fixed restore before arming Exec on the original
startup connection. The production command, OneShot/Workload lifecycle, finite
timeout, label, sudo, capture limits and exact original current/retained runtime
stdin are checked. The actual original successful terminal must also pass the
owner's preparation report/capacity validation. Guest quiesce and physical pause
are later authorities; no callback after either substitutes for final-exec loss.

Select each combination separately with `OKOU_TEST_FINAL_EXEC_BOUNDARY=capture|terminal`,
`OKOU_TEST_FINAL_EXEC_FAULT=drop|observer-unwind|producer-unwind` and
`OKOU_TEST_FINAL_EXEC_MODE=fresh|snapshot`. One-shot capture never sends
`exec_started`. Capture is pre-dispatch and a held terminal proves completed
exec/containment/stdin/stdout/stderr, never an unfinished running-helper window.
Producer unwind remains a transport fault only after real terminal delivery.

Shared Guest-preparation custody keeps the original complete Executor session,
physical history, protected private runtime, ordinary home,64KiB payload,
promotion, backing and full lease outside cancelled observers. Uncertain
commit/repark/incoming refusal and the actual client's NotParkable policy remain
sticky through late delivery. Independent observation/acknowledged heartbeat
progress under actual pool/status contention and no-headroom. Covered cleanup
must preserve its actual refusal, full original owner and both uncertain growth
allowances, with no saving, exit, lease release or memory credit.

Preserve original failed driver101/collector1, all original files, raw
`native_final_exec_policy_json`, artifact/snapshot bindings and complete original
retained image. The strict reader uses `native-final-exec-custody-v1`; it checks
exact command/stdin/result bytes, complete original data and evidence limits.
Existing fixed-restore format/entries remain separate and compatible.

```sh
<native-test-binary> final_exec::native_final_exec_loss_retains_original_uncertainty \
  --ignored --exact --nocapture --test-threads=1
python3 crates/runner/tests/guarded_idle_native/final_exec_report.py <p1-directory>
```

Require newly committed Host/all current canonical Guests, installed RootFS
readback and a new matching snapshot with unchanged supplied policy/P1/guards,
then independently replay original source/artifacts/evidence. Original image
copying follows positively confirmed collector containment, never claimed saving.
Preterminal Guest acceptance, unfinished canonical running-exec cancellation and
original cleanup IO progress remain unproven. These probes establish no complete
shutdown, D/E/P4, production memory/OOM or ancestor acceptance.

## Fixed Guest restore cancellation and retained uncertainty

`fixed_restore::native_fixed_restore_loss_retains_original_uncertainty` attaches
invocation-owned framed controls to the genuine accepted Guest stream. Explicit
scope capture/reinstallation covers both the owned Executor preparation task and
the Sandbox startup listener. It uses the production handshake, fixed restore RPC
and installed canonical `/sbin/guest-state-restore`; no executable is substituted.

Run each combination separately: `OKOU_TEST_FIXED_RESTORE_BOUNDARY=capture|terminal`,
`OKOU_TEST_FIXED_RESTORE_FAULT=drop|observer-unwind|producer-unwind` and
`OKOU_TEST_FIXED_RESTORE_MODE=fresh|snapshot`. Capture precedes dispatch; a held
successful terminal proves the actual helper/stdin/stderr work has completed.
Neither is an acknowledgement of an unfinished running helper. Producer unwind
is injected only after actual terminal delivery and remains a transport-fixture
failure, with no positive exchange join.

The actual Executor first completes a real Codex session. Complete original
session/history bytes and their physical file, private runtime, ordinary home and
64 KiB payload are bound and synced before cancellation. The external original
capsule retains backing generation, promotion, metadata and the full lease.
Cancellation leaves Uncertain and refuses commit/repark/incoming. Late terminal
drain never clears the actual client's NotParkable state. Ordinary covered cleanup
must report that refusal and retain the same original owner and both uncertain
growth allowances, with no completed lease, saving or physical-relief credit.
Independent observation and an acknowledged heartbeat progress under actual
pool/status contention while another full-profile allocation remains refused.

This corpus deliberately preserves its failed Rust driver result (101). Keep the
original collector report, stdout/stderr, sample stream, artifacts, supplied raw
`native_fixed_restore_policy_json` and matching snapshot preparation record. After
the collector has positively contained only its owned children, copy the exact
identified original `home.ext4` to `retained-home.ext4` beside those original files.
The strict consumer reopens this regular full image and checks complete original
home/private/session/history bytes; containment is never required cleanup.

```sh
<native-test-binary> fixed_restore::native_fixed_restore_loss_retains_original_uncertainty \
  --ignored --exact --nocapture --test-threads=1
python3 crates/runner/tests/guarded_idle_native/fixed_restore_report.py <p1-directory>
```

Build exact committed Host/all current canonical Guests, verify installed helper
and RootFS bytes, and create a new matching snapshot before execution. Preserve
supplied policy/P1 and independently replay source/artifacts/original files.
Synthetic reader/CLI negatives are ordinary validation only. Pre-terminal Guest
acceptance, genuine running-helper cancellation and original cleanup IO progress
remain explicitly blocked. This corpus cannot establish complete saving, private
runtime removal, positive native exit, lease release, shutdown or D/E/P4 acceptance.

## Accepted physical pause with public repark awaiting HTTP

`native_pause::native_accepted_physical_pause_loss_preserves_required_saving`
exercises borrowed drop, observer unwind and post-delivery response-relay unwind
for fresh and newly restored matching-snapshot Guests. Actual unpark, production
Guest restore and complete original private/home/64 KiB payload verification
precede the public speculative repark. Its real final exec, Guest quiesce and
balloon work precede an exact pause-only gate. Complete original PATCH /vm bytes
are captured before dispatch; only the actual Firecracker 204 establishes pause
acceptance while the public repark is still Pending on response delivery. This
does not claim unfinished internal VMM execution.

The original Sandbox retains the actual pause producer/result and operation fence;
the external GuardedSpeculativeIdleOwner retains backing, history, promotion and
the full lease. Observer loss leaves Uncertain and refuses commit/repark/incoming.
Earlier Guest/balloon cancellation and unrelated dirtiness grant no pause recovery.
Terminal recovery joins that exact pause, then the original native/Guest resume
readiness, and grants only original terminal data operations. Shared ordinary
policy remains Dirty, keeping controls, assignment, RPC admission and reuse closed.
Normal successful physical park and exact-successor handoff keep their behavior.

While the actual response is held, cancelled terminal observations retain the same
work; memory observation and an acknowledged heartbeat progress under held pool
contention and the complete allocation refuses another full profile. Release and
join the actual relay before positively joining terminal readiness. Producer unwind
is injected only after actual HTTP delivery. A separate readiness witness precedes
required cleanup; it never publishes ordinary inventory or proves data saving.

The common saving path then holds real 64 MiB post-exit IO and proves complete
original home/payload recovery, private-runtime removal, positive exit, full
lease/growth through late IO, independent pool/status/IO progress and final zero
accounting/status with all producers joined. Failed or unknown work keeps original
unresolved custody; emergency Drop and P1 intervention cannot establish success.
Existing unpark and C8 witnesses retain their own formats and regression coverage.

Freeze committed Host/all canonical Guests, verify owned RootFS installed bytes
and create a new actual matching snapshot. Keep unchanged supplied policy/P1 and
original files, including raw `native_pause_policy_json`, `native_terminal_artifacts`
and `snapshot-preparation.json`. Run the exact ignored entry and original reader:

```sh
<native-test-binary> native_pause::native_accepted_physical_pause_loss_preserves_required_saving \
  --ignored --exact --nocapture --test-threads=1
python3 crates/runner/tests/guarded_idle_native/native_pause_report.py <p1-directory>
```

The strict reader requires actual pause bytes, original owner/data/phase/clock
bindings, separate pause/resume readiness and complete saving/progress/joins.
Synthetic original-file/CLI negatives are ordinary consumer checks, not native
proof. Guest RPC cancellation, full Supervisor shutdown, claim/API arbitration,
D/E and calibrated or production P4 memory relief remain separate.

## Accepted native resume with public unpark awaiting HTTP

`native_unpark::native_accepted_unpark_loss_preserves_required_saving` runs
drop, observer unwind and response-relay producer unwind with genuine fresh and
new matching-snapshot Guests. The real public Sandbox unpark enters the exact
owned socket route. Complete request capture precedes dispatch; only a complete
actual Firecracker 204 response establishes accepted resume. That response
waits before original client delivery while unpark is polled Pending, then its
borrowed observation is dropped or unwound. This proves the accepted API wait;
it does not claim that the internal VMM command is still unfinished.

The original guarded capsule remains Uncertain, retaining its backing,
promotion, history and full lease and refusing commit/repark/incoming. The
Sandbox retains its original readiness producers across cancelled observations.
A borrowed real terminal-unpark observation also remains Pending before delivery
while observation and an acknowledged heartbeat progress through held pool
contention; the original full profile prevents another full-profile reservation.
Cancel that terminal observation, release and join the independently owned
response producer, then invoke ordinary covered required cleanup. A producer
unwind is injected only after real response delivery; it is a relay task failure,
not an invented Firecracker error. Terminal readiness still requires positive
joining of the original API and Guest readiness producers.

Only the original Sandbox receives terminal data-operation authority. Its shared
ordinary coordinator stays Dirty, and ordinary controls, assignment and RPC
publication remain fenced. Other dirty causes revoke terminal recovery. Unknown
or failed readiness retains original custody; it never authorizes reuse or
required-data deletion. Emergency Drop is not successful cleanup.

The shared original saving fixture holds actual 64 MiB post-exit IO, preserves
full lease/growth ownership, and verifies independent pool/status/IO progress,
positive original exit, complete original home/64 KiB payload recovery, private
runtime removal, final status/accounting and producer joins. C8 keeps its separate
callback boundary and original witness format. Native errors retain owners and
original files; P1 intervention always fails.

Freeze the committed Host and all current canonical Guests, verify owned RootFS
bytes and create a new actual matching snapshot. Keep the original supplied
policy/P1 guards. Include exact raw `native_unpark_policy_json`,
`native_terminal_artifacts` and `snapshot-preparation.json` in original evidence:

```sh
<native-test-binary> native_unpark::native_accepted_unpark_loss_preserves_required_saving \
  --ignored --exact --nocapture --test-threads=1
python3 crates/runner/tests/guarded_idle_native/native_unpark_report.py <p1-directory>
```

The strict reader checks original HTTP bytes/socket identity, real acceptance
before cancellation, clock/owner/uncertainty/progress/producer attribution and
complete saving. Synthetic real-file/CLI negatives are ordinary consumer tests,
not native proof. Guest RPC cancellation, physical pause, full Supervisor
shutdown, D/E and production P4 remain separate.

## Cancelled or panicked speculative restore callbacks

`native_speculative_callback_loss_preserves_uncertain_owner_and_required_saving`
runs drop/panic cases with fresh and newly matching snapshot factories. The
original full-lease Guest actually unparks, completes production UTC state
restoration and verifies its complete private marker, ordinary home and 64 KiB
payload through Guest RPC. Only then does the borrowed restore callback wait at
an invocation-owned response gate. Dropping that future or releasing its injected
unwind must leave the production owner Uncertain and refuse commit, repark and
reusable inventory. The original capsule stays outside the observed future.

Production covered cleanup must save the entire original home. Held durable
post-exit IO preserves the full lease/growth allowance while actual observation
and acknowledged heartbeat progress through held pool/status locks. Joined
saving releases the original lease; another heartbeat progresses through an
observed current-status wait before empty regular status and all producer joins.
The common cache restoration verifies every original payload byte and private
runtime removal. Failure releases owned gates, joins accepted work and retains
unresolved resources; intervention cannot produce successful proof.

Use exact committed Host/current Guests, verified owned RootFS and a new matching
snapshot with unchanged supplied policy/P1 guards. Include exact raw
`native_speculative_fault_policy_json`, `native_terminal_artifacts` and matching
`snapshot-preparation.json` in the original collector files:

```sh
<native-test-binary> native_speculative_callback_loss_preserves_uncertain_owner_and_required_saving \
  --ignored --exact --nocapture --test-threads=1
python3 crates/runner/tests/guarded_idle_native/speculative_fault_report.py <p1-directory>
```

The injected failure is at the callback response boundary after completed actual
restore/RPC. It does not prove cancellation inside unpark, an in-flight Guest RPC
or repark, actual API claim arbitration or full Supervisor shutdown. Ordinary
consumer regressions are separate from opt-in native execution. Complete C/D/P4,
bootstrap provenance, residency, calibrated RAM relief and OOM/production
protection remain separate gates.

## Provider failures and retained producer uncertainty

`native_provider_failures_preserve_guarded_rollback_and_required_saving` runs
decode/disconnect × fresh/snapshot. The actual authenticated ApiProvider POST
waits at an owned response gate; malformed HTTP200 JSON and a deliberate
per-connection disconnect return None through the real provider. This means
unavailable at the JobProvider boundary, not proof that a remote claim never
happened. Actual Guest preparation, original repark/guarded restore and complete
required saving use the C7 ownership/progress/data contract below. Add exact raw
`native_claim_failure_policy_json` to the original collector metadata and replay
`claim_failure_report.py <p1-directory>`.

The separate ignored entry points are:

```text
native_claim_producer_loss_retains_original_fresh
native_claim_producer_loss_retains_original_snapshot
native_cancelled_claim_observer_retains_original_fresh
native_cancelled_claim_observer_retains_original_snapshot
```

Each owns exactly one Guest and deliberately preserves its actual ProducerLost
failure (Rust exit101, failed original P1 report). An accepted JobProvider task
waits at an owned gate, then unwinds. This is an explicit trait-boundary fault;
it does not claim ApiProvider itself panicked or returned an unreachable
mismatched claim. The non-default Firecracker Restore checkpoint observes the
actual successful fixed RPC before cancellation of only the borrowed response
observers. Pool contention, independent real observer/acknowledged heartbeat,
producer/native joins, receipt take, later wait, commit and rollback refusals,
original promotion lock contention, empty inventory and exact full lease are
required. Conversion to required cleanup still cannot clear claim uncertainty.
Before releasing the producer, an inotify-backed wait observes a complete new
sample in the owning P1 collector's `samples.jsonl` in its working directory.
The strict reader binds that acknowledgement to the original sample and clocks;
a fast transition cannot silently omit its native measurement window. This wait
is bounded by the existing claim deadline and adds no fixed delay or new policy.

The original private/home bytes and complete payload are verified and synced
before the fault. Failed cases retain their original directory and capsule;
they never enter successful terminal saving, lease release or factory teardown.
Run each entry separately under unchanged P1 guards, with exact raw
`native_claim_producer_policy_json`, artifact manifest and matching new snapshot.
Preserve the original logs, nonzero driver/collector outcomes and any collector
owned-child intervention. Such intervention is fixture containment, never
required saving, cleanup completion, memory credit or physical relief proof.
Keep all original case files; copy the positively identified original home image
to `retained-home.ext4` beside that case's original P1 files after the collector
has joined its owned children. Hash both originals and copy in the evidence
archive. The strict reader reopens this regular ext4 file and verifies its
original superblock and all seeded required bytes through read-only debugfs.
The image filesystem root corresponds to `/home/user` inside the Guest:

```sh
python3 crates/runner/tests/guarded_idle_native/claim_producer_report.py <p1-directory>
```

The reader's success confirms retained-custody evidence while retaining
`original_driver_exit_code=101`, `original_collector_success=false`,
`required_saving_complete=false` and `cleanup_complete=false`. Never rewrite
the original P1 failure or pass it to a successful terminal-saving validator.
Native images/data and raw failure records remain preserved for reconciliation.
Ordinary reader tests use synthetic logs and disposable real ext4 images with
`/usr/sbin/mke2fs` and `/usr/sbin/debugfs`; they do not establish native execution.
All C10/C11/full shutdown, complete session/history, numerical policy,
residency/provenance and P4 gates remain separate. No production activation.

## Actual provider claim rejection and guarded rollback

`native_provider_claim_rejection_preserves_guarded_rollback_and_required_saving`
runs fresh and newly matching snapshot cases. An actual ApiProvider sends its
original authenticated POST to the invocation-owned HTTP peer. Only that claim's
response waits at an owned gate; the original Guest/full lease remains in the
external GuardedSpeculativeAdmission capsule while an independent observer and
acknowledged heartbeat progress under held/released pool contention.

Release returns HTTP 404 through the real provider. Actual Guest preparation
must join, claim observation must return unavailable and commit must refuse.
Production rollback physically reparks and guarded-restores the same original.
Current regular status and an acknowledged heartbeat must preserve its original
reuse/history/profile metadata. A newly captured batch then joins required
original home saving across held post-exit IO and final status publication, with
independent progress, full lease/growth custody and positive exit/release/joins.
The common restoration verifies all original home bytes, 64 KiB payload and
private-runtime removal. Error paths release owned gates and join accepted work
outside the observation timeout, retaining unresolved owners explicitly.

Build exact committed Host/all canonical Guests, verify installed rootfs bytes
and create a new actual matching snapshot. Preserve supplied policy/P1 guards,
adding exact raw `native_claim_loss_policy_json`, `native_terminal_artifacts`
and matching `snapshot-preparation.json` to original collector evidence:

```sh
<native-test-binary> native_provider_claim_rejection_preserves_guarded_rollback_and_required_saving \
  --ignored --exact --nocapture --test-threads=1
python3 crates/runner/tests/guarded_idle_native/claim_loss_report.py <p1-directory>
```

Ordinary real-HTTP/consumer regressions remain separate from opt-in KVM proof.
The peer supplies synthetic 404 only: API service/database competing-claimant
arbitration, successful/mismatched/panicked claims, cancelled Guest preparation,
full C/D/P4 and complete session/history matrices remain unproven. Historical
base/bootstrap, unsigned/nonreproducible provenance and incomplete residency
remain explicit limits. No calibrated RAM relief, OOM or production protection
follows from this test-policy evidence.

## Same-key replacement against a captured batch

`native_same_key_replacement_fences_captured_batch_and_preserves_incoming` runs
fresh and newly matching snapshot cases. A separately leased actual incoming
Guest completes Fresh preparation, Guest RPC and physical parking. An old fixed
batch captures the original at the same reuse key, then waits at an owned
one-shot pre-read gate. Other real readers remain free to admit production
guarded replacement; no memory value or sample timestamp is manufactured.

The original required home retirement reaches actual held post-exit durable IO.
Both full leases and cleanup growth remain covered while an independent observer
progresses under a held pool lock; releasing the pool permits an acknowledged
HTTP 204 heartbeat while IO stays held. Only joined original saving releases its
full lease. The distinct incoming remains live with its own full lease. Releasing
the old read must produce exactly one original `AccountingChanged` refusal and
zero completed selections. A positively observed final status wait and heartbeat
precede publication of the current incoming at the same key. A separate newly
captured batch then retires only that incoming and joins all owners. Complete
original home bytes, the 64 KiB payload and private-runtime removal are verified
by the common restoration fixture. Error paths release owned gates and join
accepted producers outside the scenario timeout, retaining unresolved owners.

Build the exact committed Host/all canonical Guests, verify installed rootfs
bytes and prepare a new actual matching snapshot. Retain unchanged supplied
policy and P1 guards, adding exact raw `native_batch_replacement_policy_json`
to collector metadata with `native_terminal_artifacts` and the matching
`snapshot-preparation.json`. Run the frozen executable and strict reader:

```sh
<native-test-binary> native_same_key_replacement_fences_captured_batch_and_preserves_incoming \
  --ignored --exact --nocapture --test-threads=1
python3 crates/runner/tests/guarded_idle_native/batch_replacement_report.py <p1-directory>
```

Ordinary real-file/CLI regressions are synthetic consumer checks; KVM remains
opt-in. Incoming is tenant-free with no required prior history. This proves the
same-key distinct-Guest collision only; a second required incoming history,
actual API claim loss, other fault families, complete parent C/D matrices,
residency, numerical calibration, physical relief, OOM protection and P4
activation remain separate gates. Historical base OS/bootstrap and unsigned,
nonreproducible producer provenance remain explicit where applicable.

## Physical speculative rollback and batch recovery

`native_speculative_repark_preserves_history_and_batch_recovery` runs fresh and
matching-snapshot cases. While an original fixed batch waits at the pre-read
admission gate, `GuardedSpeculativeIdleOwner` performs two actual unpark, Guest
RPC and repark cycles, outside held pool/status locks. The second RPC verifies
that the first repark retained the original private runtime marker, ordinary
home bytes and complete original 64 KiB payload. Each speculative run differs
from the original history and the other speculative run. The original backing,
claim metadata and full lease remain owned throughout; repark uses the original
canonical home identity.

Only a verified parked owner restores into the vacant pool. Its insertion must
already differ from the captured selection before the subsequent shared logical
reserve/restore race. The shared batch checks below still require exact old
refusal/current inventory, independent observer and acknowledged heartbeat
progress, separate new guarded recovery, held real durable IO, original backing
exit, complete original home restoration/private-runtime removal and every
accepted cleanup join. Borrowed physical owners survive the scenario timeout;
failure attempts covered required cleanup before tracker teardown and preserves
unresolved ownership rather than producing successful proof.

Compile from the exact committed source and prepare a new matching snapshot as
described below. Retain the unchanged P1 guards and supplied policy, adding its
exact raw JSON as `native_batch_repark_policy_json` in collector metadata. Run
the frozen native test executable with:

```sh
<native-test-binary> native_speculative_repark_preserves_history_and_batch_recovery \
  --ignored --exact --nocapture --test-threads=1
python3 crates/runner/tests/guarded_idle_native/batch_repark_report.py <p1-directory>
```

The dedicated reader requires both physical cycles and the complete shared batch
proof. Its ordinary real-file/CLI regressions are synthetic consumer tests. This
is physical speculative rollback followed by a logical insertion race; actual
API claim loss, all cancellation points, physical RAM relief, complete residency,
calibrated envelopes and parent C/D/P4 completion remain separate gates.

## Fixed-batch insertion ABA and new-batch recovery

`native_fixed_batch_refuses_restored_insertion_and_recovers_original` runs fresh
and matching-snapshot cases. A production fixed batch waits at the existing
pre-read observation scheduling gate with two unused queued cleanup claims.
Reserving and restoring the same parked Guest preserves its physical identity,
full lease and home while changing its pool insertion identity. Independent
memory observation and HTTP 204 acknowledged heartbeats progress through held
pool/status boundaries. Fresh real reads resume before the old batch must
report exactly one original `ResourceChanged` refusal, zero physical completion
and current status retaining the restored original.

A separately captured guarded batch must then retire that insertion. Its
accepted durable tail IO retains the exact original full lease/cleanup growth
while independent observation and acknowledged heartbeat progress. Success
requires complete saving, positive original backing exit, joined dependencies,
zero ownership/accounting/allocation and the common full original home restore.
Refusal releases owned gates and joins accepted work, retaining uncertainty.

Select this exact ignored entry through the supplied-artifact bounded P1
invocation below. Include exact raw `native_batch_aba_policy_json`,
`native_terminal_artifacts` and the matching `snapshot-preparation.json`.

```sh
python3 crates/runner/tests/guarded_idle_native/batch_aba_report.py <p1-directory>
```

Default Cargo runs real-file/CLI refusal checks and an ordinary owner regression
with complete original home bytes. Actual KVM/NBD execution remains opt-in and
requires verified committed source, frozen Host and matching inputs. This is a
logical reserve/restore insertion ABA of an already physically parked Guest;
it does not prove physical resume/repark, claim loss, another Guest replacement,
blocked proc IO, numerical pressure, complete residency, calibrated envelopes,
physical relief, OOM or production protection. Other C/D/P4 gates remain open.

## Later parking after a fixed batch capture

`native_fixed_batch_preserves_later_exact_and_blank_inventory` runs four cases:
fresh/snapshot factories, each with a distinct later exact or blank Guest. The
incoming Guest is prepared through actual GuestRPC and physically parked before
the original batch starts, retaining its separate full lease outside the pool.
Only after the original captured entry reaches held accepted durable tail IO is
the incoming owner inserted through guarded pool insertion.

Both full leases and required cleanup growth remain owned while the pool/status
locks and original IO are held. An independent actual memory read completes;
pool release permits an HTTP 204 acknowledged heartbeat with both allocations.
Releasing only IO permits complete durable 64-MiB saving and positive original
backing exit. Another heartbeat observes only the later lease while original
batch completion still waits for status. After status release, the original
report completes exactly one selection, and the actual regular status file
contains only the later live exact identity/key or blank identity. A separate
guarded batch must retire that later entry before joined shutdown and zero
accounting. Complete original required-home restoration remains mandatory.

Use the existing supplied artifacts/policy and bounded P1 collector to invoke
this exact ignored entry. Include the exact raw
`native_later_parking_policy_json` and `native_terminal_artifacts` in metadata,
and retain the original matching `snapshot-preparation.json`. Validate with:

```sh
python3 crates/runner/tests/guarded_idle_native/later_parking_report.py <p1-directory>
```

Default Cargo runs synthetic real-file/CLI refusal regressions and an ordinary
owner test preserving both required homes. Actual KVM/NBD execution is opt-in
and requires verified committed source, frozen Host and matching inputs. The
blank wire status contains only its sandbox identity; profile compatibility is
checked through the prepared fixture. This corpus does not cover same-key/ABA
replacement, concurrent preparation cancellation, complete residency, calibrated
bounds, physical relief, OOM or production protection. Other C/D acceptance
remains in #39998.

## Final status write failure

`native_status_failure_preserves_saving_and_retries_current_inventory` runs fresh
and matching-snapshot factories. It first publishes the original parked inventory,
then positively observes held accepted saving and pool/status contention. An
independent host-memory read and acknowledged heartbeat must progress while the
original full lease and required IO remain owned.

After complete durable 64-MiB tail IO, the final status write must positively wait
for the held status lock while accounting is joined/zero and another heartbeat
completes. Only the invocation's private `status.json` destination is then replaced
with a directory. The original batch must return an actual `Write` error with all
physical work completed and `is_complete=false`. Repairing that private fault and
calling the existing current-snapshot retry must publish empty inventory without
resurrecting the original parked sandbox or rewriting the failed report. Complete
original home restoration and joined dependencies remain required.

Use the existing supplied artifacts/policy and bounded P1 collector with this exact
ignored entry. Metadata must include `native_status_failure_policy_json` as the
raw policy text and `native_terminal_artifacts`; retain the original
`snapshot-preparation.json`. Validate the original files with:

```sh
python3 crates/runner/tests/guarded_idle_native/status_failure_report.py <p1-directory>
```

Default Cargo runs synthetic real-file/CLI consumer regressions. Actual KVM/NBD
execution is opt-in, requires submitted-source/Host/input verification and uses
only owned disposable resources. This is a deterministic private status-write
failure, not a status timeout, stalled storage or provider panic. It does not
establish complete residency, calibrated resource bounds, physical relief, OOM or
production protection. Remaining C/D acceptance stays in #39998.

## Cleanup observer loss

`native_observer_loss_keeps_required_saving_and_independent_progress` runs four
cases: dropping or panicking the external completion observer, each with fresh
and matching-snapshot factories. The original batch is positively Pending at the
accepted physical IO boundary before its observer is lost. The independently
owned required saving keeps the exact original full lease and cleanup growth;
tracker/accounting shutdown remains Pending until the actual work finishes.

The corpus holds a real pool/status boundary while an independent host-memory
read completes. After pool release, the real heartbeat controller/provider must
receive HTTP 204 while status and physical IO remain held. Releasing only the
owned IO gate permits the complete durable 64-MiB tail; final status publication
must then poll Pending while accounting joins and another heartbeat completes.
Status release precedes joined tracker/reporting shutdown. Inherited complete
home restoration, original backing exit and dependency cleanup remain required.

Use the existing artifact and supplied memory-policy inputs, selecting this exact
ignored entry through bounded P1. Include `native_observer_loss_policy_json` as
the exact raw policy file text and the existing `native_terminal_artifacts`
manifest. Retain the original `snapshot-preparation.json` alongside P1 files.
Validate the complete files with:

```sh
python3 crates/runner/tests/guarded_idle_native/observer_loss_report.py <p1-directory>
```

Default Cargo runs the real-file/CLI report regressions. Actual KVM/NBD execution
remains opt-in and requires matching submitted-source/Host/input verification.
The failure is the external observer's panic or disappearance; it does not claim
provider failure, stalled storage, complete residency, a calibrated resource
envelope, physical memory relief or production protection. Other failure families
and final measurement acceptance remain in #39998.

## Current P1 diagnostic contract

The [original-file residency tool](file_residency.md) observes bounded original
file extents across replacement, unlink and growth, with strict original-file
qualification/replay. Its point observations retain the separate full native
residency, cold-input and interval-coverage gates.

The [complete original-file range command](file_residency_scan.md) streams a
stable original's full byte range under supplied byte/time budgets. It preserves
completed-prefix records on failure and verifies complete-original replay;
sequential points do not establish a simultaneous total or interval maximum.

The separate [owned charged-memory window tool](charged_windows.md) qualifies
isolated kernel counters with a bounded disposable workload and strict original
file replay. Its charge scope and false native/full-residency claims do not
change P1 or this suite's native acceptance.

New native runs consume `runner-memory-calibration-v2` from the matching
[owned collector](../../../../.github/scripts/runner-memory-calibrate.md).
Every process sample carries PID/start generation, explicit residency state and
reason, the observation clock and any positively observed pidfd-exit clock.
The shared reader rejects contradictory diagnostics, dropped captured identities,
changed generations or revoked/changed positive exit observations across samples
and reports per-phase `missing_residency_reasons`. Missing or raced reads remain
distinct from positive process exit; both retain null bytes and incomplete
residency. Collector exit
observations never replace the original Guest/backing, accepted-I/O or lease
completion witnesses and establish no physical memory relief.

Historical v1 bundles retain their original frozen consumers and source/producer
identities. Do not feed them to the current reader as new v2/current-source proof.
This format change alone does not establish complete residency, calibrated
envelopes, bootstrap provenance, native Guest execution or production protection.

## Native artifact byte verification

Artifact and snapshot-preparation checks request Linux `O_DIRECT` reads instead
of deliberately populating the observed input page cache with buffered hashing.
The shared verifier retains complete SHA256, a no-follow regular-file descriptor,
bounded reads and before/after length/mtime/ctime validation. It uses an initialized
1 MiB buffer in 4 KiB aligned blocks and at most 256 IO vectors. A partial tail is
re-read from its aligned prefix to confirm EOF without an unaligned request.

The filesystem must support these direct-IO buffers/offsets; unsupported or failed
IO is an error, with no buffered fallback in the verifier. Repeated verification
can perform more disk IO and take longer. Kernel/filesystem behavior, including
possible fallback, still requires actual cache observations: `O_DIRECT` alone
proves neither cold inputs nor physical relief. The ordinary owned-file regression
checks real before/after mincore observations and a buffered positive control;
cache advice affects only its new disposable file. Existing report formats,
producer bindings, native/cold completeness and P1 guards remain unchanged.

## Snapshot creation input record

Current native artifact manifests also require `snapshot_preparation_sha256`.
The existing ignored `prepare_native_terminal_snapshot` entry now produces
`snapshot-preparation.json` in its new snapshot directory, after the real
snapshot creator succeeds. Use the same exact-source test executable for
preparation and the measured cases, compiled with `OKOU_TEST_BUILD_SOURCE_SHA`.
The [measured corpus instructions](#measured-terminal-corpus) still define the
immutable disposable inputs, explicit environment and complete native profile.

The record format is `native-snapshot-preparation-v1`. It binds the compiled
source and actual producer executable, Firecracker/kernel/rootfs bytes, original
snapshot creation ID, 2-vCPU/4096-MiB/24576-MiB profile and every required snapshot
output, including the exact production completion marker. Preparation hashes the
inputs before creation and rechecks them after hashing all outputs. Changed or
non-regular files, incomplete output and an existing record fail publication.
The record is published atomically without overwrite after its file is synced;
the output directory is then synced. Keep partial failures for investigation;
never synthesize a successful record from their remaining files.

Put the SHA-256 of the exact record bytes in `snapshot_preparation_sha256` and
retain those bytes in the measured bundle. After the bounded collector completes,
copy the record into its invocation-owned output before running any report:

```sh
cp -- "$OWNED_NATIVE_SNAPSHOT_DIR/snapshot-preparation.json" \
  "$P1_OUTPUT_DIRECTORY/snapshot-preparation.json"
```

Native preflight and the shared report reader both require the same hash and
matching source, executable, inputs, profile, ID and output inventory. Record
reads are bounded to 64 KiB and reject symlinks, non-regular files, duplicate or
unknown fields, invalid types and invalid clocks. Creator monotonic/wall clocks
and boot identity describe that preparation; clocks from different hosts/boots
are not implicitly comparable. The production snapshot format and completion
marker are unchanged.

The shared phase report exposes `snapshot_creation_inputs_verified=true` and
`bootstrap_provenance_verified=false`. This record verifies the snapshot link;
it does not identify the rootfs/bootstrap/Guest producers, calibrate residency or
prove physical relief, P2 settlement or production protection. Immutable owned
inputs and retained source/compiler logs remain necessary; unsigned local
receipts are not supply-chain signatures or adversarial tamper resistance.
Historical bundles without this record retain their original frozen consumers.
Do not retrofit them with invented producer records or feed them to current
readers as new-source acceptance.

## Ordinary verification

```sh
cargo test --manifest-path crates/Cargo.toml --profile local --locked -j 1 \
  -p runner-host -p runner-lifecycle -p runner-supervisor -p runner \
  -- --test-threads=1
```

The external-boundary tests use real home-image bytes, procfs-format file reads,
an owned child process, blocked kernel I/O and gated provider completions. They
exercise refusal, grant cancellation, missing/failed/lost backing, preparation
and teardown panic, parallel progress, dropped receivers and shutdown ownership.

## Packaged Firecracker fixture setup

The ignored Linux test `guarded_terminal_saving_restores_home_without_private_runtime_bytes`
is executable on a root-owned KVM/NBD test host with current packaged guest
artifacts. It physically parks a Firecracker sandbox, runs terminal private
preparation and freeze, waits for exact backing exit, publishes home, tears down
the factory-owned sandbox, and restores the saved home into another sandbox.
It verifies ordinary bytes survive and the previous private runtime directory
does not. It repeats exact-prune, all-inventory drain/shutdown batches and logical
substitution, atomic park replacement, reserved restore over blank inventory and
aged exact-to-blank replenishment with fresh boot and the matching prepared
snapshot (twenty-six owned cases, including independent job-free pressure,
caller-owned cancellation before
business activation, speculative guest restore failure, and cancelled parked
and fenced running finalizing deliveries).

The fixture captures backing while the parked candidate is exclusively owned,
then enters the real Lifecycle inventory and tracked Supervisor batch API. Both
memory allowances are granted while the entry remains in the pool. Only a
matching insertion can be detached and transferred to accepted physical cleanup.
The fixed original selection never adopts later inventory. Admission refusals,
accepted uncertainty and status-publication failure all fail native acceptance;
each completed full logical lease is released by its independent batch owner.

Logical substitution transfers the complete lease without joining old exit. A
replacement Fresh preparation allowance is granted in the same P2 authority,
and a different guest is prepared before joining old cleanup. The original
required export is then checked through restored home bytes. Ordinary gated
owner tests establish live overlap; the native seam does not impose an old-exit
startup barrier or use logical removal as physical credit.

Replacement and restore enter the concrete borrowed incoming-owner transaction;
both original and incoming physical guests exist under the same host authority.
The replacement's prior exact owner requires real home export. Restore displaces
a tenant-free blank and then retires the restored exact owner through a guarded
batch, verifying its required home too. Aged replenishment drives the real
background component with an explicitly aged insertion and wraps new blank
preparation in a supplied Fresh operation. Its final park uses guarded acceptance.
Each scenario finishes its remaining pool inventory through the guarded batch.
These component seams do not activate the production composition root.

Caller-owned saving removes an ordinary exact reservation from inventory and
uses the borrowed `IdleActivationOwner`/tracked Supervisor entry after successor
cancellation before activation. Required preparation and freeze run under both
supplied allowances; exact backing exit, publication and factory tail must all
complete. No-progress owners remain separately retained through joined shutdown.
The original full logical lease is explicitly recovered for release only after
the cancelled caller's physical cleanup completes; a lost observer retains it.
This native seam proves required saving for that caller state; mocked partial
unpark/cancellation/panic regressions are separate, and the complete native dirty
activation/session/history corpus remains P3d.

Speculative saving unparks an exact reservation and invokes the real Executor
guest restore with a deliberately absent required timezone, before any business
process. It verifies the specific unavailable-timezone error before cleanup.
The failed preparation retains its original promotion/private context,
backing generation and full lease, then enters the same required covered cleanup.
Both fresh and snapshot modes verify saved ordinary home bytes and removal of
the predecessor private runtime. This fixture does not wire production policy or
replace the broader P3d session/history corpus.

Finalizing saving uses the real `IdleParkRequest` transition and exact
`ActiveRuns` broker. The parked case completes physical park; the running case
requests handoff before balloon submission and requires the provider's fenced
running result. Both carry the original backing proof through
`GuardedFinalizingOffer` and recover queued delivery on successor cancellation
in `GuardedFinalizingAdmission`. Required covered preparation, freeze, exact
exit, publication and factory tail must complete before release of the full
logical lease. Fresh and snapshot restores verify ordinary bytes and absence of
the predecessor private runtime. The native seam carries a local fixture claim;
ordinary provider-boundary tests verify preservation of real returned completion
authorization. This opt-in fixture is compiled by ordinary checks and requires
separate execution on the specified KVM/NBD host to establish native acceptance.

An accepted aged conversion transfers its full logical lease separately from
physical cleanup. Before blank creation it joins old cleanup; foreground
preemption releases that lease and the background CPU permit immediately even
when status or old teardown is held. Physical coverage and shutdown ownership
remain with the tracker, so logical release never predicts memory relief.

Supply `OKOU_TEST_RPC_BASE_DIR` as a disposable directory, plus
`OKOU_TEST_RPC_FIRECRACKER`, `OKOU_TEST_RPC_KERNEL`, `OKOU_TEST_RPC_ROOTFS`,
`OKOU_TEST_RPC_SNAPSHOT_DIR`, `OKOU_TEST_RPC_SNAPSHOT_HASH` and
`OKOU_TEST_IDLE_ROOTFS_HASH` from the matching artifact preparation. Each mode
creates its own temporary Runner workspace/cache below that base and shuts down
its own factory/runtime. No production Runner directory should be used.

`OKOU_TEST_IDLE_MEMORY_POLICY` must name a JSON file containing these required
current test-host measurements and limits (no defaults): `host_total_bytes`,
`operating_floor_bytes`, `cleanup_reserve_bytes`, `critical_available_bytes`,
`recovery_available_bytes`, `live_growth_bytes`, `tail_growth_bytes`,
`replacement_preparation_bytes`,
`max_sample_age_millis`, `max_operations`, `max_cleanup_inflight`. The guest shape
matches the canonical `vm0/default` definition: two vCPUs, 4096 MiB, 24576 MiB home.
The actual home preparation, snapshot creator, size checks and artifact receipts
share [the production profile definition](../../../runner-types/src/profile.rs).
The ordinary Rust-to-Python consumer test binds those dimensions to the strict
external reader. A current-profile native run requires a newly matching snapshot
and package at its pinned source; it must retain all collector/resource guards.
Size the disposable invocation's disk prerequisite from this shape rather than
the old 16 GiB capacity calculation; never lower an existing guard to obtain a run.
Archived 16 GiB results retain their original source, readers and fixed workload.
Changing the fixture shape does not requalify those measurements or choose a
production memory envelope.
The host observation is a real fresh `/proc/meminfo` read. Arithmetic validation
does not prove calibration or OOM safety. The test must have actual headroom;
rejected admission fails the test and uses the existing fixture cleanup path.

The pressure cases additionally require `pressure_sample_period_millis`,
`pressure_recovery_sustain_millis`, `pressure_wave_cooldown_millis`,
`pressure_optional_start_interval_millis` and `pressure_max_wave_entries` in the
same JSON file. All must be positive. They use the same P2 policy and real fresh
reader, and require an actual critical sample with enough covered cleanup
headroom on this disposable test host. Absent pressure, refused grants and
uncertain outcomes fail acceptance; the fixture does not manufacture pressure
or start business work. Shutdown joins sampling and accepted saving before
factory/runtime teardown. These two seams do not activate production policy or
replace the combined native pressure/session/history corpus in P3d.

```sh
cargo test --manifest-path crates/Cargo.toml --profile local --locked -j 1 \
  -p runner --test guarded_idle_native \
  guarded_terminal_saving_restores_home_without_private_runtime_bytes \
  -- --ignored --exact --nocapture
```

Ordinary CI compiles this fixture but does not execute its ignored native test.
Compilation or mocked proof does not establish native execution, real host
capacity savings, restored session/history correctness, or the parent P3d corpus.

## Measured terminal corpus

`native_terminal_corpus_records_data_and_phase_ownership` selects twelve cases:
exact and all-inventory retirement, caller-owned cancellation, speculative guest
restore failure, and parked/running finalizing cancellation, each with fresh boot
and the matching snapshot. It preserves the complete older fixture above.
Every case writes a 64 KiB home payload containing its original run identity,
saves it through the real owner, restores and verifies its digest, and checks
removal of the predecessor private runtime.

Compile this test with `OKOU_TEST_BUILD_SOURCE_SHA` set to the exact checked-out
commit. Prepare an immutable copy of the matching rootfs, kernel and Firecracker
under a new experiment root; never use an existing Runner workspace. The ignored
`prepare_native_terminal_snapshot` test creates a new matching snapshot directory
using these explicit inputs. Supply a new invocation-owned snapshot ID in
`OKOU_TEST_RPC_SNAPSHOT_HASH` before preparation and retain that exact value for
restore. The provider encodes this ID into the vsock bind path; replacing it with
a digest of the resulting files creates an incompatible restore path. File
digests are recorded separately. The fixture also requires
`OKOU_TEST_IDLE_ROOTFS_HASH`.
The rootfs must contain the current Guest programs and initialization settings.
An older packaged Guest can boot while failing the current control handshake;
prepare the image through the existing source-derived Guest build and rootfs
customization flow rather than relaxing the connection or data checks.

Select the executable from Cargo's `compiler-artifact` JSON for the
`guarded_idle_native` target with `profile.test` set, requiring exactly one
non-null executable. A dependency/profile change can change the executable's
filename; never reuse a previous filename or hash a different test binary.
For large rootfs and snapshot files, compile with
`--config 'profile.local.package.sha2.opt-level=3'` so their cryptographic
preflight fits the bounded collector's workload. Record that build option in the
experiment metadata; it does not establish a calibrated memory envelope.

`OKOU_TEST_TERMINAL_ARTIFACTS` names a JSON object with `source_sha`,
`test_binary_sha256`, `firecracker_sha256`, `kernel_sha256`, `rootfs_sha256`, `snapshot_id`,
`snapshot_files` (filename to SHA-256), `snapshot_preparation_sha256` and
`policy_sha256`. All hashes are lower-case hexadecimal. The test verifies the
compiled source value and hashes its actual
executable and supplied artifacts before starting a VM. Preserve the source
checkout and build log alongside the manifest; the compiled value is not a
signature proving where a rootfs was produced.
See [Snapshot creation input record](#snapshot-creation-input-record) for the
required record's generation and transport into the P1 bundle.

The measured factory adds an explicit **fixture** post-exit tail: it writes and
syncs 64 MiB in 1 MiB chunks, then reads and verifies every byte. The original full
logical lease must remain allocated throughout that accepted blocking IO. This
work belongs to the factory's joined physical tracker; it is not a calibration of
production teardown. `tail_growth_bytes` must cover at least the complete 64 MiB
file and 1 MiB buffer. All supplied policy bounds are test limits, and observations
below them do not establish a production upper envelope or OOM protection.

Each receipt records Linux monotonic and wall clocks, the original sandbox and
backing generation, a positive owned backing wait, physical-tail completion and
the restored data result. Case directories are removed only after success and
dependency shutdown. Failed cases preserve their directories and never emit a
completion receipt. Native admission, saving, teardown or data failures must be
investigated; forced cleanup cannot substitute for native success.

Run the exact test through the repository's bounded
[P1 collector](../../../../.github/scripts/runner-memory-calibrate.md), using
an owned driver that supplies these non-secret fixture inputs before executing
the native test binary. P1 deliberately removes the caller's environment. Put
`native_terminal_artifacts` in its metadata, containing the manifest plus
`profile: {"vcpu": 2, "memory_mib": 4096, "home_mib": 24576}` and
`required_fixture_tail_bytes: 67108864`.
The owned driver must also explicitly supply the standard system-tool PATH,
including `/usr/sbin` and `/sbin` for the provider's iptables, conntrack and sysctl
prerequisites. Keep the collector's environment isolation intact; do not inherit
the caller's credentials or substitute fake provider commands.

```sh
"$OWNED_NATIVE_TEST_BINARY" \
  native_terminal_corpus_records_data_and_phase_ownership \
  --ignored --exact --nocapture --test-threads=1

python3 crates/runner/tests/guarded_idle_native/report.py "$P1_OUTPUT_DIRECTORY"
```

The report requires all twelve cases, stable original identities, every phase
and actual samples in both live saving and the added required fixture IO. The
total post-exit window also includes publication and teardown before the added
tail starts. It reports
RSS/PSS **lower bounds**, sample/read age and host availability. Missing process
residency stays unknown; a missing phase/window fails validation. P1's generic
`calibrated` and `native_vm_exit_confirmed` flags remain false. Complete
session/history continuation, combined pressure/foreground/optional work and
native cancellation races remain the separate parent acceptance gate.

Ordinary `cargo test -p runner --test guarded_idle_native` executes the report
consumer's real-file regressions through Python 3 and compiles the opt-in native
tests. The report regressions do not substitute for executing KVM/NBD cases.
The ordinary provider-boundary refusal test also drives actual finalizing park
with controlled external park errors, an unexpected parked return and an
unexpected running handoff point. It verifies the original file bytes and cache
lock remain owned, the complete logical lease stays allocated and no destruction
occurs until explicit disposal of the ordinary mock fixture.

## Separately measured pressure paths

`native_policy_pressure_records_saving_and_free_logical_capacity` selects the
job-free independent pressure owner in fresh and snapshot modes. It requires an
actual fresh Proc/P2 observation at or below the supplied Critical watermark,
while its original full lease remains allocated and another complete profile
fits the logical budget. Its resolved one-entry wave and sampling/controller
shutdown have separate original-identity witnesses.

`native_logical_pressure_records_replacement_and_required_saving` selects logical
substitution in both modes. It requires exhausted logical capacity and actual
availability above the recovery watermark and the full profile/preparation plus
protected bounds. A different Guest must complete accepted preparation through
the same authority before original retirement joins are requested. This ordering
does not assert that old physical exit remains pending or impose an exit barrier.

Use the same exact-source binary, immutable artifact manifest, matched snapshot
creation identity, disposable base and P1 driver requirements above. Each path
uses a separate supplied policy and new P1 output directory; do not manufacture
MemAvailable, induce host-wide pressure or alter existing business resources.
P1 metadata additionally requires `native_pressure_kind` (`physical` or `logical`)
and `native_pressure_policy_json` containing the exact UTF-8 policy file contents.
Its SHA-256 must equal `native_terminal_artifacts.policy_sha256`. Scenario receipts
must agree with those exact parsed bounds and contain valid actual read/age and
budget observations. Missing, stale or mismatched conditions fail acceptance.

```sh
"$OWNED_NATIVE_TEST_BINARY" \
  native_policy_pressure_records_saving_and_free_logical_capacity \
  --ignored --exact --nocapture --test-threads=1

"$OWNED_NATIVE_TEST_BINARY" \
  native_logical_pressure_records_replacement_and_required_saving \
  --ignored --exact --nocapture --test-threads=1

python3 crates/runner/tests/guarded_idle_native/pressure_report.py "$P1_OUTPUT_DIRECTORY"
```

Each report requires its complete two-mode corpus, original data/backing/full
lease/required IO and actual P1 windows, plus pressure or different-Guest/join
witnesses. The original twelve-case terminal report remains separate and strict.
Ordinary Cargo/default Crates CI runs the pressure report's real-file and CLI
regressions through its ordinary Rust wrapper; the native entries remain opt-in.

The physical label means observed policy classification under supplied disposable
test limits. It does not prove calibrated real-host shortage, RAM relief, a
production envelope or OOM protection. Residency unknowns remain lower bounds;
rootfs producer provenance, complete continuation, optional/foreground/recovery,
native races and parent numerical/aggregate acceptance remain separate gates.

## Complete native session/history continuation

`native_continuation_records_complete_session_history_and_required_saving`
selects ten cases: logical admission, replacement, reserved restore, aged
replenishment and nonzero terminal saving, each with fresh and snapshot factories.
It runs the public Executor and packaged mock Codex app-server against an owned
synthetic history/storage/finalization peer. Every byte of the original committed
JSONL and its canonical thread must survive native preparation/execution, final
metadata, export/freeze, original positive backing wait, saved-home continuation
and joined continued saving. The actual process checks the original full prefix
and 64 KiB home payload.

Nonzero execution must retain complete history/home data and withhold reusable
session identity, matching Executor's success-only finalization contract. Its
first successful continuation therefore restores the complete supplied history
without a prior cache history binding; that successful assignment must produce a
new verified identity. The next assignment must consume the resulting bound
history, and joined saving must preserve the final verified cache identity.

After saving the first continuation, a second Executor assignment reopens that
image and checks the entire continued history and original home again. Its own
fresh final identity goes through required saving, so validation preserves a
usable session/history binding in the final cache rather than promoting a
read-only assignment without an Agent identity.

Keep the existing artifact and supplied P2 policy environment. Additionally set
`USE_MOCK_CODEX=true` and `OKOU_TEST_NATIVE_API_HOST` to the authorized test host's
actual private IPv4 address reachable by its disposable Guests. The synthetic peer
uses no real model credentials. Missing input, verified final identity, matching
artifacts or safe headroom fails the native run.

The synthetic Agent request explicitly supplies the canonical Guest HOME with
its mock scenario/timestamp environment; the fixture does not assume an inherited
shell environment when the control server starts the Agent.

Select the exact ignored entry through bounded P1. Its metadata must contain
`native_continuation_policy_json` equal to the raw supplied policy file bytes.
Validate the resulting directory:

```bash
python3 crates/runner/tests/guarded_idle_native/continuation_report.py <p1-directory>
```

The strict report preserves original terminal phase/wait/tail requirements and
binds complete input/original/continued history and home hashes, distinct run and
Guest identities, actual policy/observation and final identity/cache/saving proof.
It rejects incomplete, duplicated, mixed, truncated, stale or mismatched evidence.
The original lease has a non-owning test-support witness which survives an atomic
one-for-one same-shape substitution. An unrelated reservation cannot replace it.
Production builds allocate no witness and change no memory policy or protocol.

Default Crates CI runs the ordinary Rust wrapper and ten real-file/CLI report
regressions, the resource-budget lifetime/transfer regressions, and the synthetic
peer's complete-history prepare/upload/completion round trip through its separate
Guest and loopback Host listeners. A separate peer regression requires rejection
as soon as a chunked request exceeds 4 MiB, before its terminating chunk or EOF;
the peer enforces this bound while reading, before buffering the complete request.
Actual KVM/NBD
cases remain ignored/opt-in and require separate submitted-source/binary/artifact
verification. Terminal12 and pressure4 contracts remain unchanged. The remaining
optional/recovery/full failure/race, provenance/residency/conservative-envelope,
parent aggregation and P4 activation gates remain #39997/#39998 and the parents.

## Actual create cancellation and rollback

`native_create_cancellation_retains_actual_transaction_through_rollback` selects
`CreateCancellation-fresh` and `CreateCancellation-snapshot`. It creates the
actual provider home image, reads its complete 1 KiB ext4 superblock, and holds
the original transaction inside a separate blocking Unix read. The non-default
`sandbox-firecracker/test-support` checkpoint is invocation-owned; default
production factories expose no checkpoint. This establishes accepted physical
creation custody after real file preparation, without claiming stalled storage.

Cancellation must leave both original and creating full leases and the same P2
Fresh allowance alive through positively Pending dropped/replacement observers,
foreground CPU admission, an acknowledged heartbeat and an independent actual
host-memory read. Positive workspace deletion is observed before the final
custody drops. No new Guest is returned or published. The cancelled Fresh row
remains registered and uncertain with its entire original growth allowance,
including at P2 shutdown; cleanup is not numerical memory credit. The existing
original immutable snapshot/home, exact backing exit, durable 64 MiB tail,
restored original data and all provider/factory/runtime joins remain required.

Set `OKOU_TEST_OPTIONAL_MEMORY_POLICY` to a JSON file containing the original
`snapshot_path`, `snapshot_memory_mb` and `prefetch_overhead_bytes` inputs.
Supply exact raw metadata fields
`native_create_cancellation_policy_json`,
`native_create_cancellation_inputs_json`,
`native_create_cancellation_snapshot_bytes` and `native_terminal_artifacts`.
Validate all bounded P1 files with:

```sh
python3 crates/runner/tests/guarded_idle_native/create_cancellation_report.py <p1-directory>
```

The report checks actual superblock bytes/hash, distinct new workspace identity,
original source/input identity, fresh sustained observations, cancellation and
cleanup clocks, original full resources, pending observers and preserved Fresh
uncertainty. Real-file/CLI refusal tests run in default CI; actual KVM/NBD remains
opt-in. This completes only #40786. Returned actual Guest/late results (#40787)
and post-merge reconciliation (#40788), production activation, numerical relief,
full residency, calibrated envelopes, unknown bootstrap provenance and OOM
protection remain open under #40760 and the delivery parents.

## Actual returned Guest cancellation and late cleanup

`native_returned_guest_cancellation_retains_actual_stages_and_late_cleanup`
selects actual successful start, home-mount RPC and reusable park, each in fresh
and matching-snapshot factories. Before these six cases accept creation, a real
pool acquisition must poll Pending, cancel under foreground CPU preemption and
join while the pool remains held, without entering the provider or P2.

The feature-only, invocation-owned checkpoint holds a separate Unix read after
the actual stage succeeds. It retains the exact returned Guest, ext4 home UUID
and backing generation. Draining cancellation, dropped and replacement Pending
observers, foreground CPU, acknowledged heartbeat and independent host observation
must preserve both full leases and original Fresh growth. Releasing the stage
must join a late cancelled success without preparing or publishing inventory.

Invalid publication enters the existing required cleanup engine. Actual factory
destruction, exact backing wait and workspace absence precede a second owned IO
checkpoint. Heartbeat and observation progress while required tail accounting,
uncertain Fresh growth and both full leases remain held. Only positive cleanup
completion releases the new lease; the original lease/data survive through all
producer joins and the inherited original saving, complete snapshot hash, durable
64 MiB tail and exact original backing exit. P2 close retains the cancelled Fresh
row and its complete growth; no numerical credit is inferred.

Supply `native_returned_guest_policy_json`, `native_returned_guest_inputs_json`,
`native_returned_guest_snapshot_bytes` and the original terminal artifact metadata.
The nine ordered phases per case are checked with the inherited physical proof:

```sh
python3 crates/runner/tests/guarded_idle_native/returned_guest_report.py <p1-directory>
```

Default Cargo executes the real-file/CLI refusal contract. KVM/NBD execution
remains opt-in. Checkpoints establish late result custody, not stalled storage or
Guest transport. This completes only #40787; #40788 still requires both merges
before final ancestor reconciliation. Production Reactor/P2 activation, full/cold
residency, calibrated envelopes, unknown original bootstrap provenance, numerical
relief and OOM protection remain unverified.

## Two required histories in one physical cache entry

`native_same_entry_replacement_preserves_both_required_histories` selects original
success and nonzero exit, each in fresh and matching-snapshot factories. Both
Guests run the real Executor and packaged mock Codex, with distinct committed
sessions, complete history bytes, ordinary home files, private run files and
64 KiB home/workspace payloads. The original promotion holds the physical cache
entry's exclusive lease. Incoming therefore first completes with `LockBusy`;
its exact Guest and full logical lease remain owned through the existing C6
replacement, stale-batch refusal, contention and required-saving guards.

Both assignments use an ordinary workspace directory inside the home image.
The context declares no external workspace artifact, giving the required home
owner custody of every workspace byte through successful and failed terminals.
Versioned artifact re-materialization belongs to its separate storage contract.

The fixture restores and saves the complete original generation before allowing
supersession. It then activates that same incoming Guest through the public idle
owner and actual Executor reuse dispatch. This acquires the now available same
physical entry and extends the incoming session. A valid promotion produced by
that execution must survive guarded retirement, after which an independent
Executor restores the complete first-plus-continued history and home/workspace
bytes. Both restoration producers, API peers, physical backings, full logical
leases, tracker and memory operations must join. Accepted native work remains
outside the race's observation timeout; failures preserve its owners.

Use the immutable artifact, supplied P2 policy and bounded P1 requirements above,
including `USE_MOCK_CODEX=true` and the authorized `OKOU_TEST_NATIVE_API_HOST`.
P1 metadata must contain `native_dual_history_policy_json` with the exact raw
policy file text and the original `native_terminal_artifacts` manifest.

```sh
"$OWNED_NATIVE_TEST_BINARY" \
  native_same_entry_replacement_preserves_both_required_histories \
  --ignored --exact --nocapture --test-threads=1

python3 crates/runner/tests/guarded_idle_native/dual_history_report.py "$P1_OUTPUT_DIRECTORY"
```

The strict reader requires all four cases, complete canonical byte oracles,
actual same-entry/generation bindings, private-directory removal and positive
producer joins in addition to every C6/P1 guard. Ordinary Cargo runs its
original-file and CLI refusal regressions. Native KVM/NBD execution remains
opt-in. This phased sequence does not claim simultaneous promotion leases,
permanent retention of two cache generations, an actual API claim-loss race,
calibrated physical relief, full residency, bootstrap provenance or production
activation. Parent aggregate acceptance remains separate.

## Real API competing claims (#41467)

`native_real_api_competing_claims_preserve_both_owners` composes two independent
native guarded preparations with the production authenticated claim route and
invocation-owned PostgreSQL. The explicit API entry constructs synthetic actors,
predecessors and candidates through public onboarding/chat/Runner/callback
interfaces. Its loopback listener mounts existing production routes only. The
canonical external-provider registry supplies synthetic external services.
No development server or production account/database is used.

The transport waits for both actual requests and both positively observed native
owners, then forwards A first, B first, or both concurrently. It never selects a
status. Each order covers fresh and newly matching-snapshot Guests. Concurrent
release observes overlapping HTTP lifetimes; it does not establish an internal
database schedule. Before releasing a successful response, the bridge records
the actor's public running state. Each pending native owner also records an
independent host observation while its pool blocks heartbeat publication, then
joins the acknowledged heartbeat after releasing that pool. The winner keeps its original returned context and token,
executes one exclusive synthetic GuestRPC task, and completes through the public
protocol. The loser reparks through production guarded rollback. Both complete
the existing full home/data, 64 MiB required saving, private-runtime removal,
physical-exit and full-lease/accounting checks. The independent heartbeat peer
checks acknowledged HTTP progress; it is distinct from the real claim API.
This seam does not run the complete Executor/framework CLI or certify CLI session
history, calibrated host envelopes, bootstrap provenance or production protection.

Freeze the source, actual Host and all eleven canonical Guest binaries. Verify
the installed Guest bytes in an owned rootfs and create a new matching snapshot
with this Host. Keep the original snapshot preparation record. Start an owned
loopback PostgreSQL cluster in UTC and apply normal migrations; the ordinary API
global setup supplies canonical baseline catalog seeds. Retain the producer's
cluster system identifier, binary/version, data directory, migration receipt,
source manifest and native input hashes in an owner-only `producer.json` with
format `native-real-api-producer-v1`.

From the API workspace, under an owned private mount namespace with native
privileges, run `pnpm test:native-competing-claims`. Supply
`OKOU_TEST_REAL_API_INPUTS` pointing to a bounded owned JSON containing `root`
(a new results directory with `producer.json`), `driver` (the frozen
`real_api_driver.py` here), `sourceSha`, `databaseUrl` (the owned cluster), and
`producerFile` (the same producer receipt). The driver documents its frozen input
paths in code and refuses source/input changes. It uses unchanged P1 duration,
sampling, headroom, log and cleanup guards. Failed cases retain original evidence
and uncertain ownership; diagnose them before starting a new invocation.
Disk preflight reserves four complete profile-sized Home images for the two
original owners and their saved-home verification; existing rootfs and snapshot
inputs are already allocated. This is a fixture capacity check, not a measured
production storage envelope.

```bash
python3 crates/runner/tests/guarded_idle_native/real_api_claim_report.py <results-root>
python3 crates/runner/tests/guarded_idle_native/real_api_claim_report_test.py
```

The original-file reader requires all six scenarios/twelve owner paths, genuine
200/404 results, original authority, public winner/completion, exact source and
producer/snapshot/policy bindings, complete data/full leases and joined owners.
Its ordinary synthetic CLI mutation tests do not supply native acceptance. Keep
evidence private because original synthetic authorization is deliberately
retained. Missing native evidence blocks readiness; #39998 stays open.
