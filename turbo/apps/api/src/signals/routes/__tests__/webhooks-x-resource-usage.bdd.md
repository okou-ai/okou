# webhooks-x-resource-usage

## webhooks-x-resource-usage-001

- Vitest: "X daily resource usage webhook > validates the originating Run identity"
- Mode: run
- Given: Two Runs of a Pro-entitled org member are executing on a Runner, each with its own sandbox token. The first Run has already reported an `x-resource-v1` observation for a shared X post ID, and is then cancelled and read back with HTTP 200.
- When: The first Run's sandbox token submits a fresh post ID observation to `POST /api/webhooks/run/usage-event` with the second Run's `runId`; then the second Run submits an observation for both the shared and the fresh post IDs with its own token.
- Then: The mismatched Run identity returns HTTP 401. The second Run's own submission of both IDs returns HTTP 200.

## webhooks-x-resource-usage-002

- Vitest: "X daily resource usage webhook > rolls back a whole mixed batch when a source UUID belongs to another organization"
- Mode: run
- Given: Two Runs in different organizations are executing. The first Run has reported an `x-resource-v1` observation for one X post ID.
- When: The second Run submits to `POST /api/webhooks/run/usage-event` a batch with a fresh post observation, a count-only `posts.read` event of quantity 5, and the first Run's original observation; then the first Run submits the fresh observation, and the second Run submits a new observation of the same fresh post ID.
- Then: The mixed batch returns HTTP 409. The first Run's later submission of the fresh observation returns HTTP 200, and the second Run's new observation of that ID also returns HTTP 200.

## webhooks-x-resource-usage-003

- Vitest: "X daily resource usage webhook > rejects a source UUID when only its user owner differs"
- Mode: run
- Given: Row `user`. Two Runs are executing for different users in the same organization. The first Run has reported an `x-resource-v1` observation for one X post ID.
- When: The second Run submits that observation together with a fresh post observation to `POST /api/webhooks/run/usage-event`, then the first Run submits the fresh observation.
- Then: The second Run's batch returns HTTP 409, and the first Run's submission of the fresh observation returns HTTP 200.

## webhooks-x-resource-usage-004

- Vitest: "X daily resource usage webhook > rejects a source UUID when only its organization owner differs"
- Mode: run
- Given: Row `organization`. Two Runs are executing for the same user in different organizations. The first Run has reported an `x-resource-v1` observation for one X post ID.
- When: The second Run submits that observation together with a fresh post observation to `POST /api/webhooks/run/usage-event`, then the first Run submits the fresh observation.
- Then: The second Run's batch returns HTTP 409, and the first Run's submission of the fresh observation returns HTTP 200.

## webhooks-x-resource-usage-005

- Vitest: "X daily resource usage webhook > enforces actual streamed bytes with content-length=undefined"
- Mode: run
- Given: Row `content-length` absent. A Run is executing with its sandbox token and has an unsubmitted `x-resource-v1` observation.
- When: The Run streams a valid JSON body padded with trailing whitespace to 256 KiB + 1 byte in 16 KiB chunks to `POST /api/webhooks/run/usage-event` without a `content-length` header, then submits the same observation normally.
- Then: The streamed request returns HTTP 413, and the subsequent normal submission returns HTTP 200.

## webhooks-x-resource-usage-006

- Vitest: "X daily resource usage webhook > enforces actual streamed bytes with content-length=1"
- Mode: run
- Given: Row `content-length: 1`. A Run is executing with its sandbox token and has an unsubmitted `x-resource-v1` observation.
- When: The Run streams a valid JSON body padded with trailing whitespace to 256 KiB + 1 byte in 16 KiB chunks to `POST /api/webhooks/run/usage-event` while declaring `content-length: 1`, then submits the same observation normally.
- Then: The streamed request returns HTTP 413, and the subsequent normal submission returns HTTP 200.

## webhooks-x-resource-usage-007

- Vitest: "X daily resource usage webhook > rejects observations older than the two UTC dates without claiming the identity"
- Mode: run
- Given: Row "older than the two UTC dates". A Run is executing with its sandbox token and has an unsubmitted `x-resource-v1` observation.
- When: The Run submits the observation to `POST /api/webhooks/run/usage-event` with `observedAt` two days in the past, then submits it again with the current time.
- Then: The back-dated submission returns HTTP 400, and the current-time submission of the same identity returns HTTP 200.

## webhooks-x-resource-usage-008

- Vitest: "X daily resource usage webhook > rejects observations ahead of the database clock without claiming the identity"
- Mode: run
- Given: Row "ahead of the database clock". A Run is executing with its sandbox token and has an unsubmitted `x-resource-v1` observation.
- When: The Run submits the observation to `POST /api/webhooks/run/usage-event` with `observedAt` six minutes in the future, then submits it again with the current time.
- Then: The future-dated submission returns HTTP 400, and the current-time submission of the same identity returns HTTP 200.

## webhooks-x-resource-usage-009

- Vitest: "X daily resource usage webhook > rejects observations before this run existed without claiming the identity"
- Mode: run
- Given: Row "before this run existed". A Run is executing with its sandbox token and has an unsubmitted `x-resource-v1` observation.
- When: The Run submits the observation to `POST /api/webhooks/run/usage-event` with `observedAt` six minutes before now (before the Run was created), then submits it again with the current time.
- Then: The early-dated submission returns HTTP 400, and the current-time submission of the same identity returns HTTP 200.
