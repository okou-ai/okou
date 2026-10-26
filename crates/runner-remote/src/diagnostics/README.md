# Remote diagnostics

Runner owns typed failure evidence, operation association and explanation text.
CLI treats the wording as opaque text; it has no report/stage/cause/version
schema or remediation-code translation.

## Automatic SSH explanations

Runner and CLI always use matching versions. Existing SSH exec, session and file requests
use their ordinary methods and parameters, without a version marker, opt-in,
capability request or business retry. Evidence requires trusted Run authority and
current assignment/subject checks. Without trusted authority, diagnostics omit
explanation text.

A failed result may contain one `diagnostic_text` string, at most
8192 UTF-8 bytes. Runner renders the exact committed report, observed route,
selected address/family, fresh/reused stages, source/dependency cause, uncertainty
and guidance in lightweight Failure/Evidence/Unknown/Next step sections with
context IDs for exact history selection. These sections are readable text, not
a diagnostic JSON dump or a content schema. Their titles, wording and order can
change without CLI changes. Human output and JSON
contain the same text. CLI checks only bounded, terminal-safe text; missing or
unusable optional text cannot replace a verified business result.

Native explanations distinguish a stage still pending at the recorded observation
from missing or abandoned detail, with monotonic stage durations. They identify
the actual embedded Tailscale/DERP path and the selected regional connection
incarnation, including reused setup and live non-home-region evidence. Ordinary
failures, passive history and checks use captured copies of those pure facts.
Later regional replacement cannot rewrite an earlier operation's path evidence.
Live connections follow authenticated peer-region changes when selecting their
regional evidence; a completed operation keeps its previously captured region.

TCP SYN output and authenticated exact-tuple TCP reply flags belong to that
connection. WireGuard output, relay queue/flush and peer-labelled input are
shared peer observations during the recorded window. Local queue admission or
flush does not prove remote acknowledgement. A window can span regional changes,
and its shared counts are not attributed to one region. A DERP source label does not
prove cryptographic authentication. SDK reset-or-closed remains distinct from
an observed authenticated TCP RST. Counts, durations and safe error categories
retain no packet bodies, SDK error strings, credentials or physical resources.

Selected-peer map status retains online/offline/unknown and separately labelled
provider last-seen and local offline-notification estimates. These map facts may
be stale and do not establish reachability. WireGuard initiation/response/cookie
and transport-data headers are observed separately in each direction; inbound
headers are not authentication evidence and transport-data includes keepalives.
A local SYN can await encryption. Only admitted exact-tuple TCP facts establish
that connection's replies.

Status-update receipt time belongs to the map-owned peer. Only a known status
in a full/upsert node or a status patch refreshes it; an unknown patch means no
change. Empty/unrelated maps and bindings that reuse cached peer state preserve
that receipt. Local sampling, local status receipt, provider last-seen and the
SDK's local offline estimate are distinct clocks/facts, frozen with the report.
The existing structured `observed_at` field remains the local sample time;
optional `status_received_at` records receipt of the target's status assertion.

Explanations lead with a native boundary summary and the strongest supported
next step. PeerGone and offline/no-input hints retain their selected-peer/relay
scope and uncertainty after stronger root, trust and transport failures.
SSH command, session program and independent session request effects are
captured from their actual owners with the business result's unchanged semantics.
They are labelled separately and never replace CLI/helper delivery uncertainty;
a failed session request does not describe its existing program's effects.

The existing bounded DERP reader optionally observes complete KeepAlive/Ping
frames and SDK-typed PeerGone reasons. Controls belong to a regional incarnation;
PeerGone is correlated to the selected peer before capture. A private 64-entry
recent buffer discards keys from snapshots and marks history overflow explicitly.
An old notification is not global peer state. Without diagnostic authority, no
control observer is allocated and no diagnostic packet classification or peer traversal occurs.

Both retained evidence and rendered text keep the 8192-byte limit. Lower-priority
completed detail can be omitted with an explicit notice to preserve the incident,
critical path, context and next action. A pending relay read is normal waiting,
not evidence that a remote endpoint failed.
Active checks subtract their actual wrapper size and use the same semantic
renderer to fit the remaining budget, preserving critical facts and the omission
notice rather than discarding an otherwise renderable near-limit explanation.

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
replayed automatically. Collection uses the same trusted Run authority and current
assignment/host/dependency authority as passive history.

## Same-Run passive history

