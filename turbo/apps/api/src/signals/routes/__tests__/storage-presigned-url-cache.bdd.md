# storage-presigned-url-cache

## storage-presigned-url-cache-001

- Vitest: "system storage presigned URL cache > rejects cache pruning with invalid authorization undefined"
- Mode: run
- Given: The cron secret is configured and the caller sends no `authorization` header.
- When: The caller requests `GET /api/cron/prune-storage-presigned-urls`.
- Then: The request returns HTTP 401 with error code `UNAUTHORIZED`.

## storage-presigned-url-cache-002

- Vitest: "system storage presigned URL cache > rejects cache pruning with invalid authorization Bearer wrong"
- Mode: run
- Given: The cron secret is configured and the caller sends `authorization: Bearer wrong`.
- When: The caller requests `GET /api/cron/prune-storage-presigned-urls`.
- Then: The request returns HTTP 401 with error code `UNAUTHORIZED`.

## storage-presigned-url-cache-003

- Vitest: "system storage presigned URL cache > reuses one exact cached URL for a Connector Skill bundle"
- Mode: run
- Given: A signed-in chat user has published a custom Connector with a readonly skill archive and has entered its secret. Each storage signature produces a distinct URL per object.
- When: The user starts two chat Runs with `POST /api/chat/events`; each Run is dispatched to a Runner and then finishes as failed.
- Then: Each Runner execution contains exactly one skill bundle at the Connector's `/home/user/.claude/skills/custom-...` mount path with the published archive size and SHA-256, plus a custom Connector runtime target for the user's connection. Both executions receive the identical bundle entry and download URL, and the archive object is signed only once.

## storage-presigned-url-cache-004

- Vitest: "system storage presigned URL cache > enforces the four-hour readonly archive margin at 14399999 ms remaining"
- Mode: run
- Given: A signed-in chat user has a custom Connector skill archive whose two-day download URL was issued by a first Run. The clock advances until 14,399,999 ms (just under four hours) of that URL's lifetime remain.
- When: The user starts a second and then a third chat Run with `POST /api/chat/events`, each dispatched to a Runner.
- Then: The second Run receives the same bundle with a newly signed URL (second signature for the object) requested with a two-day (`172800` s) expiry. The third Run receives exactly the same bundle and URL as the second.

## storage-presigned-url-cache-005

- Vitest: "system storage presigned URL cache > enforces the four-hour readonly archive margin at 14400000 ms remaining"
- Mode: run
- Given: A signed-in chat user has a custom Connector skill archive whose two-day download URL was issued by a first Run. The clock advances until exactly 14,400,000 ms (four hours) of that URL's lifetime remain.
- When: The user starts a second and then a third chat Run with `POST /api/chat/events`, each dispatched to a Runner.
- Then: The second Run receives the original bundle entry and URL, and the object has still been signed only once. The third Run receives exactly the same bundle and URL.

## storage-presigned-url-cache-006

- Vitest: "system storage presigned URL cache > enforces the four-hour readonly archive margin at 14400001 ms remaining"
- Mode: run
- Given: A signed-in chat user has a custom Connector skill archive whose two-day download URL was issued by a first Run. The clock advances until 14,400,001 ms (just over four hours) of that URL's lifetime remain.
- When: The user starts a second and then a third chat Run with `POST /api/chat/events`, each dispatched to a Runner.
- Then: The second Run receives the original bundle entry and URL, and the object has still been signed only once. The third Run receives exactly the same bundle and URL.

## storage-presigned-url-cache-007

- Vitest: "system storage presigned URL cache > delivers and caches 51 Connector Skill bundles across Runner executions"
- Mode: run
- Given: An entitled user with a direct Runner group has 51 authorized Connectors, each with its own readonly skill archive. Each storage signature produces a distinct URL per object.
- When: The user creates three thread Runs in turn; each is dispatched to the Runner and then cancelled.
- Then: The first execution contains all 51 skill bundles with the expected mount paths, SHA-256 and sizes, each under `/home/user/.claude/skills/` with a distinct path and a `https://r2.example.com` URL for `bundles/v1/<sha256>.tar.gz` at signature 1. The second and third executions receive exactly the same bundles and URLs, and each archive object is signed exactly once in total.

## storage-presigned-url-cache-008

- Vitest: "system storage presigned URL cache > refreshes a hard-expired readonly archive with a new exact URL"
- Mode: run
- Given: A signed-in chat user has a custom Connector skill archive whose two-day download URL was issued by a first Run. The clock advances one minute past the two-day lifetime.
- When: The user starts another chat Run with `POST /api/chat/events`, dispatched to a Runner.
- Then: The Run receives the same bundle entry with a newly signed URL (second signature), and the object has been signed exactly twice.

## storage-presigned-url-cache-009

