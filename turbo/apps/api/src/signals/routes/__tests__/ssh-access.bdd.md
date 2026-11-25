# ssh-access

## ssh-access-001

- Vitest: "live chat SSH Run inventory > filters multiple SSH hosts by the Run's chat, current defaults, and sparse overrides"
- Mode: run
- Given: A member has a running chat Run whose Agent token can read SSH hosts, and created two SSH hosts with `POST /api/ssh/connections`. The member later starts a second chat Run in another Thread.
- When: The Run's Agent token lists `GET /api/ssh/hosts` while the member enables the second host's chat default with `PUT /api/remote-access/hosts/ssh/:connectionId/default`, sets a Thread override for the first host with `PUT /api/chat-threads/:threadId/remote-access/ssh/:connectionId`, disables the second host's default, and clears the override with `DELETE /api/chat-threads/:threadId/remote-access/ssh/:connectionId`.
- Then: Initially no hosts are listed. After enabling the default, both Runs list only the second host. With the Thread override, the first Run lists both hosts while the other Thread's Run still lists only the second. After disabling the default the first Run lists only the first host, and after clearing the override it lists none.

## ssh-access-002

- Vitest: "live chat SSH Run inventory > returns creation identities from the same visible inventory and distinguishes recreated IDs"
- Mode: run
- Given: A member has a running chat Run with an Agent token, and created one SSH host with chat access enabled by default.
- When: The Agent token lists `GET /api/ssh/hosts`; the member deletes the host with `DELETE /api/ssh/connections/:connectionId`, recreates one with the same ID via `POST /api/ssh/connections`, and the token lists again before and after enabling the replacement's chat default.
- Then: The first list's identities contain the host ID and generation with a microsecond-precision `createdAt`, and no private key. The delete returns HTTP 204 and the recreate HTTP 201. Before enabling, identities are empty; after enabling, the identity has the same ID but a different `createdAt`.

## ssh-access-003

- Vitest: "live chat SSH Run inventory > keeps first-host and recreated-host chat access default off"
- Mode: run
- Given: A Pro member has a running `claude-fable-5-1` chat Run with an Agent token and no SSH hosts.
- When: The member creates a first SSH host with `POST /api/ssh/connections`, the Agent token lists `GET /api/ssh/hosts`, the member deletes it with `DELETE /api/ssh/connections/:connectionId`, creates a replacement, and the token lists again.
- Then: Creation publishes exactly `ssh:changed` for the organization and `ssh-authority-invalidated` for the Run and connection. Both inventory reads return exactly `{ hosts: [], identities: [] }`, and the delete returns HTTP 204.

## ssh-access-004

- Vitest: "live chat SSH Run inventory > commits concurrent first hosts when best-effort invalidation fails"
- Mode: run
- Given: A member has a running chat Run with an Agent token, and realtime publishing fails.
- When: The member creates two SSH hosts concurrently with `POST /api/ssh/connections`, then lists `GET /api/ssh/connections` and the Agent token lists `GET /api/ssh/hosts`.
- Then: Both creations succeed and the connection list has two entries, while the Run inventory lists no hosts.

## ssh-access-005

- Vitest: "live chat SSH Run inventory > lists both chat-enabled logins at a shared endpoint"
- Mode: run
- Given: A Pro member has a running chat Run with an Agent token. The member created host `ssh.example.com` as `deploy` and host `SSH.example.com.` as `ubuntu`, both with chat access enabled by default.
- When: The Agent token lists `GET /api/ssh/hosts`, the member deletes the first host with `DELETE /api/ssh/connections/:connectionId`, and the token lists again.
- Then: The first list contains exactly both hosts, normalized to `ssh.example.com` on port 22 with their display names, usernames, no learned host key and `ready` availability, and no private key. The delete returns HTTP 204 and the second list contains only the `ubuntu` host.

## ssh-access-006

- Vitest: "live chat SSH Run inventory > uses only the Run owner's hosts across members of the same workspace"
- Mode: run
- Given: Two members share a workspace and each has a running Run. The creator owns `creator.example.com`; the other member owns `user.example.com` with chat access enabled by default. An official Runner serves the member's Run.
- When: The member's Agent token lists `GET /api/ssh/hosts`, and the Runner calls `POST /api/runners/runs/:runId/ssh/resolve` and `POST /api/runners/runs/:runId/ssh/pin` for the member's Run with the member's host and with the creator's host, then repeats resolve and pin for the member's host.
- Then: The inventory lists only the member's host. Resolve returns `resolved` and the first pin returns `pinned` for the member's host. For the creator's host, resolve and pin both return exactly `{ outcome: "unavailable" }`. Afterwards the inventory still lists only the member's host, resolve returns `resolved`, and the repeated pin returns `matched`.

## ssh-access-007

- Vitest: "live chat SSH Run inventory > keeps the Run inventory Agent-token and capability scoped"
- Mode: run
- Given: A member's organization exists and a Run ID is chosen.
- When: `GET /api/ssh/hosts` is called with the member's Clerk session, with an Okou Agent token for the Run without capabilities, and with a Sandbox token for the Run.
- Then: All three requests return HTTP 403.

## ssh-access-008

- Vitest: "live chat SSH Run inventory > rejects completed Runs despite an enabled host default"
- Mode: run
- Given: A member's chat Run completed and its Thread was deleted (the Thread metadata read returns 404). The member then creates an SSH host with chat access enabled by default.
- When: An Okou Agent token for the completed Run with `ssh:read` capability lists `GET /api/ssh/hosts`.
- Then: The Run reads as `completed`, and the inventory request returns HTTP 404.
