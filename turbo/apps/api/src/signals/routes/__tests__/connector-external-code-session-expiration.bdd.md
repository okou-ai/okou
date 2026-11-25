# connector-external-code-session-expiration

## connector-external-code-session-expiration-001

- Vitest: "Builtin external-code session expiration > expires an exact non-default reconnect only after its deadline and preserves both accounts through recovery and completed replay"
- Mode: run
- Given: An authenticated owner has two distinct AWS CLI accounts and starts a reconnect for the non-default account. AWS rejects a bad code.
- When: The owner posts the bad code to POST /api/connectors/aws/external-code/sessions/:sessionId/complete at the exact session deadline, rechecks one millisecond later, and starts and completes a fresh reconnect for the same account. The owner replays the completed recovery after its own deadline.
- Then: The exact deadline returns HTTP 400 BAD_REQUEST instructing the caller to check the rejected external authorization code and try again. One millisecond later the original returns HTTP 400 BAD_REQUEST with message External-code authorization session expired, consistently even after recovery. The new session and its replay return HTTP 200 for the exact existing sibling, both IDs and default roles remain, and responses omit secrets.

## connector-external-code-session-expiration-002

- Vitest: "Builtin external-code session expiration > keeps completing sessions exclusive at the strict stale boundary then expires without publishing the late successful account"
- Mode: run
- Given: An authenticated owner starts an AWS CLI add session whose deadline is before 30 minutes. The first valid provider exchange is in flight with its successful response held.
- When: The owner repeats POST /api/connectors/aws/external-code/sessions/:sessionId/complete at the deadline, a millisecond afterwards, exactly 30 minutes from the initial request and a millisecond after that. The provider then releases its late success.
- Then: The first three repeats return HTTP 400 BAD_REQUEST with message External-code authorization session is already completing. After 30 minutes plus one millisecond replies consistently return HTTP 400 BAD_REQUEST with message External-code authorization session expired, including after the delayed response. The original in-flight request returns HTTP 500 Internal server error and no account is published or listed. Responses omit secrets.
