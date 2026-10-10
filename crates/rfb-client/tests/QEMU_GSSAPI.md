# RFB/GSSAPI protocol tests and optional QEMU interoperability

This is engine/protocol interoperability, not Owner→Agent→Runner product acceptance, compatibility with every VNC server, merge permission or production activation. #37612 leaves #37613 and `VncAccess.enabled: false` unchanged. SCRAM remains a separate profile; rsasl's ambient GSS backend is not enabled.

## Protocol scope and routine CI

VNC uses RFB; QEMU is an external server implementation, not a runtime dependency
of this client. Routine PR, main and merge-queue CI test the Rust client and its
real native MIT worker, independent MIT/KDC acceptor and controlled RFB peer.
They do not download/build QEMU or prepare its firmware, private server bundle,
reproducibility candidates or full-frame acceptance artifacts.

This change is a testing-scope decision, not a protocol implementation change.
The current `authenticate_qemu_gssapi` API explicitly selects the verified-X509
**263 compatibility profile**. QEMU9.2 assigns X509SASL263/TLSSASL264, unlike the
published RFB extension's TLSSASL263/X509SASL264 assignment. This API does not
claim generic standards-X509SASL264 support and does not silently alias264 or
admit anonymous TLS. The client's other RFB profiles remain unchanged.

QEMU-specific interoperability and screenshot validation below are separate
checks, not routine CI. Their missing controller/pins or incomplete provenance
must be reported as unverified QEMU coverage, not used to infer protocol success
or block the controlled-peer CI scope. This does not waive separately scoped
full-fixture acceptance: input, identity, resource, lifetime and teardown
requirements still apply, and Rust CI does not establish a real-server pass.

## Optional QEMU server and independent client identity

The local server is QEMU **9.2.0**, source commit `ae35f033b874c627d81d51070187fbf55f0bf1a7`, archive SHA256 `f859f0bc65e1f533d040bbe8c92bcfecee5af2c921a6687c652fb44d089bd894`, `ui/vnc-auth-sasl.c` SHA256 `3dfd2c4be76597983641fde3d99b64ac5b0d6a56b59e4d6a08edacc95075bc2d`. The audited local fixture binary is SHA256 `cef1a9a4a18daad78f74b4997fafdb3c18aeaead1596732bf6c5bc5bb32eabc8`; the harness refuses a substituted binary. QEMU 8.2.2's GSS token/NUL behavior is not a reason to weaken parsing.

Independent private server/KDC libraries came from signed official Ubuntu Noble package indexes: Cyrus `2.1.28+dfsg1-5ubuntu3`, MIT `1.20.1-6ubuntu2`, GnuTLS `3.8.3-1.1ubuntu3.6`. These are fixture identities, **not** the production client's maintenance/security baseline. The client uses the sealed, separately built MIT1.22.2/musl worker described in [`../../kerberos-worker/README.md`](../../kerberos-worker/README.md).

TLS `localhost`, the loopback TCP destination and the explicit same-realm `vnc/<fixture-instance>` service are independent identities. The library does no TCP/DNS/KDC discovery. Two synthetic realms use independent exact caller routes, locally generated AES17/18 keytabs/passwords/service-only caches, and a private synthetic TLS CA. Password leading/trailing spaces are intentional. None is a real account credential.

## Start with direct Rust tests

Ordinary client changes do not need a rebuilt QEMU/server runtime:

```bash
cargo test --manifest-path crates/Cargo.toml --profile local --locked -j 1 \
  -p kerberos-credentials --test credentials
cargo test --manifest-path crates/Cargo.toml --profile local --locked -j 1 \
  -p rfb-client --test qemu_gssapi_framing
cargo test --manifest-path crates/Cargo.toml --profile local --locked -j 1 \
  -p kerberos-worker --lib
```

The latter two compile the genuine pinned MIT worker when Cargo needs it; this
is not a system-GSS substitute. Cargo reuses unchanged build inputs normally.
Real independent-peer/lifecycle tests still need their signed private MIT/KDC
fixture, but not a QEMU source build. The two native CI matrices and their
fail-closed gate retain their existing selection on both x86-64 and ARM. A
selected native test must succeed: failure, cancellation or unexpected skipping
still fails the gate. These checks verify native containment and independent
mutual-GSS/RFC4752/TLS/RFB behavior, not a QEMU server implementation.

The Crates workflow has no QEMU candidate job, selector, artifact or gate
requirement on PR, main or merge-queue events. The optional QEMU producer and
full fixture remain explicit tools, not a hidden dependency of Rust tests.
Their runtime/PNG results are not implied by Rust CI. No worker, peer, package,
profile, resource budget or existing security assertion is weakened.

## Optional QEMU reproduction

