-- Keep the expansion DDL in its own transaction. The previous API can
-- continue writing agent-only rows before, during and after this scan.
SET LOCAL statement_timeout = '5min';
--> statement-breakpoint
UPDATE chat_threads AS thread
SET org_id = agent.org_id
FROM agents AS agent
WHERE thread.org_id IS NULL AND thread.agent_id = agent.id;
