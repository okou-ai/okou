# Guest-to-Runner RPC

The transport delivered by #32012 is infrastructure under #31932. Its first
consumer is the [Runner SSH dispatcher](runner-ssh-execution.md), installed by
#32387 for official API-backed Runs. The generic transport itself has no API
calls or business validators. Local/mock sandbox providers expose no capability.
The [SSH CLI and owner/Agent UI](ssh-access.md) are delivered. SSH availability
uses the existing staff-default `sshAccess` switch and current API authority;
the transport itself does not grant SSH access.

## Guest boundary

`/usr/local/bin/runner-rpc-client` takes no arguments. Its stdin is one JSON envelope
terminated by EOF:

```json
{
  "version": 1,
  "method": "ssh.exec",
  "params": {
    "sshConnectionId": "ad729daa-0606-4113-ae6e-a8c553260f9d",
    "command": "uname -s"
  }
}
```

This is the SSH adapter's request; availability still depends on current API authority.
Transport validates version 1, a nonempty method of at most 64 ASCII letters,
digits, dots, underscores or hyphens, and object-valued params. Unknown envelope
fields, duplicate envelope keys, invalid types and extra JSON within the request
frame fail. The helper also rejects extra JSON on its stdin.
Transport does not interpret params or validate SSH UUIDs/commands. Raw JSON
preserves nested fields, duplicate business keys and numeric tokens without
rounding; the method schema decides whether those values are acceptable.

A routing label is not a path, executable, endpoint or permission grant. Run,
owner and sandbox identity come from the host assignment, never from params.
Every production method must have explicit dispatch and current-authority checks
before sensitive work. Unknown/unavailable methods must be rejected before
invoking a handler. These responsibilities belong to #32013.

The helper connects once to AF_VSOCK CID 2, port 52001, routed by Firecracker to
the private host listener at `vsock.sock_52001`. There is no destination override,
reconnection or replay. It invokes no shell and creates no payload files/logs.
Each frame is a big-endian u32 length followed by JSON:

| Bound                                     | Encoded bytes |
| ----------------------------------------- | ------------: |
| Request                                   |       400 KiB |
| Response frame                            |        24 KiB |
| Entire response, including length headers |         4 MiB |

Frame and remaining aggregate limits are checked before body allocation.
Outgoing messages are checked before wire writes. Events must leave capacity
for one maximum-sized terminal frame. The first complete request frame is the
request boundary: the host validates it and dispatches at most once per connection,
without waiting for EOF. Bytes after that frame are outside the one-shot request;
they are never consumed as another request and cannot trigger another operation.
The host does not drain or wait for trailing input and drops the connection after
request handling ends. Detached host cleanup does not retain that connection.
This replaces connection-wide trailing-byte rejection,
not strict JSON validation inside the frame.

The guest helper half-closes after sending, but dispatch does not depend on that
half-close. Firecracker v1.15.1 records guest send shutdown without forwarding it
as EOF on its host Unix stream. Waiting for it before replying stalls until the
guest's deadline. Drop request I/O on cancellation or
failure; stateful response readers/writers cannot resume after partial I/O.

## Responses, completion and ambiguity

The strict response envelopes are:

```json
{"type":"event","data":{"progress":1}}
{"type":"result","data":{"businessSuccess":false}}
{"type":"error","code":"unknown_method","delivery":"not_dispatched"}
```

These illustrate alternatives: a stream permits zero or more events followed by
exactly one result OR error, then EOF. Data can be any opaque JSON value,
including null. Error codes are `invalid_request`, `unknown_method`,
`unavailable`, `protocol`, `transport`, `timed_out` and
`resource_exhausted`. No arbitrary diagnostic string is allowed.

The helper emits events as single-line NDJSON. Only JSON whitespace outside
strings is removed; raw numeric tokens, duplicate keys and escapes survive.
The terminal is withheld until EOF proves there is no duplicate/trailing data.
The stateful host writer half-closes after terminal, but retains its stream.
Unlike guest send shutdown, Firecracker forwards host stream EOF to the guest.
Native fresh/restored tests verify terminal delivery while the host still owns
the stream. Do not replace terminal-plus-EOF verification with first-terminal
success: duplicate/trailing response data remains a protocol error.

A valid result means RPC completion, **not business success**. The helper exits
zero only after delivering that result. The caller must interpret business
failure/nonzero exit within its data. A generic error exits nonzero and is not a
method result.

`delivery: not_dispatched` is allowed only when known before local request
transmission or explicitly rejected before host handler dispatch. It is invalid
after any event. Once transmission is attempted, missing replies or transport
failures are conservatively `unknown`: absence of events proves nothing about
effects. The helper never reconnects or retries.

The total helper budget is 60 seconds over stdin, connect, request/response I/O
and stdout, with the last 100 ms reserved for terminal reporting. Failed or
cancelled partial stdout writes exit unsuccessfully without appending a corrupt
replacement terminal. A broken pipe cannot guarantee terminal delivery.

After stdin and connect, the bundled helper adds internal `remaining_ms` metadata
to the wire envelope. Callers cannot supply that field, including null. The host
clamps it to 60 seconds, includes request reading in that budget, and reserves
the final second for its terminal response. The metadata is an untrusted deadline
hint, never authority. It contains no method-specific data. Helper and official
Runner ship together; no fallback or protocol negotiation is added.

