# uploads-complete

## uploads-complete-001

- Vitest: "POST /api/uploads/complete > records a private artifact from an agent run in the catalog with its authenticated URL"
- Mode: run
- Given: A member with a Pro entitlement has a chat-thread Run in progress and an Okou agent token with `file:write` for that Run. The agent prepared a `private-report.md` artifact upload (`text/markdown; charset=utf-8`, 1234 bytes) through `POST /api/uploads/prepare`, and storage reports the object with that size and type.
- When: The agent calls `POST /api/uploads/complete` with the prepared ID, and the member reads `GET /api/artifacts/catalog?kind=file` and the artifact's catalog entry.
- Then: Completion returns HTTP 200 with the prepared URL and the markdown content type. The catalog lists `private-report.md`, and its detail shows a file with the prepared URL, filename and content type.

## uploads-complete-002

- Vitest: "POST /api/uploads/complete > completes a run-scoped upload after the object exists"
- Mode: run
- Given: A member with a Pro entitlement has a Run and an Okou agent token with `file:write`; storage holds `report.pdf` (1234 bytes) for a new file ID.
- When: The agent calls `POST /api/uploads/complete` with that file ID.
- Then: The API responds with HTTP 200 with the file ID, filename `report.pdf`, content type `application/pdf` and size 1234.

## uploads-complete-003

- Vitest: "POST /api/uploads/complete > completes and catalogs an upload when realtime is unavailable"
- Mode: run
- Given: A member with a Pro entitlement has a chat-thread Run and an Okou agent token with `file:write`; storage holds `realtime-independent.pdf`, and realtime publishing fails.
- When: The agent calls `POST /api/uploads/complete` with that file ID, and the member lists `GET /api/artifacts/catalog?kind=file`.
- Then: Completion returns HTTP 200 with the file ID, filename, `application/pdf` and size 1234, and the catalog contains `realtime-independent.pdf`.

## uploads-complete-004

- Vitest: "POST /api/uploads/complete > associates completed-run uploads with their owning thread and retains files after thread deletion"
- Mode: run
- Given: An entitled member's chat Run has already completed successfully, and an Okou agent token with `file:write` still references that Run. Storage holds `completed-run.pdf` and, later, `deleted-thread.pdf`.
- When: The agent completes `completed-run.pdf` via `POST /api/uploads/complete`, the member reads the catalog filtered by the Run's thread, deletes the thread, and the agent completes `deleted-thread.pdf`.
- Then: Both completions return HTTP 200 with their file IDs and filenames. The thread-filtered catalog contains `completed-run.pdf`, and after thread deletion the member's file catalog contains both `completed-run.pdf` and `deleted-thread.pdf`.

## uploads-complete-005

- Vitest: "POST /api/uploads/complete > completes an ordinary session upload without a run artifact association"
- Mode: run
- Given: A signed-in member (no Run) and storage holding `plain.txt` of 5 bytes for a new file ID.
- When: The member calls `POST /api/uploads/complete` with that file ID.
- Then: The response contains the file ID, filename `plain.txt` and size 5.

## uploads-complete-006

- Vitest: "POST /api/uploads/complete > keeps legacy v2 objects without a layout marker on the legacy CDN"
- Mode: run
- Given: A member's Run agent token has `file:write`, and storage holds a legacy v2 artifact key for `财务 报告.pdf` (17 bytes, `application/pdf`) without a brand layout marker.
- When: The agent calls `POST /api/uploads/complete` with that file ID.
- Then: The API responds with HTTP 200 with the file ID, filename `财务 报告.pdf`, `application/pdf`, size 17, and a URL on the legacy CDN `https://cdn.vm7.io/<key>`.

## uploads-complete-007

- Vitest: "POST /api/uploads/complete > resolves the CDN from the immutable object layout marker"
- Mode: run
- Given: A member's Run agent token has `file:write`. The member prepared `okou-report.pdf` without an organization, and storage holds the object with the `okou` brand layout marker.
- When: The agent calls `POST /api/uploads/complete` with the prepared ID.
- Then: The API responds with HTTP 200 with the prepared ID, filename `okou-report.pdf`, and a short URL matching `https://a.okou.io/<10 chars>.pdf`.

## uploads-complete-008

