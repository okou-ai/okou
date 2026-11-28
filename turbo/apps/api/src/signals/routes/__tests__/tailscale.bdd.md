# tailscale

## tailscale-001

- Vitest: "Tailscale configuration and saved-host authority > creates a credential-free Tailscale SSH host, enforces transitions and retains network identity"
- Mode: run
- Given: A signed-in member has a personal Tailscale config.
- When: The member creates a Tailscale SSH host (`tailscale_ssh`, host `peer`, username `ubuntu`, no login) with `POST /api/ssh/connections`; tries `PATCH /api/ssh/connections/:connectionId` changes to port 2222, an inline login, and a direct transport; changes the username to `deploy`; converts it to a `tailscale` transport on port 2022 with an inline login; converts it back to `tailscale_ssh` on port 22 as `ubuntu`; then another member of the same organization tries to create a Tailscale SSH host on the config.
- Then: The create returns HTTP 201 with username `ubuntu`, port 22, the `tailscale_ssh` transport and no credential fields, and no logins exist. The port, login and direct changes each return HTTP 400. The username change returns HTTP 200 keeping the `tailscale_ssh` transport. The conversion to `tailscale` returns HTTP 200 with a credential ID, and the conversion back returns HTTP 200 without one, leaving one saved login. The other member's create returns HTTP 404 and they have no hosts.

## tailscale-002

- Vitest: "Tailscale configuration and saved-host authority > resolves only authorized Tailscale SSH identity and preserves pin/config-generation fences"
- Mode: run
- Given: A signed-in member has a personal Tailscale config and a `tailscale_ssh` host for username `test-user`, and an official Runner is executing the member's Run.
- When: The Runner resolves the host with `POST /api/runners/runs/:runId/ssh/resolve` before and after the member enables it as a remote-access default; pins a host key with `POST /api/runners/runs/:runId/ssh/pin`; the member changes the config tags to `tag:next` with `PATCH /api/tailscale/configs/:configId`; the Runner resolves again; the member resets the host key.
- Then: Before enablement the Runner gets `unavailable`. After enablement it gets `resolved_tailscale_ssh` with username `test-user`, port 22 and the Tailscale OAuth credentials and config ID, with no `authentication`. The pin returns `pinned` at generation +1. After the tag change the resolve returns generation +2, the learned host key and Tailscale generation 2. The reset returns HTTP 200 with no learned host key and no credential ID, and no logins exist.

## tailscale-003

- Vitest: "Tailscale configuration and saved-host authority > creates an inline identity network without a login and preserves the mode through adoption and rebind"
- Mode: run
- Given: A signed-in member creates a `tailscale_ssh` host (username `ubuntu`) with an inline Tailscale network via `POST /api/ssh/connections`.
- When: The member, as admin, promotes the network with `POST /api/tailscale/configs/:configId/convert-to-organization`; another admin previews and converts it to personal with `POST /api/tailscale/configs/:configId/convert-to-personal`; the original member reads their host, creates a new personal config, and rebinds the host to it with `PATCH /api/ssh/connections/:connectionId`.
- Then: After creation there are no logins and exactly one config. Promotion and conversion return HTTP 200. The original member's host keeps username `ubuntu` with a `tailscale_ssh` transport marked `needsRebind`. The rebind returns HTTP 200 with username `ubuntu`, port 22 and `tailscale_ssh` on the new config, and still no logins exist.

## tailscale-004

- Vitest: "Tailscale configuration and saved-host authority > keeps OAuth write-only, supports explicit-ID reconciliation and separates metadata/effective generations"
- Mode: run
- Given: A signed-in member is managing personal Tailscale configs.
- When: The member creates a config with `POST /api/tailscale/configs`, repeats the create with the same ID but a different client secret, renames it at revision 1, replaces its OAuth credentials at revision 2, sends a stale rename at revision 2, reads configs, hosts and logins, and deletes the config at revision 3.
- Then: The create returns HTTP 201 with revision 1, generation 1, scope `personal` and no hosts. The repeat returns HTTP 204. The rename returns revision 2 with generation 1; the credential replacement returns revision 3 with generation 2; the stale rename returns HTTP 409. No listed resource contains the OAuth client ID or secret or any client-credential field, and the config list shows exactly the replaced config. The delete returns HTTP 204.

