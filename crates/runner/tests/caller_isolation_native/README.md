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

Run on an authorized Linux host with KVM access, GCC/static libc, Python 3 and
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
