# WSS host-boot filesystem fixture

This opt-in Linux fixture exercises the production canonical `HomePaths`, WSS
bind/accept and bounded GC APIs. It prepares durable ownership state before a
host boot and verifies recovery afterward. Both boot phases and the separate
process-crash rehearsal are ignored by default; ordinary CI only compiles them.

It does not run the complete Runner, submit ordinary work, observe heartbeats,
issue tickets, install Caddy, or reboot a host. Those acceptance results require
their own real environment. Passing the rehearsal supplies no host-boot evidence.

## Build and ordinary verification

```sh
cargo fmt --manifest-path crates/Cargo.toml --package runner-host -- --check
cargo test --manifest-path crates/Cargo.toml --profile local --locked -j 1 \
  -p runner-host -- --test-threads=1
cargo test --manifest-path crates/Cargo.toml --profile local --locked -j 1 \
  -p runner-host --test wss_host_boot --no-run
```

Use the executable path printed by the last command, and record its SHA256 and
source commit. Copy that exact executable to the non-production test host; do
not rebuild or replace it between phases.

## Host and isolation requirements

Use an explicitly authorized non-production host with an exclusive reboot
window. Root, Linux mount namespaces, a persistent ext4 volume, and the
provisioned non-root `okou-wss-caddy` group are required. Group creation is owned
by the normal Ansible `runner_wss_host` provisioning tag; the fixture never
changes system accounts or memberships. No Caddy installation is required.

Create a new, uniquely named root-owned fixture directory outside the actual
Runner home. Put the executable outside its new empty `home` child. For example,
set these variables to the exact paths and unique unit name chosen for this run:

```sh
WSS_FIXTURE='/var/lib/okou-wss-boot-<new-uuid>'
WSS_HOME=$WSS_FIXTURE/home
WSS_PROBE=$WSS_FIXTURE/wss_host_boot
WSS_UNIT='okou-wss-boot-<same-new-uuid>'
```

Create the directories with exclusive `mkdir` operations, owned by `root:root`
and mode `0755`. Install the copied executable as a root-owned executable at
`WSS_PROBE`. Do not use an existing Runner directory or repair an existing
fixture. Preparation refuses a nonempty backing home. A failed/consumed fixture
is retained for diagnosis; start a new run with a new directory.

The backing home's ancestors must also be real root-owned directories without
group/other write permission. A root-owned child inside a user-writable parent
is refused.

Every invocation uses a fresh private mount namespace and bind-mounts only
`WSS_HOME` onto `/var/lib/vm0-runner` inside that namespace. The tests require a
different namespace from PID1, a non-shared explicit mount, and identical current
backing/canonical-home inodes before changing files. The actual Runner home and
other services remain outside this namespace. Persistent evidence omits device
numbers because they can change across a host boot/remount.

## Prepare the live pre-boot state

Run the pre-boot holder as a uniquely named transient service. Its bounded
runtime and SIGKILL policy deliberately retain socket/anchor/ownership records
without graceful Rust teardown. It is neither enabled nor restarted after boot.

```sh
sudo systemd-run --unit "$WSS_UNIT" \
  --property=Type=exec --property=RuntimeMaxSec=30min \
  --property=KillMode=control-group --property=KillSignal=SIGKILL \
  --setenv="OKOU_TEST_WSS_BOOT_HOME=$WSS_HOME" \
  --setenv="OKOU_TEST_WSS_PROBE=$WSS_PROBE" \
  /usr/bin/unshare --mount --propagation private /bin/sh -eu -c '
    mount --bind "$OKOU_TEST_WSS_BOOT_HOME" /var/lib/vm0-runner
    exec "$OKOU_TEST_WSS_PROBE" --ignored --exact \
      prepare_wss_state_for_host_boot --nocapture --test-threads=1
  '
sudo journalctl --unit "$WSS_UNIT" --no-pager
sudo systemctl is-active "$WSS_UNIT"
```

Require `WSS_HOST_BOOT_PREPARED` and an active holder. Capture the exact source,
binary digest, host identity, prepared boot ID, private receipt and namespace
inventory. The receipt is flushed before that marker appears. Preparation creates
the missing production namespace under umask `0777`, exchanges actual bytes on
two owned sockets, and checks exact namespace/socket/private-artifact permissions.
It also leaves an unrecorded socket whose preservation is checked after recovery.

The pre-boot test intentionally stays running. A service-start acknowledgement,
timeout, crashed holder or partial receipt is not acceptance. Confirm the holder
and retained state immediately before the separately authorized host reboot.
Do not reboot a shared host while other workloads depend on it. The operator
owns the reboot and reconnection; this fixture contains no reboot command.

## Verify after the real boot

Reconnect to the same host, confirm the expected source volume and fixture
remain available, and invoke the exact same binary:

```sh
sudo env "OKOU_TEST_WSS_BOOT_HOME=$WSS_HOME" \
  "OKOU_TEST_WSS_PROBE=$WSS_PROBE" \
  unshare --mount --propagation private /bin/sh -eu -c '
    mount --bind "$OKOU_TEST_WSS_BOOT_HOME" /var/lib/vm0-runner
    exec "$OKOU_TEST_WSS_PROBE" --ignored --exact \
      verify_wss_state_after_host_boot --nocapture --test-threads=1
  '
```

An unchanged boot ID fails before recovery/GC. The verifier also requires the
same executable digest, retained home/namespace inodes, and exact socket,
anchor and private-record evidence. It recovers one same-ID listener, checks
exclusive live ownership and real byte exchange, then uses dry-run and destructive
GC to retire the other dead ID without deleting the live or unknown endpoint.
After owned teardown, only the original unknown socket may remain in `wss`.

Capture the passing test and `WSS_HOST_BOOT_VERIFIED` with distinct boot IDs.
Treat it as filesystem evidence only. Verification consumes the recorded state;
do not replay a completed invocation or call a changed/partial fixture a pass.

## Safe process-crash rehearsal

On a host whose shared services must remain running, use the same isolated
setup but stop only the unique fixture holder with `systemctl stop "$WSS_UNIT"`.
Its SIGKILL policy leaves residue. First invoke
`verify_wss_state_after_host_boot` exactly as above: require the unchanged-boot
refusal and compare the retained inventory/receipt before and after to confirm
no mutation. Then replace the exact test name with
`rehearse_wss_recovery_after_process_death` and execute it once.

The rehearsal exercises the same production recovery/GC assertions but requires
the _same_ boot ID and prints `WSS_PROCESS_CRASH_REHEARSAL_ONLY`. It cannot satisfy
physical boot acceptance. Never edit boot IDs or receipts to simulate a boot.

## Owned cleanup

Capture evidence before cleanup. Confirm the exact fixture holder is inactive
and no verifier is running. Remove only the unique fixture directory created
for this invocation; never remove the real Runner home or another run's files.
No persistent mount remains after these private-namespace processes exit. Keep
failed state until its outcome is understood, and never retry an uncertain
remote mutation without inspecting its result first.
