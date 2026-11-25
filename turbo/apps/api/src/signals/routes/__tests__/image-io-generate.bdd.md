# image-io-generate

## image-io-generate-001

- Vitest: "POST /api/image-io/generate > returns 401 when not authenticated"
- Mode: run
- Given: The caller is not authenticated.
- When: The caller sends `POST /api/image-io/generate` with prompt `a cat`.
- Then: The response is HTTP 401 with exactly `{error: {message: "Not authenticated", code: "UNAUTHORIZED"}}`.

## image-io-generate-002

- Vitest: "POST /api/image-io/generate > rejects empty prompts before provider generation"
- Mode: run
- Given: A signed-in workspace admin has 10,000 credits and image model `gpt-image-1`.
- When: The member sends `POST /api/image-io/generate` with a whitespace-only prompt.
- Then: The response is HTTP 400 with exactly `{error: {message: "prompt is required", code: "BAD_REQUEST"}}`. Fal is never called and the balance stays 10,000.

## image-io-generate-003

- Vitest: "POST /api/image-io/generate > rejects transparent background requests before provider generation"
- Mode: run
- Given: A signed-in workspace admin with credits uses image model `gpt-image-2`.
- When: The member sends `POST /api/image-io/generate` with `background: "transparent"` and `outputFormat: "webp"`.
- Then: The response is HTTP 400 with exactly `{error: {message: "gpt-image-2 does not support transparent backgrounds", code: "BAD_REQUEST"}}` and Fal is never called.

## image-io-generate-004

- Vitest: "POST /api/image-io/generate > keeps GPT Image 2 limited to its supported quality levels"
- Mode: run
- Given: A signed-in workspace admin with credits uses image model `gpt-image-2`.
- When: The member sends `POST /api/image-io/generate` with `quality: "xhigh"`.
- Then: The response is HTTP 400 with code `BAD_REQUEST` and message `Unsupported image quality: xhigh`.

## image-io-generate-005

- Vitest: "POST /api/image-io/generate > keeps a run's image model snapshot after the member setting changes"
- Mode: run
- Given: A Pro member's running Run was started with image model `fal-ai/flux-pro/v1.1`, and the member then changes the image model setting to `gpt-image-1` with `PUT /api/user-model-preference`; Fal queues both models.
- When: The Run's agent token sends `POST /api/image-io/generate`, then the member's own session sends a run-less `POST /api/image-io/generate`.
- Then: The Run request returns HTTP 202 and calls only the FLUX Pro 1.1 Fal endpoint. The session request returns HTTP 202 and calls the GPT Image 1 endpoint once, with FLUX still called only once.

## image-io-generate-006

- Vitest: "POST /api/image-io/generate > uses the catalog default in a real Run with an unset member preference"
- Mode: run
- Given: A Pro member with no image model preference starts a real Run.
- When: The member reads `GET /api/user-model-preference`, and the Runner fetches the Run's execution input.
- Then: The preference has `selectedImageModel` null, and the Run's appended system prompt states that built-in image generation uses `gpt-image-2.5-flare`.

## image-io-generate-007

- Vitest: "POST /api/image-io/generate > returns 402 when the org has no spendable credits"
- Mode: run
- Given: A signed-in workspace admin has 0 credits and image model `gpt-image-1`.
- When: The member sends `POST /api/image-io/generate` with prompt `a cat`.
- Then: The response is HTTP 402 with exactly `{error: {message: "Insufficient credits. Please add credits to continue.", code: "INSUFFICIENT_CREDITS"}}`. Fal is never called and the balance stays 0.

## image-io-generate-008

- Vitest: "POST /api/image-io/generate > settles admitted provider work after the run becomes terminal"
- Mode: run
- Given: A Pro member's running Run uses image model `gpt-image-1`, and Fal queues the request and serves the generated PNG.
- When: The Run's agent token sends `POST /api/image-io/generate`; the member cancels the Run; Fal then posts the completed result to the callback; the member reads `GET /api/built-in-generations/:generationId`.
- Then: Submission returns HTTP 202 with a queued image generation and its realtime channel. After the callback the generation result shows `creditsCharged` 42 and billing category `output_image.medium.standard`, the balance drops by exactly 42, and the Run stays `cancelled`.

## image-io-generate-009

- Vitest: "POST /api/image-io/generate > settles admitted provider work once after public spending exhausts the balance and the run becomes terminal"
- Mode: run
- Given: A Pro member's running Run uses image model `gpt-image-1`, Fal queues the request and serves the PNG; after submission, other data-search usage consumes the entire remaining balance.
- When: The Run's agent token submits `POST /api/image-io/generate`; the balance is spent to 0; the member cancels the Run and reads `GET /api/built-in-generations/:generationId`; Fal posts the completion callback; the member reads the status and `GET /api/usage/record`; Fal replays the same completion and the member reads both again.
- Then: Before completion the status is `running`. After completion it is `completed` with `creditsCharged` 42 and category `output_image.medium.standard`, and the balance is -42. Usage totals the spent balance plus 42, with a 42-credit image row attributed to `gpt-image-1` and a data-router `data-search` row for the spent balance. After the replay the balance is still -42 and the status body, usage total, rows and pagination are unchanged.

## image-io-generate-010

- Vitest: "POST /api/image-io/generate > limits run-scoped agent token image generations after three active built-ins"
- Mode: run
- Given: A Pro member's running Run with 10,000 purchased credits uses image model `gpt-image-1`, and Fal queues requests without ever calling back.
- When: The Run's agent token sends three `POST /api/image-io/generate` requests and then a fourth.
- Then: The first three return HTTP 202 and the fourth returns HTTP 429 with exactly the `BUILT_IN_RUN_CONCURRENCY_LIMIT` error saying the run already has 3 built-in generations in progress. Fal receives exactly three requests with `Key test-fal-key` and bodies containing the prompt, `image_size` `1024x1024`, one PNG image, quality `medium`, background `auto` and the OpenAI key; the balance is unchanged.

## image-io-generate-011

- Vitest: "POST /api/image-io/generate > admits only one concurrent image request into the last run slot"
- Mode: run
- Given: A Pro member's running Run with 10,000 purchased credits uses `gpt-image-1`, already has two queued image generations, and Fal never calls back.
- When: The Run's agent token sends two concurrent `POST /api/image-io/generate` requests, then one more.
- Then: The concurrent pair returns one HTTP 202 with a new generation ID and one HTTP 429 `BUILT_IN_RUN_CONCURRENCY_LIMIT`; the later request also returns HTTP 429. Fal receives exactly three requests in total and the balance is unchanged.

## image-io-generate-012

- Vitest: "POST /api/image-io/generate > reuses one completed run image slot without releasing another on callback replay"
- Mode: run
- Given: A Pro member's running Run with 10,000 purchased credits uses `gpt-image-1` with the API origin as callback host; Fal queues requests and serves a WebP image.
- When: The agent token submits three generations and a fourth; Fal completes the first via callback; the agent reads `GET /api/built-in-generations/:generationId` and submits a replacement; Fal replays the first completion; the agent submits again.
- Then: The fourth initial request returns HTTP 429 `BUILT_IN_RUN_CONCURRENCY_LIMIT`. After completion the first generation is `completed` with `creditsCharged` 42 and the balance drops by 42. The replacement returns HTTP 202 with a new generation ID; after the replayed callback the next request still returns HTTP 429, Fal has received exactly four requests, and the balance has dropped by only 42.

## image-io-generate-013

- Vitest: "POST /api/image-io/generate > generates private image files for Okou run-scoped agent tokens"
- Mode: run
- Given: A Pro member's running Run with 10,000 purchased credits uses `gpt-image-1`, callbacks use the API origin, and Fal queues the request and serves a WebP image.
- When: The agent token sends `POST /api/image-io/generate` (1024x1024, quality `auto`, background `opaque`, format `webp`); Fal posts the completion twice and then an error callback; the agent reads `GET /api/built-in-generations/:generationId` and the member reads `GET /api/usage/record`.
- Then: Fal receives one request with `Key test-fal-key` and the exact mapped body; the callback is `<API origin>/api/webhooks/built-in-generations/fal/<generationId>`. Exactly one realtime `completed` event is published and one private artifact is uploaded to bucket `test-private-artifacts` at `private-artifacts/<id>/image-<id8>.webp` with the image bytes. The result is `completed` with content type, size, 42 credits, model `gpt-image-1`, provider `fal`, request options, revised prompt, `privateArtifacts: true` and a short `/artifacts/` URL, without source URL, embed URL or usage. The Run stays `running`, the balance drops by 42, and usage shows one 42-credit image row for `gpt-image-1`.

