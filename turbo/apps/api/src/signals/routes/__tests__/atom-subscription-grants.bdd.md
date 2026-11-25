# atom-subscription-grants

## atom-subscription-grants-001

- Vitest: "Atom subscription grants > rejects a non-M2M or unverified credential: clerk-session"
- Mode: run
- Given: The machine secret key is configured and the identity provider verifies the Atom M2M token. The recipient is a member of the supplied organization, and the Anthropic OAuth profile API returns account details. The caller presents the signed-in user's session credential `clerk-session` as the bearer token.
- When: The caller calls `POST /api/internal/atom/subscription-grants` with a Claude Code grant for the recipient.
- Then: The response is HTTP 401 with error code `UNAUTHORIZED`.

## atom-subscription-grants-002

- Vitest: "Atom subscription grants > rejects a non-M2M or unverified credential: msk_existing_vm0_machine"
- Mode: run
- Given: The machine secret key is configured and the identity provider verifies the Atom M2M token. The recipient is a member of the supplied organization, and the Anthropic OAuth profile API returns account details. The caller presents the machine secret key `msk_existing_vm0_machine` itself as the bearer token.
- When: The caller calls `POST /api/internal/atom/subscription-grants` with a Claude Code grant for the recipient.
- Then: The response is HTTP 401 with error code `UNAUTHORIZED`.

## atom-subscription-grants-003

- Vitest: "Atom subscription grants > rejects a non-M2M or unverified credential: atom-test-grant-credential-32-characters"
- Mode: run
- Given: The machine secret key is configured and the identity provider verifies the Atom M2M token. The recipient is a member of the supplied organization, and the Anthropic OAuth profile API returns account details. The caller presents a 32-character static credential `atom-test-grant-credential-32-characters` as the bearer token.
- When: The caller calls `POST /api/internal/atom/subscription-grants` with a Claude Code grant for the recipient.
- Then: The response is HTTP 401 with error code `UNAUTHORIZED`.

## atom-subscription-grants-004

- Vitest: "Atom subscription grants > rejects a non-M2M or unverified credential: mt_invalid"
- Mode: run
- Given: The machine secret key is configured and the identity provider verifies the Atom M2M token. The recipient is a member of the supplied organization, and the Anthropic OAuth profile API returns account details. The caller presents an unverified M2M-style token `mt_invalid` as the bearer token.
- When: The caller calls `POST /api/internal/atom/subscription-grants` with a Claude Code grant for the recipient.
- Then: The response is HTTP 401 with error code `UNAUTHORIZED`.

## atom-subscription-grants-005

- Vitest: "Atom subscription grants > disables ingestion when the existing M2M secret is not configured"
- Mode: run
- Given: The recipient is a member of the supplied organization, but the machine secret key is not configured.
- When: Atom calls `POST /api/internal/atom/subscription-grants` with a valid M2M token and a Claude Code grant.
- Then: The response is HTTP 503 and the identity provider is never asked to authenticate the request.

## atom-subscription-grants-006

- Vitest: "Atom subscription grants > accepts another Clerk-authorized machine without a grant-specific allowlist"
- Mode: run
- Given: The machine secret key is configured and the identity provider verifies the Atom M2M token. The recipient is a member of the supplied organization, and the Anthropic OAuth profile API returns account details. The caller is a different machine whose M2M token the identity provider also verifies.
- When: The other machine calls `POST /api/internal/atom/subscription-grants` with a Claude Code grant, and the recipient then calls `GET /api/me/model-providers`.
- Then: The delivery returns HTTP 200 with exactly `{ grantId, status: "delivered" }`. The recipient's list contains one active `claude-code-oauth-token` provider.

## atom-subscription-grants-007

- Vitest: "Atom subscription grants > does not expose Clerk failures and allows retry after verification recovers"
- Mode: run
- Given: The machine secret key is configured and the identity provider verifies the Atom M2M token. The recipient is a member of the supplied organization, and the Anthropic OAuth profile API returns account details. The identity provider's first authentication attempt fails with an internal error whose message contains the machine secret.
- When: Atom calls `POST /api/internal/atom/subscription-grants` twice with the same grant.
- Then: The first delivery returns HTTP 503 and the body does not contain the machine secret. The retry returns HTTP 200.

## atom-subscription-grants-008

- Vitest: "Atom subscription grants > rejects a recipient who does not belong to the supplied org"
- Mode: run
- Given: The machine secret key is configured and the identity provider verifies the Atom M2M token. The recipient is a member of the supplied organization, and the Anthropic OAuth profile API returns account details. The organization membership lookup returns no membership for the recipient.
- When: Atom calls `POST /api/internal/atom/subscription-grants` for that recipient, and the recipient then calls `GET /api/me/model-providers`.
- Then: The delivery returns HTTP 403 and the recipient has no model providers.

## atom-subscription-grants-009

