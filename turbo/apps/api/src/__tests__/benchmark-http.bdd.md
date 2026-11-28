# benchmark-http

## benchmark-http-001

- Vitest: "benchmark HTTP fixtures > preserves another registered handler outside R2"
- Mode: run
- Intent: review
- Given: The benchmark fixture and an existing handler for `https://fixture.example.test/status` are registered together.
- When: A benchmark client requests that status URL.
- Then: The response is HTTP 200 with exactly `{"source":"existing handler"}`.

## benchmark-http-002

- Vitest: "benchmark HTTP fixtures > lists benchmark R2 objects at https://test-account.r2.cloudflarestorage.com/test-user-artifacts"
- Mode: run
- Intent: review
- Given: The benchmark R2 fixture has an attachment named `attachments/bench-attachment.md`.
- When: A benchmark client requests `GET https://test-account.r2.cloudflarestorage.com/test-user-artifacts?list-type=2&prefix=attachments/`.
- Then: The response is HTTP 200, with an XML content type and an object key of `attachments/bench-attachment.md`.

## benchmark-http-003

- Vitest: "benchmark HTTP fixtures > lists benchmark R2 objects at https://test-user-artifacts.test-account.r2.cloudflarestorage.com/"
- Mode: run
- Intent: review
- Given: The benchmark R2 fixture has an attachment named `attachments/bench-attachment.md`.
- When: A benchmark client requests `GET https://test-user-artifacts.test-account.r2.cloudflarestorage.com/?list-type=2&prefix=attachments/`.
- Then: The response is HTTP 200, with an XML content type and an object key of `attachments/bench-attachment.md`.

## benchmark-http-004

- Vitest: "benchmark HTTP fixtures > rejects unsupported R2 buckets"
- Mode: run
- Intent: review
- Given: The benchmark R2 fixture is active and the bucket `unknown` is unsupported.
- When: A benchmark client lists objects in that bucket with `list-type=2`.
- Then: The fixture returns HTTP 404 with body `not found`.

## benchmark-http-005

- Vitest: "benchmark HTTP fixtures > keeps unexpected non-R2 requests subject to the MSW error policy"
- Mode: run
- Intent: review
- Given: The benchmark R2 fixture is active and `https://unexpected.example.test/unmocked` has no registered handler.
- When: A benchmark client requests the unhandled URL.
- Then: The request fails with the fixture's `onUnhandledRequest` error.