## image-io-generate-014

- Vitest: "POST /api/image-io/generate > settles Fal failures from a string detail once and releases admission without charging"
- Mode: run
- Given: A Pro member's running Run with 1,000 purchased credits uses `gpt-image-1`, and Fal queues the request and later fails it with a string detail containing the output safety-filter message, reported as status 422 (row: a string detail). The callback carries private prompt, reference URL and request IDs.
- When: The Run's agent token sends `POST /api/image-io/generate`; Fal posts the same error callback twice concurrently; the agent reads `GET /api/built-in-generations/:generationId`; Fal replays the error and then posts a success callback; the agent reads the status again and submits three new generations; the member reads `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_OUTPUT_SAFETY_BLOCKED` with message `The generated image was blocked by the safety filter.`, with no `result`. The replays add no second event and the status stays failed with the same error. Neither realtime nor status exposes the private prompt, reference host, request IDs or `Unexpected status code: 422`. Fal was called once before the three new submissions, which all return HTTP 202 (four calls total); nothing is uploaded, the balance is unchanged, and usage shows 0 credits and no rows.

## image-io-generate-015

- Vitest: "POST /api/image-io/generate > settles Fal failures from Pydantic output safety detail with a pr… once and releases admission without charging"
- Mode: run
- Given: A Pro member's running Run with 1,000 purchased credits uses `gpt-image-1`, and Fal queues the request and later fails it with a Pydantic-style detail of type `content_policy_violation` at `body.prompt` with the output safety-filter message, reported as status 503 (row: Pydantic output safety detail with a provider status). The callback carries private prompt, reference URL and request IDs.
- When: The Run's agent token sends `POST /api/image-io/generate`; Fal posts the same error callback twice concurrently; the agent reads `GET /api/built-in-generations/:generationId`; Fal replays the error and then posts a success callback; the agent reads the status again and submits three new generations; the member reads `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_OUTPUT_SAFETY_BLOCKED` with message `The generated image was blocked by the safety filter.`, with no `result`. The replays add no second event and the status stays failed with the same error. Neither realtime nor status exposes the private prompt, reference host, request IDs or `Unexpected status code: 422`. Fal was called once before the three new submissions, which all return HTTP 202 (four calls total); nothing is uploaded, the balance is unchanged, and usage shows 0 credits and no rows.

## image-io-generate-016

- Vitest: "POST /api/image-io/generate > settles Fal failures from a downstream type without prose or loca… once and releases admission without charging"
- Mode: run
- Given: A Pro member's running Run with 1,000 purchased credits uses `gpt-image-1`, and Fal queues the request and later fails it with a detail with only `type: downstream_service_unavailable` and no message or location, reported as status 422 (row: a downstream type without prose or location). The callback carries private prompt, reference URL and request IDs.
- When: The Run's agent token sends `POST /api/image-io/generate`; Fal posts the same error callback twice concurrently; the agent reads `GET /api/built-in-generations/:generationId`; Fal replays the error and then posts a success callback; the agent reads the status again and submits three new generations; the member reads `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_PROVIDER_UNAVAILABLE` with message `The image generation provider is temporarily unavailable.`, with no `result`. The replays add no second event and the status stays failed with the same error. Neither realtime nor status exposes the private prompt, reference host, request IDs or `Unexpected status code: 422`. Fal was called once before the three new submissions, which all return HTTP 202 (four calls total); nothing is uploaded, the balance is unchanged, and usage shows 0 credits and no rows.

## image-io-generate-017

- Vitest: "POST /api/image-io/generate > settles Fal failures from a status-only provider failure once and releases admission without charging"
- Mode: run
- Given: A Pro member's running Run with 1,000 purchased credits uses `gpt-image-1`, and Fal queues the request and later fails it with no detail at all, reported only as status 429 (row: a status-only provider failure). The callback carries private prompt, reference URL and request IDs.
- When: The Run's agent token sends `POST /api/image-io/generate`; Fal posts the same error callback twice concurrently; the agent reads `GET /api/built-in-generations/:generationId`; Fal replays the error and then posts a success callback; the agent reads the status again and submits three new generations; the member reads `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_PROVIDER_UNAVAILABLE` with message `The image generation provider is temporarily unavailable.`, with no `result`. The replays add no second event and the status stays failed with the same error. Neither realtime nor status exposes the private prompt, reference host, request IDs or `Unexpected status code: 422`. Fal was called once before the three new submissions, which all return HTTP 202 (four calls total); nothing is uploaded, the balance is unchanged, and usage shows 0 credits and no rows.

## image-io-generate-018

- Vitest: "POST /api/image-io/generate > maps Fal input safety rejection despite a provid… through realtime and status without recording artifacts or usage"
- Mode: run
- Given: A Pro member's running Run with 1,000 purchased credits uses `gpt-image-1`, and Fal queues the request and then fails it with a detail of type `content_policy_violation` at `body.prompt` with the input content-checker message, reported as status 503 (row: input safety rejection despite a provider status). The callback carries private prompt, reference URL and request IDs.
- When: The Run's agent token sends `POST /api/image-io/generate`, Fal posts the error callback, the agent reads `GET /api/built-in-generations/:generationId`, and the member reads `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_INPUT_SAFETY_REJECTED` with message `The prompt or reference image was blocked by the safety filter.`. Neither exposes the private prompt, reference host, request IDs or the provider's message. Nothing is uploaded, the balance is unchanged, and usage shows 0 credits and no rows.

## image-io-generate-019

- Vitest: "POST /api/image-io/generate > maps Fal input media download failure through realtime and status without recording artifacts or usage"
- Mode: run
- Given: A Pro member's running Run with 1,000 purchased credits uses `gpt-image-1`, and Fal queues the request and then fails it with a detail of type `file_download_error` at `body.input.image_urls.0` with the file-download message, reported as status 422 (row: input media download failure). The callback carries private prompt, reference URL and request IDs.
- When: The Run's agent token sends `POST /api/image-io/generate`, Fal posts the error callback, the agent reads `GET /api/built-in-generations/:generationId`, and the member reads `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_INPUT_MEDIA_UNREACHABLE` with message `An input image could not be downloaded by the generation provider.`. Neither exposes the private prompt, reference host, request IDs or the provider's message. Nothing is uploaded, the balance is unchanged, and usage shows 0 credits and no rows.

## image-io-generate-020

- Vitest: "POST /api/image-io/generate > maps Fal unsupported input media URL without a s… through realtime and status without recording artifacts or usage"
- Mode: run
- Given: A Pro member's running Run with 1,000 purchased credits uses `gpt-image-1`, and Fal queues the request and then fails it with a detail of type `value_error` at `body.image_urls` reporting the invalid URL scheme `':'`, reported as status 422 (row: unsupported input media URL without a scheme). The callback carries private prompt, reference URL and request IDs.
- When: The Run's agent token sends `POST /api/image-io/generate`, Fal posts the error callback, the agent reads `GET /api/built-in-generations/:generationId`, and the member reads `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_INPUT_MEDIA_UNREACHABLE` with message `An input image could not be downloaded by the generation provider.`. Neither exposes the private prompt, reference host, request IDs or the provider's message. Nothing is uploaded, the balance is unchanged, and usage shows 0 credits and no rows.

## image-io-generate-021

