# global-sweep-contracts

## global-sweep-contracts-001

- Vitest: "production-global sweep route contracts > rejects screenshot cleanup without a valid cron secret"
- Mode: run
- Given: The platform cron secret is configured; one caller sends no authorization header and another presents a different bearer secret.
- When: Each caller requests `GET /api/cron/computer-use-screenshot-cleanup`.
- Then: Both requests receive HTTP 401 with exactly `{ error: { message: "Invalid cron secret", code: "UNAUTHORIZED" } }`.

## global-sweep-contracts-002

- Vitest: "production-global sweep route contracts > rejects X resource cleanup requests without authorization"
- Mode: run
- Given: The platform cron secret is configured and the caller sends no authorization header.
- When: The caller requests `GET /api/cron/cleanup-x-resource-reads`.
- Then: The API responds with HTTP 401 and exactly `{ error: { message: "Invalid cron secret", code: "UNAUTHORIZED" } }`.

## global-sweep-contracts-003

- Vitest: "production-global sweep route contracts > rejects X resource cleanup requests with an invalid cron secret"
- Mode: run
- Given: The platform cron secret is configured and the caller presents a different bearer secret.
- When: The caller requests `GET /api/cron/cleanup-x-resource-reads` with `Authorization: Bearer wrong-secret`.
- Then: The API responds with HTTP 401 and exactly `{ error: { message: "Invalid cron secret", code: "UNAUTHORIZED" } }`.

## global-sweep-contracts-004

- Vitest: "production-global sweep route contracts > keeps snapshots readable as the cursor advances with unchanged and changed content"
- Mode: run
- Given: A signed-in member owns one chat thread titled "Original title", and snapshot storage accepts and serves uploaded archives.
- When: The cron caller runs `GET /api/cron/compact-chat-thread-snapshots` and the member reads `GET /api/chat-threads/snapshot` and downloads it; this repeats after the member creates and deletes a temporary thread, and again after renaming the thread to "Updated title" with `POST /api/chat-threads/:id/rename`.
- Then: The first archive lists exactly the thread with "Original title". After the temporary thread, `latestSeqId` increases but the downloaded archive equals the first. After the rename, `latestSeqId` increases again and the archive lists exactly the thread with "Updated title", while the original snapshot URL still downloads the first archive.

## global-sweep-contracts-005

- Vitest: "production-global sweep route contracts > rejects snapshot compaction requests without authorization"
- Mode: run
- Given: The platform cron secret is configured and the caller sends no authorization header.
- When: The caller requests `GET /api/cron/compact-chat-thread-snapshots`.
- Then: The API responds with HTTP 401 and exactly `{ error: { message: "Invalid cron secret", code: "UNAUTHORIZED" } }`.

## global-sweep-contracts-006

- Vitest: "production-global sweep route contracts > rejects artifact reconciliation without authorization"
- Mode: run
- Given: The platform cron secret is configured and the caller sends no authorization header.
- When: The caller requests `GET /api/cron/reconcile-artifact-catalog`.
- Then: The API responds with HTTP 401 and exactly `{ error: { message: "Invalid cron secret", code: "UNAUTHORIZED" } }`.

## global-sweep-contracts-007

- Vitest: "production-global sweep route contracts > rejects snapshot compaction requests with an invalid cron secret"
- Mode: run
- Given: The platform cron secret is configured and the caller presents a different bearer secret.
- When: The caller requests `GET /api/cron/compact-chat-thread-snapshots` with `Authorization: Bearer wrong-secret`.
- Then: The API responds with HTTP 401 and exactly `{ error: { message: "Invalid cron secret", code: "UNAUTHORIZED" } }`.

## global-sweep-contracts-008

- Vitest: "production-global sweep route contracts > rejects cleanup-sandboxes requests with an invalid cron secret"
- Mode: run
- Given: The platform cron secret is configured and the caller presents a different bearer secret.
- When: The caller requests `GET /api/cron/cleanup-sandboxes` with `Authorization: Bearer wrong-secret`.
- Then: The API responds with HTTP 401 and exactly `{ error: { message: "Invalid cron secret", code: "UNAUTHORIZED" } }`.

## global-sweep-contracts-009

- Vitest: "production-global sweep route contracts > rejects cleanup-sandboxes requests without authorization"
- Mode: run
- Given: The platform cron secret is configured and the caller sends no authorization header.
- When: The caller requests `GET /api/cron/cleanup-sandboxes`.
- Then: The API responds with HTTP 401 and exactly `{ error: { message: "Invalid cron secret", code: "UNAUTHORIZED" } }`.

## global-sweep-contracts-010

- Vitest: "production-global sweep route contracts > rejects connector OAuth cleanup requests without authorization"
- Mode: run
- Given: The platform cron secret is configured and the caller sends no authorization header.
- When: The caller requests `GET /api/cron/connector-oauth-state-cleanup`.
- Then: The API responds with HTTP 401 and exactly `{ error: { message: "Invalid cron secret", code: "UNAUTHORIZED" } }`.

## global-sweep-contracts-011

- Vitest: "production-global sweep route contracts > rejects billing reconciliation requests without authorization"
- Mode: run
- Given: The platform cron secret is configured and the caller sends no authorization header.
- When: The caller requests `GET /api/cron/reconcile-billing-entitlements`.
- Then: The API responds with HTTP 401 and exactly `{ error: { message: "Invalid cron secret", code: "UNAUTHORIZED" } }`.

## global-sweep-contracts-012

- Vitest: "production-global sweep route contracts > rejects email-outbox drain requests without authorization"
- Mode: run
- Given: The platform cron secret is configured and the caller sends no authorization header.
- When: The caller requests `GET /api/cron/drain-email-outbox`.
- Then: The API responds with HTTP 401 and exactly `{ error: { message: "Invalid cron secret", code: "UNAUTHORIZED" } }`.

## global-sweep-contracts-013

- Vitest: "production-global sweep route contracts > rejects sync-skills requests with an invalid cron secret"
- Mode: run
- Given: The platform cron secret is configured and the caller presents a different bearer secret.
- When: The caller requests `GET /api/cron/sync-skills` with `Authorization: Bearer wrong-secret`.
- Then: The API responds with HTTP 401 and exactly `{ error: { message: "Invalid cron secret", code: "UNAUTHORIZED" } }`.

## global-sweep-contracts-014

- Vitest: "production-global sweep route contracts > rejects sync-skills requests without authorization"
- Mode: run
- Given: The platform cron secret is configured and the caller sends no authorization header.
- When: The caller requests `GET /api/cron/sync-skills`.
- Then: The API responds with HTTP 401 and exactly `{ error: { message: "Invalid cron secret", code: "UNAUTHORIZED" } }`.

## global-sweep-contracts-015

- Vitest: "production-global sweep route contracts > rejects workflow automation sweeps without authorization"
- Mode: run
- Given: The platform cron secret is configured and the caller sends no authorization header.
- When: The caller requests `GET /api/cron/execute-workflow-automations`.
- Then: The API responds with HTTP 401 and exactly `{ error: { message: "Invalid cron secret", code: "UNAUTHORIZED" } }`.

## global-sweep-contracts-016

- Vitest: "production-global sweep route contracts > rejects Gmail watch renewal without authorization"
- Mode: run
- Given: The platform cron secret is configured and the caller sends no authorization header.
- When: The caller requests `GET /api/cron/renew-gmail-watches`.
- Then: The API responds with HTTP 401 and exactly `{ error: { message: "Invalid cron secret", code: "UNAUTHORIZED" } }`.
