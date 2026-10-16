# Remote diagnostics

Runner owns typed failure evidence, operation association and explanation text.
CLI treats the wording as opaque text; it has no report/stage/cause/version
schema or remediation-code translation.

## Automatic SSH explanations

Runner and CLI always use matching versions. Existing SSH exec, session and file requests
use their ordinary methods and parameters, without a version marker, opt-in,
capability request or business retry. The default-off
`remoteConnectionDiagnostics` switch and current assignment/subject checks
gate evidence. Disabled diagnostics omit explanation text.

A failed result may contain one `diagnostic_text` string, at most
8192 UTF-8 bytes. Runner renders the exact committed report, observed route,
selected address/family, fresh/reused stages, source/dependency cause, uncertainty
and guidance in lightweight Failure/Evidence/Unknown/Next step sections with
context IDs for exact history selection. These sections are readable text, not
a diagnostic JSON dump or a content schema. Their titles, wording and order can
change without CLI changes. Human output and JSON
contain the same text. CLI checks only bounded, terminal-safe text; missing or
unusable optional text cannot replace a verified business result.

Process status/read use their retained terminal receipt. Later unrelated
operations cannot replace it. Completed remote nonzero exits and intentional
close do not create failures. Existing business/byte/truncation/EOF/helper-exit
and local file-publication checks remain authoritative. Lost or corrupt delivery
never supplies a trusted explanation and never replays work.

## Automatic VNC explanations

Ordinary VNC failures can carry the same optional `diagnostic_text` as SSH.
Runner captures early admission/configuration, selected destination/transport,
RFB authentication/initialization and independent KDC stages in owned finite
snapshots. Existing RFB deadline and Apple DH categories remain available.
Nested SSH trust/carrier/native evidence keeps its exact dependency identity;
KDC failure identifies the independent route rather than the RFB data route.

Each delivered explanation uses that operation's committed report. Retained
sessions keep pure setup/source facts and latch their first terminal cause and
time independently of subsequent operation report IDs. Later operations and
successful connections cannot substitute another report's context.
Intentional close, stale geometry and input validation do not create retained
network failures. Setup evidence on a later session operation is marked reused.

An interrupted capture can attach text to the existing error terminal without
End or a completed image. Binary framing, EOF/exit verification, PNG publication,
input outcome and delivery uncertainty remain authoritative. CLI only validates
text size/terminal safety and forwards it in human/JSON output. Missing or unsafe
optional text cannot replace a verified result; no diagnosis query or action is
replayed automatically. Collection uses the same default-off switch and current
assignment/host/dependency authority as passive history.

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
SSH evidence requires dependency visibility too. Existing metadata inventories
always return the current authorized hosts and their required identities.
Known creation identities must match with PostgreSQL microsecond precision;
later generations on the
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
A finite native trace records application-observed provisioning/control,
map framing/validation, selected terminal root and relay stages. Selected typed
endpoint/family and relay-region facts are retained when exposed by the actual
connector. Each private TCP connection has its own trace and evidence ID;
concurrent connections cannot replace one another's evidence.
SSH transport reuse keeps the original connection evidence ID; a fresh dial gets
a new ID while retaining the shared node identity. Relay attempts are
isolated, and only the selected terminal root's relay facts enter the node receipt.
Detailed collection is activated by enabled consumers before native startup.
Each operational report copies its node and connection stage snapshots when
recorded, so later map/stream activity cannot rewrite an earlier explanation.
The node lifecycle's first terminal timestamp and later cleanup remain explicit
retained-resource facts, separate from the report's captured operation stages.
The node trace is sealed before terminal publication; later cleanup remains a
separate fact. SDK-hidden decode/driver causes remain unknown; map/relay readiness
does not establish current SSH/VNC health. Trace scope retains no SDK/IO owner
and does not change DNS/address races, retry policy or physical cleanup.
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
