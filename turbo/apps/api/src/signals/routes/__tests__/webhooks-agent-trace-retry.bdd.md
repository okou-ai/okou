# webhooks-agent-trace-retry

## webhooks-agent-trace-retry-001

- Vitest: "optional agent trace recovery > recovers 429 with the same diagnostic batch while retaining accepted chat output"
- Mode: run
- Given: A signed-in member has a chat Run executing on a sandbox, with the Okou debug feature switch enabled so diagnostic traces are sent to the trace ingest dataset; retry backoff waits complete immediately. The first trace ingest request returns HTTP 429 and the second succeeds.
- When: The sandbox calls `POST /api/webhooks/run/events` with one assistant event (sequence 0) carrying the trace output text.
- Then: The webhook returns HTTP 200 with `{ received: 1, firstSequence: 0, lastSequence: 0 }`. After background work settles, the ingest endpoint receives exactly two requests with identical bodies, and the thread events read by the member contain the trace output text.

## webhooks-agent-trace-retry-002

- Vitest: "optional agent trace recovery > recovers 500 with the same diagnostic batch while retaining accepted chat output"
- Mode: run
- Given: A signed-in member has a chat Run executing on a sandbox, with the Okou debug feature switch enabled so diagnostic traces are sent to the trace ingest dataset; retry backoff waits complete immediately. The first trace ingest request returns HTTP 500 and the second succeeds.
- When: The sandbox calls `POST /api/webhooks/run/events` with one assistant event (sequence 0) carrying the trace output text.
- Then: The webhook returns HTTP 200 with `{ received: 1, firstSequence: 0, lastSequence: 0 }`. After background work settles, the ingest endpoint receives exactly two requests with identical bodies, and the thread events read by the member contain the trace output text.

## webhooks-agent-trace-retry-003

- Vitest: "optional agent trace recovery > recovers 502 with the same diagnostic batch while retaining accepted chat output"
- Mode: run
- Given: A signed-in member has a chat Run executing on a sandbox, with the Okou debug feature switch enabled so diagnostic traces are sent to the trace ingest dataset; retry backoff waits complete immediately. The first trace ingest request returns HTTP 502 and the second succeeds.
- When: The sandbox calls `POST /api/webhooks/run/events` with one assistant event (sequence 0) carrying the trace output text.
- Then: The webhook returns HTTP 200 with `{ received: 1, firstSequence: 0, lastSequence: 0 }`. After background work settles, the ingest endpoint receives exactly two requests with identical bodies, and the thread events read by the member contain the trace output text.

## webhooks-agent-trace-retry-004

- Vitest: "optional agent trace recovery > recovers 503 with the same diagnostic batch while retaining accepted chat output"
- Mode: run
- Given: A signed-in member has a chat Run executing on a sandbox, with the Okou debug feature switch enabled so diagnostic traces are sent to the trace ingest dataset; retry backoff waits complete immediately. The first trace ingest request returns HTTP 503 and the second succeeds.
- When: The sandbox calls `POST /api/webhooks/run/events` with one assistant event (sequence 0) carrying the trace output text.
- Then: The webhook returns HTTP 200 with `{ received: 1, firstSequence: 0, lastSequence: 0 }`. After background work settles, the ingest endpoint receives exactly two requests with identical bodies, and the thread events read by the member contain the trace output text.

## webhooks-agent-trace-retry-005

- Vitest: "optional agent trace recovery > recovers 504 with the same diagnostic batch while retaining accepted chat output"
- Mode: run
- Given: A signed-in member has a chat Run executing on a sandbox, with the Okou debug feature switch enabled so diagnostic traces are sent to the trace ingest dataset; retry backoff waits complete immediately. The first trace ingest request returns HTTP 504 and the second succeeds.
- When: The sandbox calls `POST /api/webhooks/run/events` with one assistant event (sequence 0) carrying the trace output text.
- Then: The webhook returns HTTP 200 with `{ received: 1, firstSequence: 0, lastSequence: 0 }`. After background work settles, the ingest endpoint receives exactly two requests with identical bodies, and the thread events read by the member contain the trace output text.

## webhooks-agent-trace-retry-006

- Vitest: "optional agent trace recovery > recovers transport with the same diagnostic batch while retaining accepted chat output"
- Mode: run
- Given: A signed-in member has a chat Run executing on a sandbox, with the Okou debug feature switch enabled so diagnostic traces are sent to the trace ingest dataset; retry backoff waits complete immediately. The first trace ingest request fails with a transport (network) error and the second succeeds.
- When: The sandbox calls `POST /api/webhooks/run/events` with one assistant event (sequence 0) carrying the trace output text.
- Then: The webhook returns HTTP 200 with `{ received: 1, firstSequence: 0, lastSequence: 0 }`. After background work settles, the ingest endpoint receives exactly two requests with identical bodies, and the thread events read by the member contain the trace output text.

## webhooks-agent-trace-retry-007

- Vitest: "optional agent trace recovery > stops after two temporary failures without replaying the accepted webhook"
- Mode: run
- Given: A signed-in member has a chat Run executing on a sandbox, with the Okou debug feature switch enabled so diagnostic traces are sent to the trace ingest dataset; retry backoff waits complete immediately. Every trace ingest request returns HTTP 503.
- When: The sandbox calls `POST /api/webhooks/run/events` with one assistant event (sequence 0) carrying the trace output text.
- Then: The webhook returns HTTP 200, and after background work settles the ingest endpoint receives exactly two requests.

## webhooks-agent-trace-retry-008