- Vitest: "POST /api/image-io/generate > maps Fal unsupported local input media URL through realtime and status without recording artifacts or usage"
- Mode: run
- Given: A Pro member's running Run with 1,000 purchased credits uses `gpt-image-1`, and Fal queues the request and then fails it with a detail of type `value_error` at `body.image_urls` reporting the invalid URL scheme `'file:'`, reported as status 422 (row: unsupported local input media URL). The callback carries private prompt, reference URL and request IDs.
- When: The Run's agent token sends `POST /api/image-io/generate`, Fal posts the error callback, the agent reads `GET /api/built-in-generations/:generationId`, and the member reads `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_INPUT_MEDIA_UNREACHABLE` with message `An input image could not be downloaded by the generation provider.`. Neither exposes the private prompt, reference host, request IDs or the provider's message. Nothing is uploaded, the balance is unchanged, and usage shows 0 credits and no rows.

## image-io-generate-022

- Vitest: "POST /api/image-io/generate > maps Fal invalid input media through realtime and status without recording artifacts or usage"
- Mode: run
- Given: A Pro member's running Run with 1,000 purchased credits uses `gpt-image-1`, and Fal queues the request and then fails it with a detail of type `image_load_error` at `body.image_url` with the image-load message, reported as status 422 (row: invalid input media). The callback carries private prompt, reference URL and request IDs.
- When: The Run's agent token sends `POST /api/image-io/generate`, Fal posts the error callback, the agent reads `GET /api/built-in-generations/:generationId`, and the member reads `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_INPUT_MEDIA_INVALID` with message `An input image could not be read by the generation provider.`. Neither exposes the private prompt, reference host, request IDs or the provider's message. Nothing is uploaded, the balance is unchanged, and usage shows 0 credits and no rows.

## image-io-generate-023

- Vitest: "POST /api/image-io/generate > maps Fal invalid prompt and image combination through realtime and status without recording artifacts or usage"
- Mode: run
- Given: A Pro member's running Run with 1,000 purchased credits uses `gpt-image-1`, and Fal queues the request and then fails it with a detail of type `invalid_request` at `prompt` with the invalid-inputs message, reported as status 422 (row: invalid prompt and image combination). The callback carries private prompt, reference URL and request IDs.
- When: The Run's agent token sends `POST /api/image-io/generate`, Fal posts the error callback, the agent reads `GET /api/built-in-generations/:generationId`, and the member reads `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_INVALID_PARAMETERS` with message `The image generation request contains invalid parameters.`. Neither exposes the private prompt, reference host, request IDs or the provider's message. Nothing is uploaded, the balance is unchanged, and usage shows 0 credits and no rows.

## image-io-generate-024

- Vitest: "POST /api/image-io/generate > maps Fal unsupported aspect ratio through realtime and status without recording artifacts or usage"
- Mode: run
- Given: A Pro member's running Run with 1,000 purchased credits uses `gpt-image-1`, and Fal queues the request and then fails it with a detail of type `literal_error` at `body.aspect_ratio` listing the allowed ratios, reported as status 422 (row: unsupported aspect ratio). The callback carries private prompt, reference URL and request IDs.
- When: The Run's agent token sends `POST /api/image-io/generate`, Fal posts the error callback, the agent reads `GET /api/built-in-generations/:generationId`, and the member reads `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_INVALID_PARAMETERS` with message `The image generation request contains invalid parameters.`. Neither exposes the private prompt, reference host, request IDs or the provider's message. Nothing is uploaded, the balance is unchanged, and usage shows 0 credits and no rows.

## image-io-generate-025

- Vitest: "POST /api/image-io/generate > maps Fal missing required input through realtime and status without recording artifacts or usage"
- Mode: run
- Given: A Pro member's running Run with 1,000 purchased credits uses `gpt-image-1`, and Fal queues the request and then fails it with a detail of type `missing` at `body.image_urls` with `Field required`, reported as status 422 (row: missing required input). The callback carries private prompt, reference URL and request IDs.
- When: The Run's agent token sends `POST /api/image-io/generate`, Fal posts the error callback, the agent reads `GET /api/built-in-generations/:generationId`, and the member reads `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_INVALID_PARAMETERS` with message `The image generation request contains invalid parameters.`. Neither exposes the private prompt, reference host, request IDs or the provider's message. Nothing is uploaded, the balance is unchanged, and usage shows 0 credits and no rows.

## image-io-generate-026

- Vitest: "POST /api/image-io/generate > maps Fal prompt shorter than the provider minimum through realtime and status without recording artifacts or usage"
- Mode: run
- Given: A Pro member's running Run with 1,000 purchased credits uses `gpt-image-1`, and Fal queues the request and then fails it with a detail of type `string_too_short` at `body.prompt` with `String should have at least 3 characters`, reported as status 422 (row: prompt shorter than the provider minimum). The callback carries private prompt, reference URL and request IDs.
- When: The Run's agent token sends `POST /api/image-io/generate`, Fal posts the error callback, the agent reads `GET /api/built-in-generations/:generationId`, and the member reads `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_INVALID_PARAMETERS` with message `The image generation request contains invalid parameters.`. Neither exposes the private prompt, reference host, request IDs or the provider's message. Nothing is uploaded, the balance is unchanged, and usage shows 0 credits and no rows.

## image-io-generate-027

- Vitest: "POST /api/image-io/generate > maps Fal downstream provider unavailable through realtime and status without recording artifacts or usage"
- Mode: run
- Given: A Pro member's running Run with 1,000 purchased credits uses `gpt-image-1`, and Fal queues the request and then fails it with a detail of type `downstream_service_unavailable` at `body` with `Downstream service unavailable`, reported as status 422 (row: downstream provider unavailable). The callback carries private prompt, reference URL and request IDs.
- When: The Run's agent token sends `POST /api/image-io/generate`, Fal posts the error callback, the agent reads `GET /api/built-in-generations/:generationId`, and the member reads `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_PROVIDER_UNAVAILABLE` with message `The image generation provider is temporarily unavailable.`. Neither exposes the private prompt, reference host, request IDs or the provider's message. Nothing is uploaded, the balance is unchanged, and usage shows 0 credits and no rows.

## image-io-generate-028

- Vitest: "POST /api/image-io/generate > maps Fal downstream provider error through realtime and status without recording artifacts or usage"
- Mode: run
- Given: A Pro member's running Run with 1,000 purchased credits uses `gpt-image-1`, and Fal queues the request and then fails it with a detail of type `downstream_service_error` at `body` with `Downstream service error`, reported as status 422 (row: downstream provider error). The callback carries private prompt, reference URL and request IDs.
- When: The Run's agent token sends `POST /api/image-io/generate`, Fal posts the error callback, the agent reads `GET /api/built-in-generations/:generationId`, and the member reads `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_PROVIDER_UNAVAILABLE` with message `The image generation provider is temporarily unavailable.`. Neither exposes the private prompt, reference host, request IDs or the provider's message. Nothing is uploaded, the balance is unchanged, and usage shows 0 credits and no rows.

## image-io-generate-029

- Vitest: "POST /api/image-io/generate > maps Fal failure evidence for near-match safety text through status and realtime"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses image model `gpt-image-1`; Fal queues the request and then posts a failure callback with status `FAILED`, error `Unexpected status code: 422`, and a `payload` detail of type `content_policy_violation` whose message is the output safety text without its final period (row: near-match safety text), alongside a private prompt, reference URL and request IDs.
- When: The member sends `POST /api/image-io/generate`, Fal posts the failure callback, and the member reads `GET /api/built-in-generations/:generationId` and `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_FAILED` with message `Image generation failed.`, with no `result`. Neither exposes the private prompt, reference host, raw status text, safety prose, private provider message, token, location or request IDs. Nothing is uploaded, the balance stays 1,000, and usage shows 0 credits and no rows.

## image-io-generate-030

- Vitest: "POST /api/image-io/generate > maps Fal failure evidence for changed provider text and location through status and realtime"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses image model `gpt-image-1`; Fal queues the request and then posts a failure callback with status `ERROR`, error `Invalid status code: 422`, and a `data` detail of type `file_download_error` at a private location with a private message and credential context (row: changed provider text and location), alongside a private prompt, reference URL and request IDs.
- When: The member sends `POST /api/image-io/generate`, Fal posts the failure callback, and the member reads `GET /api/built-in-generations/:generationId` and `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_FAILED` with message `Image generation failed.`, with no `result`. Neither exposes the private prompt, reference host, raw status text, safety prose, private provider message, token, location or request IDs. Nothing is uploaded, the balance stays 1,000, and usage shows 0 credits and no rows.

