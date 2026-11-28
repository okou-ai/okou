# cloudflare-access-concurrency

## cloudflare-access-concurrency-001

- Vitest: "rejects competing user ownership of one configuration ID without replacing the winner"
- Mode: run
- Given: Two organization admins in the same organization (dimension `user`) each prepare a personal Cloudflare Access configuration with the same configuration ID but different names and credentials.
- When: Both send `POST /api/cloudflare-access/configs` concurrently, and the losing request is replayed.
- Then: Exactly one request returns HTTP 201 and the other HTTP 409 `CLOUDFLARE_ACCESS_RESOURCE_ID_CONFLICT` ("This resource ID cannot be used for this Cloudflare Access configuration."), and the replay also returns HTTP 409. `GET /api/cloudflare-access/configs` shows the created configuration only to the winner; the loser sees no configurations.

## cloudflare-access-concurrency-002

- Vitest: "rejects competing organization ownership of one configuration ID without replacing the winner"
- Mode: run
- Given: Admins of two different organizations (dimension `organization`) each prepare an organization Cloudflare Access configuration with the same configuration ID.
- When: Both send `POST /api/cloudflare-access/configs` concurrently, and the losing request is replayed.
- Then: Exactly one request returns HTTP 201 and the other HTTP 409 `CLOUDFLARE_ACCESS_RESOURCE_ID_CONFLICT`, and the replay also returns HTTP 409. Only the winner lists the created configuration; the loser sees none.

## cloudflare-access-concurrency-003

- Vitest: "rejects competing scope ownership of one configuration ID without replacing the winner"
- Mode: run
- Given: One admin (dimension `scope`) prepares two configurations with the same ID, one personal and one organization-scoped.
- When: Both `POST /api/cloudflare-access/configs` requests are sent concurrently, and the losing request is replayed.
- Then: Exactly one returns HTTP 201 and the other HTTP 409 `CLOUDFLARE_ACCESS_RESOURCE_ID_CONFLICT`, and the replay also returns HTTP 409. The admin's configuration list contains only the winning configuration.

## cloudflare-access-concurrency-004

- Vitest: "accepts exactly one same-revision metadata rename for a personal configuration without changing host authority"
- Mode: run
- Given: An admin owns a personal Cloudflare Access configuration bound to the admin's own SSH host with a login; a member of the same organization has a direct SSH host.
- When: The admin sends two concurrent `PATCH /api/cloudflare-access/configs/:configId` renames with the same expected revision.
- Then: One returns HTTP 200 with one of the new names, the next revision, the unchanged generation and the admin's host in `sshHosts`; the other returns HTTP 409 `CLOUDFLARE_ACCESS_REVISION_CONFLICT`. The configuration list equals the renamed configuration, and both users' `GET /api/ssh/connections` and the admin's `GET /api/ssh/credentials` are unchanged.

## cloudflare-access-concurrency-005

- Vitest: "accepts exactly one same-revision metadata rename for a organization configuration without changing host authority"
- Mode: run
- Given: An admin owns an organization Cloudflare Access configuration bound to the admin's SSH host, and a member of the same organization has an SSH host bound to the same configuration.
- When: The admin sends two concurrent `PATCH /api/cloudflare-access/configs/:configId` renames with the same expected revision.
- Then: One returns HTTP 200 with one of the new names, the next revision, the unchanged generation and only the admin's host in `sshHosts`; the other returns HTTP 409 `CLOUDFLARE_ACCESS_REVISION_CONFLICT`. The configuration list equals the renamed configuration, and both users' host lists and the admin's logins are unchanged.

## cloudflare-access-concurrency-006

- Vitest: "admits selected create after a metadata-only rename during external login preparation without advancing host authority"
- Mode: run
- Given: An admin's organization configuration is bound to the admin's host and a member's retained host; while the API prepares the member's new encrypted login, the admin renames the configuration (HTTP 200, next revision, same generation).
- When: The member creates a new SSH host selecting the configuration via `POST /api/ssh/connections` with port 443 and a new login (operation `create`).
- Then: The host is created at generation 1 with the Cloudflare Access transport. The admin's host list is unchanged, the member still has the retained host, and the member sees one configuration named "Renamed gateway" at the new revision and the original generation listing exactly the retained and new hosts.

## cloudflare-access-concurrency-007

