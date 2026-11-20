-- The column addition holds the thread table lock through commit. Every
-- preceding insert is included in the backfill. Later writers must supply org_id.
SET LOCAL statement_timeout = '5min';
--> statement-breakpoint
ALTER TABLE chat_threads ADD COLUMN org_id text;
--> statement-breakpoint
UPDATE chat_threads AS thread SET org_id = agent.org_id
FROM agents AS agent WHERE agent.id = thread.agent_id;
--> statement-breakpoint
ALTER TABLE chat_threads ALTER COLUMN org_id SET NOT NULL;
--> statement-breakpoint
ALTER TABLE agents ADD CONSTRAINT uq_agents_id_org UNIQUE (id, org_id);
--> statement-breakpoint
ALTER TABLE chat_threads ADD CONSTRAINT chat_threads_agent_org_fk
FOREIGN KEY (agent_id, org_id) REFERENCES agents (id, org_id);