## tailscale-005

- Vitest: "Tailscale configuration and saved-host authority > permits only admin shared management, hides Personal/tenant IDs and other members' host references"
- Mode: run
- Given: An organization admin has a shared Tailscale config and a personal one. A regular member of the organization has an SSH host bound to the shared config.
- When: The member lists configs, renames the shared config, creates an organization-scoped config, lists configs, and creates a host bound to the admin's personal config; the admin lists configs and deletes the shared config while it is referenced; a user from another organization lists configs; the member deletes their host and the admin deletes the shared config again.
- Then: The member sees the shared config with their host. The member's rename and organization-scoped create return HTTP 403, the admin's personal config is not in the member's list, and the host bound to it returns HTTP 404 leaving the member with one login. The admin sees the shared config with no host references, and the referenced delete returns HTTP 409 without the member's host ID in the body. The other-organization user sees no configs. After the member's host deletion (HTTP 204), the admin's delete returns HTTP 204.

## tailscale-006

- Vitest: "Tailscale configuration and saved-host authority > create atomically binds inline and saved networks and logins"
- Mode: run
- Given: A signed-in member has a personal Tailscale config and a host bound to it with an inline login.
- When: The member creates three more hosts at `100.64.2.3:65535` with `POST /api/ssh/connections` using, in turn, the saved network and saved login, an inline network with the saved login, and an inline network with an inline login.
- Then: Each create returns HTTP 201 with port 65535 and a `tailscale` transport, without the OAuth client secret. Each step adds exactly one config when the network is inline and exactly one login when the login is inline.

## tailscale-007

- Vitest: "Tailscale configuration and saved-host authority > update atomically binds inline and saved networks and logins"
- Mode: run
- Given: A signed-in member has a personal Tailscale config and a host bound to it with an inline login.
- When: The member updates the host with `PATCH /api/ssh/connections/:connectionId` to `100.64.2.3:65535` using, in turn, the saved network with an inline login, an inline network with the saved login, and an inline network with an inline login; then sends a stale-generation update with both an inline login and an inline network.
- Then: Each update returns HTTP 200 with port 65535 and a `tailscale` transport, without the OAuth client secret, adding exactly one config when the network is inline and one login when the login is inline. The stale update returns HTTP 409 and leaves configs, hosts and logins unchanged.

## tailscale-008

- Vitest: "Tailscale configuration and saved-host authority > reconciles a host-create retry without overwriting its inline resources and rolls back conflicts"
- Mode: run
- Given: A signed-in member creates a host with an inline login and inline Tailscale network via `POST /api/ssh/connections`.
- When: The member retries the identical create, creates the same body with a new ID, and then another member of the same organization retries the original create.
- Then: The retry returns HTTP 204 with configs, hosts and logins unchanged. The new-ID create returns HTTP 201 and adds one config. The other member's create returns HTTP 409 and they have no configs, hosts or logins.

## tailscale-009

- Vitest: "Tailscale configuration and saved-host authority > rejects non-peer target syntax 10.0.0.1 without saving resources"
- Mode: run
- Given: A signed-in member wants to save an SSH host reached through a new Tailscale network at target `10.0.0.1`.
- When: The member sends `POST /api/ssh/connections` with host `10.0.0.1`, an inline login and an inline Tailscale network.
- Then: The request returns HTTP 400 and the member's configs, hosts and logins are unchanged.

## tailscale-010

- Vitest: "Tailscale configuration and saved-host authority > rejects non-peer target syntax 127.0.0.1 without saving resources"
- Mode: run
- Given: A signed-in member wants to save an SSH host reached through a new Tailscale network at target `127.0.0.1`.
- When: The member sends `POST /api/ssh/connections` with host `127.0.0.1`, an inline login and an inline Tailscale network.
- Then: The request returns HTTP 400 and the member's configs, hosts and logins are unchanged.

