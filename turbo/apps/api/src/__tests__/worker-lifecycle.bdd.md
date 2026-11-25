# worker-lifecycle

## worker-lifecycle-001

- Vitest: "serves DB-backed foreground writes through response EOF and a subsequent Worker request"
- Mode: run
- Intent: review
- Given: A signed-in member of a workspace calls the API through the Cloudflare Worker entrypoint, which reaches the real database through its Hyperdrive binding.
- When: The member creates a thread with `POST /api/chat-threads` titled "Worker foreground", reads the response to the end, and then sends a separate Worker request `GET /api/chat-threads/:id/metadata`.
- Then: Creation returns HTTP 201 with the title, the metadata read returns HTTP 200 with the same thread ID and title, and no background work registered with the Worker host fails.

## worker-lifecycle-002

- Vitest: "continues admitted export DB work after response eof while a concurrent request finishes"
- Mode: run
- Intent: review
- Given: A signed-in member calling through the Worker entrypoint owns a thread titled "Export via eof". The export storage holds its first document write until released.
- When: The member sends `POST /api/user/export`, reads the response body to the end while the export is held, another Worker request creates a thread, the storage write is released, and an observer then calls `GET /api/user/export`.
- Then: The export request returns HTTP 202 with a job ID and a `pending` or `running` status. The Worker's background work settles without failures, the later read returns HTTP 200 with the job `running` or `completed`, and the stored export documents contain "Export via eof".

## worker-lifecycle-003

- Vitest: "continues admitted export DB work after response cancel while a concurrent request finishes"
- Mode: run
- Intent: review
- Given: A signed-in member calling through the Worker entrypoint owns a thread titled "Export via cancel". The export storage holds its first document write until released.
- When: The member sends `POST /api/user/export` and cancels the response body while the export is held, another Worker request creates a thread, the storage write is released, and an observer then calls `GET /api/user/export`.
- Then: The export request returns HTTP 202. The Worker's background work settles without failures, the later read returns HTTP 200 with the job `running` or `completed`, and the stored export documents contain "Export via cancel".

## worker-lifecycle-004

- Vitest: "completes admitted foreground upload after the HTTP caller disconnects"
- Mode: run
- Intent: review
- Given: A signed-in member calls through the Worker entrypoint. S3 reports the object as absent and holds the multipart-upload creation until released, then returns upload ID `owned-worker-upload`.
- When: The member sends `POST /api/uploads/prepare` for a 6 MiB multipart `foreground.txt`, disconnects (aborts the request) while S3 is still creating the upload, another Worker request creates a thread, and S3 is released.
- Then: The prepare request still completes with HTTP 200 and `multipart.uploadId` `owned-worker-upload`, background work settles without failures, and the API never aborts the multipart upload.

## worker-lifecycle-005

- Vitest: "retains the publicly accepted export job after a background provider receipt fails"
- Mode: run
- Intent: review
- Given: A signed-in member calling through the Worker entrypoint owns a thread. The export storage write fails with "S3 receipt unavailable" after being held.
- When: The member sends `POST /api/user/export`, the storage write is released and fails, and an observer then calls `GET /api/user/export` and `POST /api/user/export` again.
- Then: The first request returns HTTP 202 with a job ID and Worker background work settles without failures. The read returns HTTP 200 with the same job ID in `pending` status and `canExport: false`, and the repeated export request returns HTTP 202 with the same job ID and `pending` status.

## worker-lifecycle-006

- Vitest: "uses the certificate binding to call Vertex through the Worker HTTP entrypoint"
- Mode: run
- Intent: review
- Given: A signed-in member has completed onboarding via `POST /api/onboarding/complete` (HTTP 200, `onboardingComplete: true`). The API is configured with a GCP workload identity provider and mTLS certificate chain and no Vercel runtime token; Google STS, IAM impersonation and Vertex voice accept the expected tokens. The first Worker caller has a `GCP_MTLS` certificate binding; a later caller has none.
- When: The member sends `POST /api/voice-io/polish/segments` twice through the Worker with the binding, then once through a Worker without the binding.
- Then: The first request returns HTTP 200 with `text` "Synthetic worker dictation." after STS receives a token-exchange request with the provider audience, cloud-platform scope, mTLS subject token type and the certificate chain, and impersonation and Vertex receive the exchanged bearer tokens. The second request returns HTTP 200 reusing the credential, and the call without a binding returns HTTP 503 with `NOT_CONFIGURED`; the certificate binding is used exactly once overall.