## Host ownership and lifecycle

`Sandbox::guest_rpc(expected_run_id)` returns an assignment-bound
`GuestRpcAcceptor`. `AcceptedGuestRpc` supplies a host-derived sandbox ID,
a `GuestRpcStream` owning a normal-operation reservation, and lifecycle
cancellation. Keep the stream through request I/O and intervening handler work.
Dropping the stream releases its reservation. Host-only work remaining after
guest I/O closes must retain its own capacity and resources independently; it
does not keep the guest busy for park. An input half-close or a terminal response
alone does not drop the stream or release its reservation.

Run authority and cancellation remain separate from both resource lifetimes.
RPC closure does not grant continued authority or cross-Run attachment. Handlers
must still observe lifecycle cancellation and must not publish late results into
a retired or replacement Run registration.

Admission checks Running/Open/current assignment and acquires the SAME
`GuestControlClient` tracker reservation at the admission linearization point, with no
coordinator lock held across await. If park wins, admission fails; if RPC wins,
park is Busy. Both normal park and final-exec-park/handoff invalidate the old
endpoint. Rebinding precedes guest resume; old handles/backlog cannot follow a
new assignment. There is no separate in-flight counter.

The private listener binds synchronously before fresh boot or snapshot restore
in a 0700 vsock directory, with socket mode 0600. Startup/unpark own it locally
until success. Failure, cancellation, runtime exit, stop, kill, Drop and
successful park close it. Failed bind never unlinks another owner's socket.

Termination cancels pending admission and accepted I/O without waiting for
external effects. Handlers must also select lifecycle cancellation throughout
non-I/O work and bound their own concurrency and deadline. Host work that outlives
cancellation retains its resource permits until it actually exits, without
retaining closed guest I/O or its park reservation. Transport cancellation cannot
guarantee remote process termination.

This dedicated guest-initiated channel does not change the ordinary
host-to-guest control protocol. `process-control-ipc` remains guest-local
process control/placement IPC, not this cross-VM transport.

## SSH consumer ownership and delivery

Managed `ssh.session.*` methods use the same opaque version-1 transport and one
terminal result per short request. Session IDs, cursor reads, stdin/EOF, signals,
PTY and retained process state belong to the SSH consumer, not this protocol.
The Runner-owned session task never retains the initiating guest stream or its
park reservation. No helper negotiation, method fallback or automatic replay is
added: an older Runner returns `unknown_method` explicitly. See
[managed SSH session ownership](runner-ssh-execution.md#managed-sessions-within-one-run).

#32013 owns explicit `ssh.exec` dispatch, strict business schemas, dynamic JIT
authorization, credentials, TOFU and execution. Generic events wrap SSH
accepted/stdout/stderr data; a generic result wraps SSH finished/error data.
Exec acceptance, remote exit/signal, base64 decoding, independent 1 MiB output
caps, truncation and execution effects are SSH semantics, not transport types.

#32014 owns the CLI adapter and strict SSH event/result ordering and exit-code
mapping. Both streams' full output, encoded in bounded chunks, must fit the
transport budget with terminal capacity; transport exhaustion must not be
reported as successful complete output.

Opaque transport cannot promise arbitrary user data contains no hostnames or
credential-looking strings. SSH DTOs/handlers/adapter and leak-canary tests must
prevent trusted credentials or JIT configuration from being supplied to the
guest. Authorized inventory summaries are a separate non-secret data class.

Cargo/release configuration, the manifest, release SHA/tag projections, canonical
guest inventory, generated bundle inputs, Runner build options and rootfs
verification use the generic helper identity. Runner and bundled guest binaries
ship together. The old SSH-specific helper was unmerged/unexposed when renamed,
so there is no compatibility alias. API and control-channel contracts are
unchanged.

The staff-default SSH rollout changes no transport or CLI contract. Runner/rootfs,
API, UI and selected commit-addressed CLI artifacts retain their independent
deployment boundaries. Add no negotiation header, fallback routing, plugin
registry, batching or pooling. See [deployment compatibility](deployment-compatibility.md).

Local tests use real sockets, files, the real control handshake and operation
tracker, plus unrelated external test methods. They require no web server.
Actual fresh/restored KVM boot and packaged-helper execution have separate
metal-host CI coverage.

The `guest-rpc-firecracker-test` CI job runs the native `guest_rpc` integration
test against the matching runner-build rootfs and snapshot. It covers a generic
echo result, an unknown-method rejection, response EOF, and park/reassignment in
both fresh and snapshot-restored guests. Its test-only consumer does not enable
methods in local/PAT Runners or establish SSH authorization. Unix parser/helper
and actual Runner dispatcher tests separately protect bounds, corruption handling
and one execution even when more request frames arrive.

For #32804, Runner and bundled helper remain one artifact; guest binary bytes
participate in rootfs identity and the snapshot identity includes that rootfs.
There is no cross-version helper negotiation, fallback or replay. CLI stdin/stdout
and API contracts are unchanged. PR #32722 records owner-authorized two-host SSH,
TOFU, live inventory, delivered revoke/invalidation and non-chat acceptance
through the snapshot restore/reuse path. These results are distinct from generic
native transport coverage and retain their recorded artifact identities. No
separate cold-boot business SSH path is required.
