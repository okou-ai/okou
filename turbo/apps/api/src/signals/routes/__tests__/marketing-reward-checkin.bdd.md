# marketing-reward-checkin

## marketing-reward-checkin-001

- Vitest: "records only authenticated explicit check-ins and retains the first day snapshot across concurrent clicks and organization switches"
- Mode: run
- Given: A signed-in member is in a workspace just before UTC midnight. The campaign consumer is available.
- When: An anonymous caller attempts check-in, then the member makes five concurrent explicit check-ins and repeats after switching workspaces during the same UTC day.
- Then: The anonymous request gets HTTP 401 and produces no event. All five requests return HTTP 200 with the same ID. Exactly one version-5 development check-in event captures the first user, organization and timestamp. The workspace switch returns the identical receipt and produces no second event.

## marketing-reward-checkin-002

- Vitest: "recovers the original check-in day and financial receipt across UTC rollover and expiry"
- Mode: run
- Given: One member checks in on consecutive UTC days using different organizations. The original proof includes the previous day, original organization and a 100-credit user reward.
- When: Authorized services settle the original day and replay its projection. They try a mismatched day and missing source, then replay settlement concurrently after expiry.
- Then: The consecutive days have different IDs and exactly two source events. Settlement and notification return HTTP 200 with the original receipt and a stable notification. Mismatched day returns 409 and missing proof 404. All later replays are identical to the original settlement, and the expired grant contributes zero bonus credits.
