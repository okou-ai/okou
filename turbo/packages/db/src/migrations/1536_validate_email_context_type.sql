-- 1534's replay installs the widened check without scanning chat_events.
-- Validate after its ACCESS EXCLUSIVE lock has been released. This scan holds
-- SHARE UPDATE EXCLUSIVE, so reads and writes can continue during validation.
SET LOCAL statement_timeout = '120s';
--> statement-breakpoint
ALTER TABLE "chat_events" VALIDATE CONSTRAINT "chat_events_context_type_check";