For a separately requested QEMU interoperability check, use the pinned private QEMU/server-runtime build described above, not a system GSS client or an arbitrary executable override. From the repository root:

```bash
python3 crates/rfb-client/tests/fixtures/qemu_gssapi.py \
  --runtime-dir codex-work/probe/issue-35048-gssapi/root \
  --qemu codex-work/probe/issue-35048-gssapi/qemu-build-9.2.0/qemu-system-x86_64
```

Both modes require a nonsymlink `provider.json` recording the actual private runtime's package identities and extracted regular-file SHA256 values. Those records must come from verified signed official archives, not from hashing an arbitrary installed tree. Before compiling, generating credentials or starting a KDC/QEMU, the harness rechecks every recorded file, the used MIT/KDC tool paths and contained library aliases. The manifest and each required native MIT/Cyrus/GnuTLS package must declare the selected Debian architecture (`amd64` for `x86_64-linux-gnu`, `arm64` for `aarch64-linux-gnu`); a matching layout/version string alone cannot admit an absent or cross-target architecture record. Full mode additionally requires the pinned Cyrus/GnuTLS package records, Cyrus GSS plugin and BIOS file records. A missing/mismatched record or escaped alias refuses; there is no legacy manifestless full-mode fallback. The independent-MIT provisioning script produces only the controlled-peer runtime; it does not produce the complete QEMU/Cyrus/GnuTLS/BIOS bundle. The historical full command above therefore still needs separately verified full input artifacts and a reproducible provision/build recipe; this input guard is not a new full-QEMU runtime receipt.

The full fixture's explicit `pinned-host` independent MIT acceptor remains distinct from the controlled fixture's `signed-private` acceptor. Its host package-version check is not an actual loaded-library hash/loader map. Private file/manifest equality likewise does not prove exhaustive transitive dependencies, plugin loading or the original historical runtime. Those acceptance boundaries remain required, not waived by this preflight or the controlled-peer receipt.

The harness compiles the current Rust test target and owns only its synthetic loopback listeners/processes/private generated directory. Secrets go through private stdin/files, never CLI arguments or environment values. Public fixture-directory/stopped-KDC indicators select the opt-in test target; default ignored tests are not an acceptance result. Cargo/test descendants run in an owned process group. Its single local owner requires default SIGCHLD and observes leader completion with `waitid(WNOWAIT)`, retaining the leader even after exit until the final destructive group signal. The prior calling-thread signal mask is queried without mutation before spawning, so a query failure owns no child. Cleanup masks SIGINT and the executable's exception-raising SIGTERM across group termination, bounded leader reap and adopted-child/group checks. Termination/reaping and mask restoration are guarded independently of the mutating mask call: if it changes the native mask and then raises, the retained group is still killed, its leader/adopted children reaped and the original mask restored before propagation. Cleanup/restoration failures remain visible; no destructive numeric-group signal occurs after leader reap. Four real standard-library child regressions cover interrupt/allocation failure after actual mask mutation with completed or deadline-cancelled leaders and an adopted same-group descendant, including original nonempty mask, FD count and actual process/group disappearance. A separate query-refusal regression verifies no child starts. An observed lost child reservation refuses without signalling. The harness is a subreaper and verifies same-group descendant termination/reap, listener closure and exact secret-tree removal even on timeout/failure. Real standard-library child regressions cover completed and active leaders, actual SIGINT at the waitpid boundary, actual SIGTERM before the first group kill and after leader reap with a real adopted same-group sleeper, deadline and nonzero status, ECHILD refusal, ignored SIGCHLD and an actual adopted same-group descendant. Negative controls intercept unsafe old-source signals rather than deliver them to an unowned group. These scoped tests do not admit arbitrary interpreter signal state, concurrent external reapers, constructor interruption or escaped process groups, nor replace the native/full-private fixture. Actual native child reaping is checked by process tests and completed-context/finality controls, not inferred merely from the intentionally unlinked input directory. Do not use external hosts/KDCs, public ingress, global Kerberos/PAM/SSH settings or retained credentials.

## Optional full-private candidate producer

```bash
bash .github/scripts/check-full-qemu-producer.sh
```

