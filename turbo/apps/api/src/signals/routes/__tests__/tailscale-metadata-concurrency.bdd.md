# tailscale-metadata-concurrency

## tailscale-metadata-concurrency-001

- Vitest: "atomically commits one competing effective credentials edit with every retained Host generation"
- Mode: run
- Given: An organization admin has a shared Tailscale config (tags `tag:prod`, `tag:ci`) used by two of the admin's SSH hosts; the config list shows both hosts without a revision change.
- When: The admin sends two concurrent identical `PATCH /api/tailscale/configs/:configId` requests at the current revision that replace the OAuth credentials.
- Then: One returns HTTP 200 with revision +1, generation +1, unchanged tags and both hosts listed; the other returns HTTP 409 with `TAILSCALE_REVISION_CONFLICT`. The config list shows exactly the winning state. Both hosts are otherwise unchanged with generation +1 and a shared `updatedAt` no earlier than their previous timestamps.

## tailscale-metadata-concurrency-002

- Vitest: "atomically commits one competing effective tag addition edit with every retained Host generation"
- Mode: run
- Given: An organization admin has a shared Tailscale config (tags `tag:prod`, `tag:ci`) used by two of the admin's SSH hosts; the config list shows both hosts without a revision change.
- When: The admin sends two concurrent identical `PATCH /api/tailscale/configs/:configId` requests at the current revision that set the tags to `tag:prod`, `tag:ci`, `tag:ops`.
- Then: One returns HTTP 200 with the three tags, revision +1, generation +1 and both hosts listed; the other returns HTTP 409 with `TAILSCALE_REVISION_CONFLICT`. The config list shows exactly the winning state. Both hosts are otherwise unchanged with generation +1 and a shared `updatedAt` no earlier than their previous timestamps.

## tailscale-metadata-concurrency-003

- Vitest: "atomically commits one competing effective tag removal edit with every retained Host generation"
- Mode: run
- Given: An organization admin has a shared Tailscale config (tags `tag:prod`, `tag:ci`) used by two of the admin's SSH hosts; the config list shows both hosts without a revision change.
- When: The admin sends two concurrent identical `PATCH /api/tailscale/configs/:configId` requests at the current revision that set the tags to only `tag:prod`.
- Then: One returns HTTP 200 with tags `tag:prod`, revision +1, generation +1 and both hosts listed; the other returns HTTP 409 with `TAILSCALE_REVISION_CONFLICT`. The config list shows exactly the winning state. Both hosts are otherwise unchanged with generation +1 and a shared `updatedAt` no earlier than their previous timestamps.

## tailscale-metadata-concurrency-004

- Vitest: "commits only one concurrent name edit for the same revision and returns its decoded state"
- Mode: run
- Given: An organization admin has a shared Tailscale config named "Shared private network" with tags `tag:prod`, `tag:ci`.
- When: The admin sends two concurrent identical `PATCH /api/tailscale/configs/:configId` requests at the current revision renaming it to "Renamed private network".
- Then: One returns HTTP 200 with the new name, revision +1 and an unchanged generation; the other returns HTTP 409 with `TAILSCALE_REVISION_CONFLICT`. The config list shows exactly the winning state.

## tailscale-metadata-concurrency-005

- Vitest: "commits only one concurrent tag order edit for the same revision and returns its decoded state"
- Mode: run
- Given: An organization admin has a shared Tailscale config named "Shared private network" with tags `tag:prod`, `tag:ci`.
- When: The admin sends two concurrent identical `PATCH /api/tailscale/configs/:configId` requests at the current revision reordering the tags to `tag:ci`, `tag:prod`.
- Then: One returns HTTP 200 with the reordered tags, revision +1 and an unchanged generation; the other returns HTTP 409 with `TAILSCALE_REVISION_CONFLICT`. The config list shows exactly the winning state.

## tailscale-metadata-concurrency-006

- Vitest: "updates name alongside host editing and selected binding without exposing another owner's hosts"
- Mode: run
- Given: An organization admin has a shared Tailscale config with one of their own SSH hosts, and a regular member of the organization has their own host on the same config.
- When: The admin concurrently renames the config via `PATCH /api/tailscale/configs/:configId`, renames their own host via `PATCH /api/ssh/connections/:connectionId`, and creates a new host bound to the config with their existing login via `POST /api/ssh/connections`.
- Then: The config update returns HTTP 200 with revision +1 and unchanged generation; its host list includes the admin's host and only references the admin's own hosts. The host edit returns HTTP 200 with generation +1 and unchanged host, port, login, host key and Tailscale transport, matching the stored host. The new host (HTTP 201) is stored as returned, and the member's host is unchanged.

## tailscale-metadata-concurrency-007

- Vitest: "updates tag order alongside host editing and selected binding without exposing another owner's hosts"
- Mode: run
- Given: An organization admin has a shared Tailscale config with one of their own SSH hosts, and a regular member of the organization has their own host on the same config.
- When: The admin concurrently reorders the config's tags via `PATCH /api/tailscale/configs/:configId`, renames their own host via `PATCH /api/ssh/connections/:connectionId`, and creates a new host bound to the config with their existing login via `POST /api/ssh/connections`.
- Then: The config update returns HTTP 200 with revision +1 and unchanged generation; its host list includes the admin's host and only references the admin's own hosts. The host edit returns HTTP 200 with generation +1 and unchanged host, port, login, host key and Tailscale transport, matching the stored host. The new host (HTTP 201) is stored as returned, and the member's host is unchanged.

## tailscale-metadata-concurrency-008

