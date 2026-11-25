# codex-reset-credit-expiry

## codex-reset-credit-expiry-001

- Vitest: "Codex expiry metadata resilience > caches successful dates and nulls for five minutes"
- Mode: run
- Given: A signed-in user has connected a Codex OAuth subscription (the connection itself reads reset-credit details once). The ChatGPT usage endpoint returns an increasing count, and the details endpoint first returns an expiry date and later returns a null expiry, then the date again.
- When: The user calls `GET /api/me/model-providers` at start, at +299,999 ms, at +300,000 ms, at +599,999 ms and at +600,000 ms.
- Then: Every read returns a fresh count (2 through 6). The date is served from cache until +299,999 ms (2 details requests total); at +300,000 ms a refetch returns null (3 requests), the null is served from cache until +599,999 ms, and at +600,000 ms a refetch restores the date (4 requests).

## codex-reset-credit-expiry-002

- Vitest: "Codex expiry metadata resilience > omits past expiry both on a cache hit and in upstream details"
- Mode: run
- Given: A signed-in user has connected a Codex OAuth subscription whose next reset credit expires one second from now.
- When: The user calls `GET /api/me/model-providers` immediately, after the clock advances one second, and after a further five minutes.
- Then: The first read returns the expiry; the read at the expiry moment (cache hit) and the read after five minutes (fresh upstream details still reporting the past date) both return a null expiry. The details endpoint is requested three times in total.

## codex-reset-credit-expiry-003

- Vitest: "Codex expiry metadata resilience > cools down after 503 and restores expiry at 60 seconds"
- Mode: run
- Given: A signed-in user has connected a Codex OAuth subscription, and the reset-credit details endpoint returns 503 with `Retry-After: 120`.
- When: The user calls `GET /api/me/model-providers` at start, again immediately, at +59,999 ms, and after the details endpoint recovers at +60,000 ms and once more.
- Then: Reads during the cooldown return a null expiry with fresh counts (2, 3, 4) and make no new details request (2 in total). At +60,000 ms the read returns the upstream expiry with count 5 (3 requests), and the next read returns the cached expiry with count 6 without another request.

## codex-reset-credit-expiry-004

- Vitest: "Codex expiry metadata resilience > does not revive a cached date after its TTL expires during a 503 outage"
- Mode: run
- Given: A signed-in user has connected a Codex OAuth subscription and read its expiry date; the details endpoint then returns 503 without Retry-After.
- When: The user calls `GET /api/me/model-providers` at +299,999 ms, +300,000 ms, +359,999 ms, +360,000 ms, then after the endpoint recovers with a new date at +419,999 ms and +420,000 ms.
- Then: At +299,999 ms the cached date is returned (2 requests). At +300,000 ms the expiry is null after a failed refetch (3 requests), stays null without a request at +359,999 ms, is null after another failed request at +360,000 ms (4 requests) and stays null without a request at +419,999 ms. At +420,000 ms the recovered date is returned (5 requests). Counts are fresh on every read (2 through 8).

## codex-reset-credit-expiry-005

- Vitest: "Codex expiry metadata resilience > honors Retry-After 120 without retrying usage or expiry"
- Mode: run
- Given: The clock is 2030-01-01T00:00:00Z. A signed-in user has connected a Codex OAuth subscription, and the reset-credit details endpoint returns 429 with `Retry-After: 120`.
- When: The user calls `GET /api/me/model-providers` at start, at 119,999 ms later, and after the details endpoint recovers at 120,000 ms.
- Then: The first read returns a null expiry with count 2 (2 details requests in total). The read at 119,999 ms returns a null expiry with fresh count 3 and makes no new details request. The read at 120,000 ms returns the upstream expiry with count 4 after exactly one more details request, so the cooldown is 120 seconds.

## codex-reset-credit-expiry-006

