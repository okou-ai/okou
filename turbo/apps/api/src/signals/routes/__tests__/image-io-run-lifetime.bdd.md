# image-io-run-lifetime

## image-io-run-lifetime-001

- Vitest: "keeps the lifetime limit after the fiftieth image is completed"
- Mode: run
- Given: A Pro member's running Run (20,000 plan credits, no extra purchase) uses `gpt-image-1`; Fal queues each request and, for 49 of them, posts an input-safety `content_policy_violation` failure, while the fiftieth completes with a WebP image (row: `completed`).
- When: The Run's agent token submits 50 `POST /api/image-io/generate` requests in three parallel streams, each settled by its Fal callback; the agent reads `GET /api/built-in-generations/:generationId` for the fiftieth and then submits a 51st request.
- Then: All 50 submissions return HTTP 202 and each publishes exactly one terminal realtime event: 49 `failed` with `GENERATION_INPUT_SAFETY_REJECTED` and the fiftieth `completed` with 42 credits charged; the status read agrees. Fal received exactly 50 requests and the balance dropped by 42. The 51st request returns HTTP 429 with `BUILT_IN_RUN_USAGE_LIMIT`, Fal is not called again, and the balance is unchanged.

## image-io-run-lifetime-002

- Vitest: "keeps the lifetime limit after the fiftieth image is failed"
- Mode: run
- Given: A Pro member's running Run (20,000 plan credits, no extra purchase) uses `gpt-image-1`; Fal queues each request and posts an input-safety `content_policy_violation` failure for all 50, including the fiftieth (row: `failed`).
- When: The Run's agent token submits 50 `POST /api/image-io/generate` requests in three parallel streams, each settled by its Fal callback; the agent reads `GET /api/built-in-generations/:generationId` for the fiftieth and then submits a 51st request.
- Then: All 50 submissions return HTTP 202 and each publishes exactly one terminal realtime `failed` event with `GENERATION_INPUT_SAFETY_REJECTED`; the status read for the fiftieth agrees. Fal received exactly 50 requests and nothing was charged. The 51st request returns HTTP 429 with `BUILT_IN_RUN_USAGE_LIMIT`, Fal is not called again, and the balance is unchanged.