- Vitest: "admits selected update after a metadata-only rename during external login preparation without advancing host authority"
- Mode: run
- Given: An admin's organization configuration is bound to the admin's host and a member's retained host; the member also has a direct host. While the API prepares the member's new encrypted login, the admin renames the configuration.
- When: The member switches the direct host to the configuration via `PATCH /api/ssh/connections/:connectionId` with port 443, a new login and the Cloudflare Access transport (operation `update`).
- Then: The update returns HTTP 200 with the generation advanced by one and the Cloudflare Access transport. The admin's host list is unchanged, the member still has the retained host, and the member sees one configuration named "Renamed gateway" at the new revision and original generation listing exactly the retained and updated hosts.

## cloudflare-access-concurrency-008

- Vitest: "rejects selected create after scope conversion during external login preparation without an orphan login"
- Mode: run
- Given: An admin's organization configuration and a member's direct SSH host exist; while the API prepares the member's new encrypted login, the admin converts the configuration to personal using a fresh conversion preview.
- When: The member creates an SSH host selecting the configuration via `POST /api/ssh/connections` (operation `create`).
- Then: The request returns HTTP 404 `CLOUDFLARE_ACCESS_NOT_FOUND`. The member's hosts and logins are unchanged (no orphan login), the member sees no configurations, and the admin's configuration is personal at revision 2 and generation 2.

## cloudflare-access-concurrency-009

- Vitest: "rejects selected update after scope conversion during external login preparation without an orphan login"
- Mode: run
- Given: An admin's organization configuration and a member's direct SSH host exist; while the API prepares the member's new encrypted login, the admin converts the configuration to personal using a fresh conversion preview.
- When: The member switches the direct host to the configuration via `PATCH /api/ssh/connections/:connectionId` (operation `update`).
- Then: The request returns HTTP 404 `CLOUDFLARE_ACCESS_NOT_FOUND`. The member's hosts and logins are unchanged, the member sees no configurations, and the admin's configuration is personal at revision 2 and generation 2.

## cloudflare-access-concurrency-010

- Vitest: "admits a concurrent selected create at statement start and denies new bindings after conversion"
- Mode: run
- Given: An admin has reviewed a conversion preview for an organization configuration; a member has a direct SSH host.
- When: The member creates a host selecting the configuration (operation `create`) concurrently with the admin's `POST /api/cloudflare-access/configs/:configId/convert-to-personal`.
- Then: If conversion wins and the binding was rejected, the member has only the direct host; if both succeed, the new host is listed and, once enabled as a default, a Runner `POST /api/runners/runs/:runId/ssh/resolve` returns `unavailable`; afterwards new bindings return HTTP 404. If conversion is rejected (revision or impact conflict), the binding succeeded with HTTP 201, the configuration stays organization-scoped at its revision and generation, a fresh preview counts one other host, and converting then marks the host `needsRebind` at the next generation. In every outcome the member sees no configurations at the end.

## cloudflare-access-concurrency-011

- Vitest: "admits a concurrent selected update at statement start and denies new bindings after conversion"
- Mode: run
- Given: An admin has reviewed a conversion preview for an organization configuration; a member has a direct SSH host.
- When: The member switches the direct host to the configuration (operation `update`) concurrently with the admin's `POST /api/cloudflare-access/configs/:configId/convert-to-personal`.
- Then: If conversion wins and the binding was rejected, the member has only the original direct host; if both succeed, the updated host is listed and a Runner resolve returns `unavailable`; afterwards new bindings return HTTP 404. If conversion is rejected (revision or impact conflict), the update succeeded with HTTP 200, the configuration stays organization-scoped, a fresh preview counts one other host, and converting then marks the host `needsRebind` at the next generation. In every outcome the member sees no configurations at the end.

## cloudflare-access-concurrency-012

- Vitest: "requires a fresh deletion preview for a first concurrent member binding"
- Mode: run
- Given: An admin has reviewed a deletion preview for an organization configuration with no bound hosts; a member of the organization exists.
- When: The member creates the first SSH host selecting the configuration via `POST /api/ssh/connections` concurrently with the admin's `DELETE /api/cloudflare-access/configs/:configId` using the reviewed preview.
- Then: If the delete returns HTTP 204, the binding returned HTTP 404 and the member has no hosts and no logins. Otherwise the delete returns HTTP 409 with a revision or impact conflict, the binding succeeded with HTTP 201, the configuration is unchanged, a fresh preview counts one other host, and deleting with it returns HTTP 204 and leaves the member's host at the next generation with port 443 and transport `needsRebind`. Finally the member sees no configurations.

