# cron-snapshot-chat-events

## cron-snapshot-chat-events-001

- Vitest: "cron snapshot chat events > keeps r1 snapshots readable and immutable as failed-run history grows"
- Mode: run
- Given: A signed-in member's chat Run failed with `usage_limit` and a private error string, so the thread history shows a `run.failed` row with the public usage-limit message. Snapshot storage accepts and serves uploaded archives.
- When: The cron caller runs `GET /api/cron/project-chat-event-search` and `GET /api/cron/snapshot-chat-events`, the member reads `GET /api/chat-threads/:threadId/event-snapshot` and downloads it, the cron snapshots again, the member sends a follow-up whose Run also fails with `usage_limit`, and both crons run again before the member reads the snapshot once more.
- Then: The first snapshot URL contains `-r1-` and its NDJSON rows equal the thread's event rows; the repeat snapshot leaves every stored object byte-identical. After the follow-up, the snapshot URL still contains `-r1-` with a higher `lastSeqId`, its text starts with the original archive text, its rows equal the original rows plus the new tail rows, and the original stored objects remain unchanged.

## cron-snapshot-chat-events-002

- Vitest: "cron snapshot chat events > requires the cron secret"
- Mode: run
- Given: The caller sends no authorization header.
- When: The caller requests `GET /api/cron/snapshot-chat-events`.
- Then: The API responds with HTTP 401 and exactly `{ error: { code: "UNAUTHORIZED", message: "Invalid cron secret" } }`.

## cron-snapshot-chat-events-003

- Vitest: "cron snapshot chat events > keeps a surviving archive downloadable during another thread deletion"
- Mode: run
- Given: A member has two threads that each contain the same marker prompt, and the search projection cron has run. Snapshot uploads pause after the first upload begins.
- When: The cron caller starts `GET /api/cron/snapshot-chat-events`, the member deletes the second thread with `DELETE /api/chat-threads/:id` while uploads are paused, uploads resume, and the member reads `GET /api/chat-threads/:threadId/event-snapshot` for both threads.
- Then: The deleted thread's snapshot read returns HTTP 404. The surviving thread's snapshot returns HTTP 200, downloads with HTTP 200, and contains an `input.prompt` event with the marker text.

## cron-snapshot-chat-events-004

- Vitest: "cron snapshot chat events > recovers a downloadable snapshot after an S3 read failure without leaking private diagnostics"
- Mode: run
- Given: A member's thread receives two marker prompts in sequence, with the search projection cron run after each. On the second round, the first storage request of the snapshot cron fails with an AccessDenied error whose message, cause, request ID, and URL contain private context including the thread ID and object keys.
- When: The cron caller runs `GET /api/cron/snapshot-chat-events` (once failing, then again) and the member reads `GET /api/chat-threads/:threadId/event-snapshot` and downloads it after each step.
- Then: The failing cron still returns HTTP 200 and logs a "Skipped Chat Event Snapshot pointer" warning that contains neither the private context nor the thread ID; the snapshot then still serves the previous archive with its prior `lastSeqId` and `lastEventId`. After each successful run, the downloaded rows belong to the thread in increasing `seqId` order, `lastSeqId`/`lastEventId` match the final row, the sequence advances, the earlier rows are a prefix, and the marker prompt is present.
