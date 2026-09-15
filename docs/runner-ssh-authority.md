# Runner SSH authority API

The API slice (#32386) and [Runner execution](runner-ssh-execution.md) (#32387)
deliver SSH authority under #31932. The Runner consumes these routes through
generated private Rust DTOs. [Owner and Agent consumers](ssh-access.md), including
the CLI and management UI, were delivered by #32014 / PR #32722.

## Authority and secret handoff

Runner SSH endpoints accept only the official fleet Runner credential. A local Runner
PAT, browser session or guest token cannot resolve credentials or learn trust.
The request identifies a Run, connection and winning Runner process
(`runnerId`, `heartbeatGeneration`); it cannot supply owner, Agent, endpoint,
credentials or command. The shared fleet secret authenticates the fleet, not an
individual machine: the process identity is checked against the Run's immutable
winning claim. Protecting the fleet secret remains a trust assumption.

Each call joins the current running Run, session, currently visible Agent,
the Run user's SSH grant, exact user-owned connection and its credential.
Run, session, grant and host user/workspace identities must agree. The Agent
must belong to that workspace and be public or owned by the Run user; its
creator need not own the host. Shared Agents never use their creator's hosts
on another user's Run. The current `SshAccess` (`sshAccess`) feature switch must be enabled;
there is no additional staff-org gate.
SSH access depends on the user's current configuration and the Agent's current
grant, not how the Run started. All chat channels, workflow schedule/event
automations, delegated Agents, webhooks, SDK/non-chat and test Runs use the same
authority path. A chat thread or trigger metadata is not required; workflow
associations and retained historical Goal provenance add no eligibility gate.
The Goal lifecycle is retired; that provenance cannot create or resume work.
The session identifies the Agent without using chat-thread state as an authorization gate.
The switch defaults to enabled for staff organizations and disabled elsewhere;
explicit user overrides remain effective. This rollout default does not replace
authorization or expose credentials to local/PAT Runners.

`POST /api/runners/runs/:runId/ssh/resolve` takes:

```json
{
  "connectionId": "b1f329f0-8010-48fb-9884-f78c839b35bf",
  "runnerIdentity": {
    "runnerId": "08999e12-3b53-4206-8088-374f3c0f6a54",
    "heartbeatGeneration": 7
  }
}
```

HTTP 200 has `outcome: resolved` with host, port, username, generation,
nullable learnedHostKey, privateKey and nullable passphrase. Secret whitespace
is preserved. This response is private to the trusted Runner, never guest RPC
output, Run snapshots, checkpoints, logs or audit metadata. The response is
`Cache-Control: no-store`. Downstream code must not log the response or arbitrary
errors containing it.

Missing, hidden, revoked or ineligible references all produce HTTP 200 with
only `{"outcome":"unavailable"}`, before decryption. Invalid syntax is 400;
missing/invalid auth is 401; authenticated local Runner auth is 403. Broken DB,
KMS or stored local invariants remain server errors, not unavailable references.

Configuration, encrypted credentials and relational authority are captured in
one joined read, including the host's required, same-owner reusable credential,
followed by the feature check. The selected credential supplies the username and
either the existing `resolved` private-key response or `resolved_password`
password response; only the selected method's secrets are decrypted.
That authorized snapshot is an
in-flight handoff: revocation cannot retract a response already authorized.
Every later resolve checks again and sees committed rotation/deletion/revocation.
The Runner can reuse a successfully resolved snapshot and parsed key for the
current Run independently of Ably connectivity; it does not resolve on every
command. This explicit application-owned retention is not HTTP/proxy caching.
KMS decryption runs outside transactions and row locks, so slow KMS does not
block owner edits or revocation. Resolve never writes a learned host key.

### Invalidation and accepted freshness

After a successful connection edit, deletion or
explicit host-key reset, the API sends identifier-only `ssh-authority-invalidated`
messages on `runner-group:<group>` for affected running owner Runs. Payloads are
`{runId, connectionId}`; null `connectionId` means the whole Run. Recipient discovery
must not require a grant or connection row that the mutation may have deleted.
Changing a shared credential's username, secret or authentication method advances
all referencing host generations in one transaction, then sends a Run-wide
invalidation with null `connectionId`. Renaming a credential changes its revision
and browser metadata only. Owner mutations serialize reference changes with an
owner advisory lock; shared rotation locks referencing hosts in stable ID order
before the credential, matching the connection-first pin/observation lock order.
Encryption occurs before row locks; the credential revision is rechecked after
locking. Invalidation is best-effort after commit, not part of that transaction.
The Run-wide hook accepts an Agent scope. Explicit per-user Agent grant changes
use that scope; automatic visible-Agent authorization when creating the first
host invalidates the current user's active Runs. Discovery does not depend on
a surviving grant. Current Agent visibility is rechecked on live inventory and
actual resolve/pin calls; the accepted cache lifetime below remains unchanged.

Notices are sent after commit and before the request observes cancellation. A
failed publish is logged, not reported as failure of the already-committed edit.
The Runner only evicts local authority; it obtains any replacement from the API.
Ably readiness, disconnects, reconnects and subscription errors do not change
SSH authority. Existing Sessions/transports remain usable, and new Session/SFTP
admission does not require notification availability. First use and cache misses
still resolve through the API; denied authority or API failures never grant access.
Delivered targeted/Run-wide invalidation, authentication/trust/configuration-failure
eviction, exact Run replacement and Run/sandbox teardown retain their cleanup behavior.
Cache-overflow operations remain tracked for invalidation without owning cache cells.

There is no fixed TTL or periodic authorization poll. Missed publication or a
dropped subscriber message, including during an observed outage, may leave previous
configuration/credentials/grants
usable for the remainder of the Run, including after deletion/revocation. This
Run-lifetime stale-authority window is explicitly accepted; Ably is not a reliable
revocation protocol. Reconnection neither requires reauthorization nor revives
invalidated authority. Cached parsed keys remain bounded in process memory and are
retired on invalidation or Run teardown. Per-connection public-destination and
cryptographic proof/pin checks remain mandatory, and invalidation never authorizes
command replay or guarantees termination of a remote command already started.

## Atomic trust on first use

`POST /api/runners/runs/:runId/ssh/pin` additionally takes
`expectedGeneration` and `observedHostKey: {algorithm, fingerprint}`. The Runner
must first validate the server's key-exchange proof of possession, then pin
before sending authentication. This API cannot verify that network handshake.
Accepted identities are Ed25519, NIST P-256/P-384/P-521 ECDSA and RSA, with a
canonical unpadded SHA256 fingerprint. `ssh-rsa` identifies an RSA public key;
it does **not** select SHA-1 signatures. The Runner advertises and signs RSA-SHA2;
see the execution document's explicitly deferred russh host-proof algorithm
consistency limitation.

Pin first authorizes without locking. It then locks the owned connection row
used by owner edit/reset, rechecks current authority and rollout state after
any wait, and holds shared authority/credential row locks through the write.
No KMS or other external call occurs in that transaction. Unauthorized calls
do not acquire another owner's connection lock.

| Stored state                                       | Result                  | Mutation                       |
| -------------------------------------------------- | ----------------------- | ------------------------------ |
| Unpinned, generation N equals expected             | `pinned`, N+1           | Learn key and increment once   |
| Same key, generation exactly expected+1            | `matched`               | None                           |
| Different key already pinned                       | `host_key_mismatch`     | None, regardless of generation |
| Any other generation, including integer exhaustion | `configuration_changed` | None                           |
| Current authority unavailable                      | `unavailable`           | None                           |

Concurrent identical first observations converge on one pin. A different key
never overwrites trust. Endpoint edits, credential edits and explicit reset
retain the existing generation semantics; stale observations cannot silently
repin. TOFU cannot prevent a first-use MITM, and resetting trust intentionally
reopens that first-use window.

## Diagnostic connection observations

`POST /api/runners/runs/:runId/ssh/observations` accepts the same connection and
winning Runner identity, plus `expectedGeneration`, UTC `observedAt` and nullable
`failureReason`. The allowlist covers credential parsing, destination/network,
host-key and authentication failures, plus pre-authentication protocol/timeouts.
Waiting for the first-use host-key pin API is an authority phase, not target
connection evidence; a deadline there preserves the command's `timed_out` result
without creating a host warning.
Null means host-key verification and SSH authentication succeeded, not command
success. No command, output, peer diagnostic, credential or arbitrary error text
is accepted. The strict guest/CLI outcome and inventory DTOs are unchanged.

The API applies the current Run, owner, Agent visibility/grant, feature and
winning-claim checks before locking the owned connection. It rechecks authority
under the same lock used by edits and pinning, then records only the exact current
generation. TOFU reporters use the post-pin generation. A single child row in
`ssh_connection_observations` retains the generation, observation time and code;
deletion cascades with the host. Within a generation, duplicate or older times
are ignored. Times more than 60 seconds ahead of the API clock are ignored.
Fleet timestamps provide best-effort diagnostic ordering, not a distributed
total order or an authorization freshness guarantee.

The outcome is `recorded`, `ignored` or `unavailable`. Owner reads use the separate
`GET /api/ssh/connections/observations`, returning only current-generation rows
for the authenticated user/workspace. Existing strict configuration and summary
responses are unchanged. Accepted failures and recovery from a failure publish
the owner-only `ssh:changed` notification; consecutive healthy observations do
not reload the UI. Reports never mutate configuration or invalidate Runner authority.

Runner reporting starts only after terminal delivery has been attempted and the
guest stream and execution admission have been released. The existing Run-owned
dispatch task awaits the report with a one-second limit. A separate process-wide
four-report semaphore uses nonwaiting admission; saturation drops the observation.
There is no retry, detached worker or unbounded queue. Reporting failure, old API
404s and shutdown cannot alter or replay the remote command. Shutdown can wait
up to the bounded report timeout; Run termination or revocation can reject an
otherwise valid late report. The existing credential cache and missed-Ably window
are unchanged.

## Deployment

### Cloudflare Access authority preparation

#34077 prepares the backend of #31996. It does not provide the native carrier or
Access management UI. `cloudflareAccess` is default-off, including for staff, and
requires `sshAccess`. Each protected host binds one same-owner `(orgId, userId)`
Access configuration. The saved DNS hostname is the exact approved token recipient;
its port is 443, while the origin SSH port is configured in Cloudflare. No guest
URL, wildcard, alternate recipient list or Direct fallback exists.

SSH has one canonical contract, without a version/profile selector or duplicate
legacy DTO. Protected authority requires the existing SSH checks plus the current
Access feature and bound same-owner configuration. The existing SSH grant is
the only Agent permission for either transport; configuration creation or edits
never grant SSH. Direct handoffs retain their actual key/password variants.

The protected `resolved_access` outcome contains the saved host, port, username,
host generation and learned key; `authentication` holds SSH key/password data,
while `access` holds `configId`, effective `generation`, `clientId` and
`clientSecret`. Both secret sets stay inside the official Runner boundary.
Generated `ResolveResponse` uses bounded zeroizing secret fields and has no Debug,
Clone or Serialize implementation. #34080 consumes this handoff through the
native WSS carrier, requiring port 443 and a canonical DNS recipient before
network use. Public-destination validation pins the socket; verified TLS/SNI
and the HTTP Host use that same saved hostname. No Direct fallback exists.
An S1-only Runner still rejects protected handoffs as unavailable; the feature
must not be activated on that Runner. See the activation gate below.

Pin and observation retain host-first locking and recheck protected authority
through the non-null configuration with a share lock, while retaining the
existing SSH-grant lock. Owner mutations use the
owner advisory lock, ordered affected-host locks, then configuration locks.
SSH-grant edits retain their existing Agent-lock boundary. Token replacement
advances both config generation and every referencing host generation atomically.
Metadata rename advances only config revision. Configurations have no separate
enabled state. Host pins survive rotation, rebinding and every transition
involving Access; explicit reset clears protected trust. Direct-to-Direct endpoint edits retain their
existing behavior.

Access mutations publish identifier-only invalidations for captured affected
connection IDs, scoped to owner Runs. SSH-grant changes invalidate both transport
modes for that owner's affected Agent Runs, including after revocation. Direct
hosts are not evicted by Access configuration changes. Browser notifications use
the existing owner `ssh:changed` topic with `{orgId}`, including for unreferenced
configurations and metadata-only edits.
Rename does not interrupt runtime sessions. Notifications remain best effort;
the accepted cached-authority lifetime is the remainder of the Run, not immediate
revocation.

Canonical observations accept `access_rejected`, `access_tls_failure` and
`access_protocol_failure`. These are carrier-stage evidence, not SSH authentication
failures. Platform translates them directly; there is no legacy projection.
Guest inventory and CLI terminal enums are unchanged. Unauthorized protected
hosts are omitted from inventory. DB/KMS failures and broken local references
remain errors.

See the [Cloudflare Access activation gate](deployment-compatibility.md#cloudflare-access-for-ssh)
before writing protected configuration in any deployed environment.

The observation table and endpoints are additive. Old Runners and clients do not
use them and retain existing behavior. A new Runner treats an old API's missing
observation endpoint as a dropped diagnostic; a new App shows diagnostic status
unavailable without disabling configuration management. Migration precedes API
promotion. The staff-default switch configuration does not establish which
artifacts are currently deployed. See [deployment compatibility](deployment-compatibility.md)
and [guest RPC transport](runner-rpc-transport.md) for the cross-version boundaries.