The optional native x86_64/aarch64 producer tool downloads the complete
Depends/Pre-Depends closure from signed Ubuntu snapshot `20260521T000000Z` into
an empty private APT state. Both architectures select the official explicit
`https://snapshot.ubuntu.com/ubuntu/20260521T000000Z` origin; no unsupported ports
snapshot auto-negotiation, current pocket or unauthenticated fallback is used.
An owned startup `APT_CONFIG` excludes global main/fragments/trust directories
before APT loads them; the copied Ubuntu keyring and borrowed APT/gpgv/dpkg parser
bytes are recorded separately from the private native compiler/runtime closure.
Exact MIT/Cyrus/GnuTLS identities above are retained; compiler, libc, Python/venv,
shell/tools and development seeds are explicit. Dash `0.5.12-6ubuntu5` supplies
the archive-provided `sh` realization required by the pinned configure's
`#!/bin/sh`; Bash alone does not satisfy it. Signed `bzip2` `1.0.8-5.1`
supplies the CLI required by the selected `x86_64-softmmu` installed-firmware
Meson path; `libbz2` alone does not provide that executable. Signed `diffutils`
`1:3.10-1build1` supplies the unconditional QAPI-schema Meson-setup `diff` lookup;
disabling docs/tools does not remove it. The firmware/options and upstream setup
are not changed to avoid these requirements. Before any source execution the
producer checks contained, executable native bytes for that exact interpreter,
configure/generator coreutils, `sort`, archive/assembler/symbol tools, private
GCC `cc1`/`collect2` and required compiler/Python/build tools, retaining their file/mode/hash roles in
the input-closure binding. Full-private admission rechecks each declared role's
actual contained canonical target, native header, digest and exact executable
mode, rather than trusting a mode hashed only in metadata. This is not complete
transitive loaded-byte attribution, complete Python/venv/compiler data closure,
or proof of which subordinate tools actually ran. The private-root package
inventory still needs a separately reviewed exact immutable/mutable mount
contract; repository/proc/device/ephemeral mounts cannot be equated with the
pre-mount extracted tree or excluded by broad pathname prefixes.
Archive hashes are checked against signed metadata before collision/path-safe
extraction. Package tar members are read incrementally: at most 50,000 non-root
entries and 50,001 yielded logical entries, including skipped root headers. These
are not physical extension-header counts. Separate parser guards precede GNU/PAX
payload reads and recursive interpretation: 200,001 physical headers per package,
64 KiB per extension, eight-MiB aggregate extension bytes, chain depth eight,
128 MiB per effective file, 4096-byte effective name/link/user/group strings,
32 MiB aggregate name bytes and 100,000 retained PAX-key applications. Old GNU
and PAX sparse maps remain supported under explicit block/extent/logical-byte
bounds and physical-data accounting; they are not blanket-rejected. No excess
prefix is silently truncated or extracted.

Original package collection is incremental and bounded before any package decoder:
200 archives, 202 physical directory entries, 128 MiB per regular original and
512 MiB aggregate compressed bytes, using the existing custody limits. Hashing
reads a held readonly original FD under the remaining compressed budget.
Acquisition uses nonblocking/no-follow open followed by immediate held-FD
regular/owner/size checks: replacing a collected regular pathname with a FIFO
without a writer refuses rather than blocking before the decoder deadline.
The basename is only an untrusted private-APT selector; the signed record's exact
SHA256, size, native-or-all architecture, origin and pinned version must match
before control parsing. Control and data decode that same held inode, not a
later pathname replacement. Stat-change detection does not stop external writers
and is not a complete source seal or mounted-input admission.

The maintained control reader has a separate four-MiB physical file ceiling,
including its intermediate spool, and at most 64 KiB captured field bytes with
4096 bytes per selected field. Its private TMPDIR is producer-owned; there is no
ambient OS-temp fallback. Complete internal control member/count/inflation
accounting, private-APT metadata-output bounds and whole-download limits remain
open. No maintainer program executes.

The exact `/usr/bin/dpkg-deb` filesystem decoder runs under `/usr/bin/prlimit`
with controlled PATH+LANG and private TMPDIR, closed stdin, discarded stderr
(not an unbounded PIPE), core-off and at most 256 MiB address space, 32 FDs and
30 CPU seconds. Inherited smaller limits are preserved. The existing 512 MiB
stdout ceiling is enforced by the kernel before file growth, not after decoding.
The 30-second completion phase uses `waitid(WNOWAIT)`, never a reaping wait/poll:
an interrupted owned leader remains reserved until its group is signalled.
Nondefault SIGCHLD ownership is refused before spawn; a lost child reservation
never authorizes a numeric group signal. SIGINT and SIGTERM are blocked only during
critical group termination and the five-second leader reap; the caller's mask is
restored afterward. Inside this masked phase, a caller-installed raising SIGTERM
handler is deferred until after the retained-leader reap. No handler or default
SIGTERM disposition is changed. The prior mask is captured by a nonmutating
query before spawn, while no child is owned. Cleanup and restoration are guarded
independently of the first mutating mask call: if native blocking succeeds but
that call raises, the retained group is still terminated and its leader reaped
before restoring the original caller mask and propagating the failure.
Normal reaping is outside the signalling handler, so an interruption after
`waitpid` cannot signal a released/recycled group. This is not proof of grandchild
reaping or an external source seal. Both borrowed executable hashes enter bootstrap
metadata;
a pathname/hash record is not race-free executed-inode or loader attestation.

