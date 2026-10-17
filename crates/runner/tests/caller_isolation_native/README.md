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
accounting and paired architecture evidence are separate mandatory gates.
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
  -p guest-tool-exec -p guest-task-exec
python3 crates/runner/tests/caller_isolation_native/packaged_run.py \
  --kernel /path/to/pinned/vmlinux \
  --firecracker /path/to/pinned/firecracker \
  --secilc /path/to/private/compiler/usr/bin/secilc \
  --base-rootfs /owned/prepared/read-only.ext4 \
  --rootfs-sha256 <exact-64-hex-image-sha256> \
  --tool-helper crates/target/local/guest-tool-exec \
  --task-helper crates/target/local/guest-task-exec \
  --output /owned/experiment/new-packaged-attempt \
  --source-revision <exact-40-hex-fixture-source-commit>
```

The VM has two vCPUs, 1536 MiB, a 240-second deadline, no NIC/vsock/host mount
and a 128-KiB console bound. It mounts its own writable copy and a separate
read-only drive for the protected OS/runtime view. Fixed native entries select
the role and obtain namespace handles from a peer-validated control socket.
Shell exec transitions occur before user startup files run. Actual Rust helpers
still perform their cgroup placement and OOM adjustment. Ordinary sudo/package,
terminal/network, root device/ioctl denial, image worker and startup-file probes
run in the same Guest. The prototype does not configure production resource
controllers or establish accounting/OOM/reclaim equivalence.

The controller writes `/native-result.json` on its owned drive. After the VMM is
joined, the host reads it with debugfs and retains `guest-result.json`,
`receipt.json`, generated inputs and `console.log`. It then deletes only the
owned writable copy. Kernel, VMM, compiler, fixture, helper and immutable image
identities are recorded separately. Image payloads are reduced to size/hash in
the receipt. The CLI artifact's source identity is independent of the fixture
commit; record both in the owning issue.

All 26 named checks, enforcing Guest identity, pinned CLI identity, no broker
errors and a qualified extension negative are required for exit zero. Missing,
duplicate, failed or unqualified observations fail closed. In particular, an
extension that never loaded because a dependency is missing is not a security
pass: that check currently remains explicitly unqualified. A successful subset
still leaves `gateF: incomplete`. In-process resource/configuration closure,
other helpers, real Run lifecycle/resource/resolver coverage and native ARM
remain independent requirements; this test is never an activation or rollout
fallback.