`ssh.diagnose` and `vnc.diagnose` accept optional exact UUID `connectionId`,
`attemptId` and `sessionId` filters. Filters intersect; no filters select that
protocol's latest retained operational failure. CLI exposes `okou ssh diagnose`
and `okou vnc diagnose`, including `--attempt-id`, `--session-id` and `--json`.
One passive request returns `status` and a bounded Runner-authored `message`.
These query formats do not retain old report-format decoders.

`--checks` explicitly selects completed active-check receipts instead of failures
(RPC: optional boolean `checks`, default false). The same protocol and intersecting
connection/attempt/session selectors apply. Without an exact Attempt ID, selection
returns the latest matching completed check and cannot establish that it was the
original attempt whose response was lost. Exact missing/evicted attempts never
fall back to another receipt. Empty check history returns `not_retained`.
Found receipts preserve the original check time, passed/failed/blocked outcome,
fresh/reused stages and check-owned cleanup explanation within 8 KiB. Their
Runner observations do not confirm helper delivery, present connectivity or
unobserved cleanup. Retrieval only reads metadata inventories and retained memory;
it never opens a target, resolves credentials, acquires tickets or replays work.

`found` explains one matching failure or explicitly selected check receipt.
`no_failure` means no operational failure was recorded
in this Run, not successful connectivity. `not_retained` never substitutes
an unrelated incident. `authority_unavailable` discloses no retained details.
Its opaque explanation distinguishes an authority API read denial (401/403),
a lookup timeout (including HTTP 408), request/response transport failure,
service failure or rate limit (5xx/429), and an invalid response (including
unexpected statuses, malformed or inconsistent identities and declared/streamed
inventory overflow). The same finite explanations apply to dependency lookups,
without exposing which dependency was checked, tokens, URLs, response bodies or
host data. Successful inventories that omit, revoke or recreate a subject keep
the generic authority explanation. These are failures to read history, not
evidence that the remote SSH/VNC target failed; current connectivity remains
unchecked. The `{status,message}` envelope and CLI exit behavior are unchanged.
`unavailable` covers a disabled/retired owner or unavailable detail.
Queries perform no target login, capture, input, command replay or provisioning.

History requires current read capability and Run/chat/host visibility. Nested
SSH evidence requires dependency visibility too. Existing metadata inventories
always return the current authorized hosts and their required identities.
Runner installs diagnostic authority from the API-authored
`platformEnvironment.OKOU_TOKEN` for this Run. Missing trusted agent authority
leaves history and active checks unavailable while ordinary SSH/VNC operations
keep their existing authorization paths. The internal sandbox token and
user-authored environment cannot substitute for this authority.
Known creation identities must match with PostgreSQL microsecond precision;
later generations on the
same creation instance can still read history. Missing identity projection
fails closed. Generic pre-resolve failures remain unbound and contain no
private configuration or native source evidence.

## Explicit active checks

`okou ssh check <connection-id> [--json]` opens a fresh physical connection
through the normal Direct, Cloudflare Access or Tailscale SSH path, performs
server proof/trust and authentication, and closes only that connection. It sends
no command, shell, file operation or forwarding channel. Existing host-key TOFU
and initial native provisioning policy still apply.
If all physical connection slots are occupied, the check returns blocked and
keeps existing connections.

`okou vnc check <connection-id> --mode shared|exclusive [--json]` uses the
existing session admission/capacity policy, configured security/authentication,
independent KDC and ServerInit, then closes only its temporary session. It sends
no screenshot or desktop input. Mode can affect remote viewers; exclusive mode
can disconnect them or be refused. Checks never evict foreground sessions to
make room. Kerberos ticket acquisition remains an authentication effect.

Both require the exact current assignment and a trusted
API-installed Run token with the corresponding execution (`ssh:write` or
`vnc:write`) capability. Passive read authority cannot authorize a login.
Current host/dependency authority and normal configuration invalidation remain
authoritative. A failed retained native node blocks reuse; checks never restart
it, reset trust, bypass provisioning journals or change modes automatically.

One bounded result contains `type: active_check`, `status: passed|failed|blocked`
and the same opaque Runner-authored `message` in human/JSON output. It identifies
the check time/context, observed fresh/reused/unknown stages and check-owned
cleanup scope. SSH waits for physical transport release; VNC waits for temporary
session closure and explicitly leaves SSH/Kerberos descendant completion unknown.
Those descendants retain their existing physical owners/capacity. Passing proves
only the authenticated SSH or initialized VNC setup at
that time. It does not prove command, framebuffer, input or later health.
Unconfirmed cleanup stays unknown; shared native resources remain Run-owned.