One provision-wide ledger charges every physical header, including skipped roots
and extensions, before interpretation (400,000 total), decoded output (four GiB),
regular-header logical bytes (four GiB) and path/link strings (64 MiB) before
extraction. Repeated identical collisions still consume these work budgets;
collision hashing uses bounded chunks and checks sizes rather than an eager
whole-file read. Separate monotonic output reservations now precede each maintained
extraction write: at most 20,000 root/entry/implicit-parent nodes, eight MiB of
initial-plus-rescan child-name bytes, 128 path components, 4096 path bytes and
two GiB over regular filenames. Every hardlink filename charges its target's
logical size, not just newly allocated disk blocks. Existing entries are scanned
incrementally without following aliases; reservations use the current resolved
parent after prior real writes, so changing a directory alias cannot reuse a
stale archive-name charge. Collision checks run again before each real write;
a later regular or hardlink header cannot resize an inode already shared by
hardlinks or write through a newly created dangling leaf alias. For an existing
hardlink destination, the maintained EEXIST copy fallback's archived bytes—not
the zero-sized link header—must match the existing regular file. Each potential
hardlink copy also consumes the same four-GiB work capacity before late collision
hashing or writing, even when its filename was already reserved; only regular
preflight collisions are hashed before that per-member reservation. Reservations
and collision checks run at the actual maintained `_extract_member` entry, not
only a top-level member iterator. EEXIST/missing-target fallbacks can materialize
an archived entry at a different destination: that actual type/link/metadata is
filtered at its new location before its own unlink/truncate/attribute operation.
The original archive name/offset is retained for maintained recursive lookup;
contained relocated symlinks remain supported, while a relative link that would
escape only after relocation refuses. Security-updated maintained extraction
passes `filter_function`/`extraction_root` through the same recursive boundary
and returns `(filtered, original)` from its preparation method. That context is
forwarded unchanged and the filtered entry selected; there is no TypeError retry
through an older/unfiltered path or replacement of the maintained policy. This is not an atomic whole-archive write
barrier: earlier bounded entries or enclosing implicit parents can remain after
refusal. Private CPython extraction methods still require complete version/TCB
admission independently of these scoped guards.
Deleted/replaced entries do not reclaim reservations.
The production ledger conservatively reserves 128 MiB each for the future QEMU
binary, two BIOS copies and CA bundle, plus declared aliases/mountpoint names;
CA concatenation is streamed under its reserved ceiling. The maintained extractor
still owns GNU/PAX/sparse/link semantics and delayed directory attributes.

These bounds are not a filesystem/source/writer seal or complete future-output
admission. Failed extraction can leave its bounded earlier prefix; the provision
attempt terminates, not retries that ledger. Control member/inflation accounting,
complete parser/bootstrap TCB, externally mutable paths/inodes, all future
transformations, descendant ownership and whole-provision timing remain separate
obligations; the complete final-tree measurement is still mandatory.

Public ar/tar canaries exercise the real installed data decoder and parser,
including inherited memory/file limits, exact logical-entry capacity, skipped
roots, PAX/GNU/sparse positives and refusals, cross-package quotas and streamed
collision behavior. Additional real-control cases check held-original decoding
and oversized physical control refusal; ordinary IO cases check incremental
compressed quotas, FD closure and a real writer change. Output cases check
implicit parents before writes, exact node/name/byte edges, repeated equal files,
changing real aliases, pre-existing entries and reserved future capacity. A genuine
sparse file plus hardlinks reaches the exact two-GiB filename sum without dense
input; the next name refuses. Over-depth input refuses before any directory is
created. An AST ordering check is structural evidence only, not a signed-provider
execution receipt. A real-data isolated-caller regression injects initial SIGINT
or raising SIGTERM after kernel-confirmed unreaped completion, then actual SIGTERM
before the real group signal. It verifies the reserved decoder is reaped before
the pending handler propagates, with unchanged original bytes and closed FDs;
its negative teardown only reaps the already-exited owned child. Four additional
isolated cases combine initial SIGINT or raising SIGTERM with an interrupt or
allocation failure after actual native mask mutation. They verify unchanged
input bytes and FD counts, restored masks, one reserved group signal, actual
leader reaping and absence of private decoder directories. They do not admit
constructor interruption, arbitrary raising handlers or concurrent reapers.
Other real-data cancellation regressions inject actual SIGINT after unreaped completion and
immediately after actual
`waitpid`, before maintained `Popen.wait` return-code bookkeeping. Observers
preserve real decoder/status syscalls; a possible unsafe signal attempt in the
old-source negative control is intercepted rather than sent to an unowned group.
They contain no package programs or maintainer scripts and prove neither
signatures, original input provenance nor native admission.
No package installation or maintainer script runs. Declared usrmerge,
compiler/rmt/UTC aliases and a bundle of signed public CA certificates replace
only their normal maintainer-generated inputs. Dangling package documentation
and non-C locale aliases remain recorded, not executable/library/configuration
inputs or host fallbacks. The exact usrmerge alias map is input-bound: x86 requires
its contained `usr/lib64` target; ARM creates no `lib64` alias when the signed
inputs supply no target. Existing wrong/escaping aliases are refused, not ignored.

