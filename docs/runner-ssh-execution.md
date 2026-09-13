# Runner SSH execution

#32387 implements the Runner-owned execution slice of #32013 (under #31932).
The [CLI and owner/Agent UI](ssh-access.md) were delivered by #32014 / PR #32722.
SSH defaults to enabled for staff organizations through the existing feature
switch; local/PAT Runners remain unsupported.
Current [API authority](runner-ssh-authority.md), including the feature
gate and current Agent grant, is required on a cache miss and for first-use pinning.
Successful authority snapshots follow the Run-scoped lifetime below. Run source,
chat channel, workflows and trigger metadata add no eligibility gate. Retained
historical Goal provenance follows the same source-independent rule; the retired
Goal lifecycle cannot create or resume work.

## One-shot request and outcomes

The guest calls `runner-rpc-client` with the [generic envelope](runner-rpc-transport.md).
`ssh.exec` accepts exactly `sshConnectionId` (hyphenated UUID) and `command`
(at most 64 KiB UTF-8). Extra and duplicate fields are rejected. It cannot supply
Run, owner, Agent, endpoint, username, private key, pin, timeout or SSH options.
Unknown methods and invalid params are rejected before credential resolution.

The Runner resolves or reuses its Run-owned credentials and exclusively leases an
idle authenticated connection, or validates the destination and establishes a new
TCP/SSH connection with host trust and private-key/password authentication. It opens
a new session channel and requests one non-PTY exec with acknowledgement. It sends
EOF on stdin. It never requests shell, environment, PTY, agent forwarding, port
forwarding or subsystems, and rejects unsolicited server channels. There is no
reconnection, alternate-address fallback or command replay.

Business data is contained only in generic `event`/`result` envelopes:

```json
{"type":"event","data":{"type":"accepted"}}
{"type":"event","data":{"type":"output","stream":"stdout","data":"aGVsbG8K"}}
{"type":"result","data":{"type":"finished","exit":{"type":"status","code":0},"effects":"completed","stdout_bytes":6,"stderr_bytes":0,"stdout_truncated":false,"stderr_truncated":false}}
```

`accepted` is emitted only after the peer accepts exec. Output is binary-safe
standard base64, with independent stdout/stderr byte counts and truncation.
Counts describe retained bytes, not discarded excess output. Exit status is an
unsigned SSH status, including nonzero. Signal exit is
`{"type":"signal","signal":"TERM","core_dumped":false}`; only standard known
signal names survive, and unknown names become `UNKNOWN`. Peer diagnostics and
language tags never cross the boundary. Missing exit evidence is not success.

A business failure has `type: failed` and an allow-listed `failure_reason`:
`unavailable`, `authority_failure`, `invalid_credential`,
`unsupported_credential`, `credential_resource_limit`, `unsafe_destination`,
`network_failure`, `host_key_mismatch`, `unsupported_host_key`,
`configuration_changed`, `authentication_failed`, `protocol`, `exec_rejected`,
`disconnected`, `timed_out`, `cancelled`, `resource_exhausted`, or `transport`.
It retains the same output counters/truncation fields.

`effects` is `not_started` before an exec send attempt or after explicit exec
refusal; it becomes `unknown` once sending is attempted without terminal remote
evidence. `completed` means the remote process supplied exit evidence and closed
the channel, not that its exit status was zero. The helper's exit zero means RPC
completion only: future callers must inspect these business fields. Losing a
terminal response never permits automatic replay. Local cancellation closes the
socket but cannot guarantee the remote process stopped.

## Managed sessions within one Run

#33464 adds `ssh.session.start/list/read/status/write/signal/close` as opaque
version-1 RPC methods. Each request is still short and owns its guest stream
only until its response. Each active session exclusively owns a verified,
authenticated SSH transport, which may be reused after an earlier channel ended.

`start` accepts `sshConnectionId`, `program: {type: "exec", command}` or
`program: {type: "shell"}`, and optional `pty: true`. A PTY requests
`xterm-256color`, 80 columns and 24 rows. Forwarding, agent forwarding,
subsystems and arbitrary SSH options remain unavailable. Start returns
`{type: "started", session_id}` before asynchronous setup finishes. Use `status`
or `list` to inspect `starting`, `running`, `finished` or `failed`; an admitted
ID is not evidence of successful authentication or process execution. Setup
has a 60-second budget, while an active, quiet process can run until Run/sandbox
cancellation or a two-hour session maximum. Keepalives detect dead peers without
imposing a shorter idle timeout on a healthy process.

