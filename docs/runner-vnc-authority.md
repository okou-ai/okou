# Runner VNC authority

The #34980 API slice authorizes the engine and session integration delivered by
#34780. `VncAccess` remains disabled by default, including staff. VNC authority is
independent of SSH and Desktop. The Agent chooses native shared or exclusive
mode for each session; the VNC server enforces its connection policy.

## Explicit grants and inventory

Session-authenticated owners use GET/PUT `/api/agents/:agentId/vnc-access` with
`{ enabled }`. The Agent must be visible in the same organization. Creating the
first connection automatically grants every Agent currently visible to the owner;
the connection and grants commit atomically. Later connections preserve manual
revocations and do not grant later Agents. Deleting every connection makes the
next creation repeat the onboarding grant. Grants use the composite
`(orgId, userId, agentId)` key, matching SSH. Repeated enable is idempotent;
revoke removes the row and regrant restores current access without a historical
grant incarnation.

Agent tokens receive `vnc:read` and `vnc:write` only when the feature is enabled.
These capabilities do not replace a current grant. GET `/api/vnc/hosts` requires
`vnc:read`, the exact running Run, same-owner session, visible Agent and owner's
grant. Inventory contains only id, displayName, host, port, authMethod and
securityType. It never includes credentials or trust bundles. An authorized
owner with no hosts receives an empty list. Every request checks the current
feature and Clerk membership; cached token claims cannot bypass them.

## Private handoff and checks

The private endpoints are POST `/api/runners/runs/:runId/vnc/resolve` and
`/api/runners/runs/:runId/vnc/check`. Both require official fleet authentication
plus `runnerIdentity: { runnerId, heartbeatGeneration }` matching the immutable
winning process on that exact running Run. Browser, guest and local/PAT
credentials do not authorize these routes. Fleet-secret protection remains a
trust assumption; the shared credential itself does not identify a machine.

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
`generation`, matching SSH's connection identity. Generation changes on credential
rotation, rebinding or connection edits.
KMS decryption runs outside locks, followed by another current-authority check
before handoff. A committed generation change during decryption discards the stale
snapshot.

`check` takes `connectionId`, `runnerIdentity` and `expectedGeneration`. It
returns `valid`, `configuration_changed` or `unavailable`. It rechecks current
authorization without decrypting credentials or changing database state. Multiple
authorized Runs can independently resolve and check the same connection. Neither
endpoint reserves a desktop or provides a duration-based authorization token.

As with SSH, a client-generated connection ID can be reused after deletion and
generation restarts at one. There is no retained creation history. A check cannot
distinguish a replacement with the same ID and generation, including across a
pending resolve. Absence is unavailable, and a different generation is stale.
This identity model does not add SSH's Run-lifetime credential cache or notification
transport; the current checks and #34780 runtime responsibilities below still apply.

Generated Rust resolve DTOs use zeroizing `SecretText<8>` and deliberately omit
Debug, Clone and Serialize. The runtime must also validate printable ASCII through
the engine password type. Raw responses, decode/provider errors, secrets and
server-controlled text must never become guest output, logs or observations.

## Native sharing choice

The RFB engine requires an explicit `SharingMode::Shared` or
`SharingMode::Exclusive` when initializing an authenticated connection. These
encode ClientInit shared-flag values 1 and 0 respectively, as specified in
[RFC 6143 section 7.3.1](https://www.rfc-editor.org/rfc/rfc6143.html#section-7.3.1).

Shared requests ask the server to retain other clients. Exclusive requests ask
the server to disconnect other clients. Server policy may override the request
or refuse the new connection; ServerInit does not acknowledge a guaranteed
exclusive lock. An exclusive request may disconnect a human viewer. Shared
clients usually operate the same desktop focus and pointer, so their inputs can
interleave. Okou does not add cross-Run arbitration or silently change modes.

The #34780 session-start RPC and #34781 CLI must carry the Agent's explicit
`mode: "shared" | "exclusive"` choice unchanged into the engine. Session status
reports the requested mode, not verified exclusivity. The mode is a session
option, independent of saved authentication and TLS policy. Server refusal or
disconnection does not trigger an automatic reconnect, mode retry or input replay.

## Runtime and cleanup

The #34780 Runner must check current authority before each screenshot/input and
stop fresh work on authority/API failure. Detected generation changes require closing
the old session rather than adopting new credentials into its socket. Run
cancellation and explicit session close own socket/operation teardown; resource
permits remain held until work actually ends. Input is serialized within each
session; independent sessions remain subject to server sharing policy.

Checks establish current admission, not instantaneous remote cancellation: a
change after an accepted check cannot retract already-started effects. There is
no 30-second lease or promise to disconnect an idle session within that interval.
Per-operation enforcement and real-server multi-client behavior must be verified
before activation. This API slice alone does not enforce a live Runner socket.

Owner cleanup removes connections, credentials and grants, including grants
without connections. It locks grant-owning Agent parents in stable order before
business rows so concurrent Agent deletion cannot invert its Run-to-grant
cascade order. Grant/configuration writes retain the existing erasure, cleanup
and owner admission. KMS and Clerk calls never run under these locks.

## Deployment

Apply the generated VNC authority migration before the new API. It adds the
Agent grant table; the existing connection schema and public responses stay
unchanged. Old Runners make no VNC calls; missing endpoints cannot authorize a new
Runner operation.

Before creating grants, every serving and rollback API must support grant
cleanup. Keep the additive schema on rollback. Disable the feature to stop new
authority, and preserve cleanup for retained data. Activation is a separate
decision after #34780 verifies real-server sessions, current checks and socket
teardown; #34781/#34782 own CLI, owner UI and end-to-end mode selection.
