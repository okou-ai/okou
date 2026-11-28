# cloudflare-access

## cloudflare-access-001

- Vitest: "inline SSH resource creation > create independently binds inline and saved resources and returns only resolved metadata"
- Mode: run
- Given: A signed-in workspace member owns a saved personal Cloudflare Access configuration and a protected SSH host whose saved password login can be reused.
- When: The member calls `POST /api/ssh/connections` three times with a Cloudflare Access transport, combining (saved Access, saved login), (inline new Access, saved login) and (inline new Access, inline new login).
- Then: Each create returns HTTP 201 with a schema-valid body that contains no secret values and a `cloudflare_access` transport with a config ID. Each publishes `ssh:changed` for the workspace and publishes `cloudflare-access:changed` only when a new Access configuration was created inline. Read-back through the hosts, credentials and Access-config lists shows one more host each time, one more login or Access config only when created inline, and the new host linked under both the chosen login and the chosen Access configuration.

## cloudflare-access-002

- Vitest: "inline SSH resource creation > update independently binds inline and saved resources and returns only resolved metadata"
- Mode: run
- Given: A signed-in workspace member owns a saved personal Cloudflare Access configuration and a protected SSH host whose saved password login can be reused.
- When: The member calls `PATCH /api/ssh/connections/:connectionId` three times with the current generation and a Cloudflare Access transport, combining (saved Access, inline new login), (inline new Access, saved login) and (inline new Access, inline new login).
- Then: Each update returns HTTP 200 with a schema-valid body that contains no secret values and a `cloudflare_access` transport with a config ID. Each publishes `ssh:changed` for the workspace and publishes `cloudflare-access:changed` only when a new Access configuration was created inline. Read-back shows the host count unchanged, one more login or Access config only when created inline, and the host linked under both the chosen login and the chosen Access configuration.

## cloudflare-access-003

- Vitest: "inline SSH resource creation > rejects invalid references, destinations and stale versions without creating either resource"
- Mode: run
- Given: A signed-in member has an existing SSH host; another workspace owns its own Access configuration and host with a saved login.
- When: The member calls `POST /api/ssh/connections` and `PATCH /api/ssh/connections/:connectionId` referencing an unknown or foreign login ID, an unknown or foreign Access config ID, the destination `127.0.0.1`, port 22 for an Access transport, and a stale `expectedGeneration`.
- Then: Unknown or foreign login and Access references return HTTP 404, the loopback destination and port 22 return HTTP 400, and the stale generation returns HTTP 409. The member's hosts, logins and Access configurations are unchanged afterwards.

## cloudflare-access-004

- Vitest: "inline SSH resource creation > reports Access not found when its config is deleted while a rebind encrypts a new login"
- Mode: run
- Given: A signed-in member owns a personal Access configuration and an SSH host. The configuration is deleted (`DELETE /api/cloudflare-access/configs/:configId` returns 204) at the moment the new inline login is being encrypted.
- When: The member calls `PATCH /api/ssh/connections/:connectionId` rebinding the host to the deleted Access configuration on port 443 with an inline new password login.
- Then: The update returns HTTP 404 with error code `CLOUDFLARE_ACCESS_NOT_FOUND`. Hosts and logins are unchanged and the Access configuration list is empty.

## cloudflare-access-005

- Vitest: "organization Cloudflare Access > lists retained hosts as needing rebind and recovers only after an explicit choice"
- Mode: run
- Given: A workspace admin created two organization-scoped Access configurations. A member with an active Run binds a host to the first one, enables it for chat, and the Runner pins its host key (`POST /api/runners/runs/:runId/ssh/pin` returns `pinned`).
- When: The admin previews and converts the first configuration to personal (`GET .../impact-preview?operation=convert`, `POST .../convert-to-personal`); the member then edits the host with `PATCH /api/ssh/connections/:connectionId` without a transport, with an unknown config ID, with the second shared config, and finally after the second config is also converted, with a `direct` transport.
- Then: The preview reports one other host. The member's host list shows the host with its address, login, learned host key, a generation advanced by two and transport `{ type: "cloudflare_access", needsRebind: true }` with no config ID or client secret. Editing without a transport returns 400 `SSH_INVALID_INPUT`, an unknown config returns 404 `CLOUDFLARE_ACCESS_NOT_FOUND`, rebinding to the second config returns 200 with that config ID and the same address, login and host key, and switching to Direct returns 200 with no transport while keeping address, login and host key.