- Vitest: "Atom subscription grants > delivers claude-code to the selected member once and rejects recipient changes"
- Mode: run
- Given: The machine secret key is configured and the identity provider verifies the Atom M2M token. The recipient is a member of the supplied organization, and the Anthropic OAuth profile API returns account details. The grant carries a Claude Code access token.
- When: Atom calls `POST /api/internal/atom/subscription-grants` twice, the recipient calls `GET /api/me/model-providers`, and Atom then delivers the same grant ID for a different user.
- Then: Both deliveries return HTTP 200 with the same `{ grantId, status: "delivered" }`. The list contains one active `claude-code-oauth-token` provider and does not expose the access token. The changed-recipient delivery returns HTTP 409.

## atom-subscription-grants-010

- Vitest: "Atom subscription grants > delivers codex to the selected member once and rejects recipient changes"
- Mode: run
- Given: The machine secret key is configured and the identity provider verifies the Atom M2M token. The recipient is a member of the supplied organization, and the Anthropic OAuth profile API returns account details. The grant carries Codex access, refresh and ID tokens for a ChatGPT Plus account.
- When: Atom calls `POST /api/internal/atom/subscription-grants` twice, the recipient calls `GET /api/me/model-providers`, and Atom then delivers the same grant ID for a different user.
- Then: Both deliveries return HTTP 200 with the same `{ grantId, status: "delivered" }`. The list contains one active `codex-oauth-token` provider and does not expose the access token. The changed-recipient delivery returns HTTP 409.

## atom-subscription-grants-011

- Vitest: "Atom subscription grants > preserves the existing default when adding another subscription"
- Mode: run
- Given: The machine secret key is configured and the identity provider verifies the Atom M2M token. The recipient is a member of the supplied organization, and the Anthropic OAuth profile API returns account details. Atom has delivered a Claude Code grant, so the recipient has one active subscription.
- When: Atom delivers a second grant for another Claude account via `POST /api/internal/atom/subscription-grants`, and the recipient calls `GET /api/me/model-providers`.
- Then: The second delivery returns HTTP 200. The recipient has two model providers and the active one is still the first subscription.

## atom-subscription-grants-012

- Vitest: "Atom subscription grants > does not restore credentials when a delivered grant is retried after the recipient disconnects"
- Mode: run
- Given: The machine secret key is configured and the identity provider verifies the Atom M2M token. The recipient is a member of the supplied organization, and the Anthropic OAuth profile API returns account details. Atom has delivered a Claude Code grant, and the recipient disconnects it with `DELETE /api/me/model-providers/claude-code-oauth-token` (HTTP 204).
- When: Atom retries the same grant via `POST /api/internal/atom/subscription-grants`, and the recipient calls `GET /api/me/model-providers`.
- Then: The retry returns HTTP 200 and the recipient has no model providers.

## atom-subscription-grants-013

- Vitest: "Atom subscription grants > cancels a delivered claude-code grant idempotently without allowing redelivery"
- Mode: run
- Given: The machine secret key is configured and the identity provider verifies the Atom M2M token. The recipient is a member of the supplied organization, and the Anthropic OAuth profile API returns account details. Atom has delivered a Claude Code grant.
- When: Atom calls `POST /api/internal/atom/subscription-grants/:grantId/cancel` twice, the recipient lists model providers, and Atom tries to deliver the grant again.
- Then: Both cancellations return HTTP 200 with exactly `{ grantId, status: "cancelled" }`. The recipient has no model providers, the redelivery returns HTTP 409, and the recipient still has none.

## atom-subscription-grants-014

- Vitest: "Atom subscription grants > cancels a delivered codex grant idempotently without allowing redelivery"
- Mode: run
- Given: The machine secret key is configured and the identity provider verifies the Atom M2M token. The recipient is a member of the supplied organization, and the Anthropic OAuth profile API returns account details. Atom has delivered a Codex grant.
- When: Atom calls `POST /api/internal/atom/subscription-grants/:grantId/cancel` twice, the recipient lists model providers, and Atom tries to deliver the grant again.
- Then: Both cancellations return HTTP 200 with exactly `{ grantId, status: "cancelled" }`. The recipient has no model providers, the redelivery returns HTTP 409, and the recipient still has none.

## atom-subscription-grants-015

- Vitest: "Atom subscription grants > cancels before delivery and prevents an in-flight delivery from binding the subscription"
- Mode: run
- Given: The machine secret key is configured and the identity provider verifies the Atom M2M token. The recipient is a member of the supplied organization, and the Anthropic OAuth profile API returns account details. A delivery is in flight and is waiting for the Anthropic profile response.
- When: Atom calls `POST /api/internal/atom/subscription-grants/:grantId/cancel` while the delivery waits; the profile response then arrives.
- Then: The cancellation returns HTTP 200, the in-flight delivery returns HTTP 409, and the recipient has no model providers.

## atom-subscription-grants-016

- Vitest: "Atom subscription grants > keeps a cancellation receipt when delivery has not arrived yet"
- Mode: run
- Given: The machine secret key is configured and the identity provider verifies the Atom M2M token. The recipient is a member of the supplied organization, and the Anthropic OAuth profile API returns account details. The grant has not been delivered yet.
- When: Atom calls `POST /api/internal/atom/subscription-grants/:grantId/cancel`, then `POST /api/internal/atom/subscription-grants` for the same grant.
- Then: The cancellation returns HTTP 200, the later delivery returns HTTP 409, and the recipient has no model providers.

