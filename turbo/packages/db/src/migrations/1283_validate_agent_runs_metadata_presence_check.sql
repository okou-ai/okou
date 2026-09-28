-- 1282 re-added the constraint NOT VALID in its own transaction. Validation
-- holds only SHARE UPDATE EXCLUSIVE, so agent_runs writes continue meanwhile.
ALTER TABLE "agent_runs" VALIDATE CONSTRAINT "agent_runs_metadata_presence_check";
