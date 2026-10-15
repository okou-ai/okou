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

Closing an SSH or VNC session intentionally does not replace a previous
operational failure with expected cancellation, including a pending VNC capture.
Independent request failures and authority invalidation remain eligible for
history.

Native readiness, first terminal work cause and physical cleanup are distinct.
A report may retain a small shared receipt whose cleanup fields settle after its
original failure. The receipt cannot own a node, Completion, credential, stream,
task, cancellation token or permit. Records contain typed codes and identifiers,
never provider error text, hostnames, credentials, auth URLs, command output,
screenshots, input, maps or packets. Existing business result/effect/delivery
contracts remain independent.

A later SSH request for the same native configuration retains an available
source receipt even when the terminal node rejects adoption before that host
owns a node lease. The lookup copies only pure evidence from this Run's exact
configuration/generation; it does not restart or retain the physical node.

Native subscriptions hold weak references to pure consumer activity flags.
Explicit retirement or authority invalidation disables later publication for
that consumer without keeping its physical resource alive. Separate sessions
of the same host retain separate bindings.

Rollout uses the default-off `remoteConnectionDiagnostics` key in the existing
Run feature map. Enabling it does not grant SSH or VNC access. Report fields and
finite vocabularies are a versioned contract; incompatible additions require a
new negotiated version or method, leaving legacy business replies unchanged.
The switch controls history publication and passive queries. Native first-cause
lifecycle handling and the inventory identity projection are shared paths that
also apply when diagnostics are disabled.

## SSH automatic output, version 2

`ssh.diagnostics.capabilities` accepts an empty object in the legacy request
envelope and returns schema version 2, `passive_query`, a finite list of
`automatic_methods` and `query_method` (`ssh.diagnostics.query.v2`). It advertises
only the live enabled assignment. The old capability response stays unchanged.

The advertised automatic methods append `.diagnostics.v2` to SSH exec,
file upload/download, and session start/status/read/write/signal/close. Their
parameters and business execution use the existing handlers; the method label
is the explicit version opt-in. Generic framing and both bundled-helper modes
remain opaque. No new envelope/parameter field, helper fallback or replay is
introduced. Non-opt-in methods retain their strict result shapes.

An opted-in failure terminal may add `diagnostics` with `found` and the exact
owner-published report, or `unavailable` without invented association. Process
status/read use that session's retained terminal receipt. Later failures from
other operations cannot change this reference. Completed remote nonzero exits
and intentional close do not generate failures. Lost or corrupt helper delivery
does not establish a diagnostic association; no business operation is retried.

Version-2 reports keep the same identity/retention/authority bounds and add
finite SSH consumer stages, a cause-specific next action, actual route, fresh
versus reused transport and the selected address/family when observed. A pooled
connection retains its original selected address and marks observed setup as
reused. Incomplete/cancelled stages remain unknown. Public-route selection
exposes only the one policy-approved address, never a DNS answer set. Native
source receipts keep their existing cause; finer native stages remain unobserved.
The current trace has 12 fixed stage entries, below the 32-stage ceiling.

File-operation failures retain a distinct finite `file` cause rather than a
guessed SSH network failure. Version-1 queries retain their original projection
for representable records and return unavailable for new-only categories;
they never emit a malformed version-1 report or substitute an older incident.
The new CLI negotiates version 2 for passive SSH queries. Collection and
diagnostic decoding failures remain secondary to valid original business,
effect, delivery, output, file publication/residue and truncation outcomes.
The same typed report supplies immediate output, exact passive queries and safe
structured failure logs. It owns no physical resources and contains no business
output, file paths, credentials or raw provider/peer text.

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
