-- Legacy host-token issuance and routes were retired in API 1.724.0 (#38559).
-- Keep the nullable column and its index so the outgoing API can still issue
-- implicit SELECT/INSERT/RETURNING statements while the session-only API ships.
-- Clearing every old hash lets that API recognize an installation upgraded by
-- the new writer, which no longer clears token_hash on registration.
-- Session-less historical devices stay offline; a verified Native registration
-- can reactivate their existing id and installation/chat bindings.
UPDATE "computer_use_hosts"
SET "token_hash" = NULL,
    "status" = CASE WHEN "session_id" IS NULL THEN 'offline' ELSE "status" END
WHERE "token_hash" IS NOT NULL
   OR ("session_id" IS NULL AND "status" <> 'offline');