- Vitest: "POST /api/uploads/complete > keeps completion idempotent while an Okou artifact adopts its short URL"
- Mode: run
- Given: A member's Run agent token has `file:write`, and an Okou-branded prepared upload `okou-cutover.pdf` exists in storage. The public artifacts base URL is first `https://cdn.okou.io`, then switched to `https://a.okou.io`.
- When: The agent calls `POST /api/uploads/complete` for the same file before and after the base URL switch.
- Then: Both calls return HTTP 200; the first URL matches `https://cdn.okou.io/artifacts/<10 chars>.pdf` and the second matches the short `https://a.okou.io/<10 chars>.pdf`.

## uploads-complete-009

- Vitest: "POST /api/uploads/complete > preserves recognized complete content type text/csv"
- Mode: run
- Given: Row `text/csv`. A member's Run agent token has `file:write`, and storage holds `data.bin` (9 bytes).
- When: The agent calls `POST /api/uploads/complete` with that file ID and `contentType: text/csv`.
- Then: The API responds with HTTP 200 with filename `data.bin` and content type `text/csv`.

## uploads-complete-010

- Vitest: "POST /api/uploads/complete > preserves recognized complete content type Text/Markdown; Charset=\"UTF-8\""
- Mode: run
- Given: Row `Text/Markdown; Charset="UTF-8"`. A member's Run agent token has `file:write`, and storage holds `data.bin` (9 bytes).
- When: The agent calls `POST /api/uploads/complete` with that file ID and `contentType: Text/Markdown; Charset="UTF-8"`.
- Then: The API responds with HTTP 200 with filename `data.bin` and the normalized content type `text/markdown; charset=utf-8`.

## uploads-complete-011

- Vitest: "POST /api/uploads/complete > infers audio content type from uploaded filename"
- Mode: run
- Given: A member's Run agent token has `file:write`, and storage holds `clip.mp3` (2048 bytes).
- When: The agent calls `POST /api/uploads/complete` with that file ID and no content type.
- Then: The API responds with HTTP 200 with filename `clip.mp3`, content type `audio/mpeg` and size 2048.

## uploads-complete-012

- Vitest: "POST /api/uploads/complete > is idempotent for repeated completion calls for the same run file"
- Mode: run
- Given: A member's Run agent token has `file:write`, and storage holds `retry.txt` (7 bytes).
- When: The agent calls `POST /api/uploads/complete` twice with the same file ID.
- Then: Both calls return HTTP 200 and the second response body equals the first.

## uploads-complete-013

- Vitest: "POST /api/uploads/complete > acknowledges a late upload after its run root was deleted"
- Mode: run
- Given: A member's Run agent token has `file:write` and storage holds `late.txt` (11 bytes); the member has cancelled the Run and deleted its thread.
- When: The agent calls `POST /api/uploads/complete` with that file ID.
- Then: The API responds with HTTP 200 with the file ID, filename `late.txt` and size 11.

## uploads-complete-014

- Vitest: "POST /api/uploads/complete > returns 404 when the uploaded object cannot be found"
- Mode: run
- Given: A member's Run agent token has `file:write`, and storage has no object for the requested file ID.
- When: The agent calls `POST /api/uploads/complete` with that file ID.
- Then: The API responds with HTTP 404 `NOT_FOUND` "Uploaded file not found".

## uploads-complete-015

- Vitest: "POST /api/uploads/complete > rejects suspended orgs before completing the upload"
- Mode: run
- Given: A signed-in member's organization has an unfunded Pro subscription that is suspended.
- When: The member calls `POST /api/uploads/complete` with a file ID.
- Then: The API responds with HTTP 402 and error code `INSUFFICIENT_CREDITS`.

## uploads-complete-016

- Vitest: "POST /api/uploads/complete > returns 401 when the request is unauthenticated"
- Mode: run
- Given: No authentication.
- When: The caller calls `POST /api/uploads/complete` with a file ID.
- Then: The API responds with HTTP 401 `UNAUTHORIZED` "Not authenticated".

## uploads-complete-017

- Vitest: "POST /api/uploads/complete > returns 403 for an agent token without file:write capability"
- Mode: run
- Given: An org admin's Okou agent token has only the `file:read` capability.
- When: The agent calls `POST /api/uploads/complete` with a file ID.
- Then: The API responds with HTTP 403 `FORBIDDEN` with a message mentioning `file:write`.

## uploads-complete-018

- Vitest: "POST /api/uploads/complete > falls back to a generic complete content type for unrecognized MIME values"
- Mode: run
- Given: A signed-in member and storage holding `capture.custom` (10 bytes).
- When: The member calls `POST /api/uploads/complete` with that file ID and `contentType: application/x-custom`.
- Then: The response contains filename `capture.custom`, content type `application/octet-stream` and size 10.