- Vitest: "Codex expiry metadata resilience > honors Retry-After Tue, 01 Jan 2030 00:02:00 GMT without retrying usage or expiry"
- Mode: run
- Given: The clock is 2030-01-01T00:00:00Z. A signed-in user has connected a Codex OAuth subscription, and the reset-credit details endpoint returns 429 with `Retry-After: Tue, 01 Jan 2030 00:02:00 GMT`.
- When: The user calls `GET /api/me/model-providers` at start, at 119,999 ms later, and after the details endpoint recovers at 120,000 ms.
- Then: The first read returns a null expiry with count 2 (2 details requests in total). The read at 119,999 ms returns a null expiry with fresh count 3 and makes no new details request. The read at 120,000 ms returns the upstream expiry with count 4 after exactly one more details request, so the cooldown is 120 seconds.

## codex-reset-credit-expiry-007

- Vitest: "Codex expiry metadata resilience > honors Retry-After Tuesday, 01-Jan-30 00:02:00 GMT without retrying usage or expiry"
- Mode: run
- Given: The clock is 2030-01-01T00:00:00Z. A signed-in user has connected a Codex OAuth subscription, and the reset-credit details endpoint returns 429 with `Retry-After: Tuesday, 01-Jan-30 00:02:00 GMT`.
- When: The user calls `GET /api/me/model-providers` at start, at 119,999 ms later, and after the details endpoint recovers at 120,000 ms.
- Then: The first read returns a null expiry with count 2 (2 details requests in total). The read at 119,999 ms returns a null expiry with fresh count 3 and makes no new details request. The read at 120,000 ms returns the upstream expiry with count 4 after exactly one more details request, so the cooldown is 120 seconds.

## codex-reset-credit-expiry-008

- Vitest: "Codex expiry metadata resilience > honors Retry-After Tue Jan \u00201 00:02:00 2030 without retrying usage or expiry"
- Mode: run
- Given: The clock is 2030-01-01T00:00:00Z. A signed-in user has connected a Codex OAuth subscription, and the reset-credit details endpoint returns 429 with `Retry-After: Tue Jan  1 00:02:00 2030`.
- When: The user calls `GET /api/me/model-providers` at start, at 119,999 ms later, and after the details endpoint recovers at 120,000 ms.
- Then: The first read returns a null expiry with count 2 (2 details requests in total). The read at 119,999 ms returns a null expiry with fresh count 3 and makes no new details request. The read at 120,000 ms returns the upstream expiry with count 4 after exactly one more details request, so the cooldown is 120 seconds.

## codex-reset-credit-expiry-009

- Vitest: "Codex expiry metadata resilience > honors Retry-After null without retrying usage or expiry"
- Mode: run
- Given: The clock is 2030-01-01T00:00:00Z. A signed-in user has connected a Codex OAuth subscription, and the reset-credit details endpoint returns 429 with no `Retry-After` header.
- When: The user calls `GET /api/me/model-providers` at start, at 59,999 ms later, and after the details endpoint recovers at 60,000 ms.
- Then: The first read returns a null expiry with count 2 (2 details requests in total). The read at 59,999 ms returns a null expiry with fresh count 3 and makes no new details request. The read at 60,000 ms returns the upstream expiry with count 4 after exactly one more details request, so the cooldown is 60 seconds.

## codex-reset-credit-expiry-010

- Vitest: "Codex expiry metadata resilience > honors Retry-After garbage without retrying usage or expiry"
- Mode: run
- Given: The clock is 2030-01-01T00:00:00Z. A signed-in user has connected a Codex OAuth subscription, and the reset-credit details endpoint returns 429 with `Retry-After: garbage`.
- When: The user calls `GET /api/me/model-providers` at start, at 59,999 ms later, and after the details endpoint recovers at 60,000 ms.
- Then: The first read returns a null expiry with count 2 (2 details requests in total). The read at 59,999 ms returns a null expiry with fresh count 3 and makes no new details request. The read at 60,000 ms returns the upstream expiry with count 4 after exactly one more details request, so the cooldown is 60 seconds.

## codex-reset-credit-expiry-011

