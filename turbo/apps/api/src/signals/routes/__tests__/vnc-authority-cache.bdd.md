# vnc-authority-cache

## vnc-authority-cache-001

- Vitest: "VNC authority and revocation > requires exact current Run/Runner/configuration"
- Mode: run
- Given: A Pro member has a running chat Run on an authenticated Runner and a chat-enabled VNC host at generation 1. A second member has their own running Run and host.
- When: The Runner calls `POST /api/runners/runs/:runId/vnc/check` with a direct transport for the exact Run, Runner identity, host and generation 1; then with generation 2; with a different Runner ID; with a newer heartbeat generation; with a random Run ID; and the second Run checks the first member's host.
- Then: Every call returns HTTP 200. The exact check returns `{ outcome: "valid" }`, the generation-2 check returns `{ outcome: "configuration_changed" }`, and the wrong Runner ID, wrong heartbeat generation, unknown Run and other owner's Run each return `{ outcome: "unavailable" }`.

## vnc-authority-cache-002

- Vitest: "VNC authority and revocation > delivers host changes only to the exact owner/connection and refuses stale generations"
- Mode: run
- Given: Two Pro members each have a running chat Run with a chat-enabled VNC host.
- When: The first member renames their host via `PATCH /api/vnc/connections/:connectionId` with `expectedGeneration: 1`, the Runner checks the host, the member sends another update with stale `expectedGeneration: 1`, then deletes the host with `expectedGeneration: 2`, and the Runner checks at generation 2.
- Then: The rename returns HTTP 200 and publishes exactly one `vnc-authority-invalidated` notification with the first Run ID and host ID, and no `ssh-authority-invalidated` publication. The next check returns `configuration_changed`. The stale update returns HTTP 409 with no notification. The deletion returns HTTP 204 and publishes exactly one `vnc-authority-invalidated` notification for that Run and host, after which the check returns `unavailable`. Both members' Runs still read back as `running`.

## vnc-authority-cache-003

- Vitest: "VNC authority and revocation > revokes current credential references and preserves unrelated connections"
- Mode: run
- Given: A Pro member has a running chat Run with a chat-enabled VNC host using a saved VNC credential. The member creates a second host linked to the same saved credential and a third host with its own credential.
- When: The member rotates the saved credential's password via `PATCH /api/vnc/credentials/:credentialId` with `expectedRevision: 1`, then the Runner checks the original host at generation 1 and at generation 2 via `POST /api/runners/runs/:runId/vnc/check`.
- Then: The rotation returns HTTP 200 and publishes exactly two `vnc-authority-invalidated` notifications, one for the original host and one for the linked host, both for the Run. The generation-1 check returns `configuration_changed` and the generation-2 check returns `valid`.

## vnc-authority-cache-004

- Vitest: "VNC authority and revocation > a publication failure preserves the committed host change and current admission refusal"
- Mode: run
- Given: A Pro member has a running chat Run with a chat-enabled VNC host at generation 1, and the realtime service rejects every publication.
- When: The member renames the host via `PATCH /api/vnc/connections/:connectionId` with `expectedGeneration: 1`, and the Runner checks at generation 1 and at generation 2.
- Then: The rename returns HTTP 200. The generation-1 check returns `configuration_changed` and the generation-2 check returns `valid`.
