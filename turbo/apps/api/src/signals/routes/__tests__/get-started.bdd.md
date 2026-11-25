# get-started

## get-started-001

- Vitest: "concurrent Marketing check-ins and org switches preserve one award and its exact 168-hour expiry"
- Mode: run
- Given: A signed-in admin, at 2026-09-15T23:59:59.123Z, and the Marketing rewards service settles daily check-in rewards back through the API.
- When: The admin sends five concurrent `POST /api/get-started/check-in` requests, reads `GET /api/billing/usage-pack-credits`, checks in again after switching to another workspace, and checks in once more at 2026-09-16T00:00:00Z.
- Then: All five return the same award ID with `status: "granted"`, `rewardAmount: 100`, `rewardTarget: "user"`, `grantedAt` 2026-09-15T23:59:59.123Z and `expiresAt` 2026-09-22T23:59:59.123Z. The balance shows 100 bonus credits in exactly one bonus grant of 100 remaining with that expiry. The check-in from the other workspace returns exactly the same award, and the next-day check-in returns a different award ID.

## get-started-002

- Vitest: "concurrent check-ins across organizations return one personal award and publish credits only in the winning organization"
- Mode: run
- Given: One user is signed in to two workspaces at 2026-09-15T08:00Z, and the Marketing rewards service settles check-ins back through the API.
- When: The user sends five concurrent `POST /api/get-started/check-in` requests from each workspace, then reads `GET /api/billing/usage-pack-credits` in both workspaces.
- Then: All ten responses equal one award with `status: "granted"`, `rewardAmount: 100`, `rewardTarget: "user"`, `grantedAt` 2026-09-15T08:00:00.000Z and `expiresAt` 2026-09-22T08:00:00.000Z. One workspace shows 100 bonus credits and the other 0, with exactly one bonus grant of 100 remaining across both.

## get-started-003

- Vitest: "a personal check-in bonus is visible without a purchased Usage Pack and disappears exactly at expiry"
- Mode: run
- Given: A signed-in member without a purchased Usage Pack checks in with `POST /api/get-started/check-in` at 2026-09-15T06:30:00.500Z.
- When: The member reads `GET /api/billing/usage-pack-credits` immediately, at 2026-09-22T06:30:00.499Z, and at 2026-09-22T06:30:00.500Z.
- Then: The first read shows `hasUsagePack: false`, `purchasedCredits: 0`, `bonusCredits: 100`, `totalCredits: 100`. One millisecond before expiry the bonus is still 100. At expiry it shows `bonusCredits: 0`, `totalCredits: 0`, and no credit grants.