QEMU9.2 source and VNC hashes are unchanged. The 135,188,800-byte compressed
original is acquired once with nonblocking/no-follow flags and must be an
ordinary-owner regular file of that exact size. Incremental held-FD hashing and
maintained XZ decoding borrow the same original inode, rather than reopening its
pathname after the digest. Observed held-inode drift before or after decoding
refuses; the owner closes its descriptor on success, borrower failure or SIGINT.
The owner callback is registered before acquisition. The CLI's handled SIGINT
and raising SIGTERM are deferred on the calling thread until the raw descriptor
is assigned to that owner. A nonmutating empty mask query captures the caller's
prior state before the guarded mutation; even a mutating mask call that raises
after native success restores that prior mask. Isolated real-file/FD/signal tests
cover both acquisition interrupts and an actual-mask-changed failure, checking
EBADF, unchanged FD counts/input bytes and mask restoration. This does not admit
arbitrary raising signal handlers, concurrent interpreter/reaper state or an
external writer/controller seal. The same raw-descriptor owner now covers held
package archives and all five public-retention directory descriptors plus its
source/output files; buffered readers/writers borrow with `closefd=False`.
Previously those sites acquired before registering closure or constructing a
buffered owner, so a handled post-open interrupt could leave a real FD live.
Thirty-four isolated real-file/directory cases cover SIGINT, raising SIGTERM,
interrupt/allocation failure after actual native mask mutation at each of the
eight package/retention acquisition sites, and both buffered-borrower allocation
failures. They check EBADF for every acquired original, unchanged FD counts and
public source bytes, no acquisition at the failing mask boundary and exact prior
mask restoration. Registration is with the caller's already-entered owner before
opening, not a new descriptor context that later transfers into `enter_context`.
An owner with live descriptors defers the handled signals before `ExitStack`
consumes any callback; each raw close also independently guards querying/blocking,
closes even if that mask call raises, and restores the prior mask only afterward.
A refused acquisition with no live FD performs no extra mutating retirement call.
Neither path retries a numeric FD after a native close may have succeeded. Fifty
more real-signal/mask cases cover registration while prior FDs are live, single
retirement-entry and final-close SIGINT/raising SIGTERM at all nine
QEMU/package/retention sites, and actual native retirement-mask mutation followed
by interruption/allocation failure.
All 84 cases retain the raised exception/traceback while verifying every original
is already EBADF, rather than relying on generator garbage collection. Each
retirement-entry injection identifies the selected descriptor's actual registered
owner, not an earlier nested owner while that descriptor happens to remain live.
A concrete `ExitStack` owner now surrounds generator entry and exit as well:
masking inside the generator would run too late for an interrupt in contextlib's
pre-resumption exit wrapper. Twelve additional cases inject that exact wrapper
handoff for package/QEMU/source/output originals and actual retirement query or
restore failures, retaining tracebacks through EBADF/count/mask/source checks.
The owner shields generator resumption before consuming callbacks; a failed
context entry enters guarded retirement directly, without the interruptible
`ExitStack.close` wrapper. Four additional isolated cases use naturally refused
empty-package or wrong-size QEMU inputs and send the first SIGINT or raising
SIGTERM at that owner's actual stdlib cleanup handoff. They retain the exception
and original validation cause through EBADF, FD-count, mask and public-byte checks;
no decoder or provider identity is substituted. This covers failed entry after
acquisition, not general Python opcode/allocation atomicity.
Partial retention remains incomplete data, not a completion record or permission
to retry/overwrite. These scoped tests do not admit general atomic acquisition,
arbitrary/repeated cleanup interruptions, constructor/reaper ownership,
source writers or full-private/controller/TCB interoperability.
Real path-replacement tests read the original XZ bytes after swapping the named
file, and a real FIFO with no writer refuses without blocking or creating a
child. Exact-size wrong-digest, actual-writer and buffered-borrower cases cover
separate refusal/FD-ownership outcomes. These are scoped input-custody and
handled-interrupt regressions, not general atomic acquisition or an external-writer/source seal.
The maintained in-parent XZ decoder's dictionary, decoded physical-byte, EOF,
CPU/time and complete dependency/IO bounds remain independently unadmitted.
Exact source admission also requires 81,379 logical members, 647,679,574 declared
bytes and epoch 1733874468, still below the one-GiB logical ceiling. Incremental
admission and the bounded parser precede the complete member list; the separate
source physical-header ceiling is 325,517. The exact pinned release remains a
mandatory real extraction test, without source execution.
The archive-covered EDK2 macOS development alias
`roms/edk2/EmulatorPkg/Unix/Host/X11IncludeHack` → `/opt/X11/include` is explicitly
excluded as a nonbuild input; it is never extracted, followed or rewritten to a
host path. Every other selected entry retains the path/type/data-filter checks.
The producer runs the native signed
compiler/Python in a private read-only input root, ordinary-owner build directories
and disposable mount/PID/network namespaces. Archive-covered Meson wheels are
used offline; subproject downloads, modules, plugins and KVM are disabled. Two
separate generic-ISA builds must produce identical native ELF bytes. The guest
emulation target remains `x86_64-softmmu` on both native hosts. BIOS/VGA firmware
is separately hashed against exact members of the pinned QEMU release archive,
not a host firmware directory.