There are eight retained session records per exact current Run, separate from
the existing eight short request slots. Completed records occupy a slot for five
minutes unless explicitly closed; pruning runs every 30 seconds and on access.
No Runner-wide connection quota is introduced. A retired session's CPU, DNS or
socket work retains its original session permit until actual cleanup. These host
resources never own guest I/O or a guest park reservation. Run end invalidates
all IDs; a later Run cannot reattach to an earlier session.

`read` takes `sessionId` and a nonnegative byte `cursor`. It immediately returns
tagged standard-base64 chunks, a `next_cursor`, and session status including
`oldest_cursor` and `end_cursor`. Reads do not consume data. Output retention is
bounded by 1 MiB and 256 chunks of at most 4 KiB per session. Old chunks are
discarded; reading behind the retained prefix returns `lost: {from, to}`. A read
returns at most 8 KiB and 32 chunks, fitting one existing 24 KiB RPC frame.
Stdout and stderr share one cursor; their observed interleaving is preserved.

`write` accepts `sessionId`, canonical `dataBase64` (at most 16 KiB decoded) and
optional `eof`. Empty input requires EOF. One bounded eight-item queue serializes
stdin, EOF and `signal` requests while independently draining output. Expired or
cancelled control requests are checked before submission. A write after EOF is
rejected. Signals are limited to INT, TERM, KILL, HUP, USR1 and USR2. A submitted
write/signal returns `effects: unknown`, because SSH submission does not prove
what the remote process did. Partial input failure closes the session and is
never replayed. Closing retires the ID and local transport; it does not confirm
remote descendants stopped. Lost start replies can be investigated using `list`.

Retained authority requires an active invalidation subscription. Delivered
targeted/Run-wide invalidation, registration replacement and observed Ably
disconnect cancel the affected sessions and retire their IDs. New sessions fail
explicitly while disconnected. Cache saturation uses session-owned, uncached
credentials with weak cancellation watchers on the exact Run registration, so
the 256 cache cells do not become a global session cap. Per-Run admission bounds
these extra retained credentials, and dead watchers are pruned. Failed
asynchronous credential preparation remains inspectable without caching a failed
value. A one-shot authentication/trust/configuration failure that evicts a shared
snapshot also retires sessions using that snapshot. The documented
missed-notification window still applies; close/revocation
does not guarantee remote process-tree termination.

## Idle connection reuse

#33465 reuses healthy authenticated transports between independent exec/session
channels in the same exact Run registration. A transport has one active channel
at a time. Concurrent processes use separate transports, so cancelling one process
or stalling its output consumer does not close or block another process's connection.
Each channel starts a new process; cwd, environment, stdin and PTY state are not
inherited from the preceding channel. No CLI or RPC changes are required.

Only an observed channel close with actual exit evidence can return a connection
to idle. Rejected setup, missing exit, cancellation, partial input, protocol failure
or an uncertain channel-open result closes that execution's exclusive socket.
No failed command/input is reconnected or replayed. A later separate request may
establish its own fresh connection.

A peer can retire an idle socket or refuse its next channel. If that races reuse,
the current request reports its failure/effects; it does not retry on another
connection. A peer that refuses sequential channels can therefore cause an extra
failed request compared with always establishing a new connection.

Completed connections enable `TCP_NODELAY` before idle retention so later channels'
small control packets avoid Nagle/delayed-ACK stalls. The first handshake and
command keep their existing socket behavior. If the socket cannot be prepared
for reuse, it is retired without changing the completed command's result.

The Run retains at most eight idle transports, evicting the oldest on overflow.
An idle timer closes each socket after 60 seconds without another request.
Idle expiry rechecks current pool membership under the same lock as checkout, so
a delayed timeout cannot close a connection already in use or newly returned to idle.
Physical work has 24 Run-local permits: eight short operations, eight retained sessions and
eight idle transports. Physical-capacity waits observe the caller's setup deadline
and cancellation. Neither this bound nor idle retention creates a Runner-wide quota.
The socket's host lease holds its physical permit through actual DNS/library cleanup.
It also holds the current operation permit until failure cleanup or proven channel
completion; only normal completion releases that operation permit for idle retention.
Guest park reservations remain exclusively owned by live guest RPC streams.

