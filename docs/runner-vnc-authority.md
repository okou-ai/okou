# Runner VNC authority

The #34980 API slice authorizes the engine and session integration delivered by
#34780. It does not open sockets or activate VNC. `VncAccess` remains disabled
by default, including staff. VNC authority is independent of SSH and Desktop.

## Explicit grants and inventory

Session-authenticated owners use GET/PUT `/api/agents/:agentId/vnc-access` with
`{ enabled }`. The Agent must be visible in the same organization. Creating a
connection never grants access. Each `(orgId, userId, agentId)` grant has a random
incarnation ID; repeated enable preserves it, while revoke/regrant replaces it.

Agent tokens receive `vnc:read` and `vnc:write` only when the feature is enabled.
These capabilities do not replace a current grant. GET `/api/vnc/hosts` requires
`vnc:read`, the exact running Run, same-owner session, visible Agent and owner's
grant. Inventory contains only id, displayName, host, port, authMethod and
securityType. It never includes credentials, trust bundles or lease tokens.
An authorized owner with no hosts receives an empty list. Every request checks
the current feature and Clerk membership; cached token claims cannot bypass them.

## Private handoff

All private endpoints are POST `/api/runners/runs/:runId/vnc/<operation>` and
require official fleet authentication plus
`runnerIdentity: { runnerId, heartbeatGeneration }` matching the immutable winning
process on that exact running Run. Browser, guest and local/PAT credentials do
not authorize these routes. Fleet-secret protection remains a trust assumption;
the shared credential itself does not identify a machine.

Every call joins the current same-owner Run/session/visible Agent/grant/connection
and credential. Requests contain saved IDs, not endpoint or owner overrides.
Private handlers set `Cache-Control: no-store` before authentication and body
validation. Malformed path parameters return a generic 400 before the handler.
Unavailable authority returns the opaque `unavailable` outcome. Invalid input is
400, missing/invalid authentication is 401, and authenticated local Runners are 403. DB/KMS failures remain server errors instead of fabricated absence.

`resolve` requires `connectionId` and `supportedProfiles`, a bounded list of exact
`{ authMethod: "vnc_password", securityType: "x509_vnc" }` pairs. An empty list
returns `unsupported_profile` only after authorization, before KMS. Unknown
methods or profiles are rejected. Future engine support must not broaden a saved
policy or create an implicit downgrade path.

A resolved response contains host, port, typed authentication/security and
`authority: { instanceId, generation, grantId }`. Instance IDs distinguish physical
delete/recreate of a saved connection UUID even when generation restarts at one.
Generation changes on credential rotation, rebinding or connection edits. KMS
decryption runs outside locks, followed by another current-authority check before
handoff. A committed change during decryption discards the stale snapshot.

Generated Rust resolve DTOs use zeroizing `SecretText<8>` and deliberately omit
Debug, Clone and Serialize. The runtime must also validate printable ASCII through
the engine password type. Raw responses, decode/provider errors, secrets and
server-controlled text must never become guest output, logs or observations.
This slice introduces no free-text observation endpoint.

## Fenced control lease

`acquire` takes the common identity, authority and a fresh `holderId` UUID for one
acquisition intent. `check`, `renew` and `release` take the common identity,
authority and returned `leaseToken`. One database row arbitrates a saved
connection UUID. Tokens are random and bound to the exact Run, winning process,
connection incarnation/generation and grant incarnation.

| Operation or condition                   | Result                                          |
| ---------------------------------------- | ----------------------------------------------- |
| Acquire without a live reservation       | `acquired`, fresh token, 30-second expiry       |
| Exact live holder acquisition replay     | Same token and expiry, no extension             |
| Different live holder                    | `busy`, no holder metadata                      |
| Latest expired or released holder replay | `expired`                                       |
| Check current unexpired token            | `valid`, unchanged expiry                       |
| Renew current unexpired token            | `valid`, expiry 30 seconds from database now    |
| Release current unexpired token          | `released`, expires only that token             |
| Stale configuration/grant incarnation    | `configuration_changed` or opaque `unavailable` |
| Wrong, superseded or expired token       | `expired`; no mutation                          |

Revoked or rotated holders keep their reservation until its existing expiry.
They cannot renew, and a new holder cannot steal that bounded interval. Grant or
Run deletion does not cascade the reservation. Connection deletion does; owner
cleanup deletes connections/leases, credentials and grants.
Cleanup locks grant-owning Agent parents in stable order before business rows,
so concurrent Agent deletion cannot invert its Run-to-grant cascade order.

Transactions enter existing erasure/cleanup/owner admission, lock the connection,
then explicitly lock Agent → Session → Run → grant/credential. They recheck the
joined authority and reload feature state after waits. KMS and Clerk calls never
run under these locks. Expiry uses `clock_timestamp()` after lock waits, not
transaction-start time. Returned `serverTime`, `expiresAt`, `validForMs` and
`renewAfterMs: 10000` describe the remaining bounded interval.

The #34780 Runner must calculate a conservative monotonic deadline from request
start plus validForMs, discard late replies, renew every ten seconds, and stop
admission on any authority/API failure. Every screenshot/input must check the
local fence; cleanup retains socket/operation ownership until work actually ends.
Acquisition failure may leave an unused reservation for at most its remaining
TTL. Retry the same holder ID only within the original deadline. A lost release
reply never restores authority. Inputs are never automatically replayed.

## Guarantees and limits

Revocation is bounded by an already-accepted lease lifetime, not instantaneous
remote cancellation. VNC servers do not enforce these API fences, and already
started remote effects cannot be undone. Arbitrarily old acquire requests can
allocate a new unused reservation after later holders have expired; one retained
row is not a historical receipt ledger. Original request-start deadlines and
non-replay of effects remain mandatory for the caller. Exact old renew/release
tokens can never affect a replacement.

Separate saved UUIDs, deletion/recreation incarnations, external VNC viewers and
local users are outside this single-incarnation arbitration. A previous socket
can survive until its old accepted deadline. Exclusion also assumes bounded,
non-stepping database wall time: a forward clock step can expire a database lease
before another Runner's monotonic deadline. Deployment clock discipline is an
operational requirement, not established by route tests.

## Deployment

Apply migration 1160 before the new API. Older configuration writers receive the
new connection-instance default; existing public responses stay unchanged. Old
Runners make no VNC calls. New Runners must treat missing endpoints on an old API
as unavailable, without SSH, plaintext or cached-authority fallback.

Before creating grants, every serving and rollback API must support grant/lease
cleanup. Keep the additive schema on rollback. Disable the feature to stop new
authority, and preserve cleanup for retained data. Activation is a separate
decision after #34780 validates real-server sessions, monotonic expiry, per-operation
checks and socket teardown; #34781/#34782 own CLI and owner UI delivery.