`full-qemu-producer-receipt/` retains actual candidate QEMU bytes, original signed
InRelease and APT-retained Packages indexes (declared local compression), compiler
log, package/file/alias closure and producer identities. Exact archive hashes,
repository paths, sizes and Depends/Pre-Depends/Provides fields are retained.
Before source extraction/build, `public-evidence/package-archives/` also retains
EVERY already-downloaded `.deb`, named by its complete SHA256 and bound to package,
actual size and storage path in `provision-complete.json`. Incremental directory
collection is bounded to the existing 200-package closure plus APT's lock/partial
entries; files are limited to 128 MiB each and 512 MiB total. Missing/extra/changed,
aliased/special/outside-hardlinked inputs or mismatched retained bytes refuse.
Held descriptor checks and exclusive0600 output prevent silent overwrite;
failed/partial custody never publishes a completion record and is not replayed
by failure-stage retention. No archive is downloaded again, installed or executed
for this step. These originals enable independent all-payload reinspection, not
signature verification, original-root stat, mutation barriers, loaded-byte closure
or pin/runtime admission. The tool's local public-evidence directory retains
them; routine CI no longer uploads QEMU producer artifacts. This retention does
not add a workflow, cache or time-budget change.
Both original first/second native output streams are retained separately and
rehash-checked as public data after the unchanged native/equality checks. Public
failure-stage evidence covers provisioning, source/build, post-build inventory and
provider completion. A late refusal retains build identities/output bytes without
presenting an incomplete inventory as an accepted provider; success-only receipt
copying is not the sole evidence channel.
Its receipt deliberately has `runtimeVerified: false` and
`attributionVerified: false`: successful builds do not complete full-ten/PNG or
loader acceptance. Source-built version2 now records every staging node, including
root/empty directories, actual modes/UID/GID, complete streamed regular bytes/sizes,
byte-exact names/aliases and in-tree resolution, all observable xattr names/value
digests (including ACL/capability/security attributes and empty sets), and complete
hardlink equivalence without golden inode/timestamp constants. Special nodes,
escapes/loops, outside hardlinks, unreadable metadata, observed FD/dentry drift
and finite node/path/byte bounds refuse. Held-descriptor directory enumeration
is incremental: initially discovered entries (including pending children) reserve
the 20,000-node ceiling, and all initial/rescan name bytes share an eight-MiB cap.
Both passes refuse before excess names are collected/sorted/hex-encoded; neither
truncates a directory nor relies on a later visitor guard/timeout to bound memory.
Public tests include exact default 20,000-node CLI measurement and first excess,
small exact/overflow aggregate-name limits, pending reservations and rescan refusal.
Dangling aliases are exact measured data,
not a documentation/locale-prefix exemption or executable admission.

This is a **quiescent measurement, not a source seal**. Readonly binds do not stop
an outside writer, and before/after metadata checks do not prove absence of a
change-and-restore race. The owned producer stores `provider.json` in detached
`contract/`, not inside the runtime tree; no provider pathname is skipped.
The runtime retains the empty underlying `/contract` mountpoint, while public
`contract-inventory.json` records the separate complete descriptor view. External
reviewed values must eventually bind both views, provider bytes, source measurement
identity and all existing binary/recipe/package-lock/index/bootstrap/transformation/
source/firmware/configure identities. The bootstrap Python binary is recorded;
its complete borrowed-tool/loader/stdlib TCB remains unproved, not exempted.

The fixture's existing committed `--inventory-only` CLI performs only bounded
public staging-tree measurement with `measurementOnly: true`, never native/helper
execution, credential generation or admission. The CI test materializer still
stages the same39 committed sources; no dynamic-import/search-path/helper override
is introduced. Legacy/signed-private descriptor locations and profiles are unchanged.
Source-built version1 does not fallback into version2.