## image-io-generate-031

- Vitest: "POST /api/image-io/generate > maps Fal failure evidence for downstream error with changed message through status and realtime"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses image model `gpt-image-1`; Fal queues the request and then posts a failure callback with status `ERROR`, error `Invalid status code: 500`, and a detail of type `downstream_service_error` at `body` with a private message (row: downstream error with changed message), alongside a private prompt, reference URL and request IDs.
- When: The member sends `POST /api/image-io/generate`, Fal posts the failure callback, and the member reads `GET /api/built-in-generations/:generationId` and `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_PROVIDER_UNAVAILABLE` with message `The image generation provider is temporarily unavailable.`, with no `result`. Neither exposes the private prompt, reference host, raw status text, safety prose, private provider message, token, location or request IDs. Nothing is uploaded, the balance stays 1,000, and usage shows 0 credits and no rows.

## image-io-generate-032

- Vitest: "POST /api/image-io/generate > maps Fal failure evidence for downstream error at an unrecognized loc… through status and realtime"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses image model `gpt-image-1`; Fal queues the request and then posts a failure callback with status `ERROR`, error `Invalid status code: 500`, and a detail of type `downstream_service_error` at a private location with `Downstream service error` (row: downstream error at an unrecognized location), alongside a private prompt, reference URL and request IDs.
- When: The member sends `POST /api/image-io/generate`, Fal posts the failure callback, and the member reads `GET /api/built-in-generations/:generationId` and `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_PROVIDER_UNAVAILABLE` with message `The image generation provider is temporarily unavailable.`, with no `result`. Neither exposes the private prompt, reference host, raw status text, safety prose, private provider message, token, location or request IDs. Nothing is uploaded, the balance stays 1,000, and usage shows 0 credits and no rows.

## image-io-generate-033

- Vitest: "POST /api/image-io/generate > maps Fal failure evidence for missing messages and an unknown first t… through status and realtime"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses image model `gpt-image-1`; Fal queues the request and then posts a failure callback with status `ERROR`, error `Unexpected status code: 422`, and a `response` detail list whose first type is `file_download_error:private-provider-token` followed by `image_load_error`, without messages (row: missing messages and an unknown first type), alongside a private prompt, reference URL and request IDs.
- When: The member sends `POST /api/image-io/generate`, Fal posts the failure callback, and the member reads `GET /api/built-in-generations/:generationId` and `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_FAILED` with message `Image generation failed.`, with no `result`. Neither exposes the private prompt, reference host, raw status text, safety prose, private provider message, token, location or request IDs. Nothing is uploaded, the balance stays 1,000, and usage shows 0 credits and no rows.

## image-io-generate-034

- Vitest: "POST /api/image-io/generate > maps Fal failure evidence for the documented legacy validation envelo… through status and realtime"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses image model `gpt-image-1`; Fal queues the request and then posts a failure callback with status `ERROR`, error `Invalid status code: 422`, and a detail of type `value_error.missing` at `body.prompt` with `field required` (row: the documented legacy validation envelope), alongside a private prompt, reference URL and request IDs.
- When: The member sends `POST /api/image-io/generate`, Fal posts the failure callback, and the member reads `GET /api/built-in-generations/:generationId` and `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_FAILED` with message `Image generation failed.`, with no `result`. Neither exposes the private prompt, reference host, raw status text, safety prose, private provider message, token, location or request IDs. Nothing is uploaded, the balance stays 1,000, and usage shows 0 credits and no rows.

## image-io-generate-035

- Vitest: "POST /api/image-io/generate > maps Fal failure evidence for an unknown type and out-of-range HTTP s… through status and realtime"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses image model `gpt-image-1`; Fal queues the request and then posts a failure callback with status `ERROR`, error `Unexpected status code: 999`, and a detail of unknown type `file_download_error:private-provider-token` with a private message (row: an unknown type and out-of-range HTTP status), alongside a private prompt, reference URL and request IDs.
- When: The member sends `POST /api/image-io/generate`, Fal posts the failure callback, and the member reads `GET /api/built-in-generations/:generationId` and `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_FAILED` with message `Image generation failed.`, with no `result`. Neither exposes the private prompt, reference host, raw status text, safety prose, private provider message, token, location or request IDs. Nothing is uploaded, the balance stays 1,000, and usage shows 0 credits and no rows.

## image-io-generate-036

- Vitest: "POST /api/image-io/generate > maps Fal failure evidence for empty diagnostics and a non-string error through status and realtime"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses image model `gpt-image-1`; Fal queues the request and then posts a failure callback with status `ERROR`, an object error containing a private message, and a null detail (row: empty diagnostics and a non-string error), alongside a private prompt, reference URL and request IDs.
- When: The member sends `POST /api/image-io/generate`, Fal posts the failure callback, and the member reads `GET /api/built-in-generations/:generationId` and `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_FAILED` with message `Image generation failed.`, with no `result`. Neither exposes the private prompt, reference host, raw status text, safety prose, private provider message, token, location or request IDs. Nothing is uploaded, the balance stays 1,000, and usage shows 0 credits and no rows.

## image-io-generate-037

- Vitest: "POST /api/image-io/generate > maps Fal failure evidence for free-form detail and trailing error text through status and realtime"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses image model `gpt-image-1`; Fal queues the request and then posts a failure callback with status `ERROR`, error `Invalid status code: 422 private-provider-token`, and a free-form string detail containing a private message and URL (row: free-form detail and trailing error text), alongside a private prompt, reference URL and request IDs.
- When: The member sends `POST /api/image-io/generate`, Fal posts the failure callback, and the member reads `GET /api/built-in-generations/:generationId` and `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_FAILED` with message `Image generation failed.`, with no `result`. Neither exposes the private prompt, reference host, raw status text, safety prose, private provider message, token, location or request IDs. Nothing is uploaded, the balance stays 1,000, and usage shows 0 credits and no rows.

## image-io-generate-038

- Vitest: "POST /api/image-io/generate > maps Fal failure evidence for unsupported body despite status 503 (0) through status and realtime"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses image model `gpt-image-1`; Fal queues the request and then posts a failure callback with status `ERROR`, error `Invalid status code: 503`, and a payload body that is the bare string `private-provider-message` (row: unsupported body despite status 503 (0)), alongside a private prompt, reference URL and request IDs.
- When: The member sends `POST /api/image-io/generate`, Fal posts the failure callback, and the member reads `GET /api/built-in-generations/:generationId` and `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_FAILED` with message `Image generation failed.`, with no `result`. Neither exposes the private prompt, reference host, raw status text, safety prose, private provider message, token, location or request IDs. Nothing is uploaded, the balance stays 1,000, and usage shows 0 credits and no rows.

## image-io-generate-039

- Vitest: "POST /api/image-io/generate > maps Fal failure evidence for unsupported body despite status 503 (3) through status and realtime"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses image model `gpt-image-1`; Fal queues the request and then posts a failure callback with status `ERROR`, error `Invalid status code: 503`, and a payload body that is an empty array (row: unsupported body despite status 503 (3)), alongside a private prompt, reference URL and request IDs.
- When: The member sends `POST /api/image-io/generate`, Fal posts the failure callback, and the member reads `GET /api/built-in-generations/:generationId` and `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_FAILED` with message `Image generation failed.`, with no `result`. Neither exposes the private prompt, reference host, raw status text, safety prose, private provider message, token, location or request IDs. Nothing is uploaded, the balance stays 1,000, and usage shows 0 credits and no rows.

## image-io-generate-040

