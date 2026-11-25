# billing-feedback

## billing-feedback-001

- Vitest: "settles survey 01a20bd6-511f-0000-70b9-87889e169e85 once and expires the bonus after 30 days"
- Mode: run
- Given: The PostHog survey destination secret is configured. A signed-in admin of a free organization requests an offer from `GET /api/billing/feedback-reward` and receives 200 reward credits and a signed token. The survey is the `credits_exhausted` survey (`01a20bd6-511f-0000-70b9-87889e169e85`).
- When: The PostHog destination posts a completed `survey sent` event for that survey with the user, org and token to `POST /api/webhooks/posthog/surveys` using the shared secret, posts the same event again, and the clock then advances 30 days.
- Then: The first settlement returns `rewardCredits: 200` and `GET /api/billing/usage-pack-credits` shows bonus credits increased by 200. The repeat returns `rewardCredits: 0`, and the offer endpoint then returns `{ rewardCredits: 0, token: null }`. After 30 days the bonus credits return to the original balance and the offer stays `{ rewardCredits: 0, token: null }`.

## billing-feedback-002

- Vitest: "settles survey 01a20bd6-5392-0000-848c-57c2b7d65180 once and expires the bonus after 30 days"
- Mode: run
- Given: The PostHog survey destination secret is configured. A signed-in admin of a free organization requests an offer from `GET /api/billing/feedback-reward` and receives 200 reward credits and a signed token. The survey is the `upgrade_dismissed` survey (`01a20bd6-5392-0000-848c-57c2b7d65180`).
- When: The PostHog destination posts a completed `survey sent` event for that survey with the user, org and token to `POST /api/webhooks/posthog/surveys` using the shared secret, posts the same event again, and the clock then advances 30 days.
- Then: The first settlement returns `rewardCredits: 200` and `GET /api/billing/usage-pack-credits` shows bonus credits increased by 200. The repeat returns `rewardCredits: 0`, and the offer endpoint then returns `{ rewardCredits: 0, token: null }`. After 30 days the bonus credits return to the original balance and the offer stays `{ rewardCredits: 0, token: null }`.

## billing-feedback-003

- Vitest: "settles survey 01a20bd6-55a8-0000-721e-f04ef7abf01c once and expires the bonus after 30 days"
- Mode: run
- Given: The PostHog survey destination secret is configured. A signed-in admin of a free organization requests an offer from `GET /api/billing/feedback-reward` and receives 200 reward credits and a signed token. The survey is the `checkout_canceled` survey (`01a20bd6-55a8-0000-721e-f04ef7abf01c`).
- When: The PostHog destination posts a completed `survey sent` event for that survey with the user, org and token to `POST /api/webhooks/posthog/surveys` using the shared secret, posts the same event again, and the clock then advances 30 days.
- Then: The first settlement returns `rewardCredits: 200` and `GET /api/billing/usage-pack-credits` shows bonus credits increased by 200. The repeat returns `rewardCredits: 0`, and the offer endpoint then returns `{ rewardCredits: 0, token: null }`. After 30 days the bonus credits return to the original balance and the offer stays `{ rewardCredits: 0, token: null }`.

## billing-feedback-004

- Vitest: "deduplicates different surveys submitted concurrently by two admins in one organization"
- Mode: run
- Given: Two admins of the same free organization each obtain a reward offer token from `GET /api/billing/feedback-reward`, and both remain organization admins.
- When: The PostHog destination concurrently posts a completed `upgrade_dismissed` survey for the first admin and a completed `checkout_canceled` survey for the second admin to `POST /api/webhooks/posthog/surveys`, then posts a completed `credits_exhausted` survey with the first admin's token.
- Then: Both concurrent settlements return HTTP 200, one with `rewardCredits: 200` and the other with `0`. The third survey returns `rewardCredits: 0`. The two admins' bonus credits read from `GET /api/billing/usage-pack-credits` sum to exactly 200.

## billing-feedback-005

- Vitest: "rejects direct browser claims and a reward offer reused for another identity"
- Mode: run
- Given: A signed-in admin of a free organization has a reward offer token, and another user in a different organization exists.
- When: The admin posts the completed survey to `POST /api/webhooks/posthog/surveys` with their own Clerk session instead of the destination secret, and the destination then posts the same token with the other user's ID and organization using the secret.
- Then: Both requests return HTTP 401, and the admin's bonus credits remain 0.

## billing-feedback-006

- Vitest: "does not reward partial responses or unrelated surveys"
- Mode: run
- Given: A signed-in admin of a free organization has a reward offer token.
- When: The PostHog destination posts to `POST /api/webhooks/posthog/surveys` once with `$survey_completed: false` and once with `$survey_id: "unrelated-survey"`.
- Then: Both requests return HTTP 200 with `rewardCredits: 0`, bonus credits remain 0, and `GET /api/billing/feedback-reward` still offers 200 reward credits.

## billing-feedback-007

- Vitest: "rechecks current paid eligibility when an offered response arrives after upgrading"
- Mode: run
- Given: A signed-in admin of a free organization obtains a reward offer token, and the organization then gains a Pro entitlement.
- When: The PostHog destination posts the completed survey with that token to `POST /api/webhooks/posthog/surveys`.
- Then: The settlement returns HTTP 200 with `rewardCredits: 0`, bonus credits are unchanged, and `GET /api/billing/feedback-reward` returns `{ rewardCredits: 0, token: null }`.

## billing-feedback-008

- Vitest: "does not offer a reward to non-admins and rechecks revoked membership on settlement"
- Mode: run
- Given: A free organization has an admin and an `org:member`. The admin obtains a reward offer token, after which Clerk reports the admin has no organization memberships.
- When: The member requests `GET /api/billing/feedback-reward`, and the PostHog destination posts the admin's completed survey to `POST /api/webhooks/posthog/surveys`.
- Then: The member's offer is `{ rewardCredits: 0, token: null }`. The settlement returns HTTP 200 with `rewardCredits: 0`, and the admin's bonus credits remain 0.

## billing-feedback-009

- Vitest: "rejects expired server offers"
- Mode: run
- Given: A signed-in admin of a free organization obtains a reward offer token, and the clock then advances 24 hours.
- When: The PostHog destination posts the completed survey with that token to `POST /api/webhooks/posthog/surveys`.
- Then: The API responds with HTTP 401 and bonus credits remain 0.

## billing-feedback-010

- Vitest: "withholds reward offers until trusted PostHog settlement is configured"
- Mode: run
- Given: The PostHog survey destination secret is not configured, and a signed-in admin of a free organization exists.
- When: The admin requests `GET /api/billing/feedback-reward`.
- Then: The offer is `{ rewardCredits: 0, token: null }`.

## billing-feedback-011

- Vitest: "rewards a free workspace that still has credits after canceling checkout"
- Mode: run
- Given: A signed-in admin completes onboarding for a free organization, and a signed Stripe `checkout.session.completed` webhook for a paid `credit_purchase` (amount total 100) is delivered, so `GET /api/billing/status` reports credits greater than 0.
- When: The admin requests `GET /api/billing/feedback-reward`, and the PostHog destination posts a completed `checkout_canceled` survey with the token to `POST /api/webhooks/posthog/surveys`.
- Then: The offer has `rewardCredits: 200`, the settlement returns HTTP 200 with `rewardCredits: 200`, and bonus credits increase by 200.