## cloudflare-access-006

- Vitest: "organization Cloudflare Access > returns scoped configurations and lets members bind shared configurations without seeing other hosts"
- Mode: run
- Given: A workspace admin creates an organization-scoped Access configuration and a personal one; two members of the same workspace and a user from another workspace are signed in in turn.
- When: The admin lists configurations via `GET /api/cloudflare-access/configs` and renames them via `PATCH /api/cloudflare-access/configs/:configId`; each member lists with `?view=scoped` and binds a host to the shared config; a member tries to update, delete and create organization configurations; the outsider lists and tries to bind a host to the shared config.
- Then: The shared config is created with scope `organization` and no hosts; the personal config returns scope `personal`, revision 1, generation 1 and empty SSH/VNC host lists, and renaming returns revision 2. Each member's scoped list shows only the shared config with only their own bound hosts, never the admin's personal config or the client secret. Member update, delete and organization-scoped create return HTTP 403; the outsider sees an empty scoped list and binding to the shared config returns HTTP 404.

## cloudflare-access-007

- Vitest: "organization Cloudflare Access > rotates every member host and blocks referenced deletion"
- Mode: run
- Given: A workspace admin owns an organization-scoped Access configuration that two members with active Runs have each bound a host to.
- When: The admin calls `DELETE /api/cloudflare-access/configs/:configId?view=scoped` while it is referenced, then rotates its client secret with `PATCH`, the members delete their hosts, and the admin deletes the config again.
- Then: The first delete returns HTTP 409. Rotation returns HTTP 200 with scope `organization`, generation 2, revision 2 and no visible hosts, publishes `cloudflare-access:changed`, two `ssh:changed` events and an `ssh-authority-invalidated` event for each member's Run and host. Each member's host generation advanced by one and their host deletes return 204; the admin's final delete with revision 2 returns HTTP 204.

## cloudflare-access-008

- Vitest: "Cloudflare Access owner configuration > refreshes Access metadata for unreferenced config changes without SSH invalidation"
- Mode: run
- Given: A signed-in member with an active Run owns no protected hosts.
- When: The member creates a personal Access configuration, renames it with `PATCH /api/cloudflare-access/configs/:configId`, then deletes it.
- Then: Each mutation publishes exactly one realtime event, `cloudflare-access:changed` for the workspace, on the member's user channel, with no SSH invalidation events.

## cloudflare-access-009

- Vitest: "Cloudflare Access owner configuration > requires a session and rejects unsafe token headers before encryption"
- Mode: run
- Given: A caller has no session; then a signed-in member attempts to save tokens whose client secret is empty, contains CRLF header injection, a leading space, a non-ASCII character, or is longer than 4096 characters.
- When: The unauthenticated caller calls `GET /api/cloudflare-access/configs`; the member posts each unsafe token to `POST /api/cloudflare-access/configs`.
- Then: The unauthenticated list returns HTTP 401. Every unsafe token returns HTTP 400, the member's configuration list stays empty, and no encryption key is ever generated.

## cloudflare-access-010

- Vitest: "Cloudflare Access owner configuration > keeps canonical mutations idempotent and publishes canonical changes"
- Mode: run
- Given: A signed-in workspace member chooses a client-generated configuration ID.
- When: The member calls `POST /api/cloudflare-access/configs` with that ID, retries the create with a different name, renames it with `PATCH` (revision 1), and deletes it with `DELETE` (revision 2).
- Then: The first create returns HTTP 201 named "Canonical" with no hosts; the retry returns HTTP 204 and the stored name stays "Canonical". The rename returns 200 with revision 2 and the list reflects it; the delete leaves an empty list. Exactly three `cloudflare-access:changed` events are published for the workspace and no `ssh:changed` events.

