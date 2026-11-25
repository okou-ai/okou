# agentphone-verification

## agentphone-verification-001

- Vitest: "AgentPhone verification send cooldown > reserves a cold user/org race once without consuming the rejected phone"
- Mode: run
- Given: AgentPhone is configured and accepts verification messages. A signed-in member with no prior verification send has read `GET /api/integrations/agentphone/link`, and the clock is fixed.
- When: The member sends two concurrent `POST /api/integrations/agentphone/link` requests for two different phone numbers, then a different member sends `POST /api/integrations/agentphone/link` for the number that was rejected.
- Then: One concurrent request returns HTTP 200 and the other HTTP 429. The other member's request for the rejected number returns HTTP 200 with exactly `{ phoneHandle, verificationSent: true }`, so the rejected attempt did not consume that phone's cooldown.

## agentphone-verification-002

- Vitest: "AgentPhone verification send cooldown > keeps both cooldowns after a provider rejection until the original 60 seconds expire"
- Mode: run
- Given: AgentPhone is configured and rejects the first verification message with HTTP 503 (provider rejection); afterwards it accepts messages. Two signed-in members exist and the clock starts at a fixed time.
- When: The first member sends `POST /api/integrations/agentphone/link` for phone A; then the first member requests phone B, the second member requests phone A, the second member requests phone B, and the first member retries phone A at 59.999 seconds and at exactly 60 seconds.
- Then: The first request returns HTTP 503 with `PROVIDER_UNAVAILABLE`. The same-user and same-phone requests return HTTP 429 with `TOO_MANY_REQUESTS`, while the second member's request for phone B returns HTTP 200 with `verificationSent: true`. The retry at 59.999 seconds returns HTTP 429, and at 60 seconds returns HTTP 200 with `{ phoneHandle, verificationSent: true }`.

## agentphone-verification-003

- Vitest: "AgentPhone verification send cooldown > keeps both cooldowns after a network failure until the original 60 seconds expire"
- Mode: run
- Given: AgentPhone is configured and the first verification message fails with a network error (network failure); afterwards it accepts messages. Two signed-in members exist and the clock starts at a fixed time.
- When: The first member sends `POST /api/integrations/agentphone/link` for phone A; then the first member requests phone B, the second member requests phone A, the second member requests phone B, and the first member retries phone A at 59.999 seconds and at exactly 60 seconds.
- Then: The first request returns HTTP 503 with `PROVIDER_UNAVAILABLE`. The same-user and same-phone requests return HTTP 429 with `TOO_MANY_REQUESTS`, while the second member's request for phone B returns HTTP 200 with `verificationSent: true`. The retry at 59.999 seconds returns HTTP 429, and at 60 seconds returns HTTP 200 with `{ phoneHandle, verificationSent: true }`.

## agentphone-verification-004

- Vitest: "AgentPhone verification send cooldown > rejects a concurrent request for the same phone before the provider responds"
- Mode: run
- Given: AgentPhone is configured and holds the first verification message without responding. A signed-in member has a verification send for a phone in flight.
- When: A different member sends `POST /api/integrations/agentphone/link` for the same phone while the first send is pending, then AgentPhone responds.
- Then: The concurrent request returns HTTP 429 with `TOO_MANY_REQUESTS`, and the original request completes with HTTP 200 and exactly `{ phoneHandle, verificationSent: true }`.

## agentphone-verification-005

- Vitest: "AgentPhone verification send cooldown > rejects a concurrent request for the same user/org before the provider responds"
- Mode: run
- Given: AgentPhone is configured and holds the first verification message without responding. A signed-in member has a verification send for a phone in flight.
- When: The same member (same user and workspace) sends `POST /api/integrations/agentphone/link` for a different phone while the first send is pending, then AgentPhone responds.
- Then: The concurrent request returns HTTP 429 with `TOO_MANY_REQUESTS`, and the original request completes with HTTP 200 and exactly `{ phoneHandle, verificationSent: true }`.

## agentphone-verification-006

- Vitest: "AgentPhone verification send cooldown > retains the committed cooldown when the API owner aborts an in-flight send"
- Mode: run
- Given: AgentPhone is configured and holds the verification message without responding. A signed-in member has read `GET /api/integrations/agentphone/link`.
- When: The member's `POST /api/integrations/agentphone/link` is aborted by the API's owner signal while the provider send is in flight, AgentPhone then responds, and the member retries `POST /api/integrations/agentphone/link` for the same phone.
- Then: The in-flight request fails with an `AbortError`, and the retry returns HTTP 429 with `TOO_MANY_REQUESTS` because the committed cooldown is retained.