- Vitest: "Codex expiry metadata resilience > honors Retry-After Fri, 30 Feb 2030 00:02:00 GMT without retrying usage or expiry"
- Mode: run
- Given: The clock is 2030-01-01T00:00:00Z. A signed-in user has connected a Codex OAuth subscription, and the reset-credit details endpoint returns 429 with `Retry-After: Fri, 30 Feb 2030 00:02:00 GMT`.
- When: The user calls `GET /api/me/model-providers` at start, at 59,999 ms later, and after the details endpoint recovers at 60,000 ms.
- Then: The first read returns a null expiry with count 2 (2 details requests in total). The read at 59,999 ms returns a null expiry with fresh count 3 and makes no new details request. The read at 60,000 ms returns the upstream expiry with count 4 after exactly one more details request, so the cooldown is 60 seconds.

## codex-reset-credit-expiry-012

- Vitest: "Codex expiry metadata resilience > honors Retry-After Tue, 01 Jan 2030 99:02:00 GMT without retrying usage or expiry"
- Mode: run
- Given: The clock is 2030-01-01T00:00:00Z. A signed-in user has connected a Codex OAuth subscription, and the reset-credit details endpoint returns 429 with `Retry-After: Tue, 01 Jan 2030 99:02:00 GMT`.
- When: The user calls `GET /api/me/model-providers` at start, at 59,999 ms later, and after the details endpoint recovers at 60,000 ms.
- Then: The first read returns a null expiry with count 2 (2 details requests in total). The read at 59,999 ms returns a null expiry with fresh count 3 and makes no new details request. The read at 60,000 ms returns the upstream expiry with count 4 after exactly one more details request, so the cooldown is 60 seconds.

## codex-reset-credit-expiry-013

- Vitest: "Codex expiry metadata resilience > honors Retry-After -10 without retrying usage or expiry"
- Mode: run
- Given: The clock is 2030-01-01T00:00:00Z. A signed-in user has connected a Codex OAuth subscription, and the reset-credit details endpoint returns 429 with `Retry-After: -10`.
- When: The user calls `GET /api/me/model-providers` at start, at 59,999 ms later, and after the details endpoint recovers at 60,000 ms.
- Then: The first read returns a null expiry with count 2 (2 details requests in total). The read at 59,999 ms returns a null expiry with fresh count 3 and makes no new details request. The read at 60,000 ms returns the upstream expiry with count 4 after exactly one more details request, so the cooldown is 60 seconds.

## codex-reset-credit-expiry-014

- Vitest: "Codex expiry metadata resilience > honors Retry-After 0 without retrying usage or expiry"
- Mode: run
- Given: The clock is 2030-01-01T00:00:00Z. A signed-in user has connected a Codex OAuth subscription, and the reset-credit details endpoint returns 429 with `Retry-After: 0`.
- When: The user calls `GET /api/me/model-providers` at start, at 59,999 ms later, and after the details endpoint recovers at 60,000 ms.
- Then: The first read returns a null expiry with count 2 (2 details requests in total). The read at 59,999 ms returns a null expiry with fresh count 3 and makes no new details request. The read at 60,000 ms returns the upstream expiry with count 4 after exactly one more details request, so the cooldown is 60 seconds.

## codex-reset-credit-expiry-015

- Vitest: "Codex expiry metadata resilience > honors Retry-After 1.5 without retrying usage or expiry"
- Mode: run
- Given: The clock is 2030-01-01T00:00:00Z. A signed-in user has connected a Codex OAuth subscription, and the reset-credit details endpoint returns 429 with `Retry-After: 1.5`.
- When: The user calls `GET /api/me/model-providers` at start, at 59,999 ms later, and after the details endpoint recovers at 60,000 ms.
- Then: The first read returns a null expiry with count 2 (2 details requests in total). The read at 59,999 ms returns a null expiry with fresh count 3 and makes no new details request. The read at 60,000 ms returns the upstream expiry with count 4 after exactly one more details request, so the cooldown is 60 seconds.

## codex-reset-credit-expiry-016

