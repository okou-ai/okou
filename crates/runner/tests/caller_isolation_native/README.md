# Native caller-isolation feasibility fixture

This opt-in command boots a fresh credential-free Firecracker Guest with the
Runner's exact pinned kernel. It tests SELinux role primitives, including
ordinary/root workload denial, protected files and processes, model-port
connect/bind restrictions, gateway-only key access, role forgery and inherited
sockets. Positive agent/model and ordinary workload data/network cases prevent
an all-deny policy from passing.
Root probes retain effective SYS_ADMIN, NET_ADMIN, NET_RAW and SYS_PTRACE
capabilities; ordinary probes have none. Actual UID, capabilities and SELinux
context are checked, so dropping root capabilities cannot masquerade as MAC
confinement.

The policy and native controller are test-only. They are never installed in a
production rootfs. The Guest contains no user home, platform key, network
interface, vsock, host mount, application agent or user workload.

Run on an authorized Linux host with KVM access, GCC/static libc, Python 3.11+ and
`secilc`. Use the committed `crates/runner/src/deps.rs` from the same source
artifact. Both VMM and kernel are copied into an exclusively created output
directory and their size/SHA-256 checked before execution. A private extracted
distribution policy compiler is sufficient; do not change host security policy
or install an experimental policy on another Runner's Guest.

From a staged repository artifact, for example:

```bash
python3 crates/runner/tests/caller_isolation_native/run.py \
  --kernel /path/to/pinned/vmlinux \
  --firecracker /path/to/pinned/firecracker \
  --secilc /path/to/private/compiler/usr/bin/secilc \
  --output /owned/experiment/new-attempt \
  --source-revision <exact-40-hex-source-commit>
```

The output's parent must already exist. Never reuse an attempt directory.
Retain `receipt.json` and `console.log`; the receipt binds source, fixture,
compiler, policy and initramfs identities. Compilation/setup errors, missing or
failed probes, a wrong architecture, nonzero VMM exit and timeout fail the
command. The VMM has a 35-second host deadline, a 25-second Guest deadline and a
128-KiB console limit. Its owner kills and joins it on failure or cancellation;
Linux parent-death fencing also kills it after the owner is SIGKILLed.
Cancellation is deferred until the launched process has an owner; the exec
wrapper restores the child's original signal mask before running the VMM.

Exit zero means only that the kernel-role primitive suite passed on this host
architecture. `gateF` remains `incomplete`: actual packaged Codex/Claude Code/Pi
and tools/subagents, sealed dependencies, sudo/package functionality, retained
home/history, alternate credential resolvers, real Run lifecycle/resource
accounting are separate mandatory gates. The owning issue selects the required
native architecture coverage; a receipt establishes only its observed architecture.
Neither this command nor its ordinary tests establish production caller
authorization. Task-specific observations and release decisions belong in the
owning issue/PR, not this README.

Run the ordinary receipt/lifecycle regressions without KVM or a policy compiler:

```bash
bash crates/runner/tests/behavior/tests/runner-behavior-caller-isolation-test.sh
```

These tests execute real owned subprocesses, including timeout, cancellation,
owner SIGKILL and output bounds. Existing Security script shards run them; they
do not substitute for actual native VM execution or full Gate F.

## Packaged runtime prototype

`packaged_run.py` extends the experiment to actual Codex, Claude Code and Okou Pi
executables. It uses unchanged `guest-tool-exec` and `guest-task-exec` Rust
binaries, the real CLI subagent command and synthetic Chat Completions,
Messages and Responses streams. Its small Python broker implements the existing
placement protocol; it is not the production Guest Agent or Run lifecycle.

Supply a newly owned Ubuntu rootfs from `build-template.sh`, prepared with the
verified CLI artifact and the normal managed tool hooks. This prototype pins
CLI 9.400.3, Pi runtime 1.50.18 and SDK 1.1.0+okou.592c3e597de7. Its required
private image layout is:

- `/usr/bin/node`, `/usr/bin/codex`, `/usr/local/bin/claude`, Python, sudo,
  `dpkg-deb`, dpkg and curl, with the canonical uid-1000 `user` account.
- `/usr/local/lib/okou-cli/9.400.3/okou.js`, the packaged image worker/WASM and
  `/usr/local/lib/okou-cli/installed.json`, matching the pinned package identity
  in `packaged_run.py`. Verify the downloaded package with the repository's
  `verify-okou-cli-artifact.sh` before preparing this private image.
- The canonical `okou` launcher and, only in this fixture image, symlinks
  `/usr/local/bin/guest-tool-exec -> /fixture/guest-tool-exec` and
  `/usr/local/bin/guest-task-exec -> /fixture/guest-task-exec`. PID 1 supplies the
  fixed native entries in a private tmpfs. These links are not production launch
  changes.