Reuse matches the configured connection ID and current authority generation, never
just the endpoint. Cancellation watchers are registered before credential preparation,
including when the credential cache is full. Delivered invalidation, notification
disconnect and Run/sandbox retirement close active and idle retained transports.
This also interrupts an in-flight one-shot command using retained authority; a
late pin result cannot revive its retired transport or evict a newer snapshot.
Before notification readiness, one-shot commands still resolve/connect afresh and
retain no idle socket; managed sessions keep their existing readiness requirement.

Each physical connection independently validates the public destination and server
proof/pin before authentication. Reused sockets keep their original verified peer;
new physical connections repeat validation. Keepalives run every 30 seconds, with
three unanswered probes allowed. Rekey and transport cancellation use a lifetime
of at most two hours, independent of the initial RPC deadline. Run end always
closes the transport. Existing missed-notification and remote-process termination
limitations still apply.

Sequential reuse avoids repeated TCP/KEX/authentication; busy connections are not
shared by concurrent processes. A manual real-peer cold/warm measurement lives in
`ssh::tests::pooling::measure_cold_and_warm_repeated_exec`. It reports elapsed
samples and authentication counts without a timing assertion; local measurements
do not establish a production speedup.

On 2026-09-12, the local-profile dispatcher and loopback SSH peer ran a real `true`
process for ten cold and ten warm samples. Both paths reused prepared credentials;
priming and forced idle expiry were outside the measured request. The warm path
opened a separate process/channel for every sample.

| Path | Median   | Min–max        | New connections / authentications |
| ---- | -------- | -------------- | --------------------------------- |
| Cold | 65.70 ms | 64.63–66.29 ms | 10 / 10                           |
| Warm | 44.02 ms | 43.12–44.12 ms | 0 / 0                             |

Rerun the optional measurement with:

```bash
cargo test --manifest-path crates/Cargo.toml --profile local -p runner --bin runner \
  ssh::tests::pooling::measure_cold_and_warm_repeated_exec \
  -- --ignored --exact --nocapture --test-threads=1
```

## Authority, trust and destination

Resolve/pin requests use the host's immutable Runner process identity and exact
current Run assignment. A token prefix selects official transport only; API
authentication and winning-claim checks provide the actual authority. Responses
must be HTTP 200, fit 512 KiB, and satisfy generated DTOs and semantic bounds.
Redirects are rejected. A missing/old API fails closed whenever a fresh resolve
or pin is required, without affecting normal Agent execution. Cache hits make no
API request. In-flight handoffs cannot be retracted; missed invalidations may
additionally preserve an authorized snapshot until Run end.

### Run-scoped authority and credential cache

The first use of a connection resolves current authority and prepares exactly one
authentication method. Private keys are parsed under the existing CPU/admission
limits; passwords require no key-decoding slot. While the Runner's Ably subscription
is connected, later commands in the same Run reuse that prepared configuration,
generation, host trust and parsed key or bounded zeroizing password. The credential
cache has no TTL, periodic refresh, disk persistence or cross-Run sharing; idle
authenticated transports have the separate bounded lifetime above. Raw private
key/passphrase text is released after preparation rather than retained alongside
the parsed key. Every new physical connection validates its public destination and the
server's cryptographic proof and fingerprint.

The runtime retains at most 256 cache cells, including evicted cells still owned
by in-flight requests. Saturation bypasses caching instead of rejecting a command;
uncached/in-flight work still uses the existing request and CPU limits. Concurrent
misses share a fill. Cache entries belong to a specific active Run registration,
not just its UUID; replacement, Run end, cancellation, teardown and shutdown retire
them. Removed entries cannot be republished by late resolve/decode/pin completion.
Already-admitted work may retain bounded references until it actually finishes.

API mutations publish `ssh-authority-invalidated` on the existing Runner-group
Ably channel, with `{runId, connectionId}`; a null connection ID evicts all entries
for that Run. Notices contain no credentials and cannot grant access or establish
trust. Connection edits/rotation, deletion and explicit host-key reset notify
active owner Runs after commit. Agent grant changes publish Run-wide invalidation
for the affected user's Agent Runs, including after revocation removes the grant.
First-use pin/match records the confirmed identity locally only after the
authorized N+1 response.