## tailscale-011

- Vitest: "Tailscale configuration and saved-host authority > rejects non-peer target syntax 100.63.255.1 without saving resources"
- Mode: run
- Given: A signed-in member wants to save an SSH host reached through a new Tailscale network at target `100.63.255.1`.
- When: The member sends `POST /api/ssh/connections` with host `100.63.255.1`, an inline login and an inline Tailscale network.
- Then: The request returns HTTP 400 and the member's configs, hosts and logins are unchanged.

## tailscale-012

- Vitest: "Tailscale configuration and saved-host authority > rejects non-peer target syntax 100.128.0.1 without saving resources"
- Mode: run
- Given: A signed-in member wants to save an SSH host reached through a new Tailscale network at target `100.128.0.1`.
- When: The member sends `POST /api/ssh/connections` with host `100.128.0.1`, an inline login and an inline Tailscale network.
- Then: The request returns HTTP 400 and the member's configs, hosts and logins are unchanged.

## tailscale-013

- Vitest: "Tailscale configuration and saved-host authority > rejects non-peer target syntax ::1 without saving resources"
- Mode: run
- Given: A signed-in member wants to save an SSH host reached through a new Tailscale network at target `::1`.
- When: The member sends `POST /api/ssh/connections` with host `::1`, an inline login and an inline Tailscale network.
- Then: The request returns HTTP 400 and the member's configs, hosts and logins are unchanged.

## tailscale-014

- Vitest: "Tailscale configuration and saved-host authority > rejects non-peer target syntax fd00::1 without saving resources"
- Mode: run
- Given: A signed-in member wants to save an SSH host reached through a new Tailscale network at target `fd00::1`.
- When: The member sends `POST /api/ssh/connections` with host `fd00::1`, an inline login and an inline Tailscale network.
- Then: The request returns HTTP 400 and the member's configs, hosts and logins are unchanged.

## tailscale-015

- Vitest: "Tailscale configuration and saved-host authority > rejects non-peer target syntax peer%zone without saving resources"
- Mode: run
- Given: A signed-in member wants to save an SSH host reached through a new Tailscale network at target `peer%zone`.
- When: The member sends `POST /api/ssh/connections` with host `peer%zone`, an inline login and an inline Tailscale network.
- Then: The request returns HTTP 400 and the member's configs, hosts and logins are unchanged.

## tailscale-016

- Vitest: "Tailscale configuration and saved-host authority > rejects non-peer target syntax 100.064.0.1 without saving resources"
- Mode: run
- Given: A signed-in member wants to save an SSH host reached through a new Tailscale network at target `100.064.0.1`.
- When: The member sends `POST /api/ssh/connections` with host `100.064.0.1`, an inline login and an inline Tailscale network.
- Then: The request returns HTTP 400 and the member's configs, hosts and logins are unchanged.

## tailscale-017

- Vitest: "Tailscale configuration and saved-host authority > rejects non-peer target syntax *.tail.net without saving resources"
- Mode: run
- Given: A signed-in member wants to save an SSH host reached through a new Tailscale network at target `*.tail.net`.
- When: The member sends `POST /api/ssh/connections` with host `*.tail.net`, an inline login and an inline Tailscale network.
- Then: The request returns HTTP 400 and the member's configs, hosts and logins are unchanged.

## tailscale-018

- Vitest: "Tailscale configuration and saved-host authority > rejects non-peer target syntax https://peer without saving resources"
- Mode: run
- Given: A signed-in member wants to save an SSH host reached through a new Tailscale network at target `https://peer`.
- When: The member sends `POST /api/ssh/connections` with host `https://peer`, an inline login and an inline Tailscale network.
- Then: The request returns HTTP 400 and the member's configs, hosts and logins are unchanged.

## tailscale-019

