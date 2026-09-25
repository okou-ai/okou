-- Every API from the split writer on (API 1.672.0, the rollback floor) copies
-- both owners from the source thread and agent. The only null-owner rows were
-- written by older APIs; on 2026-09-25 all 955 had lost their source thread, so
-- no owner can be derived and nothing reads them. Delete them, then make the
-- copied ownership required so erasure sweeps by owner alone.
DELETE FROM "chat_agent_run_context"
WHERE "source_user_id" IS NULL OR "source_org_id" IS NULL;--> statement-breakpoint
ALTER TABLE "chat_agent_run_context" ALTER COLUMN "source_user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_agent_run_context" ALTER COLUMN "source_org_id" SET NOT NULL;
