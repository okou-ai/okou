# Runner VNC authority

The #34980 API slice authorizes the engine and session integration delivered by
#34780. `VncAccess` remains disabled by default, including staff. VNC grants
remain independent of SSH and Desktop; an SSH-backed route additionally requires
the Agent's separate SSH grant and shared Run-owned SSH authority. The Agent
chooses native shared or exclusive mode for each session; the VNC server enforces
its connection policy.

With `ThreadRemoteAccess` enabled for the Run owner, live VNC inventory, private resolve, and check require the Run's chat thread and that thread's effective permission for the exact VNC host. SSH-backed hosts also require effective permission for the referenced SSH host. A Run without a chat thread is denied. The Agent-grant rules below apply while the switch is off.

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
grant. Inventory contains only id, displayName, host, port, authMethod,
securityType, and availability. Availability is `ready` for configured hosts or
`blocked: needs_rebind` for an SSH-backed host whose underlying SSH binding
needs repair. The host stays visible for diagnosis, but fresh Runner authority
rejects it until its owner explicitly rebinds SSH or chooses Direct. Inventory
never includes credentials, SSH references, or trust bundles. An authorized
owner with no hosts receives an empty list. Every request checks the current
feature and Clerk membership; cached token claims cannot bypass them.

## Private handoff and checks

The private endpoints are POST `/api/runners/runs/:runId/vnc/resolve` and
`/api/runners/runs/:runId/vnc/check`. Both require official fleet authentication
plus `runnerIdentity: { runnerId, heartbeatGeneration }` matching the immutable
winning process on that exact running Run. Browser, guest and local/PAT
credentials do not authorize these routes. Fleet-secret protection remains a
trust assumption; the shared credential itself does not identify a machine.

Every call joins the current same-owner Run/session/visible Agent/VNC
grant/connection and credential. SSH rows additionally require the independent
SSH Agent grant and same-owner referenced SSH connection. Requests contain
saved IDs, not endpoint or owner overrides.
Private handlers set `Cache-Control: no-store` before authentication and body
validation. Malformed path parameters return a generic 400 before the handler.
Unavailable authority returns the opaque `unavailable` outcome. Invalid input is
400, missing/invalid authentication is 401, and authenticated local Runners are 403. DB/KMS failures remain server errors instead of fabricated absence.

`resolve` requires `connectionId` and `supportedProfiles`, a bounded list of
exact authentication/security/transport tuples. Current Runners advertise the
X509Vnc and X509Plain pairs separately for `direct` and `ssh`, plus the Apple
DH and Apple Direct SRP pairs only for `ssh`. A pre-transport Runner
omits `transportType`; omission means direct-only. An empty list or a saved
tuple absent from the list returns `unsupported_profile` only after VNC
authorization and before KMS. An SSH row is also checked for its SSH grant
before any credential handoff.
Unknown methods, profiles and cross-paired combinations are rejected. Future
engine support must add a new exact pair instead of broadening a saved policy or
creating an implicit downgrade path.

Saved owner configuration also has an outer direct/SSH transport discriminator.
For a capable Runner, authority returns either an explicit direct snapshot or
only the SSH connection ID and generation. It never returns or decrypts SSH
credentials on the VNC endpoint. The saved VNC destination is opened through
the existing SSH authority, and certificate verification uses
`x509ServerName ?? host`. Any SSH setup, channel, TLS or inner-authentication
failure is terminal for that attempt; it is never retried as direct TCP or a
different profile.

A legacy direct request receives the exact original `resolved` response. A
transport-capable request receives the required-field `resolved_transport`
variant containing host, port, server name, typed authentication/security, VNC
generation and explicit transport snapshot. The separate variant keeps the old
sensitive decoder shape unchanged and makes omission unambiguous. VNC generation
changes on credential rotation, rebinding or connection edits.
KMS decryption runs outside locks, followed by another current-authority check
before handoff. A committed generation change during decryption discards the stale
snapshot.

`check` takes `connectionId`, `runnerIdentity`, `expectedGeneration` and, for a
capable Runner, `expectedTransport`. It
returns `valid`, `configuration_changed` or `unavailable`. It rechecks current
authorization, both grants and both generations without decrypting credentials
or changing database state. A missing expected transport is accepted only for a
legacy direct row; SSH requires the exact referenced ID and generation. Multiple
authorized Runs can independently resolve and check the same connection. Neither
endpoint reserves a desktop or provides a duration-based authorization token.

As with SSH, a client-generated connection ID can be reused after deletion and
generation restarts at one. There is no retained creation history. A check cannot
distinguish a replacement with the same ID and generation, including across a
pending resolve. Absence is unavailable, and a different generation is stale.
This identity model does not add SSH's Run-lifetime credential cache or notification
transport; the current checks and #34780 runtime responsibilities below still apply.

Generated Rust resolve DTOs use a zeroizing, UTF-8 byte-bounded
`SecretUtf8Text<1023>` and deliberately omit Debug, Clone and Serialize. The
runtime then constructs the selected engine authentication type: classic VNC
enforces 1–8 printable ASCII bytes, while Plain enforces its username and
password bounds without trimming spaces. Raw responses, decode/provider errors,
secrets and server-controlled text must never become guest output, logs or
observations.

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

The Runner checks current authority before status/list/screenshot/input and
stops fresh work on authority/API failure. Detected VNC or SSH generation,
reference, transport or grant changes require closing
the old session rather than adopting new credentials into its socket. Run
cancellation and explicit session close own socket/operation teardown; resource
permits remain held until work actually ends. Input is serialized within each
session; independent sessions remain subject to server sharing policy.

SSH-backed sessions reuse the exact `Arc<ssh::Run>` already created for the Run.
The SSH layer remains the sole owner of credential decryption, host-key trust,
Cloudflare Access, cache, pool, forward capacity and invalidation. The RFB engine
owns one closed direct-or-SSH stream type, while direct sessions retain their
local all-public-address policy and SSH destinations remain remotely resolved.

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
unchanged. Runners predating the original VNC runtime make no VNC calls; missing
endpoints cannot authorize a new Runner operation.

Deploy the widened API request/response contract before Runners that advertise
X509Plain. The widened API continues serving older X509Vnc-only Runners. A new
Runner against an older API fails closed because the older strict request
contract rejects the added advertised profile. A new Runner also rejects
malformed or cross-paired responses before DNS; there is no fallback to classic
authentication. No database migration, stored-data rewrite, guest RPC change or
feature activation is part of this extension.

For saved SSH transport, apply the generated SSH owner-key migration before the
generated VNC route migration, then deploy the typed-route owner API before
admitting tunneled rows. Deploy the tuple-aware API before the composed Runner.
The new API continues serving old direct-only Runners with the exact legacy
response and rejects their SSH rows before KMS. An old strict API rejects a new
Runner's transport capability field, so the Runner fails closed without retry.
After the first SSH-backed row exists, do not roll the API below the typed-route
reader/writer; disabling `VncAccess` preserves data and does not make that
rollback safe. Product exposure requires its own later rollout evidence.

Before creating grants, every serving and rollback API must support grant
cleanup. Keep the additive schema on rollback. Disable the feature to stop new
authority, and preserve cleanup for retained data. Activation is a separate
decision after #34780 verifies real-server sessions, current checks and socket
teardown; #34781/#34782 own CLI, owner UI and end-to-end mode selection.