- Vitest: "Tailscale configuration and saved-host authority > rejects non-peer target syntax host..tail.net without saving resources"
- Mode: run
- Given: A signed-in member wants to save an SSH host reached through a new Tailscale network at target `host..tail.net`.
- When: The member sends `POST /api/ssh/connections` with host `host..tail.net`, an inline login and an inline Tailscale network.
- Then: The request returns HTTP 400 and the member's configs, hosts and logins are unchanged.

## tailscale-020

- Vitest: "Tailscale configuration and saved-host authority > rejects non-peer target syntax 秘密.tail.net without saving resources"
- Mode: run
- Given: A signed-in member wants to save an SSH host reached through a new Tailscale network at target `秘密.tail.net`.
- When: The member sends `POST /api/ssh/connections` with host `秘密.tail.net`, an inline login and an inline Tailscale network.
- Then: The request returns HTTP 400 and the member's configs, hosts and logins are unchanged.

## tailscale-021

- Vitest: "Tailscale configuration and saved-host authority > rejects non-peer target syntax 0x7f000001 without saving resources"
- Mode: run
- Given: A signed-in member wants to save an SSH host reached through a new Tailscale network at target `0x7f000001`.
- When: The member sends `POST /api/ssh/connections` with host `0x7f000001`, an inline login and an inline Tailscale network.
- Then: The request returns HTTP 400 and the member's configs, hosts and logins are unchanged.

## tailscale-022

- Vitest: "Tailscale configuration and saved-host authority > accepts syntax-only peer target PEER and retains its binding on edit"
- Mode: run
- Given: A signed-in member has a personal Tailscale config and a host bound to it at peer target `PEER` port 2222.
- When: The member renames the host with `PATCH /api/ssh/connections/:connectionId`.
- Then: The update returns HTTP 200 with the `tailscale` transport still on the same config and port 2222.

## tailscale-023

- Vitest: "Tailscale configuration and saved-host authority > accepts syntax-only peer target peer.tail-test.ts.net. and retains its binding on edit"
- Mode: run
- Given: A signed-in member has a personal Tailscale config and a host bound to it at peer target `peer.tail-test.ts.net.` port 2222.
- When: The member renames the host with `PATCH /api/ssh/connections/:connectionId`.
- Then: The update returns HTTP 200 with the `tailscale` transport still on the same config and port 2222.

## tailscale-024

- Vitest: "Tailscale configuration and saved-host authority > accepts syntax-only peer target 100.64.0.1 and retains its binding on edit"
- Mode: run
- Given: A signed-in member has a personal Tailscale config and a host bound to it at peer target `100.64.0.1` port 2222.
- When: The member renames the host with `PATCH /api/ssh/connections/:connectionId`.
- Then: The update returns HTTP 200 with the `tailscale` transport still on the same config and port 2222.

## tailscale-025

- Vitest: "Tailscale configuration and saved-host authority > accepts syntax-only peer target fd7a:115c:a1e0::1 and retains its binding on edit"
- Mode: run
- Given: A signed-in member has a personal Tailscale config and a host bound to it at peer target `fd7a:115c:a1e0::1` port 2222.
- When: The member renames the host with `PATCH /api/ssh/connections/:connectionId`.
- Then: The update returns HTTP 200 with the `tailscale` transport still on the same config and port 2222.

## tailscale-026