- The Claude managed-settings and Codex requirements hooks from
  `customize-rootfs.sh`. `/fixture` and `/sealed` must exist as directories.

Prepare and mount only a fresh private copy, in a private mount namespace, then
unmount and make that input file read-only. Never prepare an active, shared or
user-data image for this fixture. The rootfs SHA must be independently retained;
the driver checks it before copying and checks the owned copy before boot.

```bash
cargo build --manifest-path crates/Cargo.toml --profile local --locked -j1 \
  -p guest-tool-exec -p guest-task-exec -p guest-storage-apply -p guest-home-mount \
  -p guest-contracts
rustc --edition 2024 \
  crates/runner/tests/caller_isolation_native/packaged_resource_policy.rs \
  --extern guest_contracts=crates/target/local/libguest_contracts.rlib \
  -L dependency=crates/target/local/deps -o /owned/experiment/resource-policy
python3 crates/runner/tests/caller_isolation_native/packaged_run.py \
  --kernel /path/to/pinned/vmlinux \
  --firecracker /path/to/pinned/firecracker \
  --secilc /path/to/private/compiler/usr/bin/secilc \
  --base-rootfs /owned/prepared/read-only.ext4 \
  --rootfs-sha256 <exact-64-hex-image-sha256> \
  --tool-helper crates/target/local/guest-tool-exec \
  --task-helper crates/target/local/guest-task-exec \
  --storage-helper crates/target/local/guest-storage-apply \
  --home-helper crates/target/local/guest-home-mount \
  --resource-helper /owned/experiment/resource-policy \
  --home-layout retained \
  --output /owned/experiment/new-packaged-attempt \
  --source-revision <exact-40-hex-fixture-source-commit>
```

The VM has two vCPUs, 1536 MiB, a 240-second deadline, no NIC/vsock/host mount
and a 128-KiB console bound. It mounts its own writable root, a newly created
96-MiB home at the real helper's fixed `/dev/vdb`, and the separate read-only
runtime drive at `/dev/vdc`. Fixed native entries select
the role and obtain namespace handles from a peer-validated control socket.
Shell exec transitions occur before user startup files run. Actual Rust helpers
still perform their cgroup placement and OOM adjustment. Ordinary sudo/package,
terminal/network, root device/ioctl denial, image worker and startup-file probes
run in the same Guest. A small test setup executable links the unchanged
production resource-policy calculator and configures CPU, memory and PID
controllers before admitting Python or user code. The controller retains its
writable cgroup mount; agent and tool mount views are read-only. Legitimate
Rust placement still writes the controller-opened descriptor. User and
sudo-root attempts actually write migration files and create a forged domain.
Actual tool CPU, peak memory, PID accounting and group OOM are observed. These
are prototype results, not production Run accounting/reclaim equivalence or a
resource-saving comparison. A real Pi loop waits on its synthetic model peer
while a managed tool reaches group OOM; it must keep its protected identity and
continue after that pressure. All three packaged CLIs reopen the actual sessions
they created, and the model peer must observe their earlier user conversation.

The Guest switches its mounted root over the initramfs before entering role
namespaces. A chroot-only setup would reject user namespace creation even for
the control role. Workloads can create subordinate user namespaces and use their
namespaced capabilities; host-level SYS_ADMIN and protected model/file authority
remain denied. The suite checks mapped uid 0 and the actual unchanged workload
role, and runs the packaged browser's default sandboxed local-page operation,
including an actual PNG screenshot. Nested user/root probes also reject cgroup
mount, remount and migration. Workload memfd mappings and `/dev/shm` IO use data
labels rather than protected-controller labels.

The controller writes `/native-result.json` on its owned drive. After the VMM is
joined, the host reads it with debugfs and retains `guest-result.json`,
`receipt.json`, generated inputs and `console.log`. It then deletes only the
owned writable copy. Kernel, VMM, compiler, fixture, helper and immutable image
identities are recorded separately. Image payloads are reduced to size/hash in
the receipt. The CLI artifact's source identity is independent of the fixture
commit; record both in the owning issue.

All named checks, enforcing Guest identity, exact Node/Claude/Codex and pinned
CLI identities, no broker
errors and a qualified extension negative are required for exit zero. Missing,
duplicate, failed or unqualified observations fail closed. The positive extension
control seals the same executable dependencies but retains the user's discovery
roots. Both it and the real CLI use an explicit test-only Node import that selects
the packaged SDK's bundled loader. Package bytes are unchanged; a dependency
loading error cannot stand in for extension denial.