## cloudflare-access-concurrency-013

- Vitest: "promotes a configuration with a concurrent first binding or an explicit new request after conflict"
- Mode: run
- Given: An owner has a personal Cloudflare Access configuration with no bound hosts.
- When: The owner creates an SSH host bound to it concurrently with `POST /api/cloudflare-access/configs/:configId/convert-to-organization` at the original revision; if the promotion conflicts, the owner sends a new promotion request.
- Then: The binding returns HTTP 201. A conflicting promotion returns HTTP 409 `CLOUDFLARE_ACCESS_REVISION_CONFLICT` while the configuration stays personal at its revision and generation and the host list equals the new host. The completed promotion is organization-scoped at the next revision and generation, lists exactly the new host, and the host's generation advances by one only when the promotion included it.

## cloudflare-access-concurrency-014

- Vitest: "includes first concurrent bindings in current rotation authority without losing existing hosts"
- Mode: run
- Given: An owner has an organization configuration with no bound hosts (timing `first`).
- When: The owner rotates its credentials via `PATCH /api/cloudflare-access/configs/:configId` concurrently with two new host bindings via `POST /api/ssh/connections`; if the rotation conflicts, the owner sends a new rotation request afterwards.
- Then: Both bindings return HTTP 201. A conflicting rotation returns HTTP 409 `CLOUDFLARE_ACCESS_REVISION_CONFLICT` and leaves the configuration at revision 1, generation 1 with all hosts at generation 1, after which the new request succeeds. Either way the configuration ends at revision 2, generation 2 listing both new hosts, and each host keeps its login, port 443 and Cloudflare Access transport at its original or next generation.

## cloudflare-access-concurrency-015

- Vitest: "includes late concurrent bindings in current rotation authority without losing existing hosts"
- Mode: run
- Given: An owner has an organization configuration already bound to one existing host (timing `late`).
- When: The owner rotates its credentials via `PATCH /api/cloudflare-access/configs/:configId` concurrently with two new host bindings; if the rotation conflicts, the owner sends a new rotation request afterwards.
- Then: Both bindings return HTTP 201. A conflicting rotation returns HTTP 409 `CLOUDFLARE_ACCESS_REVISION_CONFLICT` with authority unchanged before the new request succeeds. The configuration ends at revision 2, generation 2 listing both new hosts, each new host keeps its login, port 443 and transport at its original or next generation, and the existing host advances by one generation.

## cloudflare-access-concurrency-016

- Vitest: "preserves revision authority when metadata rename races configuration rotate"
- Mode: run
- Given: An admin's organization configuration is bound to a member's host with a login.
- When: The admin sends a metadata rename and a credential rotation (operation `rotate`) for the same revision concurrently via `PATCH /api/cloudflare-access/configs/:configId`.
- Then: If the rename returns HTTP 200, the rotation returns HTTP 409 `CLOUDFLARE_ACCESS_REVISION_CONFLICT`, the configuration is "Renamed gateway" at the next revision and same generation, and the member's host is unchanged. Otherwise the rename returns 409 `CLOUDFLARE_ACCESS_REVISION_CONFLICT` (or 404 `CLOUDFLARE_ACCESS_NOT_FOUND`), the rotation returns HTTP 200 with the original name at the next revision and generation, and the host advances one generation keeping its Cloudflare Access binding. The member's logins are unchanged.

## cloudflare-access-concurrency-017

- Vitest: "preserves revision authority when metadata rename races configuration convert"
- Mode: run
- Given: An admin's organization configuration is bound to a member's host, and the admin has reviewed a conversion preview.
- When: The admin sends a metadata rename concurrently with `POST /api/cloudflare-access/configs/:configId/convert-to-personal` (operation `convert`).
- Then: If the rename returns HTTP 200, the conversion returns HTTP 409 `CLOUDFLARE_ACCESS_REVISION_CONFLICT`, the configuration is the renamed organization configuration at the next revision and same generation, and the host is unchanged. Otherwise the rename is rejected with a revision conflict or not-found, the conversion returns HTTP 200 with the original name as a personal configuration at the next revision and generation, and the member's host advances one generation with transport `needsRebind`. The member's logins are unchanged.