- Vitest: "Tailscale configuration and saved-host authority > uses current winning process/host/chat/config authority and the shared host generation fence without a backend rollout flag"
- Mode: run
- Given: A signed-in member has a personal Tailscale config (tag `tag:okou`) and a host bound to it with a password login, and an official Runner is executing the member's Run. No backend rollout flag is set.
- When: The Runner resolves via `POST /api/runners/runs/:runId/ssh/resolve` before and after the member enables the host as a remote-access default, then with an unknown connection, another runner ID, a newer heartbeat generation, and with member credentials; pins with a wrong and then the right expected generation; records an observation; the member changes the tags to `tag:next`; the Runner pins and observes with the old generation and resolves again; the member disables the host for the Run's thread with `PUT /api/chat-threads/:threadId/remote-access/ssh/:connectionId` and later clears the override with `DELETE`, with the Runner resolving after each.
- Then: Before enablement the Runner gets `unavailable` without decryption. After enablement it gets `resolved_tailscale` with the host, the password authentication and the Tailscale OAuth credentials, config ID, generation 1 and tags. The stale connection and runner identities get `unavailable`, member credentials get HTTP 401, and nothing is decrypted. The wrong-generation pin returns `configuration_changed`; the correct pin returns `pinned` at generation +1, and the observation is `recorded` and listed once in `GET /api/ssh/connections/observations`. The tag change returns config generation 2, the host moves to generation +2 keeping its learned key, and observations are cleared. The old-generation pin then returns `configuration_changed`, the observation `ignored`, and the resolve returns generation +2 with tags `tag:next`. With the thread override disabled the Runner gets `unavailable` without decryption; after clearing it, it resolves `resolved_tailscale` with the current config generation and tags.

## tailscale-027

- Vitest: "Tailscale configuration and saved-host authority > fences a first credential binding via create during rotation and keeps the admitted handoff snapshot"
- Mode: run
- Given: A signed-in member has a personal Tailscale config, a saved password login with no hosts, and an official Runner executing the member's Run. A rotation of the login (username `rotated-user`, new password) is stalled while KMS encrypts the new secret.
- When: While the rotation is stalled, the member creates the first host bound to the login and config with `POST /api/ssh/connections` and enables it as a remote-access default; the Runner resolves it; a second resolve is held during decryption while the rotation completes; then the Runner pins at the old generation and resolves again.
- Then: The first resolve returns `resolved_tailscale` with the original username and password. The held resolve completes with the admitted snapshot: original generation, original username and password. The rotation returns HTTP 200 with revision +1, username `rotated-user` and an empty host list in its response. The host is then listed at generation +1 with `rotated-user`. The old-generation pin returns `configuration_changed` without decryption, and the next resolve returns generation +1 with `rotated-user` and the rotated password.

## tailscale-028

- Vitest: "Tailscale configuration and saved-host authority > fences a first credential binding via rebind during rotation and keeps the admitted handoff snapshot"
- Mode: run
- Given: A signed-in member has a personal Tailscale config with an existing host, a separate saved password login with no hosts, and an official Runner executing the member's Run. A rotation of that login (username `rotated-user`, new password) is stalled while KMS encrypts the new secret.
- When: While the rotation is stalled, the member rebinds the existing host to the login with `PATCH /api/ssh/connections/:connectionId` and enables it as a remote-access default; the Runner resolves it; a second resolve is held during decryption while the rotation completes; then the Runner pins at the old generation and resolves again.
- Then: The first resolve returns `resolved_tailscale` with the original username and password. The held resolve completes with the admitted snapshot: the rebound generation, original username and password. The rotation returns HTTP 200 with revision +1, username `rotated-user` and an empty host list in its response. The host is then listed at generation +1 with `rotated-user`. The old-generation pin returns `configuration_changed` without decryption, and the next resolve returns generation +1 with `rotated-user` and the rotated password.

## tailscale-029

- Vitest: "Tailscale configuration and saved-host authority > protects private-key JIT with passphrase null using the admitted snapshot, then denies fresh resolution after revocation"
- Mode: run
- Given: A signed-in member has a personal Tailscale config and a host `peer:2222` bound to it with an inline private-key login (username `key-user`) using a null passphrase. The host is enabled as a remote-access default and an official Runner is executing the member's Run.
- When: The member lists configs, hosts and logins; the Runner resolves the host with `POST /api/runners/runs/:runId/ssh/resolve`; during the final decryption of a second resolve the member disables the host for the Run's thread with `PUT /api/chat-threads/:threadId/remote-access/ssh/:connectionId`; then the Runner resolves a third time.
- Then: No listed resource contains the OAuth client ID or secret, the private key or the passphrase. The first resolve returns exactly `resolved_tailscale` with the host, port, username `key-user`, generation, no learned host key, the private-key authentication as saved, and the Tailscale OAuth credentials, config ID, generation and tags. The second resolve returns the identical admitted snapshot. The third resolve returns `unavailable` without any decryption.

