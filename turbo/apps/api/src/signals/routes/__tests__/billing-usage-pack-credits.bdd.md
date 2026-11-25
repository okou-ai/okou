# billing-usage-pack-credits

## billing-usage-pack-credits-001

- Vitest: "GET /api/billing/usage-pack-credits > reports when the organization has no active usage pack"
- Mode: run
- Given: The environment is development. A signed-in `org:member` belongs to an organization with no usage pack.
- When: The member requests `GET /api/billing/usage-pack-credits`.
- Then: The API responds with HTTP 200 `{ totalCredits: 0, purchasedCredits: 0, bonusCredits: 0, creditGrants: [], hasUsagePack: false }`.

## billing-usage-pack-credits-002

- Vitest: "GET /api/billing/usage-pack-credits > reports no usage pack for a member without an active allocation"
- Mode: run
- Given: The environment is development. A signed-in `org:member`'s organization has purchased a $20 usage pack allocated only to another member.
- When: The member requests `GET /api/billing/usage-pack-credits`.
- Then: The API responds with HTTP 200 `{ totalCredits: 0, purchasedCredits: 0, bonusCredits: 0, creditGrants: [], hasUsagePack: false }`.

## billing-usage-pack-credits-003

- Vitest: "GET /api/billing/usage-pack-credits > returns a check-in bonus without a usage pack allocation"
- Mode: run
- Given: The environment is development and the clock is 2026-08-10T00:00Z. A signed-in `org:member` has checked in through `POST /api/get-started/check-in` under the marketing check-in campaign, and has no usage pack allocation.
- When: The member requests `GET /api/billing/usage-pack-credits`.
- Then: The API responds with HTTP 200 with 100 total credits, 0 purchased, 100 bonus, `hasUsagePack: false`, and a single `bonus` grant of 100 (100 remaining) expiring 2026-08-17T00:00Z.

## billing-usage-pack-credits-004

- Vitest: "GET /api/billing/usage-pack-credits > returns only the current member's active purchased and bonus credits"
- Mode: run
- Given: The environment is development. A signed-in `org:member` checked in on 2026-08-02 (a 7-day bonus). On 2026-08-10 the organization purchases usage packs: $20 for this member and $50 for another member.
- When: On 2026-08-10 the member requests `GET /api/billing/usage-pack-credits`.
- Then: The API responds with HTTP 200 with 20,400 total credits, 20,000 purchased, 400 bonus and `hasUsagePack: true`, and exactly two grants: `purchased` 20,000 and `bonus` 400 (each fully remaining), both expiring 2026-09-09T00:00Z. The expired check-in bonus and the other member's credits are not included.

## billing-usage-pack-credits-005

- Vitest: "GET /api/billing/usage-pack-credits > returns every member's active usage pack balance to an admin"
- Mode: run
- Given: The environment is development and the clock is 2026-08-10T00:00Z. A signed-in org admin's organization has purchased usage packs: $20 for the admin and $50 for another member.
- When: The admin requests `GET /api/billing/usage-pack-credits`.
- Then: The API responds with HTTP 200, `hasUsagePack: true`, and exactly two `memberCredits` entries, each with two grants: the admin with 20,400 total (20,000 purchased, 400 bonus remaining) and the other member with 52,600 total (50,000 purchased, 2,600 bonus remaining).