## atom-subscription-grants-017

- Vitest: "Atom subscription grants > cancels only the granted active account and leaves a usable default"
- Mode: run
- Given: The machine secret key is configured and the identity provider verifies the Atom M2M token. The recipient is a member of the supplied organization, and the Anthropic OAuth profile API returns account details. Atom has delivered two Claude Code grants for different accounts; the first one is the active default.
- When: Atom cancels the grant of the active account via `POST /api/internal/atom/subscription-grants/:grantId/cancel`, and the recipient lists model providers.
- Then: The cancellation returns HTTP 200 and only the other (previously inactive) account remains, now active.

## atom-subscription-grants-018

- Vitest: "Atom subscription grants > cancels only the granted inactive account and leaves a usable default"
- Mode: run
- Given: The machine secret key is configured and the identity provider verifies the Atom M2M token. The recipient is a member of the supplied organization, and the Anthropic OAuth profile API returns account details. Atom has delivered two Claude Code grants for different accounts; the first one is the active default.
- When: Atom cancels the grant of the inactive account via `POST /api/internal/atom/subscription-grants/:grantId/cancel`, and the recipient lists model providers.
- Then: The cancellation returns HTTP 200 and only the previously active account remains, still active.

## atom-subscription-grants-019

- Vitest: "Atom subscription grants > does not cancel a newer grant for the same upstream account"
- Mode: run
- Given: The machine secret key is configured and the identity provider verifies the Atom M2M token. The recipient is a member of the supplied organization, and the Anthropic OAuth profile API returns account details. Atom has delivered a grant and then a newer grant for the same upstream Claude account.
- When: Atom cancels the older grant twice via `POST /api/internal/atom/subscription-grants/:grantId/cancel`, the recipient lists providers, then Atom cancels the newer grant.
- Then: Both cancellations of the older grant return HTTP 200 and the account remains, active. After the newer grant is cancelled (HTTP 200), the recipient has no model providers.

## atom-subscription-grants-020

- Vitest: "Atom subscription grants > keeps a connected default when two grants are cancelled concurrently"
- Mode: run
- Given: The machine secret key is configured and the identity provider verifies the Atom M2M token. The recipient is a member of the supplied organization, and the Anthropic OAuth profile API returns account details. Atom has delivered three Claude Code grants for three different accounts.
- When: Atom cancels the first two grants concurrently via `POST /api/internal/atom/subscription-grants/:grantId/cancel`, and the recipient lists model providers.
- Then: Both cancellations return HTTP 200 and only the third account (`claude-third-account@example.com`) remains, active.

## atom-subscription-grants-021

- Vitest: "Atom subscription grants > preserves the account when the recipient has reconnected it themselves"
- Mode: run
- Given: The machine secret key is configured and the identity provider verifies the Atom M2M token. The recipient is a member of the supplied organization, and the Anthropic OAuth profile API returns account details. Atom has delivered a Claude Code grant, and the recipient then reconnects a Claude Code token themselves via `POST /api/me/model-providers`.
- When: Atom cancels the grant via `POST /api/internal/atom/subscription-grants/:grantId/cancel`, and the recipient lists model providers.
- Then: The cancellation returns HTTP 200 and the same account remains, active.

## atom-subscription-grants-022

- Vitest: "Atom subscription grants > rejects cancellation with another recipient, organization or provider"
- Mode: run
- Given: The machine secret key is configured and the identity provider verifies the Atom M2M token. The recipient is a member of the supplied organization, and the Anthropic OAuth profile API returns account details. Atom has delivered a Claude Code grant.
- When: Atom calls `POST /api/internal/atom/subscription-grants/:grantId/cancel` for the grant with a different user ID, a different organization ID, and the `codex` provider in turn.
- Then: Each cancellation returns HTTP 409 and the recipient still has one model provider.

## atom-subscription-grants-023

- Vitest: "Atom subscription grants > requires verified M2M authentication to cancel and preserves the account on auth failures"
- Mode: run
- Given: The machine secret key is configured and the identity provider verifies the Atom M2M token. The recipient is a member of the supplied organization, and the Anthropic OAuth profile API returns account details. Atom has delivered a Claude Code grant.
- When: A caller cancels via `POST /api/internal/atom/subscription-grants/:grantId/cancel` with a user session credential; then, with the machine secret key unconfigured, Atom cancels with its M2M token.
- Then: The session-credential cancellation returns HTTP 401, the unconfigured cancellation returns HTTP 503, and the recipient still has one model provider.

## atom-subscription-grants-024

- Vitest: "Atom subscription grants > can cancel after the recipient has left the organization"
- Mode: run
- Given: The machine secret key is configured and the identity provider verifies the Atom M2M token. The recipient is a member of the supplied organization, and the Anthropic OAuth profile API returns account details. Atom has delivered a Claude Code grant, and the recipient has since left the organization.
- When: Atom cancels the grant via `POST /api/internal/atom/subscription-grants/:grantId/cancel`, and the recipient lists model providers.
- Then: The cancellation returns HTTP 200 and the recipient has no model providers.