- Vitest: "POST /api/image-io/generate > maps Fal failure evidence for status-only provider failure 429 through status and realtime"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses image model `gpt-image-1`; Fal queues the request and then posts a failure callback with status `ERROR`, error `Unexpected status code: 429`, and no detail (row: status-only provider failure 429), alongside a private prompt, reference URL and request IDs.
- When: The member sends `POST /api/image-io/generate`, Fal posts the failure callback, and the member reads `GET /api/built-in-generations/:generationId` and `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_PROVIDER_UNAVAILABLE` with message `The image generation provider is temporarily unavailable.`, with no `result`. Neither exposes the private prompt, reference host, raw status text, safety prose, private provider message, token, location or request IDs. Nothing is uploaded, the balance stays 1,000, and usage shows 0 credits and no rows.

## image-io-generate-041

- Vitest: "POST /api/image-io/generate > maps Fal failure evidence for status-only provider failure 500 through status and realtime"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses image model `gpt-image-1`; Fal queues the request and then posts a failure callback with status `ERROR`, error `Unexpected status code: 500`, and no detail (row: status-only provider failure 500), alongside a private prompt, reference URL and request IDs.
- When: The member sends `POST /api/image-io/generate`, Fal posts the failure callback, and the member reads `GET /api/built-in-generations/:generationId` and `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_PROVIDER_UNAVAILABLE` with message `The image generation provider is temporarily unavailable.`, with no `result`. Neither exposes the private prompt, reference host, raw status text, safety prose, private provider message, token, location or request IDs. Nothing is uploaded, the balance stays 1,000, and usage shows 0 credits and no rows.

## image-io-generate-042

- Vitest: "POST /api/image-io/generate > maps Fal failure evidence for status-only provider failure 502 through status and realtime"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses image model `gpt-image-1`; Fal queues the request and then posts a failure callback with status `ERROR`, error `Unexpected status code: 502`, and no detail (row: status-only provider failure 502), alongside a private prompt, reference URL and request IDs.
- When: The member sends `POST /api/image-io/generate`, Fal posts the failure callback, and the member reads `GET /api/built-in-generations/:generationId` and `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_PROVIDER_UNAVAILABLE` with message `The image generation provider is temporarily unavailable.`, with no `result`. Neither exposes the private prompt, reference host, raw status text, safety prose, private provider message, token, location or request IDs. Nothing is uploaded, the balance stays 1,000, and usage shows 0 credits and no rows.

## image-io-generate-043

- Vitest: "POST /api/image-io/generate > maps Fal failure evidence for status-only provider failure 503 through status and realtime"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses image model `gpt-image-1`; Fal queues the request and then posts a failure callback with status `ERROR`, error `Unexpected status code: 503`, and no detail (row: status-only provider failure 503), alongside a private prompt, reference URL and request IDs.
- When: The member sends `POST /api/image-io/generate`, Fal posts the failure callback, and the member reads `GET /api/built-in-generations/:generationId` and `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_PROVIDER_UNAVAILABLE` with message `The image generation provider is temporarily unavailable.`, with no `result`. Neither exposes the private prompt, reference host, raw status text, safety prose, private provider message, token, location or request IDs. Nothing is uploaded, the balance stays 1,000, and usage shows 0 credits and no rows.

## image-io-generate-044

- Vitest: "POST /api/image-io/generate > maps Fal failure evidence for status-only provider failure 504 through status and realtime"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses image model `gpt-image-1`; Fal queues the request and then posts a failure callback with status `ERROR`, error `Unexpected status code: 504`, and no detail (row: status-only provider failure 504), alongside a private prompt, reference URL and request IDs.
- When: The member sends `POST /api/image-io/generate`, Fal posts the failure callback, and the member reads `GET /api/built-in-generations/:generationId` and `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_PROVIDER_UNAVAILABLE` with message `The image generation provider is temporarily unavailable.`, with no `result`. Neither exposes the private prompt, reference host, raw status text, safety prose, private provider message, token, location or request IDs. Nothing is uploaded, the balance stays 1,000, and usage shows 0 credits and no rows.

## image-io-generate-045

- Vitest: "POST /api/image-io/generate > maps Fal failure evidence for status outside the provider fallback se… through status and realtime"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses image model `gpt-image-1`; Fal queues the request and then posts a failure callback with status `ERROR`, error `Invalid status code: 200`, and no detail (row: status outside the provider fallback set 200), alongside a private prompt, reference URL and request IDs.
- When: The member sends `POST /api/image-io/generate`, Fal posts the failure callback, and the member reads `GET /api/built-in-generations/:generationId` and `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_FAILED` with message `Image generation failed.`, with no `result`. Neither exposes the private prompt, reference host, raw status text, safety prose, private provider message, token, location or request IDs. Nothing is uploaded, the balance stays 1,000, and usage shows 0 credits and no rows.

## image-io-generate-046

- Vitest: "POST /api/image-io/generate > maps Fal failure evidence for status outside the provider fallback se… through status and realtime"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses image model `gpt-image-1`; Fal queues the request and then posts a failure callback with status `ERROR`, error `Invalid status code: 400`, and no detail (row: status outside the provider fallback set 400), alongside a private prompt, reference URL and request IDs.
- When: The member sends `POST /api/image-io/generate`, Fal posts the failure callback, and the member reads `GET /api/built-in-generations/:generationId` and `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_FAILED` with message `Image generation failed.`, with no `result`. Neither exposes the private prompt, reference host, raw status text, safety prose, private provider message, token, location or request IDs. Nothing is uploaded, the balance stays 1,000, and usage shows 0 credits and no rows.

## image-io-generate-047

- Vitest: "POST /api/image-io/generate > maps Fal failure evidence for status outside the provider fallback se… through status and realtime"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses image model `gpt-image-1`; Fal queues the request and then posts a failure callback with status `ERROR`, error `Invalid status code: 401`, and no detail (row: status outside the provider fallback set 401), alongside a private prompt, reference URL and request IDs.
- When: The member sends `POST /api/image-io/generate`, Fal posts the failure callback, and the member reads `GET /api/built-in-generations/:generationId` and `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_FAILED` with message `Image generation failed.`, with no `result`. Neither exposes the private prompt, reference host, raw status text, safety prose, private provider message, token, location or request IDs. Nothing is uploaded, the balance stays 1,000, and usage shows 0 credits and no rows.

## image-io-generate-048

- Vitest: "POST /api/image-io/generate > maps Fal failure evidence for status outside the provider fallback se… through status and realtime"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses image model `gpt-image-1`; Fal queues the request and then posts a failure callback with status `ERROR`, error `Invalid status code: 403`, and no detail (row: status outside the provider fallback set 403), alongside a private prompt, reference URL and request IDs.
- When: The member sends `POST /api/image-io/generate`, Fal posts the failure callback, and the member reads `GET /api/built-in-generations/:generationId` and `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_FAILED` with message `Image generation failed.`, with no `result`. Neither exposes the private prompt, reference host, raw status text, safety prose, private provider message, token, location or request IDs. Nothing is uploaded, the balance stays 1,000, and usage shows 0 credits and no rows.

## image-io-generate-049

- Vitest: "POST /api/image-io/generate > maps Fal failure evidence for status outside the provider fallback se… through status and realtime"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses image model `gpt-image-1`; Fal queues the request and then posts a failure callback with status `ERROR`, error `Invalid status code: 422`, and no detail (row: status outside the provider fallback set 422), alongside a private prompt, reference URL and request IDs.
- When: The member sends `POST /api/image-io/generate`, Fal posts the failure callback, and the member reads `GET /api/built-in-generations/:generationId` and `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_FAILED` with message `Image generation failed.`, with no `result`. Neither exposes the private prompt, reference host, raw status text, safety prose, private provider message, token, location or request IDs. Nothing is uploaded, the balance stays 1,000, and usage shows 0 credits and no rows.

## image-io-generate-050

- Vitest: "POST /api/image-io/generate > maps Fal failure evidence for status outside the provider fallback se… through status and realtime"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses image model `gpt-image-1`; Fal queues the request and then posts a failure callback with status `ERROR`, error `Invalid status code: 501`, and no detail (row: status outside the provider fallback set 501), alongside a private prompt, reference URL and request IDs.
- When: The member sends `POST /api/image-io/generate`, Fal posts the failure callback, and the member reads `GET /api/built-in-generations/:generationId` and `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_FAILED` with message `Image generation failed.`, with no `result`. Neither exposes the private prompt, reference host, raw status text, safety prose, private provider message, token, location or request IDs. Nothing is uploaded, the balance stays 1,000, and usage shows 0 credits and no rows.