Before subscription readiness or while disconnected/failed, the Runner bypasses
shared caching and resolves each command. Observed connection loss clears cached
entries; recovery rebuilds them lazily from the API. A relevant invalidation or one-shot
authentication/trust/configuration failure evicts the entry for later commands.
Required re-resolution failure never restores an invalidated credential, and no
failure or invalidation automatically replays a command or silently repins a host.

Publishing is best effort and subscriber business messages can be dropped when
its queue is full. **A missed notice can leave old authority usable for the rest
of the Run, even after deletion or revocation.** There is no 30-second freshness
guarantee; observed-disconnect clearing does not guarantee delivery. This window
and longer bounded retention of parsed keys in Runner memory are accepted product
trade-offs. Cache invalidation does not promise to stop an already-started remote
command. HTTP/proxy caching remains disabled with `Cache-Control: no-store`.

Native public-address constants are generated from the canonical connector
destination policy and exercised against its shared JSON fixtures. All DNS
answers must be public, use the exact requested port, and have no IPv6 scope or
flow metadata. Empty or more than 64 answers are rejected. Canonical ASCII DNS
names are queried with a root dot; literals bypass DNS. Legacy numeric, scoped,
URL and bracketed host forms are rejected. The engine connects to one selected
approved `SocketAddr`, without a second lookup.

After KEX proof verification, an existing pin must match algorithm and SHA256
fingerprint locally. Without a pin, the current-authority pin API must return
`pinned` or `matched` at exactly JIT generation plus one before authentication.
Mismatch/stale/unavailable results do not authenticate or overwrite trust.
First-use TOFU still cannot prevent a first-use MITM.

The engine advertises Curve25519 and DH group14 SHA256 KEX, Ed25519/ECDSA and
RSA-SHA2 host signatures, ChaCha20-Poly1305/AES-GCM/AES-CTR, and SHA2 MACs. RSA
client authentication uses SHA2 only. DSA, SHA1 negotiation and certificates are
not offered.

### Explicitly deferred dependency limitation

The published `russh 0.63.2` verifies cryptographic host signatures but does not
require the signature blob's algorithm to equal the negotiated host-signature
algorithm. A real-peer probe showed a valid RSA-SHA1 proof can be accepted after
RSA-SHA512-only negotiation. This is a verified algorithm-policy gap, not a
demonstrated host-pin bypass or practical impersonation exploit. The user
explicitly deferred fixing it on 2026-09-08. This PR uses the stock dependency,
not a fork/vendor patch, and does not claim zero risk or strict enforcement of
the actual server proof hash. Pin, proof-of-possession, current-authority and
client-signing checks remain in force.

## Credential and resource envelope

Accepted private key containers are OpenSSH, PKCS8, encrypted PKCS8 and PKCS1
RSA. Keys may be Ed25519, NIST P-256/P-384/P-521 or RSA 2048..8192 bits. RSA
components are bounded to 1024 bytes, with an exponent at most 4 bytes; multiprime
RSA is unsupported. PEM legacy encryption, standalone SEC1 EC, DSA, certificates,
security keys and PPK are not accepted.

Encrypted OpenSSH permits modern AES schemes with bcrypt 1..64 rounds and
16..64-byte salt. Encrypted PKCS8 requires PBES2/AES with PBKDF2 SHA256/384/512
at most 600,000 iterations, or scrypt with at most 32 MiB estimated working memory,
`r <= 8`, `p = 1` and power-of-two `N > 1`. Advertised excessive cost is rejected
before derivation. These are intentional service resource limits: a valid key
outside them must be re-exported within the supported envelope.

Private key/passphrase text uses canonical UTF-16 bounds (65536/4096), preserving
whitespace. Credential-bearing generated DTOs cannot Debug/Clone/Serialize and
deserialize fields directly rather than through tagged generic-value buffers.
Application-owned response, PEM and decrypted buffers are bounded and zeroizing;
this is not a claim that serde/HTTP/crypto libraries eliminate every internal
plaintext copy. Credentials are never written to guest files or checkpoints.