- Vitest: "Codex expiry metadata resilience > honors Retry-After 999999999999999999999999999 without retrying usage or expiry"
- Mode: run
- Given: The clock is 2030-01-01T00:00:00Z. A signed-in user has connected a Codex OAuth subscription, and the reset-credit details endpoint returns 429 with `Retry-After: 999999999999999999999999999`.
- When: The user calls `GET /api/me/model-providers` at start, at 59,999 ms later, and after the details endpoint recovers at 60,000 ms.
- Then: The first read returns a null expiry with count 2 (2 details requests in total). The read at 59,999 ms returns a null expiry with fresh count 3 and makes no new details request. The read at 60,000 ms returns the upstream expiry with count 4 after exactly one more details request, so the cooldown is 60 seconds.

## codex-reset-credit-expiry-017

- Vitest: "Codex expiry metadata resilience > honors Retry-After Tue, 01 Jan 2030 00:00:00 GMT without retrying usage or expiry"
- Mode: run
- Given: The clock is 2030-01-01T00:00:00Z. A signed-in user has connected a Codex OAuth subscription, and the reset-credit details endpoint returns 429 with `Retry-After: Tue, 01 Jan 2030 00:00:00 GMT`.
- When: The user calls `GET /api/me/model-providers` at start, at 59,999 ms later, and after the details endpoint recovers at 60,000 ms.
- Then: The first read returns a null expiry with count 2 (2 details requests in total). The read at 59,999 ms returns a null expiry with fresh count 3 and makes no new details request. The read at 60,000 ms returns the upstream expiry with count 4 after exactly one more details request, so the cooldown is 60 seconds.

## codex-reset-credit-expiry-018

- Vitest: "Codex expiry metadata resilience > omits the expiry after an unexpected 401 failure and preserves the count"
- Mode: run
- Given: A signed-in user has connected a Codex OAuth subscription and the reset-credit details endpoint returns HTTP 401 (row: 401); the usage endpoint still returns a count.
- When: The user calls `GET /api/me/model-providers`.
- Then: The read succeeds with a null next reset-credit expiry and the reset-credit count 2, after two details requests in total.

## codex-reset-credit-expiry-019

- Vitest: "Codex expiry metadata resilience > omits the expiry after an unexpected 500 failure and preserves the count"
- Mode: run
- Given: A signed-in user has connected a Codex OAuth subscription and the reset-credit details endpoint returns HTTP 500 (row: 500); the usage endpoint still returns a count.
- When: The user calls `GET /api/me/model-providers`.
- Then: The read succeeds with a null next reset-credit expiry and the reset-credit count 2, after two details requests in total.

## codex-reset-credit-expiry-020

- Vitest: "Codex expiry metadata resilience > omits the expiry after an unexpected json failure and preserves the count"
- Mode: run
- Given: A signed-in user has connected a Codex OAuth subscription and the reset-credit details endpoint returns malformed JSON (row: json); the usage endpoint still returns a count.
- When: The user calls `GET /api/me/model-providers`.
- Then: The read succeeds with a null next reset-credit expiry and the reset-credit count 2, after two details requests in total.

## codex-reset-credit-expiry-021

- Vitest: "Codex expiry metadata resilience > omits the expiry after an unexpected schema failure and preserves the count"
- Mode: run
- Given: A signed-in user has connected a Codex OAuth subscription and the reset-credit details endpoint returns JSON whose `credits` field is not a list (row: schema); the usage endpoint still returns a count.
- When: The user calls `GET /api/me/model-providers`.
- Then: The read succeeds with a null next reset-credit expiry and the reset-credit count 2, after two details requests in total.

## codex-reset-credit-expiry-022

- Vitest: "Codex expiry metadata resilience > omits the expiry after an unexpected transport failure and preserves the count"
- Mode: run
- Given: A signed-in user has connected a Codex OAuth subscription and the reset-credit details request fails with a network error (row: transport); the usage endpoint still returns a count.
- When: The user calls `GET /api/me/model-providers`.
- Then: The read succeeds with a null next reset-credit expiry and the reset-credit count 2, after two details requests in total.
