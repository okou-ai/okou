# friend-referrals

## friend-referrals-001

- Vitest: "links are reusable and registration attribution is immutable, without rewarding existing accounts or self-referrals"
- Mode: run
- Given: At 2026-01-31T10:00Z a signed-in referrer and a second referrer each request a referral link, and visitors open both links with `POST /api/friend-referrals/visit`.
- When: The referrer calls `POST /api/friend-referrals/link` five times (four concurrently); a new user registers with `POST /api/friend-referrals/register` using the first link's token and then the second's; the referrer registers with their own token; an account created in December 2025 registers; a new user registers with a token whose visit timestamp is rewritten to 2020; both referrers read their links again.
- Then: The link code is six lowercase alphanumerics and every request returns the same code, while the second referrer gets a different code. Both registrations by the new user return exactly `{ status: "registered" }`; the self-referral, pre-existing account, and tampered-token registrations return exactly `{ status: "ineligible" }`. The first referrer shows `registeredCount: 1`, `rewardedCount: 0`, `earnedCredits: 0`, and the second shows `registeredCount: 0` and `rewardedCount: 0`.

## friend-referrals-002

- Vitest: "a paid pro usage pack rewards only on a verified webhook, once across deliveries and renewals, with calendar-month expiry"
- Mode: run
- Given: Row `pro`. An invitee registered through a referrer's link on 2026-01-31 and completed a Pro checkout with a $20 usage pack for themselves, but no paid-invoice webhook has been delivered yet.
- When: The invitee reads `GET /api/billing/usage-pack-credits`; a Stripe `invoice.paid` webhook with an invalid signature is sent to `POST /api/webhooks/stripe`; the valid event is delivered three times concurrently; a renewal invoice on the same subscription is delivered; both users read their usage-pack credits, the referrer reads their link, and the referrer reads credits again just after 2026-02-28T10:00:01Z.
- Then: The invitee has 20,000 purchased credits and the referrer is not yet rewarded. The invalid-signature webhook returns HTTP 401 with no reward. After the three deliveries the referrer shows `registeredCount: 1`, `rewardedCount: 1`, `earnedCredits: 20000`. After the renewal the invitee has 40,000 purchased credits, while the referrer still has exactly one bonus grant of 20,000 (20,000 remaining) expiring at 2026-02-28T10:00:01.000Z and `rewardedCount: 1`. After expiry the referrer's bonus credits are 0.

## friend-referrals-003

- Vitest: "a paid team usage pack rewards only on a verified webhook, once across deliveries and renewals, with calendar-month expiry"
- Mode: run
- Given: Row `team`. An invitee registered through a referrer's link on 2026-01-31 and completed a Team checkout with a $20 usage pack for themselves, but no paid-invoice webhook has been delivered yet.
- When: The invitee reads `GET /api/billing/usage-pack-credits`; a Stripe `invoice.paid` webhook with an invalid signature is sent to `POST /api/webhooks/stripe`; the valid event is delivered three times concurrently; a renewal invoice on the same subscription is delivered; both users read their usage-pack credits, the referrer reads their link, and the referrer reads credits again just after 2026-02-28T10:00:01Z.
- Then: The invitee has 20,000 purchased credits and the referrer is not yet rewarded. The invalid-signature webhook returns HTTP 401 with no reward. After the three deliveries the referrer shows `registeredCount: 1`, `rewardedCount: 1`, `earnedCredits: 20000`. After the renewal the invitee has 40,000 purchased credits, while the referrer still has exactly one bonus grant of 20,000 (20,000 remaining) expiring at 2026-02-28T10:00:01.000Z and `rewardedCount: 1`. After expiry the referrer's bonus credits are 0.

## friend-referrals-004

- Vitest: "a zero-dollar usage-pack invoice does not reward its referrer"
- Mode: run
- Given: Row `zero-dollar`. An invitee registered through a referrer's link and bought a $20 usage pack whose Stripe `invoice.paid` event reports `amount_paid: 0`.
- When: The paid-invoice webhook is delivered to `POST /api/webhooks/stripe` and the referrer reads `POST /api/friend-referrals/link`.
- Then: The referrer shows `registeredCount: 1`, `rewardedCount: 0`, and `earnedCredits: 0`.

## friend-referrals-005

- Vitest: "a out-of-band usage-pack invoice does not reward its referrer"
- Mode: run
- Given: Row `out-of-band`. An invitee registered through a referrer's link and bought a $20 usage pack whose Stripe `invoice.paid` event is marked `paid_out_of_band`.
- When: The paid-invoice webhook is delivered to `POST /api/webhooks/stripe` and the referrer reads `POST /api/friend-referrals/link`.
- Then: The referrer shows `registeredCount: 1`, `rewardedCount: 0`, and `earnedCredits: 0`.