- Vitest: "content bundle presigned URL cache > issues and reuses two-day URLs for Connector Skill bundles"
- Mode: run
- Given: An entitled user with a direct Runner group has a custom Connector with a skill and has entered its secret.
- When: The user creates a thread Run, it is dispatched to the Runner and cancelled, then the user creates a second thread Run.
- Then: The first execution has the Connector's skill bundle at its `/home/user/.claude/skills/custom-...` mount path, a custom Connector runtime target for the user's connection, and a download URL with `X-Amz-Expires=172800`. The second execution receives the identical download URL.

## storage-presigned-url-cache-010

- Vitest: "content bundle presigned URL cache > reuses complete Content Bundle URLs across claims with unchanged mounts"
- Mode: run
- Given: An entitled user has a Workflow with an attached file, and a direct Runner group is available.
- When: The user sends two chat Runs with `POST /api/chat/events`; each is dispatched to a Runner and cancelled.
- Then: Both executions receive identical content bundles: four skill bundles and an instructions bundle, each with a download URL carrying `X-Amz-Expires=172800`.

## storage-presigned-url-cache-011

- Vitest: "content bundle presigned URL cache > refreshes Content Bundle URLs after 44 hours without renewing cache hits"
- Mode: run
- Given: An entitled user has a Workflow with an attached file, and a direct Runner group is available. The clock starts at a whole second.
- When: The user sends a chat Run, another one 43 hours later, and another 44 hours and one second after the start; each is dispatched to a Runner and cancelled.
- Then: The 43-hour Run receives exactly the original content bundles. The 44-hour Run receives skill bundles with the same SHA-256 values but a different first skill download URL and a different instructions download URL.

## storage-presigned-url-cache-012

- Vitest: "content bundle presigned URL cache > refreshes Content Bundle URLs after 49 hours without renewing cache hits"
- Mode: run
- Given: An entitled user has a Workflow with an attached file, and a direct Runner group is available. The clock starts at a whole second.
- When: The user sends a chat Run, another one 43 hours later, and another 49 hours and one second after the start; each is dispatched to a Runner and cancelled.
- Then: The 43-hour Run receives exactly the original content bundles. The 49-hour Run receives skill bundles with the same SHA-256 values but a different first skill download URL and a different instructions download URL.

## storage-presigned-url-cache-013

- Vitest: "content bundle presigned URL cache > uses the replacement signer's credentials and endpoint instead of cached old URLs"
- Mode: run
- Intent: review
- Given: An entitled user has a Workflow with an attached file, and a direct Runner group is available. The API's storage signing secret is later replaced, and then its storage endpoint is replaced.
- When: The user sends chat Runs before the change, after the secret change, after the endpoint change, and once more; each is dispatched to a Runner and cancelled.
- Then: After the secret change, the first skill bundle keeps its SHA-256 but gets a different download URL. After the endpoint change, it again keeps its SHA-256 with a URL different from the secret-change URL. The final Run receives exactly the same bundles as the endpoint-change Run.

## storage-presigned-url-cache-014

- Vitest: "content bundle presigned URL cache > pins dispatched Workflow URLs and selects later edits for the following Run"
- Mode: run
- Given: An entitled user has a Workflow with an attached file, a direct Runner group is available, and a previous Run already cached the Workflow bundle URLs.
- When: The user queues a chat Run, updates the Workflow content to "# Updated Workflow package" before that Run is dispatched, then the queued Run is dispatched; afterwards the user sends two more chat Runs.
- Then: The queued Run receives the original first skill bundle mount path, SHA-256 and download URL. The next Run receives a first skill bundle with a different SHA-256 and URL, and the following Run receives exactly the same bundles as that updated Run.

## storage-presigned-url-cache-015

- Vitest: "content bundle presigned URL cache > settles a preparation signing failure and caches URLs for a later fresh Run"
- Mode: run
- Given: An entitled user has a Workflow with an attached file and a direct Runner group. The storage signer fails once with "Fixture signer unavailable".
- When: The user sends a chat message with `POST /api/chat/events`; afterwards the user sends two more chat Runs that are dispatched and cancelled.
- Then: The message is accepted with HTTP 201, but background Run preparation fails with "Run execution preparation failed". The thread contains an event revoking the message that references a Run whose status is `failed`, and the Run queue reports zero active Runs. The two later Runs receive identical content bundles.

## storage-presigned-url-cache-016

- Vitest: "content bundle presigned URL cache > retains the newer URL when an older cold signer publishes last"
- Mode: run
- Given: An entitled user has a Workflow with an attached file and a direct Runner group. An older chat Run's first storage signature is delayed.
- When: The user sends the older chat message with `POST /api/chat/events` (accepted with HTTP 201); while its signature is delayed, a newer chat Run sent one second later is dispatched to the Runner and cancelled with `POST /api/runs/:id/cancel`; then the older signature completes and its Run is dispatched and cancelled; finally another Run is sent two seconds after the start and dispatched.
- Then: The older Run receives an instructions bundle URL different from the newer Run's. The final Run reuses the newer Run's instructions download URL.