## tailscale-030

- Vitest: "Tailscale configuration and saved-host authority > protects private-key JIT with passphrase \" private-passphrase-canary\\n\" using the admitted snapshot, then denies fresh resolution after revocation"
- Mode: run
- Given: A signed-in member has a personal Tailscale config and a host `peer:2222` bound to it with an inline private-key login (username `key-user`) using passphrase `" private-passphrase-canary\n"`. The host is enabled as a remote-access default and an official Runner is executing the member's Run.
- When: The member lists configs, hosts and logins; the Runner resolves the host with `POST /api/runners/runs/:runId/ssh/resolve`; during the final decryption of a second resolve the member disables the host for the Run's thread with `PUT /api/chat-threads/:threadId/remote-access/ssh/:connectionId`; then the Runner resolves a third time.
- Then: No listed resource contains the OAuth client ID or secret, the private key or the passphrase. The first resolve returns exactly `resolved_tailscale` with the host, port, username `key-user`, generation, no learned host key, the private-key authentication as saved, and the Tailscale OAuth credentials, config ID, generation and tags. The second resolve returns the identical admitted snapshot. The third resolve returns `unavailable` without any decryption.

## tailscale-031

- Vitest: "Tailscale configuration and saved-host authority > completes the admitted network snapshot during rotation without holding DB locks across decryption"
- Mode: run
- Given: A signed-in member has a personal Tailscale config (tag `tag:okou`) and a bound host enabled as a remote-access default, and an official Runner is executing the member's Run.
- When: The Runner resolves the host with `POST /api/runners/runs/:runId/ssh/resolve`; during the first decryption the member changes the config tags to `tag:rotated` with `PATCH /api/tailscale/configs/:configId`; then the Runner resolves again.
- Then: The tag change returns HTTP 200 while the first resolve is in progress, and the first resolve returns `resolved_tailscale` with the original host generation and the original Tailscale OAuth credentials, config ID, generation and tags. The second resolve returns host generation +1 and Tailscale generation +1 with tags `tag:rotated`.

## tailscale-032

- Vitest: "Tailscale configuration and saved-host authority > serializes shared config CAS and host CAS without orphan inline resources"
- Mode: run
- Given: A signed-in member has a personal Tailscale config at revision 1 and a host bound to it.
- When: The member concurrently sets the config tags to `tag:first` and `tag:second` with `PATCH /api/tailscale/configs/:configId`; then concurrently sends two host updates at the current generation, each with a new inline login and a new inline Tailscale network.
- Then: One tag update returns HTTP 200 and the other HTTP 409, and the host generation increases by one. One host update returns HTTP 200 and the other HTTP 409, leaving exactly one additional config, one additional login and still one host.

## tailscale-033

- Vitest: "Tailscale configuration and saved-host authority > bind/delete races preserve restrictive FK ownership and creation atomicity"
- Mode: run
- Given: A signed-in member has a personal Tailscale config at revision 1 with no hosts.
- When: The member concurrently creates a host bound to the config with an inline login via `POST /api/ssh/connections` and deletes the config via `DELETE /api/tailscale/configs/:configId` at revision 1.
- Then: Either the create returns HTTP 201 and the delete HTTP 409, leaving one config, one host and one login; or the create returns HTTP 404 and the delete HTTP 204, leaving no configs, hosts or logins.

## tailscale-034

- Vitest: "Tailscale configuration and saved-host authority > requires reviewed scope conversion and rejects invalid tags/credentials through real request validation"
- Mode: run
- Given: A signed-in member has a personal Tailscale config at revision 1.
- When: The member sends raw `PATCH /api/tailscale/configs/:configId` requests at revision 1 that set `scope: organization`, set empty tags, or set credentials whose client secret starts with a newline.
- Then: Each request returns HTTP 400, and the config remains at revision 1 and generation 1.