## image-io-generate-051

- Vitest: "POST /api/image-io/generate > maps Fal failure evidence for status outside the provider fallback se… through status and realtime"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses image model `gpt-image-1`; Fal queues the request and then posts a failure callback with status `ERROR`, error `Invalid status code: 505`, and no detail (row: status outside the provider fallback set 505), alongside a private prompt, reference URL and request IDs.
- When: The member sends `POST /api/image-io/generate`, Fal posts the failure callback, and the member reads `GET /api/built-in-generations/:generationId` and `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_FAILED` with message `Image generation failed.`, with no `result`. Neither exposes the private prompt, reference host, raw status text, safety prose, private provider message, token, location or request IDs. Nothing is uploaded, the balance stays 1,000, and usage shows 0 credits and no rows.

## image-io-generate-052

- Vitest: "POST /api/image-io/generate > maps Fal failure evidence for malformed status-only evidence 0 through status and realtime"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses image model `gpt-image-1`; Fal queues the request and then posts a failure callback with status `ERROR`, error `Invalid status code: 503 private-provider-token`, and no detail (row: malformed status-only evidence 0), alongside a private prompt, reference URL and request IDs.
- When: The member sends `POST /api/image-io/generate`, Fal posts the failure callback, and the member reads `GET /api/built-in-generations/:generationId` and `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_FAILED` with message `Image generation failed.`, with no `result`. Neither exposes the private prompt, reference host, raw status text, safety prose, private provider message, token, location or request IDs. Nothing is uploaded, the balance stays 1,000, and usage shows 0 credits and no rows.

## image-io-generate-053

- Vitest: "POST /api/image-io/generate > maps Fal failure evidence for downstream_service_error without human-… through status and realtime"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses image model `gpt-image-1`; Fal queues the request and then posts a failure callback with status `FAILED`, no error text, and a `response` detail containing only `type: downstream_service_error` (row: downstream_service_error without human-readable fields or a status), alongside a private prompt, reference URL and request IDs.
- When: The member sends `POST /api/image-io/generate`, Fal posts the failure callback, and the member reads `GET /api/built-in-generations/:generationId` and `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_PROVIDER_UNAVAILABLE` with message `The image generation provider is temporarily unavailable.`, with no `result`. Neither exposes the private prompt, reference host, raw status text, safety prose, private provider message, token, location or request IDs. Nothing is uploaded, the balance stays 1,000, and usage shows 0 credits and no rows.

## image-io-generate-054

- Vitest: "POST /api/image-io/generate > maps Fal failure evidence for downstream_service_unavailable without … through status and realtime"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses image model `gpt-image-1`; Fal queues the request and then posts a failure callback with status `FAILED`, no error text, and a `response` detail containing only `type: downstream_service_unavailable` (row: downstream_service_unavailable without human-readable fields or a status), alongside a private prompt, reference URL and request IDs.
- When: The member sends `POST /api/image-io/generate`, Fal posts the failure callback, and the member reads `GET /api/built-in-generations/:generationId` and `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_PROVIDER_UNAVAILABLE` with message `The image generation provider is temporarily unavailable.`, with no `result`. Neither exposes the private prompt, reference host, raw status text, safety prose, private provider message, token, location or request IDs. Nothing is uploaded, the balance stays 1,000, and usage shows 0 credits and no rows.

## image-io-generate-055

- Vitest: "POST /api/image-io/generate > maps Fal failure evidence for ambiguous structured evidence despite s… through status and realtime"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses image model `gpt-image-1`; Fal queues the request and then posts a failure callback with status `ERROR`, error `Invalid status code: 503`, and a single `file_download_error` detail at `body.image_urls` with a private message (row: ambiguous structured evidence despite status 503 (0)), alongside a private prompt, reference URL and request IDs.
- When: The member sends `POST /api/image-io/generate`, Fal posts the failure callback, and the member reads `GET /api/built-in-generations/:generationId` and `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_FAILED` with message `Image generation failed.`, with no `result`. Neither exposes the private prompt, reference host, raw status text, safety prose, private provider message, token, location or request IDs. Nothing is uploaded, the balance stays 1,000, and usage shows 0 credits and no rows.

## image-io-generate-056

- Vitest: "POST /api/image-io/generate > maps Fal failure evidence for ambiguous structured evidence despite s… through status and realtime"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses image model `gpt-image-1`; Fal queues the request and then posts a failure callback with status `ERROR`, error `Invalid status code: 503`, and a single detail of type `downstream_service_error:private-provider-token` (row: ambiguous structured evidence despite status 503 (1)), alongside a private prompt, reference URL and request IDs.
- When: The member sends `POST /api/image-io/generate`, Fal posts the failure callback, and the member reads `GET /api/built-in-generations/:generationId` and `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_FAILED` with message `Image generation failed.`, with no `result`. Neither exposes the private prompt, reference host, raw status text, safety prose, private provider message, token, location or request IDs. Nothing is uploaded, the balance stays 1,000, and usage shows 0 credits and no rows.

## image-io-generate-057

- Vitest: "POST /api/image-io/generate > maps Fal failure evidence for ambiguous structured evidence despite s… through status and realtime"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses image model `gpt-image-1`; Fal queues the request and then posts a failure callback with status `ERROR`, error `Invalid status code: 503`, and a single detail with `type: null` (row: ambiguous structured evidence despite status 503 (2)), alongside a private prompt, reference URL and request IDs.
- When: The member sends `POST /api/image-io/generate`, Fal posts the failure callback, and the member reads `GET /api/built-in-generations/:generationId` and `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_FAILED` with message `Image generation failed.`, with no `result`. Neither exposes the private prompt, reference host, raw status text, safety prose, private provider message, token, location or request IDs. Nothing is uploaded, the balance stays 1,000, and usage shows 0 credits and no rows.

## image-io-generate-058

- Vitest: "POST /api/image-io/generate > maps Fal failure evidence for ambiguous structured evidence despite s… through status and realtime"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses image model `gpt-image-1`; Fal queues the request and then posts a failure callback with status `ERROR`, error `Invalid status code: 503`, and a detail list of `downstream_service_error` followed by an unknown private type (row: ambiguous structured evidence despite status 503 (4)), alongside a private prompt, reference URL and request IDs.
- When: The member sends `POST /api/image-io/generate`, Fal posts the failure callback, and the member reads `GET /api/built-in-generations/:generationId` and `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_FAILED` with message `Image generation failed.`, with no `result`. Neither exposes the private prompt, reference host, raw status text, safety prose, private provider message, token, location or request IDs. Nothing is uploaded, the balance stays 1,000, and usage shows 0 credits and no rows.

## image-io-generate-059

- Vitest: "POST /api/image-io/generate > maps Fal failure evidence for ambiguous structured evidence despite s… through status and realtime"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses image model `gpt-image-1`; Fal queues the request and then posts a failure callback with status `ERROR`, error `Invalid status code: 503`, and a detail list of `downstream_service_error` followed by an input-safety `content_policy_violation` (row: ambiguous structured evidence despite status 503 (5)), alongside a private prompt, reference URL and request IDs.
- When: The member sends `POST /api/image-io/generate`, Fal posts the failure callback, and the member reads `GET /api/built-in-generations/:generationId` and `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_FAILED` with message `Image generation failed.`, with no `result`. Neither exposes the private prompt, reference host, raw status text, safety prose, private provider message, token, location or request IDs. Nothing is uploaded, the balance stays 1,000, and usage shows 0 credits and no rows.

## image-io-generate-060