## cloudflare-access-011

- Vitest: "Cloudflare Access owner configuration > shares one configuration across hosts without public secret readback and rejects stale/dependent deletion"
- Mode: run
- Given: A signed-in member owns one personal Access configuration used by two chat-enabled protected SSH hosts.
- When: The member lists configurations, tries `DELETE /api/cloudflare-access/configs/:configId` while in use, renames it, retries a rename with the stale revision, deletes both hosts, then deletes the config with stale revision 1 and then with revision 2.
- Then: The list shows both hosts under the configuration and none of the listed config, host or config bodies contain the client ID, client secret, SSH password or encrypted values. Deleting while in use returns 409 `CLOUDFLARE_ACCESS_IN_USE`; the rename returns revision 2 with generation 1; the stale rename returns 409; the stale delete returns 409, the current delete returns 204 and the list is empty.

## cloudflare-access-012

- Vitest: "Cloudflare Access owner configuration > isolates foreign user configuration IDs and metadata"
- Mode: run
- Given: A user owns a personal Access configuration; a different user in the same workspace (the user-isolation row) is signed in.
- When: The second user calls `POST /api/cloudflare-access/configs` reusing the first user's config ID, lists configurations, updates and deletes that ID, and creates an SSH host bound to it.
- Then: The create returns HTTP 409 with `CLOUDFLARE_ACCESS_RESOURCE_ID_CONFLICT` and message "This resource ID cannot be used for this Cloudflare Access configuration."; the list is empty; update, delete and the host binding each return HTTP 404.

## cloudflare-access-013

- Vitest: "Cloudflare Access owner configuration > isolates foreign org configuration IDs and metadata"
- Mode: run
- Given: A user owns a personal Access configuration; the same user signed in to a different workspace (the organization-isolation row) is the caller.
- When: The caller calls `POST /api/cloudflare-access/configs` reusing the config ID, lists configurations, updates and deletes that ID, and creates an SSH host bound to it.
- Then: The create returns HTTP 409 with `CLOUDFLARE_ACCESS_RESOURCE_ID_CONFLICT` and message "This resource ID cannot be used for this Cloudflare Access configuration."; the list is empty; update, delete and the host binding each return HTTP 404.

## cloudflare-access-014

- Vitest: "Cloudflare Access owner configuration > preserves chat host authority across Access config updates"
- Mode: run
- Given: A member has a running chat Run with a chat-enabled host bound to their Access configuration, plus a second configuration with its own host.
- When: The member renames the configuration and then rotates its client secret with `PATCH /api/cloudflare-access/configs/:configId`, and after each change the Runner calls `POST /api/runners/runs/:runId/ssh/resolve` for the host.
- Then: Both updates return HTTP 200 and each subsequent resolve returns outcome `resolved_access`.

## cloudflare-access-015

- Vitest: "protected SSH authority > treats a protected host awaiting rebind as unavailable, never Direct"
- Mode: run
- Given: A workspace admin owns an organization-scoped Access configuration. A member with an active Run has a protected host bound to it and a Direct host, both enabled for chat; the first resolve returns `resolved_access`.
- When: The admin converts the configuration to personal; then the Runner resolves, pins and observes the protected host via `POST /api/runners/runs/:runId/ssh/{resolve,pin,observations}`, and the Agent lists `GET /api/ssh/hosts` before and after the Direct host is deleted.
- Then: The preview reports one other host; the member's host list shows the protected host with generation +1 and `needsRebind: true`. Resolve, pin and observe all return exactly `{ outcome: "unavailable" }`. The Agent inventory lists the Direct host as `ready` and the protected host as `blocked` with reason `needs_rebind`, then only the blocked host, without the client secret. No additional credential decryption happens after the conversion.

## cloudflare-access-016

