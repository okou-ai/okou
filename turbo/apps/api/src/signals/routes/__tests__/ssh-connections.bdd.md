# ssh-connections

## ssh-connections-001

- Vitest: "SSH connection routes > allows host management without feature overrides in org_3ANttyrbWYJk6JKRSTRLEsbsDLe"
- Mode: run
- Given: A signed-in member of organization `org_3ANttyrbWYJk6JKRSTRLEsbsDLe` has no SSH hosts and no feature-switch overrides.
- When: The member lists hosts with `GET /api/ssh/connections`.
- Then: The request returns HTTP 200 with an empty `connections` list and a `cache-control: no-store` header.

## ssh-connections-002

- Vitest: "SSH connection routes > allows host management without feature overrides in org_ordinary_ssh"
- Mode: run
- Given: A signed-in member of the ordinary organization `org_ordinary_ssh` has no SSH hosts and no feature-switch overrides.
- When: The member lists hosts with `GET /api/ssh/connections`.
- Then: The request returns HTTP 200 with an empty `connections` list and a `cache-control: no-store` header.

## ssh-connections-003

- Vitest: "SSH connection routes > notifies only the owner after every successful connection creation"
- Mode: run
- Given: A signed-in member can encrypt secrets with KMS.
- When: The member creates three hosts in turn with `POST /api/ssh/connections` for `first.example.com`, `second.example.com`, and `first.example.com` again.
- Then: Each create returns HTTP 201, and after each one exactly one realtime `ssh:changed` message carrying the owner's organization ID is published, only on the owner's `user:<userId>` channel.

## ssh-connections-004

- Vitest: "SSH connection routes > requires organization authentication"
- Mode: run
- Given: One caller sends no credentials, and another is a signed-in user without an active organization.
- When: Each caller lists hosts with `GET /api/ssh/connections`.
- Then: Both requests return HTTP 401 with error code `UNAUTHORIZED`.

## ssh-connections-005

- Vitest: "SSH connection routes > creates, normalizes, lists, edits, resets, and deletes without exposing secrets"
- Mode: run
- Given: A signed-in member can encrypt secrets with KMS, and an official Runner is serving a running Run owned by the member.
- When: The member creates a host with padded display name, host `  BÜCHER.Example.  `, padded username, a private key and a passphrase, then reads the summary and list, enables the host as a remote-access default via `PUT /api/remote-access/hosts/ssh/:connectionId/default`, lets the Runner resolve and pin it via `POST /api/runners/runs/:runId/ssh/resolve` and `.../ssh/pin`, then edits name and login, replaces the key, moves the endpoint to `2001:0DB8:0:0::1` port 2222, repins, resets the host key twice via `POST /api/ssh/connections/:connectionId/reset-host-key`, sends a stale update and stale reset, and finally deletes the host with `DELETE /api/ssh/connections/:connectionId`.
- Then: Creation returns HTTP 201 with display name `Production`, host `xn--bcher-kva.example`, port 22, username `deploy`, generation 1, no learned host key, and no private key, passphrase, or `vm0secret:` value. The summary reports `configuredCount: 1` and the list contains exactly the created host. The Runner resolves the original key and passphrase, and pinning returns `pinned` with generation 2. The login edit returns generation 3 and keeps the learned host key; the key replacement returns generation 4, keeps the host key, and the Runner then resolves `replacement\n` with a null passphrase. The endpoint move returns host `2001:db8::1`, port 2222, generation 5 and clears the host key; repinning returns generation 6. The resets return generations 7 and 8 with no host key. The stale update and stale reset at generation 7 return HTTP 409 with a message containing `modified`. Delete returns HTTP 204 and the summary then reports `configuredCount: 0`.

## ssh-connections-006

