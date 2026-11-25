# onboarding-bootstrap

## onboarding-bootstrap-001

- Vitest: "workspace creation credit grants > keeps the onboarding bonus personal to the workspace creator"
- Mode: run
- Given: A workspace creator is signed in as admin, and Clerk's signed `organization.created` webhook for the workspace has been delivered.
- When: The creator reads `GET /api/billing/status` and `GET /api/billing/usage-pack-credits`; another member of the workspace reads the usage-pack credits; then the creator reads them again.
- Then: The creator sees 0 workspace credits and no workspace grants, and 1,000 personal usage-pack credits (all bonus, none purchased, no usage pack) from a single `bonus` grant of 1,000 remaining, with member credits listing only the creator at 1,000 bonus. The other member sees 0 total, purchased and bonus credits, no grants and no member-credit breakdown. The creator's second read is identical to the first.

## onboarding-bootstrap-002

- Vitest: "workspace creation credit grants > expires the personal onboarding grant after 30 days without restarting on replay"
- Mode: run
- Given: At 2027-01-01T12:34:56.789Z a signed-in workspace creator's `organization.created` webhook is delivered.
- When: The creator reads usage-pack credits; the webhook is replayed 1 ms before 2027-01-31T12:34:56.789Z and again at that instant, with reads after each; finally the creator reads `GET /api/billing/status`.
- Then: The initial read shows a single 1,000-credit bonus grant expiring at 2027-01-31T12:34:56.789Z. The read just before expiry is identical. At expiry total and bonus credits are 0 and there are no grants, and billing status shows 0 credits and no grants.

## onboarding-bootstrap-003

- Vitest: "workspace creation credit grants > issues one personal bonus across repeated organization creation events"
- Mode: run
- Given: A signed-in workspace creator's `organization.created` webhook has been delivered once.
- When: The webhook is delivered again and the creator reads `GET /api/billing/usage-pack-credits` and `GET /api/billing/status`.
- Then: Both before and after the replay there is exactly one 1,000-credit bonus grant and 0 workspace credits, and the usage-pack response after the replay is identical to the initial one.

## onboarding-bootstrap-004

- Vitest: "workspace creation credit grants > preserves a pro purchase racing bootstrap"
- Mode: run
- Given: A signed-in workspace admin.
- When: The `organization.created` webhook and a `pro` subscription purchase are processed concurrently, then the admin reads `GET /api/billing/status`.
- Then: The billing tier is `pro`.

## onboarding-bootstrap-005

- Vitest: "workspace creation credit grants > preserves a team purchase racing bootstrap"
- Mode: run
- Given: A signed-in workspace admin.
- When: The `organization.created` webhook and a `team` subscription purchase are processed concurrently, then the admin reads `GET /api/billing/status`.
- Then: The billing tier is `team`.

## onboarding-bootstrap-006

- Vitest: "workspace creation credit grants > does not grant limited-free credits to an already pro workspace"
- Mode: run
- Given: A workspace already has a `pro` subscription and its admin is signed in.
- When: The `organization.created` webhook is delivered, then the admin reads billing status and usage-pack credits.
- Then: The tier is `pro`, and the usage-pack credits total 0 with no grants.

## onboarding-bootstrap-007

- Vitest: "workspace creation credit grants > does not grant limited-free credits to an already team workspace"
- Mode: run
- Given: A workspace already has a `team` subscription and its admin is signed in.
- When: The `organization.created` webhook is delivered, then the admin reads billing status and usage-pack credits.
- Then: The tier is `team`, and the usage-pack credits total 0 with no grants.