## cloudflare-access-concurrency-018

- Vitest: "preserves revision authority when metadata rename races configuration delete"
- Mode: run
- Given: An admin's organization configuration is bound to a member's host, and the admin has reviewed a deletion preview.
- When: The admin sends a metadata rename concurrently with `DELETE /api/cloudflare-access/configs/:configId` (operation `delete`).
- Then: If the rename returns HTTP 200, the deletion returns HTTP 409 `CLOUDFLARE_ACCESS_REVISION_CONFLICT`, the renamed configuration remains, and the host is unchanged. Otherwise the rename is rejected with a revision conflict or HTTP 404 `CLOUDFLARE_ACCESS_NOT_FOUND`, the deletion returns HTTP 204, no configurations remain, and the member's host advances one generation with transport `needsRebind`. The member's logins are unchanged.

## cloudflare-access-concurrency-019

- Vitest: "preserves atomic rotation when a bound host concurrently leaves through delete"
- Mode: run
- Given: An owner's organization configuration is bound to the owner's own host with a login.
- When: The owner deletes the host via `DELETE /api/ssh/connections/:connectionId` (operation `delete`) concurrently with a credential rotation via `PATCH /api/cloudflare-access/configs/:configId`.
- Then: A successful rotation lists exactly the rotated configuration at the next revision and generation; a rejected rotation returns HTTP 409 `CLOUDFLARE_ACCESS_REVISION_CONFLICT` only when the delete succeeded, leaving the configuration unchanged. If the delete returned HTTP 409 `SSH_GENERATION_CONFLICT`, the host remains at the next generation with the Cloudflare Access binding and is listed in `sshHosts`; otherwise no hosts remain and `sshHosts` is empty. Logins are unchanged except that their host lists are empty after a successful delete.

## cloudflare-access-concurrency-020

- Vitest: "preserves atomic rotation when a bound host concurrently leaves through detach"
- Mode: run
- Given: An owner's organization configuration is bound to the owner's own host with a login.
- When: The owner switches the host to a direct port-22 transport via `PATCH /api/ssh/connections/:connectionId` (operation `detach`) concurrently with a credential rotation via `PATCH /api/cloudflare-access/configs/:configId`.
- Then: A successful rotation lists exactly the rotated configuration at the next revision and generation; a rejected rotation returns HTTP 409 `CLOUDFLARE_ACCESS_REVISION_CONFLICT` only when the detach succeeded, leaving the configuration unchanged. If the detach returned HTTP 409 `SSH_GENERATION_CONFLICT`, the host remains bound at the next generation; otherwise `sshHosts` is empty and the host is at the next generation on port 22 with its login and no transport. The owner's logins are unchanged.

## cloudflare-access-concurrency-021

- Vitest: "serializes configuration rotation with independent-login deletion without losing the binding"
- Mode: run
- Given: An owner's organization configuration is bound to the owner's host that uses an independent login at revision 1.
- When: The owner rotates the configuration credentials via `PATCH /api/cloudflare-access/configs/:configId` concurrently with `DELETE /api/ssh/credentials/:credentialId` for the host's login.
- Then: The rotation returns HTTP 200 at generation 2; the login deletion returns HTTP 409 `SSH_CREDENTIAL_IN_USE`. The host keeps its login and Cloudflare Access binding at the next generation, and the login remains at revision 1 with username `deploy`.

## cloudflare-access-concurrency-022

- Vitest: "rejects a binding after selected Access deletion during KMS without creating a login"
- Mode: run
- Given: An admin's organization configuration exists and a member has a direct SSH host; while the API prepares the member's new encrypted login, the admin deletes the configuration (HTTP 204).
- When: The member switches the direct host to the configuration with a new login via `PATCH /api/ssh/connections/:connectionId`.
- Then: The request returns HTTP 404 `CLOUDFLARE_ACCESS_NOT_FOUND`. The member's logins are unchanged (no new login), the member still has only the original direct host, and no configurations are visible.

## cloudflare-access-concurrency-023

