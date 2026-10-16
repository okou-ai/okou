# Remote diagnostics

Runner owns typed failure evidence, operation association and explanation text.
CLI treats the wording as opaque text; it has no report/stage/cause/version
schema or remediation-code translation.

## Automatic SSH explanations

The owning Runner adds `OKOU_REMOTE_DIAGNOSTIC_TEXT=1` to its reserved per-Run
environment alongside its bundled helper. New CLI adds `diagnosticText=true`
to parameters of existing SSH exec, session and file methods only when that
marker exists. Guest RPC validates/removes it before strict business parsing.
No capability request, diagnostic method alias or business retry is needed.

Old CLIs do not opt in, so their strict responses stay unchanged. A new CLI
on an older Runner sees no marker and makes one ordinary business call.
The marker declares support, never authority. The default-off
`remoteConnectionDiagnostics` switch and current assignment/subject checks
still gate evidence. Disabled diagnostics omit explanation text.

An opted-in failed result may contain one `diagnostic_text` string, at most
8192 UTF-8 bytes. Runner renders the exact committed report, observed route,
selected address/family, fresh/reused stages, source/dependency cause, uncertainty
and guidance. Formatting can change without CLI changes. Human output and JSON
contain the same text. CLI checks only bounded, terminal-safe text; missing or
unusable optional text cannot replace a verified business result.

Process status/read use their retained terminal receipt. Later unrelated
operations cannot replace it. Completed remote nonzero exits and intentional
close do not create failures. Existing business/byte/truncation/EOF/helper-exit
and local file-publication checks remain authoritative. Lost or corrupt delivery
never supplies a trusted explanation and never replays work.

## Same-Run passive history

`ssh.diagnose` and `vnc.diagnose` accept optional exact UUID `connectionId`,
`attemptId` and `sessionId` filters. Filters intersect; no filters select that
protocol's latest retained operational failure. CLI exposes `okou ssh diagnose`
and `okou vnc diagnose`, including `--attempt-id`, `--session-id` and `--json`.
One passive request returns `status` and a bounded Runner-authored `message`.
These non-GA query formats do not retain old report-format decoders.

`found` explains one matching failure. `no_failure` means none was recorded
in this Run, not successful connectivity. `not_retained` never substitutes
an unrelated incident. `authority_unavailable` discloses no retained details.
`unavailable` covers a disabled/retired owner or unavailable detail.
Queries perform no target login, capture, input, command replay or provisioning.

History requires current read capability and Run/chat/host visibility. Nested
SSH evidence requires dependency visibility too. The owner requests
`diagnostics=1` from existing metadata inventories. Known creation identities
must match with PostgreSQL microsecond precision; later generations on the
same creation instance can still read history. Missing identity projection
fails closed. Generic pre-resolve failures remain unbound and contain no
private configuration or native source evidence.

## Source ownership and bounds

The exact Run registration owns 64 detailed reports plus separately pinned
latest SSH/VNC failures. Later successes do not clear pins. Removed sessions
and nodes do not remove history. Assignment UUIDs fence stale producers.
No cross-Run archive exists.

Evidence contains finite stages and typed identifiers, never provider/peer
bodies, hostnames, credentials, auth URLs, commands/output, file paths/content,
screenshots, input, maps or packets. Only the selected policy-approved address
is recorded, not a complete DNS answer set. Incomplete stages stay unknown;
reused setup cannot prove fresh health. File causes remain file causes.
The first Cloudflare cause survives later carrier/cleanup failures. Safe logs
and explanation text use the same typed source facts.

Native readiness, first terminal work cause and physical cleanup are distinct.
A pure shared receipt may gain cleanup detail after the original failure,
but owns no node, stream, Completion, credential, task, token or permit.
Native subscriptions keep weak consumer activity references, at most 64 recent
subject bindings. Retirement/revocation disables later publication. A later
rejected adoption copies available pure source evidence from this Run's exact
configuration/generation without restarting or retaining the physical node.

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