The `qemu_gssapi_full_pins.json` map remains empty and refuses before any
credentials/KDC/QEMU. Pins alone cannot enable execution: the source-built mounted
controller is explicitly unavailable until its independent source mutation barrier,
namespace-local FD/mount epoch, separately validated repository/test/package/contract
views, derived proc/dev/run/tmp grammar and actual attribution have been implemented
and accepted. There is no recursive live-root inventory or manifest/path-authorized
pruning. `/run` cannot be blanket `noexec`, nor can `/proc` blindly be readonly:
unchanged worker bootstrap writes namespace mappings and provisions/spawns the sealed
helper before Ready, then retains its minimal final root. These requirements are not
replaced by metadata equality. This mode remains distinct from legacy `--qemu`/
`pinned-host` and `--controlled-peer-only`/`signed-private`; neither is a fallback.

Full-private execution additionally needs the private-root harness, actual
interpreter/transitive/late-plugin/short-lived-tool and firmware/data attribution,
the unchanged ten tests on both native hosts, their actual 640x480 PNGs and checked
teardown. These mandatory inputs/executions are **not yet completed** by the
candidate-producer patch. No K2, six-pass review, non-root or production readiness
is implied. The optional `QEMU_GSSAPI_CAPTURE_DIR` is only a public image-receipt
destination for actual fixture frames, never a backend or native-helper override.
Sequential, concurrent and offline occurrences have distinct receipt names;
`create_new` still refuses overwrites. Both online captures and the concurrent
realm control remain in the unchanged ten-test acceptance.

## Native independent-acceptor CI

```bash
bash .github/scripts/check-native-gssapi-peer.sh
```

The separate Crates `native-gssapi-independent-peer` matrix runs on native x86-64 and ARM Linux, without emulation. It builds the current Rust test target unprivileged and downloads the exact MIT `1.20.1-6ubuntu2` acceptor/KDC packages through signed official Ubuntu Noble indexes. Archive SHA256, package/version/architecture and extracted file digests are checked; packages are **extracted, not installed**, and host apt/Kerberos configuration is unchanged. The independent acceptor uses only those private libraries; the production MIT1.22.2/musl helper has no override. Fixture-only event-loop and CLI dependencies are also bound to the signed Noble metadata.

Runtime explicitly uses the existing disposable privileged-synthetic mount/PID harness, not a production elevation or a non-root availability claim. Two synthetic loopback KDCs and their private native input roots use a bounded child-only 64 MiB/256-inode `/run` tmpfs; host `/run`, ancestor permissions, sysctl/AppArmor and unchanged worker isolation are not modified. No credentials are supplied by the user or retained. The `--controlled-peer-only` mode is explicit and mutually exclusive with the hash-pinned `--qemu` mode: it is not a fallback for unavailable QEMU.

The native driver first runs the separate standard-library `qemu_gssapi_runtime_test.py` input-integrity suite. Its inert file/manifest canaries are never loaded or executed and do not fake native results or attest signatures/runtime interoperability; they test the preflight's digest, package, path and used-input refusal contracts. The native runtime result groups and seven opt-in tests remain distinct.

Seven opt-in tests execute a timed acquisition/expiry regression, two real keytab/password renewal/reacquisition tests and the four existing tests' 25 meaningful controls: independently verified mutual GSS/RFC4752, corrupt AP-REP/MIC, confidentiality/layer/maxbuf/length/sequence refusal, retained completed-GSS expiry, actual verified-TLS RFB finality/padding/SecurityResult, and AP-REP/layer/SecurityResult stalls at acquired expiry. Existing assertions, lifetimes and deadlines are unchanged. The new regression supplies real five-second KDC latency with an eight-second requested ticket: acquisition must not backdate a still-valid ticket to before KDC work, but it must still refuse at the actual native endtime rather than grant a fresh requested lifetime on receipt. It verifies initial AP-REQ eligibility, later `Expired`, actual helper disappearance and empty private resources. It does not complete mutual GSS by itself. The renewal tests use only the independent signed KDC and public native worker APIs, not QEMU; both preserve the original lifetimes/deadlines, refuse distinct expiry/nonrenewable/exhaustion states without KDC traffic or implicit reacquisition, and explicitly verify actual helper disappearance and empty resources for keytab and password sources. All native/acceptor/KDC children, listeners and private material must actually be cleaned. `crates/target/native-gssapi-peer-receipt/` records the exact head/dirty flag, architecture/helper/test/provider digests and results; `runtimeVerified` becomes true only after all seven tests and cleanup succeed. A missing, failed, dirty or older receipt does not establish current-head ARM interoperability.

This is independent mutual-GSS/verified-TLS RFB-control evidence, **not** source-pinned ARM QEMU/Cyrus PNG, complete product acceptance or every hostile completed-context field. The original full QEMU command and its ten tests, including the new timed acquisition regression, remain separately required for that fixture's scope; they are outside routine CI and are not claimed complete.