- Vitest: "creates neither inline resource when its owned host is deleted during KMS"
- Mode: run
- Given: An owner has a direct SSH host; while the API prepares the encrypted login, the owner deletes that host (HTTP 204).
- When: The owner updates the host via `PATCH /api/ssh/connections/:connectionId` with an inline new login and an inline new Cloudflare Access configuration.
- Then: The request returns HTTP 404 `SSH_CONNECTION_NOT_FOUND`. No hosts and no configurations exist, and the owner's logins are the previous ones with empty host lists, so neither inline resource is created.

## cloudflare-access-concurrency-024

- Vitest: "rejects an inline login on a host needing rebind until a transport is explicitly selected"
- Mode: run
- Given: An admin's organization configuration is bound to a member's host, and the admin converts the configuration to personal with a reviewed preview so the member's host needs a rebind.
- When: The member updates that host via `PATCH /api/ssh/connections/:connectionId` with only an inline new login and no transport selection.
- Then: The request returns HTTP 400 `SSH_INVALID_INPUT`. The member's hosts and logins are unchanged and the member sees no configurations.

## cloudflare-access-concurrency-025

- Vitest: "protected host writes with authorized Runner authority > keeps the first personal same-ID creation immutable across concurrent requests and changed-payload replays"
- Mode: run
- Given: An owner with a running Run (personal scope) prepares two personal configuration creations with the same ID but different names and credentials; the realtime service is unavailable.
- When: Both `POST /api/cloudflare-access/configs` requests are sent concurrently, then a changed-payload retry with the same ID is sent; after realtime recovers the owner binds a host to the configuration, enables it as an SSH default, and the Runner calls `POST /api/runners/runs/:runId/ssh/resolve`.
- Then: One request returns HTTP 201 (revision 1, generation 1, no hosts, no client secret in the body) and the other HTTP 204; the changed retry also returns HTTP 204. The owner's list equals the created configuration and an organization member sees none. The Runner resolves `resolved_access` with the configuration ID, generation 1 and the winning payload's client ID and secret.

## cloudflare-access-concurrency-026

- Vitest: "protected host writes with authorized Runner authority > keeps the first organization same-ID creation immutable across concurrent requests and changed-payload replays"
- Mode: run
- Given: An owner with a running Run and a second admin in the same organization prepare organization configuration creations with the same ID but different names and credentials; the realtime service is unavailable.
- When: Both `POST /api/cloudflare-access/configs` requests are sent concurrently, then the second admin sends a changed-payload retry and a member submits the winning payload; after realtime recovers the owner binds a host, enables it as an SSH default, and the Runner resolves it.
- Then: One request returns HTTP 201 (revision 1, generation 1, no hosts, no client secret) and the other HTTP 204; the changed retry returns HTTP 204 and the member's create returns HTTP 403. The owner and the member both list exactly the created configuration. The Runner resolves `resolved_access` with generation 1 and the winning payload's credentials.

## cloudflare-access-concurrency-027

- Vitest: "protected host writes with authorized Runner authority > preserves pin and observation authority across a concurrent metadata-only rename without rotating credentials"
- Mode: run
- Given: An owner's running Run can use an SSH host bound to an organization configuration and enabled as a default; a member has another host on the same configuration.
- When: The owner renames the configuration via `PATCH /api/cloudflare-access/configs/:configId` concurrently with the Runner's `POST /api/runners/runs/:runId/ssh/pin` (with a host key) and `POST /api/runners/runs/:runId/ssh/observations`, then the Runner resolves the host.
- Then: The rename returns HTTP 200 at the next revision and same generation listing the owner's host; the pin returns `pinned` at the next host generation; the observation is `recorded` or `ignored`. The host keeps its login, address and binding with the learned host key, the member's hosts are unchanged, resolve returns `resolved_access` with the learned key, the original login and the unrotated Access credentials, there are no observations listed, and the owner's logins are unchanged.

## cloudflare-access-concurrency-028

- Vitest: "protected host writes with authorized Runner authority > rejects an edit delayed at KMS after Runner learns trust, without replacing the pin or leaving an inline login"
- Mode: run
- Given: An owner's running Run can use a protected SSH host; while the API prepares the encrypted data for an edit, the Runner pins the host key (outcome `pinned`, next generation).
- When: The owner updates the host at the old generation via `PATCH /api/ssh/connections/:connectionId` with an inline new login and an inline new Cloudflare Access configuration.
- Then: The request returns HTTP 409 `SSH_GENERATION_CONFLICT`. Configurations and logins are unchanged, the host keeps the pinned key, original login and binding at the next generation, and the Runner still resolves `resolved_access` with the original password and configuration.