- Vitest: "POST /api/image-io/generate > maps Fal failure evidence for ambiguous structured evidence despite s… through status and realtime"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses image model `gpt-image-1`; Fal queues the request and then posts a failure callback with status `ERROR`, error `Invalid status code: 503`, and a detail list of an input-safety `content_policy_violation` followed by `downstream_service_unavailable` (row: ambiguous structured evidence despite status 503 (6)), alongside a private prompt, reference URL and request IDs.
- When: The member sends `POST /api/image-io/generate`, Fal posts the failure callback, and the member reads `GET /api/built-in-generations/:generationId` and `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_FAILED` with message `Image generation failed.`, with no `result`. Neither exposes the private prompt, reference host, raw status text, safety prose, private provider message, token, location or request IDs. Nothing is uploaded, the balance stays 1,000, and usage shows 0 credits and no rows.

## image-io-generate-061

- Vitest: "POST /api/image-io/generate > maps Fal failure evidence for ambiguous structured evidence despite s… through status and realtime"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses image model `gpt-image-1`; Fal queues the request and then posts a failure callback with status `ERROR`, error `Invalid status code: 503`, and a detail list of a `file_download_error` with an unrelated message followed by an output-safety `content_policy_violation` (row: ambiguous structured evidence despite status 503 (7)), alongside a private prompt, reference URL and request IDs.
- When: The member sends `POST /api/image-io/generate`, Fal posts the failure callback, and the member reads `GET /api/built-in-generations/:generationId` and `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_FAILED` with message `Image generation failed.`, with no `result`. Neither exposes the private prompt, reference host, raw status text, safety prose, private provider message, token, location or request IDs. Nothing is uploaded, the balance stays 1,000, and usage shows 0 credits and no rows.

## image-io-generate-062

- Vitest: "POST /api/image-io/generate > maps Fal failure evidence for ambiguous structured evidence despite s… through status and realtime"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses image model `gpt-image-1`; Fal queues the request and then posts a failure callback with status `ERROR`, error `Invalid status code: 503`, and a single `downstream_service_error` detail carrying the output safety-filter message (row: ambiguous structured evidence despite status 503 (8)), alongside a private prompt, reference URL and request IDs.
- When: The member sends `POST /api/image-io/generate`, Fal posts the failure callback, and the member reads `GET /api/built-in-generations/:generationId` and `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_FAILED` with message `Image generation failed.`, with no `result`. Neither exposes the private prompt, reference host, raw status text, safety prose, private provider message, token, location or request IDs. Nothing is uploaded, the balance stays 1,000, and usage shows 0 credits and no rows.

## image-io-generate-063

- Vitest: "POST /api/image-io/generate > maps Fal failure evidence for ambiguous structured evidence despite s… through status and realtime"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses image model `gpt-image-1`; Fal queues the request and then posts a failure callback with status `ERROR`, error `Invalid status code: 503`, and a detail list containing both an input-safety and an output-safety `content_policy_violation` (row: ambiguous structured evidence despite status 503 (9)), alongside a private prompt, reference URL and request IDs.
- When: The member sends `POST /api/image-io/generate`, Fal posts the failure callback, and the member reads `GET /api/built-in-generations/:generationId` and `GET /api/usage/record`.
- Then: Submission returns HTTP 202. A realtime `failed` event and the status read (HTTP 200) both report error `GENERATION_FAILED` with message `Image generation failed.`, with no `result`. Neither exposes the private prompt, reference host, raw status text, safety prose, private provider message, token, location or request IDs. Nothing is uploaded, the balance stays 1,000, and usage shows 0 credits and no rows.

## image-io-generate-064

- Vitest: "POST /api/image-io/generate > does not complete a job after the status route times it out"
- Mode: run
- Given: The clock is 2026-05-15T12:00:00Z; a signed-in workspace admin with 1,000 credits uses `gpt-image-1`, and Fal queues the request and serves a WebP image.
- When: The member sends `POST /api/image-io/generate` with prompt `a late image`; the clock advances 16 minutes and the member reads `GET /api/built-in-generations/:generationId`; Fal then posts a completed result and the member reads the status again.
- Then: Submission returns HTTP 202 and Fal receives one request with `Key test-fal-key` and the default body (1024x1024, PNG, quality `medium`, background `auto`). Both status reads return HTTP 200 with status `failed` and error `GENERATION_TIMEOUT` (`Generation timed out. Please try again.`). Nothing is uploaded and the balance stays 1,000.

## image-io-generate-065

- Vitest: "POST /api/image-io/generate > rejects a Qwen Image 3 size above the provider's pixel cap"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses image model `alibaba/qwen-image-3/text-to-image`.
- When: The member sends `POST /api/image-io/generate` with size `3840x2160`.
- Then: The response is HTTP 400 with exactly `{error: {message: "Unsupported image size for qwen-image-3: 3840x2160; total pixels must be at most 4194304", code: "BAD_REQUEST"}}`. Fal is never called and the balance stays 1,000.

## image-io-generate-066

- Vitest: "POST /api/image-io/generate > generates fal image files and settles megapixel usage asynchronously"
- Mode: run
- Given: A Pro member's running Run with 1,000 purchased credits uses `fal-ai/flux-pro/v1.1`, and Fal queues the request and serves a 1536x1024 JPEG.
- When: The Run's agent token sends `POST /api/image-io/generate` with size `1536x1024`, format `jpeg` and seed 99; Fal posts the completion callback; the agent reads `GET /api/built-in-generations/:generationId`.
- Then: Fal receives one request with `Key test-fal-key` and body `image_size` `{width: 1536, height: 1024}`, one JPEG, seed 99, `safety_tolerance` `4` and `enhance_prompt` false. The result shows 80 credits, model `fal-ai/flux-pro/v1.1`, provider `fal`, quality `model-default`, billing category `output_megapixel` with quantity 2, private artifacts, seed 99 and a short `/artifacts/*.jpg` URL, without source URL, embed URL or usage. The image is stored as a private artifact with JPEG content type, and the balance drops by exactly 80.

## image-io-generate-067

- Vitest: "POST /api/image-io/generate > generates image-to-image through fal at standard provider prices"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses `fal-ai/flux-pro/v1.1`, and Fal's FLUX Redux endpoint queues the request and serves a 1536x1024 JPEG.
- When: The member sends `POST /api/image-io/generate` with a reference `imageUrl`, format `jpeg` and seed 42; Fal posts the completion callback; the member reads `GET /api/built-in-generations/:generationId`.
- Then: Fal Redux receives one request with `Key test-fal-key` and body `image_size` `landscape_4_3`, one JPEG, seed 42, `safety_tolerance` `4`, `enhance_prompt` false and the `image_url`. The result shows 80 credits, billing category `output_megapixel` with quantity 2, `sourceImageUrls` with the reference, seed 42 and a short artifact URL, without `sourceUrl` or `imagePromptStrength`. The balance drops to 920.

## image-io-generate-068

- Vitest: "POST /api/image-io/generate > generates with FLUX.2 Pro and bills the first and additional output megapixels"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses `fal-ai/flux-2-pro`; Fal queues the request, reports 1.5 billable units on the authenticated result response, and serves a 1536x1024 PNG.
- When: The member sends `POST /api/image-io/generate` with size `1536x1024`, format `png`, seed 42 and `safetyTolerance` `5`; Fal posts the completion callback; the member reads `GET /api/built-in-generations/:generationId`.
- Then: Fal receives exactly the prompt, `image_size` `{width: 1536, height: 1024}`, `output_format` `png`, seed 42 and `safety_tolerance` `5`. The result charges 45 credits (30 for the first megapixel plus 15 for an additional one) with model `fal-ai/flux-2-pro`, provider `fal`, billing category `processed_megapixel.first`, quantity 1 and seed 42, and the balance drops to 955.

## image-io-generate-069

- Vitest: "POST /api/image-io/generate > edits up to nine references with FLUX.2 Pro and uses Fal billing units"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses `fal-ai/flux-2-pro`; Fal's edit endpoint queues the request, reports 3 billable units on the authenticated result response, and serves a PNG.
- When: The member sends `POST /api/image-io/generate` with ten `imageUrls`, then with two reference URLs and format `png`; Fal posts the completion callback; the member reads `GET /api/built-in-generations/:generationId`.
- Then: The ten-reference request returns HTTP 400 with message `imageUrls supports at most 9 images` and Fal is not called. The two-reference request reaches the edit endpoint once with `image_size` `auto`, `output_format` `png`, `safety_tolerance` `4` and both `image_urls`. The result charges 90 credits (30 plus four additional megapixels at 15) with model `fal-ai/flux-2-pro` and the source image URLs, and the balance drops to 910.