## Matrix and limits

- Actual password and keytab AS/TGS plus verified TLS, mutual GSS, integrity-protected RFC4752 no-layer selection, complete SecurityResult/ServerInit and 640×480 PNG.
- Two concurrent distinct realms/initiators with independent checked caller transports and MEMORY handles.
- Prefetched service-only imports after both KDC processes are stopped: successful PNG and **zero** caller KDC exchanges. Missing/expired input is not an online fallback.
- Wrong TLS/name, current authority, password/keytab and service refuse; changed current authority blocks the next actual KDC exchange. Online sources against actually stopped KDC listeners report `KdcUnavailable` without retry. A caller-injected `DeliveryUnknown` is observed once and never replayed; it is not proof a real packet had uncertain delivery or a ticket was revoked.
- Actual native renewal extends new ticket metadata; nonrenewable, expired initial-ticket with still-live renew-till, and exhausted renew-till controls refuse in distinct categories without KDC traffic or automatic reacquisition. Explicit same-source reacquisition after expiry succeeds only as a future handshake source. No active RFB deadline is extended.
- Established sessions separately reach a selected three-second Run deadline and an acquired four-second ticket/GSS bound, with a still-live 60-second Run, and close. Stalled controlled peers also withhold AP-REP, the authenticated layer offer or SecurityResult after real four-second AS/TGS acquisition: the original TLS stream closes at the earlier acquired ticket/completed-GSS bound, not its ten-second handshake or 60-second Run deadline. Neither is full product/idle-owner acceptance.
- The independent maintained MIT acceptor (`mit_gss_peer.py`, fixture MIT1.20.1, no custom GSS/crypto) actually verifies a valid mutual context and no-layer selection. The public worker retains the earlier rounded-down completed-GSS expiry, even while the source ticket and original operation deadline remain live: no-layer selection at that reported bound refuses `Expired`, closes the real helper and produces no response for the independent acceptor. The pre-repair regression independently verified an authentic no-layer response after that bound, rather than inferring expiry enforcement from an internal counter. Corrupt AP-REP/MIC, confidentiality, incorrect layer bits/maxbuf/length and an authenticated sequence gap refuse. Controlled RFB/TLS peers backed by that acceptor verify NULL/empty final success and reject early/invalid finality, absent/empty/oversized/padded-invalid tokens, post-selection data and a rejected SecurityResult.
- `qemu_gssapi_framing.rs` separately checks subtype/mechanism aliases and malformed offers before native credential authority, plus pending-authority deadline/cancellation and original-stream closure. Nested acquired-ticket/GSS/native deadlines retain the public RFB authentication-deadline/stage category. A paused-clock phase regression releases a pending gate exactly at expiry and independently verifies that no output byte is sent: rejecting the result only after credential output would not enforce that boundary.

Public process canaries separately cover exact encoded-ticket service/realm/case and canonical DER framing (including suffix/concatenation refusal), absent-versus-empty/oversized/malformed GSS states, real queue/process capacity, authority/KDC cancellation, idle deadline/reaping, cleanup uncertainty/quarantined capacity and subsecond timestamp mapping. Their fake zero-key tickets are never delivered to a peer and are not mutual authentication.

Both architecture containment/package/cleanup receipts must come from the current Crates native matrix, not older static probes or user-mode emulation. They do not by themselves prove mutual GSS/RFB. The separate native independent-acceptor receipts above cover only their executed protocol controls; source-pinned ARM QEMU/Cyrus PNG and local ARM execution are not inferred. Completed-context MIC/finality controls above do not prove every hostile name/mechanism/flag/QOP or bootstrap interleaving. The separate native matrix covers one actual unauthenticated high-cost preauth/CPU-limit/reap/admission control and one stopped-worker/actual-parent-death interleaving after Ready but before credentials, as documented in the worker README; these are not broad CPU/DoS/bootstrap coverage or mutual GSS interoperability. An earlier local renewal-test invocation observed `Expired` during initial acquisition; later isolated and full runs passed, which does **not** establish its cause or prove a flaky-test diagnosis. Preserve that unresolved observation in current-head review/acceptance. The later same-source reacquisition `Invalid` observation was investigated separately: pinned MIT reads `kdc_timesync` as an integer, so the former `false` value silently retained enabled clock-offset adjustment. A maintained-library effective-flag proof, authenticated synthetic Ticket timestamps and the uninstrumented full fixture after the numeric-zero repair support that diagnosis. Both private profiles now use `0`; malformed readonly profiles refuse before Ready, and no timestamp predicate, assertion, lifetime or timeout was relaxed.

Engine evidence does not complete product custody/KMS, exact KDC permissions, saved capabilities/DTO/App, real Run handoff or production readiness.