## cloudflare-access-concurrency-029

- Vitest: "protected host writes with authorized Runner authority > publishes a create binding with a shared login while another host records Runner authority"
- Mode: run
- Given: An owner's running Run can use a protected SSH host bound to an organization configuration with a login (operation `create`).
- When: The owner creates a second host bound to the same configuration that reuses the existing login, concurrently with the Runner's pin and observation for the first host, then the Runner resolves.
- Then: The new host returns HTTP 201 with the shared login and the Access transport; the pin returns `pinned` at the next generation and the observation is `recorded` or `ignored`. Resolve returns `resolved_access` with the learned key and original login and configuration. The host list contains the new host, the configuration lists both hosts with its revision unchanged, and there is still exactly one login.

## cloudflare-access-concurrency-030

- Vitest: "protected host writes with authorized Runner authority > publishes a rebind binding with a shared login while another host records Runner authority"
- Mode: run
- Given: An owner's running Run can use a protected SSH host bound to an organization configuration, and the owner has a second direct host reusing the same login (operation `rebind`).
- When: The owner switches the direct host to the configuration via `PATCH /api/ssh/connections/:connectionId` concurrently with the Runner's pin and observation for the first host, then the Runner resolves.
- Then: The update returns HTTP 200 with the shared login and the Access transport; the pin returns `pinned` at the next generation and the observation is `recorded` or `ignored`. Resolve returns `resolved_access` with the learned key and original login and configuration. The configuration lists both hosts with its revision unchanged, and there is exactly one login.

## cloudflare-access-concurrency-031

- Vitest: "protected host writes with authorized Runner authority > notifies the affected Runner after reviewed deletion and preserves the detached Host"
- Mode: run
- Given: An owner's running Run can use an SSH host bound to an organization configuration; another admin of the organization reviews a deletion preview.
- When: The admin deletes the configuration via `DELETE /api/cloudflare-access/configs/:configId` with the reviewed preview.
- Then: The deletion returns HTTP 204 and publishes exactly one `ssh-authority-invalidated` event for the Run and host, with no `vnc-authority-invalidated` event. The host is kept at the next generation with transport `needsRebind`, and the Runner's resolve returns `unavailable`.

## cloudflare-access-concurrency-032

- Vitest: "protected host writes with authorized Runner authority > commits network rotation completely or rejects concurrent Runner authority before a fresh request"
- Mode: run
- Given: An owner's running Run can use a protected host bound to an organization configuration, and a second host shares the same login and configuration (resource `network`).
- When: The owner rotates the configuration credentials via `PATCH /api/cloudflare-access/configs/:configId` concurrently with the Runner's pin and observation; if the rotation conflicts, the owner sends a new rotation request.
- Then: A conflicting rotation returns HTTP 409 `CLOUDFLARE_ACCESS_REVISION_CONFLICT` with configuration, hosts and login unchanged and resolve still using the original credentials. The committed rotation returns HTTP 200 at revision 2, generation 2; both hosts advance a generation, the protected host keeps its address, login and binding, and is pinned (directly or via a later pin). Resolve returns `resolved_access` with the original login, the learned key and the rotated Access credentials at generation 2; no observations are listed and the login stays at revision 1.

## cloudflare-access-concurrency-033

- Vitest: "protected host writes with authorized Runner authority > commits login rotation completely or rejects concurrent Runner authority before a fresh request"
- Mode: run
- Given: An owner's running Run can use a protected host bound to an organization configuration, and a second host shares the same login and configuration (resource `login`).
- When: The owner rotates the shared login via `PATCH /api/ssh/credentials/:credentialId` (username `rotated-deploy`, new password) concurrently with the Runner's pin and observation; if the rotation conflicts, the owner sends a new rotation request.
- Then: A conflicting rotation returns HTTP 409 `SSH_CREDENTIAL_REVISION_CONFLICT` with hosts, configuration and login unchanged and resolve still using the original credentials. The committed rotation returns HTTP 200 at revision 2 with username `rotated-deploy`; both hosts advance a generation, the protected host is pinned (directly or via a later pin), and resolve returns `resolved_access` with the rotated username and password, the learned key and the original Access credentials at generation 1. No observations are listed.