- Vitest: "SSH connection routes > rejects invalid input before KMS work"
- Mode: run
- Given: A signed-in member can encrypt secrets with KMS.
- When: The member creates hosts with invalid hosts `[::1]`, `example.com:22` and `https://example.com`, then a valid host `EXAMPLE.com.`, then sends a create and a `PATCH /api/ssh/connections/:connectionId` whose private-key credential also includes a `password` field with a canary value.
- Then: Each invalid host returns HTTP 400 with `SSH_INVALID_HOST` and no KMS data key is generated. The valid host returns HTTP 201 with host `example.com` after exactly one KMS data-key generation. Both requests with the extra password field return HTTP 400, their bodies do not contain the canary, and the KMS data-key count stays at 1.

## ssh-connections-007

- Vitest: "SSH connection routes > allows independent logins to share a normalized endpoint on create and update"
- Mode: run
- Given: A signed-in member can encrypt secrets with KMS.
- When: The member creates a host `EXAMPLE.com.` with login `ubuntu`, another host `example.COM` with login `deploy`, and a third host `other.example.com` port 2222, then moves the third host with `PATCH /api/ssh/connections/:connectionId` to `EXAMPLE.com.` port 22, and lists hosts.
- Then: All creates return HTTP 201; the second host is stored as `example.com`, port 22, username `deploy`. The move returns HTTP 200 with the same ID, host `example.com`, port 22, username `deploy`, and generation 2. The list contains exactly the three hosts.

## ssh-connections-008

- Vitest: "SSH connection routes > fails closed across owners without invoking KMS"
- Mode: run
- Given: A signed-in member has created a host (one KMS data-key generation), and another member of the same organization is signed in.
- When: The other member sends `PATCH /api/ssh/connections/:connectionId` with a new credential for the owner's host, then lists hosts.
- Then: The update returns HTTP 404 with message `SSH connection not found`, KMS is not called again (still one data-key generation), and the other member's list is empty.

## ssh-connections-009

- Vitest: "SSH connection routes > rejects a foreign host-key reset sharing the orgId without changing either owner's configuration"
- Mode: run
- Given: An owner has a host, and a peer who shares the owner's organization ID (but has a different user ID) has their own host.
- When: The peer resets the owner's host key with `POST /api/ssh/connections/:connectionId/reset-host-key`, then resets a random unknown connection ID, then both list hosts and the owner resets their own host key.
- Then: The peer's reset of the owner's host returns HTTP 404 with `SSH_CONNECTION_NOT_FOUND`, identical to the response for an unknown ID. Each list shows only that caller's own unchanged host. The owner's reset returns HTTP 200 with the original host at generation 2, and the owner's list then shows that reset host.

## ssh-connections-010

- Vitest: "SSH connection routes > rejects a foreign host-key reset sharing the userId without changing either owner's configuration"
- Mode: run
- Given: An owner has a host, and a peer who shares the owner's user ID (but in a different organization) has their own host.
- When: The peer resets the owner's host key with `POST /api/ssh/connections/:connectionId/reset-host-key`, then resets a random unknown connection ID, then both list hosts and the owner resets their own host key.
- Then: The peer's reset of the owner's host returns HTTP 404 with `SSH_CONNECTION_NOT_FOUND`, identical to the response for an unknown ID. Each list shows only that caller's own unchanged host. The owner's reset returns HTTP 200 with the original host at generation 2, and the owner's list then shows that reset host.

## ssh-connections-011

- Vitest: "SSH connection routes > preserves concurrent configurations for the same endpoint and username"
- Mode: run
- Given: A signed-in member can encrypt secrets with KMS.
- When: The member concurrently sends two `POST /api/ssh/connections` requests for `RACE.example.com` and `race.example.com.` with the same username and different private keys.
- Then: Both creates return HTTP 201, and the list contains exactly those two hosts.

## ssh-connections-012

- Vitest: "SSH connection routes > leaves no visible row when KMS encryption fails"
- Mode: run
- Given: A signed-in member is creating a host while KMS data-key generation fails with "KMS unavailable".
- When: The member sends `POST /api/ssh/connections` for `kms-failure.example.com`, then reads `GET /api/ssh/connections/summary`.
- Then: The create returns HTTP 500 without exposing the KMS error text, KMS was called exactly once, and the summary reports `configuredCount: 0`.
