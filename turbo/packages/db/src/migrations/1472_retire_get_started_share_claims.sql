-- The X share quest is retired. Close its unresolved claims so nothing waits on
-- a review that no longer runs; granted receipts and their credits are kept.
UPDATE "get_started_claims"
SET "status" = 'rejected',
    "reason" = 'quest_retired',
    "lease_id" = NULL,
    "lease_expires_at" = NULL,
    "reviewed_at" = now(),
    "updated_at" = now()
WHERE "quest_key" = 'share' AND "status" IN ('pending', 'reviewing');
