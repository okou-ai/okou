-- The provisional purge boundary was never activated and has no API or
-- operator caller. Retire its executable advisory lock from the final schema;
-- current account deletion and retained billing attribution remain unchanged.
DROP FUNCTION "public"."purge_quiescent_provisional_billing_attribution"(text, text, uuid[]);