## image-io-generate-070

- Vitest: "POST /api/image-io/generate > maps Ideogram 4 quality to rendering speed without paid prompt expansion"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses `ideogram/v4`, and Fal queues the request and serves a 2048x1024 PNG.
- When: The member sends `POST /api/image-io/generate` with size `2048x1024`, quality `high`, format `png` and seed 17; Fal posts the completion callback; the member reads `GET /api/built-in-generations/:generationId`.
- Then: Fal receives exactly the prompt, `image_size` `{width: 2048, height: 1024}`, one PNG, `rendering_speed` `QUALITY`, `expansion_model` `None` and seed 17. The result charges 50 credits with model `ideogram/v4`, quality `high`, billing category `output_megapixel.quality` and quantity 2.

## image-io-generate-071

- Vitest: "POST /api/image-io/generate > routes Ideogram 4 single-image edits and rejects multiple references"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses `ideogram/v4`, and Fal's image-to-image endpoint queues the request and serves a 1024x1024 PNG.
- When: The member sends `POST /api/image-io/generate` with two `imageUrls`, then with one `imageUrl`, quality `low` and format `png`; Fal posts the completion callback; the member reads `GET /api/built-in-generations/:generationId`.
- Then: The two-image request returns HTTP 400 with message `ideogram-4 accepts one source image` and Fal is not called. The single-image edit reaches the image-to-image endpoint once with `image_size` `auto`, `output_format` `png`, `rendering_speed` `TURBO`, `expansion_model` `None` and the `image_url`. The result charges 8 credits with billing category `output_megapixel.turbo` and the source image URL.

## image-io-generate-072

- Vitest: "POST /api/image-io/generate > fails Ideogram 4 auto edits when Fal omits billable dimensions"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses `ideogram/v4`, and Fal's image-to-image endpoint completes with an image that has no width or height.
- When: The member sends `POST /api/image-io/generate` with one `imageUrl`, quality `low` and format `png`; Fal posts the completion callback; the member reads `GET /api/built-in-generations/:generationId`.
- Then: The status is `failed` with error `NO_BILLING_UNITS` (`Fal returned no billing details`). The image is never downloaded or uploaded and the balance stays 1,000.

## image-io-generate-073

- Vitest: "POST /api/image-io/generate > generates Qwen Image 3 images through fal and bills the standard resolution tier"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses `alibaba/qwen-image-3/text-to-image`, and Fal queues the request and serves a 1024x1024 PNG.
- When: The member sends `POST /api/image-io/generate` with size `1024x1024`, format `png` and seed 7; Fal posts the completion callback; the member reads `GET /api/built-in-generations/:generationId`.
- Then: Fal receives exactly the prompt, `image_size` `{width: 1024, height: 1024}`, one PNG and seed 7. The result charges 40 credits with model `alibaba/qwen-image-3/text-to-image`, provider `fal`, billing category `output_image.1k`, quantity 1, private artifacts, seed 7 and a short `/artifacts/*.png` URL, and the balance drops to 960.

## image-io-generate-074

- Vitest: "POST /api/image-io/generate > bills Qwen Image 3 at the high resolution tier above 2,250,000 output pixels"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses `alibaba/qwen-image-3/text-to-image`, and Fal queues the request and serves a 2048x2048 PNG.
- When: The member sends `POST /api/image-io/generate` with size `2048x2048`; Fal posts the completion callback; the member reads `GET /api/built-in-generations/:generationId`.
- Then: The result charges 75 credits with billing category `output_image.2k` and quantity 1, and the balance drops to 925.

## image-io-generate-075

- Vitest: "POST /api/image-io/generate > edits with Qwen Image 3 through fal and caps its reference images at three"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses `alibaba/qwen-image-3/text-to-image`; the member owns two stored Okou artifacts (one referenced through a resized short-artifact URL, one through the CDN artifact URL), and Fal's edit endpoint queues the request and serves a 1024x768 PNG.
- When: The member sends `POST /api/image-io/generate` with four `imageUrls`, then with the two artifact URLs plus an external URL; Fal posts the completion callback; the member reads `GET /api/built-in-generations/:generationId`.
- Then: The four-image request returns HTTP 400 with exactly `{error: {message: "imageUrls supports at most 3 images", code: "BAD_REQUEST"}}` and Fal is not called. The edit reaches Fal once; the two artifact references are replaced by presigned storage URLs for the exact artifact keys (after ownership checks on both objects) and the external URL is passed unchanged. The result charges 40 credits with model `alibaba/qwen-image-3/text-to-image`, category `output_image.1k`, private artifacts, a short artifact URL and the original source URLs, and the balance drops to 960.

## image-io-generate-076

- Vitest: "POST /api/image-io/generate > generates Nano Banana 2 Lite images through fal at its fixed 1K price"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses `google/nano-banana-2-lite`, and Fal queues the request and serves a 1024x1024 PNG.
- When: The member sends `POST /api/image-io/generate` with size `1024x1024`, format `png` and `safetyTolerance` `5`; Fal posts the completion callback; the member reads `GET /api/built-in-generations/:generationId`.
- Then: Fal receives exactly the prompt, `aspect_ratio` `1:1`, one PNG and `safety_tolerance` `5`, with no resolution parameter. The result charges 42 credits with model `google/nano-banana-2-lite`, provider `fal`, category `output_image`, quantity 1, private artifacts and a short `/artifacts/*.png` URL, and the balance drops to 958.

## image-io-generate-077

- Vitest: "POST /api/image-io/generate > generates Nano Banana 2 images through fal at standard provider prices"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses `fal-ai/nano-banana-2`, and Fal queues the request and serves a 1024x1024 WebP.
- When: The member sends `POST /api/image-io/generate` with size `1024x1024`, format `webp`, seed 123 and `safetyTolerance` `5`; Fal posts the completion callback; the member reads `GET /api/built-in-generations/:generationId`.
- Then: Fal receives one request with `Key test-fal-key` and exactly the prompt, `aspect_ratio` `1:1`, one WebP, `resolution` `1K`, seed 123 and `safety_tolerance` `5`. The result charges 80 credits with model `fal-ai/nano-banana-2`, provider `fal`, size 1024x1024, quality `model-default`, category `output_image`, quantity 1, private artifacts, seed 123 and a short `/artifacts/*.webp` URL without `sourceUrl`, and the balance drops to 920.

## image-io-generate-078

- Vitest: "POST /api/image-io/generate > edits images with Nano Banana 2 through fal"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses `fal-ai/nano-banana-2`, and Fal's edit endpoint queues the request and serves a 1536x1024 PNG.
- When: The member sends `POST /api/image-io/generate` with two reference `imageUrls`; Fal posts the completion callback; the member reads `GET /api/built-in-generations/:generationId`.
- Then: Fal's edit endpoint receives one request with `Key test-fal-key` and exactly the prompt, `aspect_ratio` `auto`, one PNG, `resolution` `1K`, `safety_tolerance` `4` and both `image_urls`. The result charges 80 credits with size 1536x1024, quality `model-default`, category `output_image`, private artifacts, a short artifact URL and the source URLs without `sourceUrl`, and the balance drops to 920.

## image-io-generate-079

- Vitest: "POST /api/image-io/generate > records a failed job when fal image generation fails"
- Mode: run
- Given: A signed-in workspace admin with 1,000 credits uses `gpt-image-1`, and Fal rejects the submission with HTTP 429 `rate limit exceeded`.
- When: The member sends `POST /api/image-io/generate` with prompt `a cat` and then reads `GET /api/built-in-generations/:generationId` for the generation announced in the realtime event.
- Then: The response is HTTP 502 with exactly `{error: {message: "Image generation failed", code: "FAL_IMAGE_REQUEST_FAILED"}}`. Fal received one request with `Key test-fal-key` and the default body. A realtime `failed` event is published and the status read returns `failed` with the same error; nothing is uploaded and the balance stays 1,000.