- Vitest: "protected SSH authority > resolves a same-organization shared Access row for another member"
- Mode: run
- Given: A workspace admin created an organization-scoped Access configuration; another member of the workspace with an active Run binds a chat-enabled host to it.
- When: The Runner calls `POST /api/runners/runs/:runId/ssh/resolve` for the host and the Agent lists `GET /api/ssh/hosts`.
- Then: Resolve returns `resolved_access` with the shared config ID, and the Agent inventory lists exactly that host.

## cloudflare-access-017

- Vitest: "protected SSH authority > uses chat-enabled protected hosts for a later Agent"
- Mode: run
- Given: A member has a chat-enabled protected host bound to their Access configuration and starts a later, separate Run.
- When: The later Run's Runner calls `POST /api/runners/runs/:runId/ssh/resolve` for the host and its Agent lists `GET /api/ssh/hosts`.
- Then: Resolve returns `resolved_access` with the member's config ID, and the inventory lists exactly that host.

## cloudflare-access-018

- Vitest: "protected SSH authority > uses only the Run owner's protected hosts across members of the same workspace"
- Mode: run
- Given: Two members of the same workspace each have an active Run and a protected host on their own Access configuration; only the second member's host is chat-enabled.
- When: The Runner for the second member's Run resolves its own host and the first member's host, the Agent lists `GET /api/ssh/hosts`, and the Runner resolves and pins its own host again.
- Then: Resolving the own host returns `resolved_access` with the own config ID while the other member's host returns exactly `{ outcome: "unavailable" }`. The inventory lists only the own host, and the pin returns `pinned`.

## cloudflare-access-019

- Vitest: "protected SSH authority > preserves key authentication separately from the Access token"
- Mode: run
- Given: A member has a running chat Run with a chat-enabled protected host.
- When: The member replaces the host login with an inline private key and passphrase (with surrounding whitespace) via `PATCH /api/ssh/connections/:connectionId`, then the Runner resolves the host.
- Then: The update returns HTTP 200 and resolve returns `resolved_access` with `private_key` authentication carrying the exact key and passphrase, and the Access client ID and secret as a separate `access` credential.

## cloudflare-access-020

- Vitest: "protected SSH authority > keeps KMS failure an error instead of returning unavailable or Direct authority"
- Mode: run
- Given: A member has a running chat Run with a chat-enabled protected host, and the key management service fails decryption.
- When: The Runner calls `POST /api/runners/runs/:runId/ssh/resolve` for the host.
- Then: The request returns HTTP 500 and the error body contains neither the Access client ID, client secret nor SSH password.

## cloudflare-access-021