The agent view masks Pi's global and ancestor project discovery roots. Mandatory
labels protect configuration bytes and mount anchors while allowing the private
credential file and specifically named credential/settings lock directories.
The existing SDK requires these locks even for reads. The original tool view
remains writable and the canonical session tree is shared as data. The suite
checks extension execution identity and observed model ingress in the load
control, absence in the frozen view, rejected configuration writes, stable
anchors, private-state denial and retained-session access.

Actual Claude Code and Codex MCP clients also initialize a benign stdio peer.
Direct execution is an explicit control that demonstrates the peer inheriting
agent authority. A captured test configuration instead selects a fixed capless
native adapter that has already transitioned to workload. It transfers only
stdio to a peer-validated, bounded controller owner. That owner selects the fixed
Rust tool helper and preserves the adapter's actual capability bounding set and
no-new-privileges state. The unchanged helper places the peer as workload, where
model ingress is denied while its MCP handshake succeeds. This establishes that
handoff, not complete vendor configuration/plugin closure. The native result
retains peer identities, handshake completion and server-observed requests.
Serial output keeps concise verdicts; an audit tail and denial count remain in
the receipt rather than duplicating every kernel syscall/proctitle line.

The real storage helper applies both file and loopback HTTP gzip/tar manifests;
pre-existing synthetic user data remains intact. The real Pi subagent kill
command cancels a child with a blocked workload tool; its task family becomes
unpopulated and the controller verifies that the tool has exited.

Add `--snapshot-restore` with a new output directory to checkpoint after enforcing
policy, resource domains and protected namespaces are established, before user
code. The owner pauses and snapshots its first VMM, joins it, restores a second
owned VMM and runs the complete suite. Receipts require unchanged enforcing
state and distinct namespace identities, exact snapshot bytes and both native
processes joined. On a failed restore, verified joined processes permit owned
drive cleanup without converting the failed test into success. Unverified
ownership retains the drive for diagnosis. Snapshot memory files may be large;
retain them locally on the authorized host and transfer the small receipts.

The extended qualification uses the unchanged fixed home helper under enforcing
SELinux. `--home-layout fresh` starts an empty unlabelled ext4 volume;
`--home-layout retained` seeds only synthetic shell/history/workspace data with
no SELinux xattrs. A controller-owned `defcontext` mount supplies ordinary data
labels without recursively relabelling retained files. User/root append and
restore actual data, and the unchanged helper revalidates the full device and
workspace after the suite, including after snapshot restore.

Claude and Codex use captured configuration views with writable private runtime
state and retained session/snapshot directories. Actual known-load MCP controls
prove that the same user configuration executes in the discovery control and
is absent in the frozen view. All packaged CLIs reopen their real histories.
Pi children enter the Run-captured canonical workspace before protected launch;
an arbitrary invoking tool cwd cannot select another executable discovery root.
A nested-project probe runs the real public subagent command and waits for its
actual task family to become unpopulated. Native result metadata records actual
tool names and parameter keys for the pinned runtime profiles.

A separate `gateway_t` Python process serves all three synthetic model dialects.
Its HTTP and TLS listeners share 16 request owners, a 32-MiB body limit, a
128-MiB aggregate body budget and 16-KiB response reads. A 256-MiB/64-PID leaf
below the workload aggregate charges its real CPU, memory and threads. Slow-body
admission, the exact body boundary, cancellation/EOF budget reuse, slow-reader
4-MiB SSE delivery and direct/proxy timings are observed with actual sockets.
Local gateway OOM kills that group, closes the entrance and permits only a
controller-owned restart; there is no direct fallback. Paired real Pi startup
samples use alternating discovery/frozen views, fresh logical sessions and
same-open-FD cgroup memory peaks. These descriptive samples do not establish a
resource saving or stable production latency percentile.

Actual Pi/Claude file tools and Codex's supported `view_image` tool cannot read
the private synthetic gateway key; in-process configuration writes are denied.
Claude WebFetch uses a generated local test certificate and a trusted test-only
setting that omits its external domain lookup. The real tool must reach the TLS
entrance, receive 405 for an inference-path GET and cause zero upstream GETs;
an incidental network/preflight failure cannot pass. No host trust store or
production setting changes. The alternate resolver probe uses the real route
shape and synthetic host-shaped material on its own protected port: only the
gateway role can reach it. It does not implement or attest the production API's
authorization.

Receipts always retain `gateF: incomplete`: a native command alone cannot accept
the current provider/Runner eligibility and alternate-resolver source audit or
the separately observed deployed connector/catalog bytes. The issue owner must
combine that audit with exact-source native receipts before accepting the first
feasibility slice. Later Run lease/epoch/reassignment, deployment and final
compatibility deletion remain separate integration/rollout gates. This fixture
is never an activation or rollout fallback.