- Vitest: "optional agent trace recovery > does not retry permanent HTTP 400"
- Mode: run
- Given: A signed-in member has a chat Run executing on a sandbox, with the Okou debug feature switch enabled so diagnostic traces are sent to the trace ingest dataset; retry backoff waits complete immediately. Every trace ingest request returns HTTP 400.
- When: The sandbox calls `POST /api/webhooks/run/events` with one assistant event (sequence 0) carrying the trace output text.
- Then: The webhook returns HTTP 200, and after background work settles the ingest endpoint receives exactly one request.

## webhooks-agent-trace-retry-009

- Vitest: "optional agent trace recovery > does not retry permanent HTTP 401"
- Mode: run
- Given: A signed-in member has a chat Run executing on a sandbox, with the Okou debug feature switch enabled so diagnostic traces are sent to the trace ingest dataset; retry backoff waits complete immediately. Every trace ingest request returns HTTP 401.
- When: The sandbox calls `POST /api/webhooks/run/events` with one assistant event (sequence 0) carrying the trace output text.
- Then: The webhook returns HTTP 200, and after background work settles the ingest endpoint receives exactly one request.

## webhooks-agent-trace-retry-010

- Vitest: "optional agent trace recovery > does not retry permanent HTTP 403"
- Mode: run
- Given: A signed-in member has a chat Run executing on a sandbox, with the Okou debug feature switch enabled so diagnostic traces are sent to the trace ingest dataset; retry backoff waits complete immediately. Every trace ingest request returns HTTP 403.
- When: The sandbox calls `POST /api/webhooks/run/events` with one assistant event (sequence 0) carrying the trace output text.
- Then: The webhook returns HTTP 200, and after background work settles the ingest endpoint receives exactly one request.

## webhooks-agent-trace-retry-011

- Vitest: "optional agent trace recovery > does not retry permanent HTTP 404"
- Mode: run
- Given: A signed-in member has a chat Run executing on a sandbox, with the Okou debug feature switch enabled so diagnostic traces are sent to the trace ingest dataset; retry backoff waits complete immediately. Every trace ingest request returns HTTP 404.
- When: The sandbox calls `POST /api/webhooks/run/events` with one assistant event (sequence 0) carrying the trace output text.
- Then: The webhook returns HTTP 200, and after background work settles the ingest endpoint receives exactly one request.

## webhooks-agent-trace-retry-012

- Vitest: "optional agent trace recovery > does not retry permanent HTTP 413"
- Mode: run
- Given: A signed-in member has a chat Run executing on a sandbox, with the Okou debug feature switch enabled so diagnostic traces are sent to the trace ingest dataset; retry backoff waits complete immediately. Every trace ingest request returns HTTP 413.
- When: The sandbox calls `POST /api/webhooks/run/events` with one assistant event (sequence 0) carrying the trace output text.
- Then: The webhook returns HTTP 200, and after background work settles the ingest endpoint receives exactly one request.

## webhooks-agent-trace-retry-013

- Vitest: "optional agent trace recovery > does not replay invalid-json responses"
- Mode: run
- Given: A signed-in member has a chat Run executing on a sandbox, with the Okou debug feature switch enabled so diagnostic traces are sent to the trace ingest dataset; retry backoff waits complete immediately. The trace ingest endpoint responds with the non-JSON text `not JSON`.
- When: The sandbox calls `POST /api/webhooks/run/events` with one assistant event (sequence 0) carrying the trace output text.
- Then: The webhook returns HTTP 200, and after background work settles the ingest endpoint receives exactly one request.

## webhooks-agent-trace-retry-014

- Vitest: "optional agent trace recovery > does not replay partial-ingest responses"
- Mode: run
- Given: A signed-in member has a chat Run executing on a sandbox, with the Okou debug feature switch enabled so diagnostic traces are sent to the trace ingest dataset; retry backoff waits complete immediately. The trace ingest endpoint responds with a partial-ingest result (`ingested: 0`, `failed: 1`).
- When: The sandbox calls `POST /api/webhooks/run/events` with one assistant event (sequence 0) carrying the trace output text.
- Then: The webhook returns HTTP 200, and after background work settles the ingest endpoint receives exactly one request.

## webhooks-agent-trace-retry-015

- Vitest: "optional agent trace recovery > respects the provider's Retry-After minimum before recovering"
- Mode: run
- Given: A signed-in member has a chat Run executing on a sandbox, with the Okou debug feature switch enabled. The clock is frozen and advances only by each backoff wait. The first trace ingest request returns HTTP 429 with `Retry-After: 1` and the second succeeds.
- When: The sandbox calls `POST /api/webhooks/run/events` with one assistant event (sequence 0) carrying the trace output text.
- Then: The webhook returns HTTP 200, and the ingest endpoint receives two requests: one at the start time and one exactly 1000 ms later.

## webhooks-agent-trace-retry-016

- Vitest: "optional agent trace recovery > stops retries on API lifetime cancellation during backoff"
- Mode: run
- Given: A signed-in member has a chat Run executing on a sandbox, with the Okou debug feature switch enabled. Every trace ingest request returns HTTP 503, and the API request lifetime is cancelled during the first backoff wait.
- When: The sandbox calls `POST /api/webhooks/run/events` with one assistant event (sequence 0) carrying the trace output text.
- Then: The webhook returns HTTP 200, and the ingest endpoint receives exactly one request.

## webhooks-agent-trace-retry-017

- Vitest: "optional agent trace recovery > keeps required telemetry HTTP 503 outside optional trace recovery"
- Mode: run
- Given: A signed-in member has a chat Run executing on a sandbox (debug traces not enabled). The required sandbox network telemetry ingest dataset returns HTTP 503.
- When: The sandbox calls `POST /api/webhooks/run/telemetry` with one network log entry for host `required-ingest.example.test`.
- Then: The response is HTTP 500, and the network telemetry ingest endpoint receives exactly one request.