The private `resolved_password` response supplies a login password (1..4096 UTF-16
code units, preserving whitespace), distinct from a private-key passphrase. The
Runner sends it only after host proof and pin/TOFU succeed. The destination receives
the password over encrypted SSH; unlike private-key authentication, a malicious
destination can learn and reuse it. Partial authentication or rejection fails
without exec, another authentication method or command replay. Keyboard-interactive,
OTP/MFA and forced password-change exchanges are not supported.

#33467 adds this contract and execution capability only. Owner configuration and
API credential writers remain key-only until #33468 delivers reusable credentials.
SSH is staff-only, so this work adds no legacy compatibility or reader-drain gate;
see [fallback policy](fallback.md#2-features-behind-a-feature-switch-need-no-fallback).

Each sandbox's current Run admits up to 8 concurrent SSH requests, before request
parsing and JIT. There is no Runner-wide SSH request or connection admission cap;
other Runs do not consume this quota. A new Run receives a fresh 8-slot quota.
Slots cover admitted work through parsing, authority, DNS, authentication,
execution and host cleanup, rather than only established connections. Aggregate
socket, memory and network use can therefore grow with active Runs and outstanding
cleanup from retired Runs. Expensive key decoding still uses 2 process-wide
blocking slots. When both are occupied, private-key preparation waits
asynchronously within the request's existing deadline and Run/sandbox cancellation
scope, before submitting a blocking job. Waiting retains the Run request slot and
credential input but occupies no blocking worker; timeout or cancellation removes
the waiter before DNS, TCP connection, SSH authentication or command execution.
Password authentication and valid prepared-credential cache hits bypass decoding.
Authority-cache and observation-report bounds remain separate.
Cancelled blocking work and system DNS retain their original Run's capacity
permits until they really finish. The dispatcher owns the guest stream and its existing
normal-operation/park reservation independently. Once request I/O closes and the
stream drops, host-only work no longer blocks guest park, while its capacity
remains charged until actual completion. No independent park counter is added.

Each stream retains at most 1 MiB output, coalesced into at most 16 KiB chunks,
with periodic low-volume flushing. Both full streams fit the generic 24 KiB
frame/4 MiB aggregate envelope, including terminal reserve. Incoming SSH channel
queues hold at most 64 messages. The advertised packet size is 32 KiB, with
russh's hard transport cap of 256 KiB plus framing headroom bounding packets
from nonconforming peers too. Excess output is discarded with truncation, not
accumulated.
Every external await observes Run/sandbox cancellation and the helper-coordinated
60-second maximum deadline. Partial cancelled frame writes are never resumed.

The shared fresh/reused Run boundary installs the dispatcher before Agent work
and cancels/joins it before cleanup. Dropping the Run also cancels it. A connected
socket guard closes detached russh I/O, while that I/O retains host capacity
until it exits. Shutdown joins request dispatch; it need not wait for remaining
host-only cleanup before guest park. Run registration retirement and cancellation
still prevent late work from connecting, authenticating or republishing old
credentials after cancellation. Telemetry contains only owned identifiers, fixed
outcomes, timing, byte counts, truncation and terminal-delivery state. Production
fmt/Axiom sinks suppress raw russh/ssh-key/ssh-cipher diagnostics at every level.

## Connection observations

PR #33165 adds best-effort [connection observations](runner-ssh-authority.md#diagnostic-connection-observations)
after terminal delivery is attempted. Reports carry only Run/Runner/connection
identifiers, configuration generation, observation time and an allow-listed failure code or
authenticated-success observation, never commands, output or credentials.
They are separate from command outcomes: successful authentication can clear a
host warning even if its command later fails. Reporting cannot change or replay
the command, and missing reports do not prove a host is healthy.

## Rollout and validation

Staff-default availability is configured in `sshAccess`; explicit overrides and
current owner/Agent/Run authority still apply. It is not general availability or
evidence that every deployed artifact is current. API, Platform, Runner/rootfs
and the selected CLI retain their [deployment compatibility](deployment-compatibility.md)
boundaries.

PR #32722 records two-host, same-Run, non-chat and snapshot restore/reuse SSH
acceptance. Native generic RPC has separate fresh/restored/reused KVM coverage.
Actual API-backed Runs use the snapshot provider; a separate cold-boot business
SSH mode is not required. Historical validation retains its recorded revision
and artifacts, rather than claiming a fresh deployed test of later changes.
