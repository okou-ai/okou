# codex-reset-credit-expiry-concurrency

## codex-reset-credit-expiry-concurrency-001

- Vitest: "Codex expiry concurrent readers and cancellation > shares a concurrent 503 attempt and its cooldown while refreshing each count"
- Mode: run
- Given: A signed-in user has connected a Codex OAuth subscription via `POST /api/me/model-providers`. The ChatGPT usage endpoint returns an increasing reset-credit count on each call, and the reset-credit details endpoint stalls and then answers 503.
- When: Two `GET /api/me/model-providers` reads run concurrently while the details request is pending, then a third read follows after the 503.
- Then: Both concurrent reads return a null next reset-credit expiry with their own fresh counts (2 and 3), and the follow-up read returns a null expiry with count 4. The details endpoint receives exactly two requests in total, so the concurrent readers share one failed attempt and the follow-up read stays in its cooldown.

## codex-reset-credit-expiry-concurrency-002

- Vitest: "Codex expiry concurrent readers and cancellation > coalesces readers and isolates one caller's TimeoutError cancellation"
- Mode: run
- Given: A signed-in user has connected a Codex OAuth subscription. The usage endpoint returns an increasing reset-credit count, and the reset-credit details request stalls.
- When: Two `GET /api/me/model-providers` reads run concurrently; the first caller's request is cancelled with a `TimeoutError` ("caller deadline") before the details response arrives, then the details endpoint returns an expiry; a third read follows.
- Then: The cancelled read rejects with "caller deadline" while the shared upstream details request is not aborted. The second read returns the upstream expiry with count 3, and the third read returns the same expiry with count 4, with the details endpoint requested only twice in total.

## codex-reset-credit-expiry-concurrency-003

- Vitest: "Codex expiry concurrent readers and cancellation > aborts all-waiter work and lets a new flight survive late cleanup"
- Mode: run
- Given: A signed-in user has connected a Codex OAuth subscription, and the reset-credit details request stalls.
- When: The only reader of `GET /api/me/model-providers` cancels with an `AbortError`; the upstream then returns a new expiry two hours ahead for a fresh read; afterwards the stalled original request completes late with a different expiry and another read follows.
- Then: The cancelled read rejects with "cancelled" and the stalled upstream details request is aborted. The fresh read returns the new two-hour expiry, and after the late completion the next read still returns that new expiry. The details endpoint is requested three times in total.
