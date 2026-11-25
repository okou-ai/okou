# user-export-publication

## user-export-publication-001

- Vitest: "exports PATCH-created drafts with owned thread timestamps and absent draft nulls"
- Mode: run
- Given: A signed-in member owns three chat threads: "Saved draft" with a saved draft message (including "你好") and empty attachments, "No draft" with no draft, and "Cleared draft" whose draft was saved and then cleared to null. A peer in the same workspace has a thread with a saved draft. Export storage is available.
- When: The owner creates the threads via `POST /api/chat-threads`, sets drafts via `PATCH /api/chat-threads/:id`, starts `POST /api/user/export`, then reads `GET /api/user/export` and downloads the ZIP; the peer also reads `GET /api/user/export`.
- Then: The export returns HTTP 202, the status read shows the same job `completed` with no error, and the ZIP is valid with `README.md`, `restore.py` and `export-manifest.json`. The `chat-threads/` folder contains exactly the owner's three thread files, each with the fixed ordered key list (id through draftAttachments), the owner's user and org IDs, title, createdAt, null `sourceScheduleRunId`, `pinnedAt` and `renamedAt`, ISO-8601 `updatedAt`/`lastMessageAt`/`lastReadAt`, and the draft message plus `[]` attachments only for "Saved draft" (null for the other two). The peer's thread is absent and the peer sees no export job.

## user-export-publication-002

- Vitest: "publishes an owned ZIP, deduplicates concurrent requests and excludes peers"
- Mode: run
- Given: A signed-in member owns a private workflow "exported-workflow" and a chat thread "Exported conversation". A same-workspace peer and a member of another workspace also exist. Export storage is available.
- When: The owner sends two concurrent `POST /api/user/export` requests, reads `GET /api/user/export` after processing, downloads the ZIP, the peer and outsider read `GET /api/user/export`, and the owner sends another `POST /api/user/export`.
- Then: Both concurrent requests return HTTP 202 with the same job ID, and the status shows that job `completed` with no error. The ZIP contains `workflows/<id>.json` with the workflow's instruction and `chat-threads/<id>.json` with the thread title. The peer and outsider see no export job. The third export request returns HTTP 429 with error code `RATE_LIMITED`.

## user-export-publication-003

- Vitest: "publishes the exact owned memory bytes committed by a genuine Runner execution"
- Mode: run
- Given: A signed-in member has an authenticated Runner executing one of their runs with a memory storage. The Runner prepares a memory upload for `notes.md`, uploads the archive and manifest bytes to the returned targets, and commits the version. Export storage can read those same objects.
- When: The Runner calls `POST /api/webhooks/run/storages/prepare` and `POST /api/webhooks/run/storages/commit`; the owner then starts `POST /api/user/export`, reads `GET /api/user/export` and downloads the ZIP.
- Then: Prepare and commit return HTTP 200, the export job is `completed`, and the ZIP entry `memory/<orgId>/<storageId>/archive.tar.gz` is byte-for-byte identical to the archive the Runner uploaded.

## user-export-publication-004

- Vitest: "exports completed Runner history across 100-row metadata pages without losing rows"
- Mode: run
- Given: A signed-in member has an authenticated Runner executing one of their runs. Parameter row "100-row metadata pages": the Runner posts 104 assistant text messages of about 36 characters each, three per request (each request body under 4.5 MB), then completes with exit code 0.
- When: The Runner posts `POST /api/webhooks/run/events` batches and `POST /api/webhooks/run/complete`; the owner pages `GET /api/chat-threads/:threadId/event-rows` 50 rows at a time, then starts `POST /api/user/export`, reads `GET /api/user/export` and downloads the ZIP.
- Then: The run reads back as `completed`, the public event rows include every message content in order plus a `run.completed` row with null payload. The export job is `completed` with no error, and the ZIP holds more than one `chat-messages/<threadId>/tail/` page whose parsed rows exactly equal the public event rows, in ascending `seqId` order, with unique IDs, and the first page holds exactly 100 rows.

## user-export-publication-005

- Vitest: "exports completed Runner history across a large multi-byte output and its short… without losing rows"
- Mode: run
- Given: A signed-in member has an authenticated Runner executing one of their runs. Parameter row "a large multi-byte output and its short tail": the Runner posts 2 assistant text messages, the first containing 400,000 "语" characters (about 1.2 MB of UTF-8) and the second a short text, in a request body under 4.5 MB, then completes with exit code 0.
- When: The Runner posts `POST /api/webhooks/run/events` and `POST /api/webhooks/run/complete`; the owner pages `GET /api/chat-threads/:threadId/event-rows` 50 rows at a time, then starts `POST /api/user/export`, reads `GET /api/user/export` and downloads the ZIP.
- Then: The run reads back as `completed`, the public event rows include both message contents in order plus a `run.completed` row with null payload. The export job is `completed` with no error, and the ZIP holds more than one `chat-messages/<threadId>/tail/` page whose parsed rows exactly equal the public event rows, in ascending `seqId` order, with unique IDs.

## user-export-publication-006

- Vitest: "recovers the owner's private Instructions export after an S3 failure without an owner retry"
- Mode: run
- Given: A signed-in member saved personal Instructions "Personal export" and a same-workspace peer saved "Peer private content". Export storage keeps the first written object but its first upload acknowledgement fails with a 503 `ServiceUnavailable`. The cron secret is configured.
- When: The owner starts `POST /api/user/export` once and reads `GET /api/user/export`; the scheduler then repeatedly calls `GET /api/cron/process-background-jobs` with the cron bearer secret until the owner's job completes; the owner downloads the ZIP and the peer reads `GET /api/user/export`.
- Then: The start returns HTTP 202 and exactly one storage failure occurs, after which the HTTP 200 read shows the same job ID in `pending` or `running` with no download URL. Each cron call returns HTTP 200, and background processing later completes the same job with no error without another owner request. The download is a valid ZIP with `README.md`, `restore.py` and `export-manifest.json`, and its only `instructions/` entry is `instructions/<orgId>.json`, holding the owner's user ID, org ID and content "Personal export". The peer sees no export job.
