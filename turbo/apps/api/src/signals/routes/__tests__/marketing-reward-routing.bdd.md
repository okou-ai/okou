# marketing-reward-routing

## marketing-reward-routing-001

- Vitest: "forwards authenticated campaign status and recovers a check-in from the ledger after a lost Marketing response"
- Mode: run
- Given: An authenticated member has no campaign service configured at first. Once configured, the service receives the user and organization and successfully settles a check-in before losing its response.
- When: The member reads status, checks in before and after configuration, then checks in again in another organization on the same day.
- Then: Before configuration status is HTTP 404 and check-in HTTP 503. The later status returns HTTP 200 with claimedToday false. The lost response is recovered as HTTP 200 with a granted reward of 100, original timestamp and seven-day expiry. The other organization’s repeat returns the identical receipt.

## marketing-reward-routing-002

- Vitest: "a Marketing acknowledgement cannot fabricate money and a retained pending request can be funded later exactly once"
- Mode: run
- Given: The campaign claims it granted a reward, but no authenticated settlement has funded it.
- When: The member checks in and reads credits. An authorized financial service later settles the retained source, and the member repeats check-in twice.
- Then: Initially HTTP 202 reports pending, the retained event matches the request and actor, and bonus credits are zero. The funded repeat returns HTTP 200 with a granted result, subsequent replay returns the same result, and the credit read shows exactly 100 bonus credits.