- Vitest: "preserves winning-Runner pin and observation authority during a concurrent name update"
- Mode: run
- Given: An organization admin has a shared Tailscale config with an SSH host enabled as a remote-access default, and an official Runner is executing the admin's Run.
- When: The admin renames the config via `PATCH /api/tailscale/configs/:configId` while the Runner concurrently pins an observed host key via `POST /api/runners/runs/:runId/ssh/pin`; then the Runner records an observation via `POST /api/runners/runs/:runId/ssh/observations` at the current generation.
- Then: The config update returns HTTP 200 with unchanged generation. The pin returns `pinned` with generation +1, and the host shows that generation, the learned host key and unchanged endpoint, login and Tailscale transport. The observation returns `recorded`.

## tailscale-metadata-concurrency-009

- Vitest: "preserves winning-Runner pin and observation authority during a concurrent tag order update"
- Mode: run
- Given: An organization admin has a shared Tailscale config with an SSH host enabled as a remote-access default, and an official Runner is executing the admin's Run.
- When: The admin reorders the config's tags via `PATCH /api/tailscale/configs/:configId` while the Runner concurrently pins an observed host key via `POST /api/runners/runs/:runId/ssh/pin`; then the Runner records an observation via `POST /api/runners/runs/:runId/ssh/observations` at the current generation.
- Then: The config update returns HTTP 200 with unchanged generation. The pin returns `pinned` with generation +1, and the host shows that generation, the learned host key and unchanged endpoint, login and Tailscale transport. The observation returns `recorded`.

## tailscale-metadata-concurrency-010

- Vitest: "rejects a credential replacement prepared before a name update without changing host authority"
- Mode: run
- Given: An organization admin has a shared Tailscale config with an SSH host. A credential replacement for the config is stalled while KMS encrypts the new secret.
- When: While the replacement is stalled, the admin renames the config via `PATCH /api/tailscale/configs/:configId` at the same revision; then the replacement completes.
- Then: The rename returns HTTP 200 with revision +1 and unchanged generation, after exactly one KMS data-key generation. The credential replacement returns HTTP 409 with `TAILSCALE_REVISION_CONFLICT`, and the host is unchanged.

## tailscale-metadata-concurrency-011

- Vitest: "rejects a credential replacement prepared before a tag order update without changing host authority"
- Mode: run
- Given: An organization admin has a shared Tailscale config with an SSH host. A credential replacement for the config is stalled while KMS encrypts the new secret.
- When: While the replacement is stalled, the admin reorders the config's tags via `PATCH /api/tailscale/configs/:configId` at the same revision; then the replacement completes.
- Then: The reorder returns HTTP 200 with revision +1 and unchanged generation, after exactly one KMS data-key generation. The credential replacement returns HTTP 409 with `TAILSCALE_REVISION_CONFLICT`, and the host is unchanged.

## tailscale-metadata-concurrency-012

- Vitest: "invalidates reviewed convert impact after a name update and keeps shared management admin-only"
- Mode: run
- Given: An organization admin has a shared Tailscale config, and a regular member has an SSH host on it. The admin has reviewed `GET /api/tailscale/configs/:configId/impact-preview?operation=convert`.
- When: The admin renames the config, then sends `POST /api/tailscale/configs/:configId/convert-to-personal` with the reviewed revision and impact snapshot; the member then tries to rename the config.
- Then: The rename returns HTTP 200 with revision +1, unchanged generation and no admin-visible hosts. The conversion returns HTTP 409. The member's rename returns HTTP 403, the member's host is unchanged, and the member's config list shows the updated config with their host.

## tailscale-metadata-concurrency-013

- Vitest: "invalidates reviewed delete impact after a name update and keeps shared management admin-only"
- Mode: run
- Given: An organization admin has a shared Tailscale config, and a regular member has an SSH host on it. The admin has reviewed `GET /api/tailscale/configs/:configId/impact-preview?operation=delete`.
- When: The admin renames the config, then sends `DELETE /api/tailscale/configs/:configId` with the reviewed revision and impact snapshot; the member then tries to rename the config.
- Then: The rename returns HTTP 200 with revision +1, unchanged generation and no admin-visible hosts. The delete returns HTTP 409. The member's rename returns HTTP 403, the member's host is unchanged, and the member's config list shows the updated config with their host.

## tailscale-metadata-concurrency-014

- Vitest: "invalidates reviewed convert impact after a tag order update and keeps shared management admin-only"
- Mode: run
- Given: An organization admin has a shared Tailscale config, and a regular member has an SSH host on it. The admin has reviewed `GET /api/tailscale/configs/:configId/impact-preview?operation=convert`.
- When: The admin reorders the config's tags, then sends `POST /api/tailscale/configs/:configId/convert-to-personal` with the reviewed revision and impact snapshot; the member then tries to reorder the tags.
- Then: The reorder returns HTTP 200 with revision +1, unchanged generation and no admin-visible hosts. The conversion returns HTTP 409. The member's update returns HTTP 403, the member's host is unchanged, and the member's config list shows the updated config with their host.

## tailscale-metadata-concurrency-015

- Vitest: "invalidates reviewed delete impact after a tag order update and keeps shared management admin-only"
- Mode: run
- Given: An organization admin has a shared Tailscale config, and a regular member has an SSH host on it. The admin has reviewed `GET /api/tailscale/configs/:configId/impact-preview?operation=delete`.
- When: The admin reorders the config's tags, then sends `DELETE /api/tailscale/configs/:configId` with the reviewed revision and impact snapshot; the member then tries to reorder the tags.
- Then: The reorder returns HTTP 200 with revision +1, unchanged generation and no admin-visible hosts. The delete returns HTTP 409. The member's update returns HTTP 403, the member's host is unchanged, and the member's config list shows the updated config with their host.
