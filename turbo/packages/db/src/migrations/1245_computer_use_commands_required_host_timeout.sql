-- Commands left by the retired approval flow (status pending_approval, some
-- without a host) are unreachable: no current reader or writer handles them.
-- Remove them with their audit rows, then require the host and timeout that
-- every current creation already writes. The table holds well under 100k rows,
-- so the NOT NULL scans stay far inside the default statement timeout.
DELETE FROM "computer_use_command_audit_events"
WHERE "command_id" IN (
  SELECT "id" FROM "computer_use_commands"
  WHERE "status" NOT IN ('queued', 'running', 'succeeded', 'failed')
    OR "host_id" IS NULL
    OR "timeout_ms" IS NULL
);
--> statement-breakpoint
DELETE FROM "computer_use_commands"
WHERE "status" NOT IN ('queued', 'running', 'succeeded', 'failed')
  OR "host_id" IS NULL
  OR "timeout_ms" IS NULL;
--> statement-breakpoint
-- Hosts registered without a Desktop installation are no longer accepted; the
-- last one was seen in August 2026. Revoke any still marked active.
UPDATE "computer_use_hosts"
SET "status" = 'offline', "revoked_at" = now(), "updated_at" = now()
WHERE "installation_id" IS NULL AND "revoked_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "computer_use_commands" ALTER COLUMN "host_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "computer_use_commands" ALTER COLUMN "timeout_ms" SET NOT NULL;