- Vitest: "protected SSH authority > invalidates only protected host IDs on Access credential rotation"
- Mode: run
- Given: A member has two protected hosts on one Access configuration, a chat-enabled Direct host, two active Runs of their own, and another workspace member also has an active Run.
- When: The member renames the configuration, then rotates its client secret with `PATCH /api/cloudflare-access/configs/:configId`, and the Runner resolves the protected and the Direct host.
- Then: The rename publishes only `cloudflare-access:changed`. The rotation publishes exactly four `ssh-authority-invalidated` events (each of the member's two Runs × each protected host), one `ssh:changed` and a `cloudflare-access:changed`. Afterwards the protected host still resolves `resolved_access` and the Direct host resolves `resolved_password`.

## cloudflare-access-022

- Vitest: "protected SSH authority > commits token replacement even when realtime publication fails"
- Mode: run
- Given: A member has a running chat Run with a chat-enabled protected host, and realtime publishing fails.
- When: The member rotates the client secret with `PATCH /api/cloudflare-access/configs/:configId`, then the Runner resolves the host.
- Then: The update returns HTTP 200 with revision 2 and generation 2, and resolve returns `resolved_access` with generation 2 and the rotated client secret.

## cloudflare-access-023

- Vitest: "protected SSH authority > rejects foreign Run owners before decrypting protected credentials"
- Mode: run
- Given: A member owns a chat-enabled protected host; another member of the same workspace has their own active Run.
- When: The other member's Runner calls `POST /api/runners/runs/:runId/ssh/resolve` for the first member's host.
- Then: Resolve returns exactly `{ outcome: "unavailable" }` and no credential is decrypted.

## cloudflare-access-024

- Vitest: "protected SSH authority > hands off two independent credentials only to the winning Runner"
- Mode: run
- Given: A member has a running chat Run with a chat-enabled protected host using a password login.
- When: The dispatched Runner resolves the host; then resolves are attempted with a different Runner ID, an older heartbeat generation, the member's session token and the Agent token; and the Agent lists `GET /api/ssh/hosts`.
- Then: The winning Runner receives `resolved_access` with port 443, generation 1, the password authentication and the Access token with config ID and generation 1. The other Runner identities get exactly `{ outcome: "unavailable" }`, and the session and Agent tokens get HTTP 401. The inventory lists the host as `ready` on port 443 with username `deploy` and no learned host key.

## cloudflare-access-025

- Vitest: "protected SSH authority > preserves an omitted transport binding and rejects a stale editor without affecting Direct hosts"
- Mode: run
- Given: A member has a running chat Run with a chat-enabled protected host and a chat-enabled Direct host.
- When: The Agent lists `GET /api/ssh/hosts`; the member renames the protected host without a transport field, then sends a stale-generation update switching it to Direct on port 22; the Runner resolves both hosts.
- Then: The inventory includes both hosts. The rename returns generation 2 and keeps the Access transport and config ID; the stale update returns HTTP 409. The protected host resolves `resolved_access` at generation 2 and the Direct host resolves `resolved_password` on port 22.

## cloudflare-access-026

- Vitest: "protected SSH authority > uses chat host permission for inventory, resolve, observe and pin"
- Mode: run
- Given: A member has a running chat Run with a chat-enabled protected host.
- When: The Runner resolves the host, the Agent lists `GET /api/ssh/hosts`, and the Runner posts an `access_rejected` observation and a host-key pin.
- Then: Resolve returns `resolved_access`, the inventory lists one host, the observation returns `recorded` and the pin returns `pinned`.

## cloudflare-access-027

- Vitest: "protected SSH authority > preserves host trust across rotation, protected edits and Access transitions; rejects stale evidence"
- Mode: run
- Given: A member has a running chat Run with a pinned protected host, a second protected host on the same configuration and a Direct host.
- When: The member rotates the client secret, the Runner posts an observation for the old host generation, the member edits the host's address, moves it to a replacement Access config, to Direct on port 22 and back to Access on 443, resets the host key, and the Runner resolves.
- Then: Rotation returns revision 2 and generation 2; the pinned host is at generation 3 with its learned key, the second host at generation 2 and the Direct host unchanged at 1. The stale observation returns `ignored`. Every edit keeps the learned host key; after `POST /api/ssh/connections/:connectionId/reset-host-key` the host resolves `resolved_access` with `learnedHostKey: null`.

## cloudflare-access-028

- Vitest: "protected SSH authority > preserves precise Access-stage evidence instead of misclassifying SSH authentication"
- Mode: run
- Given: A member has a running chat Run with a chat-enabled protected host.
- When: The Runner posts an observation with failure reason `access_rejected` to `POST /api/runners/runs/:runId/ssh/observations`, and the member reads `GET /api/ssh/connections/observations`.
- Then: The observation returns `recorded` and the member's first observation reports failure reason `access_rejected`.

## cloudflare-access-029

- Vitest: "protected SSH authority > rejects unsafe protected destinations without silently creating Direct hosts"
- Mode: run
- Given: A signed-in member owns a personal Access configuration.
- When: The member posts `POST /api/ssh/connections` with a Cloudflare Access transport and destinations `1.2.3.4`, `::1`, `localhost`, `*.example.com` and `https://ssh.example.com/path`.
- Then: Every request returns HTTP 400 and the member's host list stays empty.
