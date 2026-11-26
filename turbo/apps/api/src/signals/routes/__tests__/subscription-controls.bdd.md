# subscription-controls

## subscription-controls-001

- Vitest: "subscription listing requires an authenticated organization session"
- Mode: run
- Given: One caller is not authenticated, and another is a signed-in user without an active organization.
- When: Each caller lists subscriptions with `GET /api/me/3rd-party-subscriptions`.
- Then: Both requests return HTTP 401.

## subscription-controls-002

- Vitest: "agents read all subscriptions and single-account live usage without a failed run"
- Mode: run
- Given: A user has connected two Codex subscriptions through device authentication. ChatGPT reports a Pro plan with a 5-hour window at 75% used resetting at 2029-12-31T20:00:00Z, a weekly window at 40% used, and 3 reset credits. The caller is an Agent using the user's Run execution token.
- When: The Agent lists `GET /api/me/3rd-party-subscriptions` and reads `GET /api/me/subscriptions/:id` for the first account, the second account, and the first account again.
- Then: The list returns HTTP 200 with exactly the two account IDs. The first account's detail shows reset supported, 3 reset credits, 5-hour usage 75% used / 25% remaining with the 2029-12-31T20:00:00.000Z reset, weekly 60% remaining, and a logical `modelProviderId` that matches its list entry. The second account has the same `modelProviderId` and type `codex-oauth-token`, and the repeated read returns the same ID and provider ID. No list or detail entry exposes `secrets`, `externalAccountId`, `orgId` or `userId`.

## subscription-controls-003

- Vitest: "cLI account activation reuses the existing switch behavior"
- Mode: run
- Given: A user has connected two Codex subscriptions, the first one active. The caller is an Agent using the user's Run execution token.
- When: The Agent activates the second account with `POST /api/me/model-provider-accounts/:id/activate`, lists subscriptions, activates it again, and lists again.
- Then: Activation returns HTTP 200 with the second account marked active and no `secrets`, `externalAccountId`, `orgId` or `userId`. The list then orders the second account first, with only it active. The repeated activation returns HTTP 200 with the same provider ID and active state, and the list still has exactly the second account active and the same order.

## subscription-controls-004

- Vitest: "an executing agent cannot execute a subscription reset"
- Mode: run
- Given: A user has a Codex subscription with 3 reset credits. The caller is an Agent using the user's Run execution token.
- When: The Agent requests `POST /api/me/model-provider-accounts/:id/subscription-reset` with an idempotency key.
- Then: The request returns HTTP 403, the account still lists 3 reset credits, and no reset credit is consumed at ChatGPT.

## subscription-controls-005

- Vitest: "a missing run cannot authorize recovery or reset of a connected account"
- Mode: run
- Given: A signed-in user has two connected Codex subscriptions, and the referenced Run ID does not exist.
- When: The user reads `GET /api/me/model-provider-accounts/:id?runId=<missing>` for their account and for a random account, then requests `POST /api/me/model-provider-accounts/:id/runs/:runId/subscription-reset` for both, then reads the account's subscription detail.
- Then: Both reads return HTTP 404 with identical bodies, and both resets return HTTP 404 with identical bodies. The subscription detail still shows 3 reset credits and no `secrets` or `externalAccountId`.

## subscription-controls-006

- Vitest: "foreign users and organizations cannot read or activate the linked account"
- Mode: run
- Given: A user has two connected Codex subscriptions. Two other signed-in users exist: one in the same organization and one with the same user ID in another organization.
- When: Each other user lists subscriptions, reads `GET /api/me/subscriptions/:id` for the user's account and for a random ID, and activates both via `POST /api/me/model-provider-accounts/:id/activate`.
- Then: Each other user's list is empty. Reading the user's account and the random ID both return HTTP 404 with identical bodies, and both activations return HTTP 404 with identical bodies.

## subscription-controls-007

- Vitest: "reset rejects foreign, logical-provider and disconnected IDs without changing a sibling"
- Mode: run
- Given: A signed-in user has two connected Codex subscriptions and deletes the second with `DELETE /api/me/model-provider-accounts/:id` (HTTP 204).
- When: Subscription resets are requested via `POST /api/me/model-provider-accounts/:id/subscription-reset` for a random ID, the logical provider ID, the deleted account, and the remaining account by a same-organization user and by a same-user-ID user in another organization.
- Then: Every reset returns HTTP 404 with `{ error: { message: "Resource not found", code: "NOT_FOUND" } }`. The user's list contains only the remaining account, active, with its original provider ID, reset credits and usage.

## subscription-controls-008

- Vitest: "an unavailable upstream usage read keeps quota unknown instead of fabricating zero"
- Mode: run
- Given: A signed-in user has a connected Codex subscription, and the ChatGPT usage endpoint returns HTTP 503.
- When: The user reads `GET /api/me/subscriptions/:id`.
- Then: The request returns HTTP 200 for the account with reset supported, while subscription usage and reset credits are null or absent.

## subscription-controls-009

- Vitest: "claude Code exposes natural usage windows but explicitly rejects manual reset"
- Mode: run
- Given: A signed-in user connects a Claude Code OAuth token with `POST /api/me/model-providers`, and Anthropic reports usage with 88% of the 5-hour and 76% of the weekly window remaining.
- When: The user reads `GET /api/me/subscriptions/:id` and then requests `POST /api/me/model-provider-accounts/:id/subscription-reset`.
- Then: The connection returns HTTP 201. The detail shows reset not supported with 5-hour 88% remaining and weekly 76% remaining. The reset request returns HTTP 404.

## subscription-controls-010

- Vitest: "mixed subscriptions keep provider usage separate when Claude usage becomes unavailable"
- Mode: run
- Given: A signed-in user has two Codex subscriptions (75% 5-hour and 40% weekly usage) and connects a Claude Code OAuth token (12% 5-hour and 24% weekly usage).
- When: The user lists `GET /api/me/3rd-party-subscriptions`, then the Anthropic usage endpoint starts returning HTTP 503 and the user lists again.
- Then: The first list contains all three accounts with each provider's own usage. The second list has the same accounts in the same order, the Codex entries are unchanged, and the Claude Code entry is still `claude-code-oauth-token` with `needsReconnect: false` and null or absent usage.

## subscription-controls-011

- Vitest: "a subscription reset link does not grant unauthenticated access"
- Mode: run
- Given: The caller is not authenticated.
- When: The caller reads `GET /api/me/subscriptions/:id` for a random ID, as reached from a subscription reset link.
- Then: The request returns HTTP 401.
