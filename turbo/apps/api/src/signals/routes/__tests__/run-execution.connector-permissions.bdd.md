# run-execution.connector-permissions

## run-execution.connector-permissions-001

- Vitest: "uses current permission definitions after publication with a warm execution cache"
- Mode: run
- Given: A member entitled to native chat has connected Figma with an API token. The connector catalog is published through the cron route with Figma's default policy allowing `file_content:read`; Run preparation data is already warm.
- When: The cron calls `GET /api/cron/sync-connector-catalog` with the cron secret to publish the catalog, the member runs a chat, queues another, a new catalog content adds `file_comments:read`, removes Figma's default allowances and sets the unknown policy to `ask`, the catalog is published again, and the queued Run launches.
- Then: Each publication returns HTTP 200 with outcome `accepted` and no failure code. The first Run's Figma policy allows only `file_content:read` with unknown policy `allow`. The queued Run uses the new definitions: it denies `file_comments:read` and `file_content:read`, allows nothing, has unknown policy `ask`, and has no Figma policy refresh.

## run-execution.connector-permissions-002

- Vitest: "Execution connector permissions > applies a add grant change made after the Run was queued"
- Mode: run
- Given: A member entitled to native chat has connected GitHub through OAuth and has no custom GitHub permission grants.
- When: The member runs and cancels a chat Run, queues another, then denies `user:read` for GitHub via `PUT /api/connector-permissions`, and the queued Run launches.
- Then: The launched Run targets the GitHub connector and its network policy denies `user:read` and does not allow it, while still allowing `notifications:read`.

## run-execution.connector-permissions-003

- Vitest: "Execution connector permissions > applies a revoke grant change made after the Run was queued"
- Mode: run
- Given: A member entitled to native chat has connected GitHub through OAuth and has denied `user:read` for GitHub.
- When: The member runs and cancels a chat Run, queues another, then replaces GitHub's grants with an empty list via `PUT /api/connector-permissions`, and the queued Run launches.
- Then: The launched Run targets the GitHub connector and its network policy allows `user:read` and does not deny it, while still allowing `notifications:read`.

## run-execution.connector-permissions-004

- Vitest: "Execution connector permissions > evaluates the captured permission source and temporary deadline: active"
- Mode: run
- Given: A member entitled to native chat has connected Slack through OAuth and has a temporary one-hour `allow` grant for `chat:write`.
- When: The member runs and cancels a Run, queues another, the clock advances 30 minutes, and the queued Run launches; later, at the grant's expiry, the Runner syncs Slack's connector runtime via `POST /api/runners/runs/:runId/connector-runtime/sync`.
- Then: The launched Run allows `chat:write` and carries a Slack policy refresh at the grant's expiry time. At expiry, the connector runtime sync reports Slack as `available` with `chat:write` denied and not allowed.

## run-execution.connector-permissions-005

- Vitest: "Execution connector permissions > evaluates the captured permission source and temporary deadline: expired-before-preparation"
- Mode: run
- Given: A member entitled to native chat has connected Slack through OAuth and has a temporary one-hour `allow` grant for `chat:write`.
- When: The member runs and cancels a Run, queues another, the clock advances to the grant's expiry, and the queued Run launches.
- Then: The launched Run's Slack policy does not allow `chat:write`, denies it, and has no policy refresh.

## run-execution.connector-permissions-006

- Vitest: "Execution connector permissions > evaluates the captured permission source and temporary deadline: expired-during-memory-signing"
- Mode: run
- Given: A member entitled to native chat has connected Slack through OAuth with a temporary one-hour `allow` grant for `chat:write`, and has published personal Memory from an earlier Run. The grant expires exactly while the Memory archive URL is being signed for the next Run.
- When: The member starts a new Run one millisecond before the grant expires.
- Then: The earlier writer Run allowed `chat:write`. The new Run hydrates the published Memory version with an archive URL, the clock is at expiry, and the Run's Slack policy does not allow `chat:write`, denies it, and has no policy refresh.

## run-execution.connector-permissions-007

- Vitest: "Execution connector permissions > evaluates the captured permission source and temporary deadline: expired-during-bundle-signing"
- Mode: run
- Given: A member entitled to native chat has connected Slack through OAuth with a temporary one-hour `allow` grant for `chat:write`, and has changed personal instructions so a fresh bundle is needed. The grant expires exactly while the bundle URL is being signed.
- When: The member sends a chat message one millisecond before the grant expires.
- Then: The clock is at expiry when the Run is prepared, and the Run's Slack policy does not allow `chat:write`, denies it, and has no policy refresh.
