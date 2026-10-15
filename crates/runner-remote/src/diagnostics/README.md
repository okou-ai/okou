# Remote diagnostic contract

The Guest RPC owner exposes three passive version-1 methods:

- `remote.diagnostics.capabilities`, with empty params, returns `schema_version`,
  `passive_query` and `active_check`. Only passive queries are implemented here.
- `ssh.diagnose` and `vnc.diagnose` accept optional exact UUID `connectionId`,
  `attemptId` and `sessionId` filters. Filters intersect. An empty filter selects
  that protocol's latest retained operational failure.

The CLI exposes these as `okou ssh diagnose [connection-id]` and
`okou vnc diagnose [connection-id]`, with `--attempt-id`, `--session-id` and
`--json`. Read each command's help before use. Queries perform no target login,
desktop capture, input, command replay or node provisioning.

`found` includes one report. `no_failure` means no failure was retained in this
Run; it says nothing about connectivity. `not_retained` never substitutes another
host or attempt. `authority_unavailable` covers failure to establish current read
capability and Run/chat/host visibility through the metadata inventory API, and
returns no report. A nested SSH dependency requires its own current visibility.
The owner requests `diagnostics=1` from those existing inventories. Their opt-in
version-1 identity projection preserves PostgreSQL microseconds, and known
primary/dependency creation timestamps must match. A later generation of the
same creation instance can still read historical evidence. An old API without
that projection fails closed. Generic pre-resolve failures are explicitly
unbound and carry no private configuration or native source evidence.
`unavailable` covers a disabled or retired owner. Missing/old helpers, unknown
versions, malformed responses and unavailable RPC paths remain finite CLI errors.

History belongs to the Run's exact registration. An overlapping replacement
keeps pure evidence while fencing stale producers by assignment UUID. Queries
require the live Run; no cross-Run archive is exposed. The store keeps 64 detail reports plus independent pinned latest
SSH/VNC failures. Later success cannot clear those pins. Each report is at most
8 KiB; version 1 has one finite operation/source stage, and explicitly marks finer
detail `not_observed` (below the 32-stage ceiling). Each native resource observes
at most 64 recent subject bindings. Older unretained selectors report
`not_retained`; ring pressure is exposed as `retention.evicted`.

Closing a running SSH session intentionally does not replace a previous
operational failure with its expected cancellation. Independent input-RPC
failures and authority invalidation remain eligible for history.

Native readiness, first terminal work cause and physical cleanup are distinct.
A report may retain a small shared receipt whose cleanup fields settle after its
original failure. The receipt cannot own a node, Completion, credential, stream,
task, cancellation token or permit. Records contain typed codes and identifiers,
never provider error text, hostnames, credentials, auth URLs, command output,
screenshots, input, maps or packets. Existing business result/effect/delivery
contracts remain independent.

Native subscriptions hold weak references to pure consumer activity flags.
Explicit retirement or authority invalidation disables later publication for
that consumer without keeping its physical resource alive. Separate sessions
of the same host retain separate bindings.

Rollout uses the default-off `remoteConnectionDiagnostics` key in the existing
Run feature map. Enabling it does not grant SSH or VNC access. Report fields and
finite vocabularies are a versioned contract; incompatible additions require a
new negotiated version or method, leaving legacy business replies unchanged.

SSH-routed Kerberos KDC failures retain their source cause and creation identity
before Kerberos error conversion. The native RPC regression uses a real packaged
Kerberos worker, controlled RFB/TLS peer and SSH trust refusal. It requires a
supported Linux user/mount namespace and Landlock runtime and is selected
explicitly:

```sh
cargo test --manifest-path crates/Cargo.toml --profile local --locked -j 1 \
  -p runner-remote --lib \
  ssh::tests::kdc_diagnostics::vnc_history_retains_kdc_ssh_failure_before_kerberos_conversion \
  -- --exact --ignored
```