Check-local evidence, including nested SSH/KDC/native failures, is isolated from
operational pins, the operational detail ring and qualifying observation API
writes. The latest 64 completed check receipts across SSH/VNC are retained in a
separate completion-ordered ring, with no check pins. Messages are frozen before
helper delivery, so a lost or rejected response can still have retained evidence.
Unfinished checks may have no receipt; eviction, missing evidence or unavailable
authority never proves connectivity or cleanup. Passing and failing
checks cannot explain or erase a previous operational failure. No discovery,
version fallback, automatic retry or business replay is performed.

## Source ownership and bounds

The exact Run registration owns 64 operational detailed reports, separately
pinned latest SSH/VNC failures, and 64 completed check receipts. Later successes
do not clear pins. Removed sessions
and nodes do not remove history. Assignment UUIDs fence stale producers.
No cross-Run archive exists.

Evidence contains finite stages and typed identifiers, never provider/peer
bodies, hostnames, credentials, auth URLs, commands/output, file paths/content,
screenshots, input, maps or packets. Only the selected policy-approved address
is recorded, not a complete DNS answer set. Unobserved or abandoned stages stay unknown;
reused setup cannot prove fresh health. File causes remain file causes.
The first Cloudflare cause survives later carrier/cleanup failures. Safe logs
and explanation text use the same typed source facts.

VNC stages retain monotonic local elapsed milliseconds only when collection is
enabled. A measured zero differs from unavailable timing; not-reached stages
have no duration. Setup is frozen when captured for a report or native watch.
Later operations label that setup as reused and time only their own observed
work after session lookup, including engine-lock waits. Unobserved background
retirement has no request duration. Explicit checks time their temporary
session's retirement wait, including an unknown result at its deadline.
Authentication includes nested KDC work; independent KDC transport/exchange
durations accumulate across exchanges, so stage times must not be added.
Reports and shared explanation text retain the existing 8 KiB limits. Semantic
compaction preserves critical VNC authentication, initialization, KDC and
retirement timing and identifies omitted noncritical timing.

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
Native VNC records separate RFB and independently authorized KDC carrier receipts,
including each configuration/generation and attempt. Tailscale receipts identify
the shared resource and fresh private TCP connection separately; reused node
setup does not establish current control health. Cloudflare receipts retain
actual DNS/address-policy, TCP, gateway TLS/WebSocket and optional independent
RFB origin-TLS progress. Successful KDC carrier facts are captured before its
source is restored to RFB; failed KDC setup keeps its own source. These two fixed
role slots retain no carrier, native node or physical lease. Established native
failure publication includes the consumer's VNC context and private connection
trace, even when no SSH dependency exists.
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
The existing bounded provisioning journal retains that pure receipt after weak
node removal. A VNC check blocks on a prior failed source before provisioning
another node, including after physical cleanup; ordinary operation retry/journal
eligibility is unchanged. Intentional node cancellation alone is not a failed
source. The receipt owns no physical capacity.

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

All packaged KDC diagnostics, including native RFB failure interrupting a pending
Cloudflare KDC exchange, can be run together on that supported runtime:

```sh
cargo test --manifest-path crates/Cargo.toml --profile local --locked -j 1 \
  -p runner-remote --all-features --lib kdc -- --ignored --test-threads=1
```

The native Cloudflare RFB/independent KDC trust-refusal RPC regression also uses
the packaged worker and the same Linux runtime requirements:

```sh
cargo test --manifest-path crates/Cargo.toml --profile local --locked -j 1 \
  -p runner-remote --lib \
  vnc::tests::native::diagnostics::native_kdc_trust_failure_keeps_separate_rfb_and_kdc_configuration_receipts \
  -- --exact --ignored
```

The mixed Cloudflare RFB/Tailscale KDC failure regression has the same requirement:

```sh
cargo test --manifest-path crates/Cargo.toml --profile local --locked -j 1 \
  -p runner-remote --lib \
  tailscale::tests::provisioning::regional_tcp::vnc::diagnostics::mixed_cloudflare_rfb_tailscale_kdc_failure_keeps_the_kdc_native_source \
  -- --exact --ignored
```
