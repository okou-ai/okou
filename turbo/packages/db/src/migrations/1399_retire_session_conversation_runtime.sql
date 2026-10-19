ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_launch_snapshot_check";--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_session_id_agent_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "framework" varchar(64);--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "framework_session_id" varchar(255);--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "framework_session_run_id" uuid;--> statement-breakpoint
ALTER TABLE "pi_memory_stage1_candidates" ADD COLUMN "source_format" varchar(32) DEFAULT 'pi-jsonl' NOT NULL;--> statement-breakpoint
ALTER TABLE "pi_memory_stage1_candidates" ADD COLUMN "source_chat_event_seq_id" integer;--> statement-breakpoint
ALTER TABLE "pi_memory_stage1_selections" ADD COLUMN "source_format" varchar(32) DEFAULT 'pi-jsonl' NOT NULL;--> statement-breakpoint
ALTER TABLE "pi_memory_stage1_selections" ADD COLUMN "source_chat_event_seq_id" integer;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_launch_snapshot_check" CHECK ((
          "agent_runs"."launch_snapshot" IS NULL OR (
            jsonb_typeof("agent_runs"."launch_snapshot") = 'object' AND
            jsonb_typeof("agent_runs"."launch_snapshot" -> 'framework') = 'string' AND
            "agent_runs"."launch_snapshot" ->> 'framework' = ANY (
              ARRAY['claude-code', 'codex', 'pi']
            ) AND
            ((
              jsonb_typeof(
              "agent_runs"."launch_snapshot" -> 'runnerProfile'
            ) = 'string' AND
            char_length("agent_runs"."launch_snapshot" ->> 'runnerProfile') >= 1 AND
            char_length("agent_runs"."launch_snapshot" ->> 'runnerProfile') <= 255 AND
            (
              (
                "agent_runs"."launch_snapshot" ?& ARRAY[
                  'schemaVersion',
                  'framework',
                  'runnerProfile'
                ] AND
                (
                  "agent_runs"."launch_snapshot" -
                  'schemaVersion' -
                  'framework' -
                  'runnerProfile'
                ) = '{}'::jsonb AND
                "agent_runs"."launch_snapshot" -> 'schemaVersion' = '1'::jsonb
              ) OR (
                "agent_runs"."launch_snapshot" ?& ARRAY[
                  'schemaVersion',
                  'framework',
                  'runnerProfile',
                  'piMemoryGenerationEnabled'
                ] AND
                (
                  "agent_runs"."launch_snapshot" -
                  'schemaVersion' -
                  'framework' -
                  'runnerProfile' -
                  'piMemoryGenerationEnabled'
                ) = '{}'::jsonb AND
                "agent_runs"."launch_snapshot" -> 'schemaVersion' = '2'::jsonb AND
                jsonb_typeof(
                  "agent_runs"."launch_snapshot" -> 'piMemoryGenerationEnabled'
                ) = 'boolean'
              ) OR (
                "agent_runs"."launch_snapshot" ?& ARRAY[
                  'schemaVersion',
                  'framework',
                  'runnerProfile'
                ] AND
                (
                  "agent_runs"."launch_snapshot" -
                  'schemaVersion' -
                  'framework' -
                  'runnerProfile'
                ) = '{}'::jsonb AND
                "agent_runs"."launch_snapshot" -> 'schemaVersion' IN ('3'::jsonb, '5'::jsonb)
              )
            )
            ) OR (
              "agent_runs"."launch_snapshot" ?& ARRAY['schemaVersion', 'framework', 'executionMode', 'inferenceContractVersion'] AND
              ("agent_runs"."launch_snapshot" - 'schemaVersion' - 'framework' - 'executionMode' - 'inferenceContractVersion') = '{}'::jsonb AND
              "agent_runs"."launch_snapshot"->'schemaVersion' = '4'::jsonb AND
              "agent_runs"."launch_snapshot"->>'framework' = 'pi' AND
              "agent_runs"."launch_snapshot"->'executionMode' = '"api-inference"'::jsonb AND
              "agent_runs"."launch_snapshot"->'inferenceContractVersion' = '1'::jsonb
            ))
          )
        ));--> statement-breakpoint
ALTER TABLE "pi_memory_stage1_candidates" ADD CONSTRAINT "pi_memory_stage1_candidates_source_format_check" CHECK (("pi_memory_stage1_candidates"."source_format" = 'pi-jsonl' AND "pi_memory_stage1_candidates"."source_chat_event_seq_id" IS NULL) OR ("pi_memory_stage1_candidates"."source_format" = 'chat-events-v1' AND "pi_memory_stage1_candidates"."source_chat_event_seq_id" IS NOT NULL AND "pi_memory_stage1_candidates"."source_chat_event_seq_id" > 0));
-- Earlier APIs must have exited, and the supported deletion preparation must
-- be deployed before this cutover. Existing retains move to Run ownership;
-- these mirrors never increment a second reference or authorize continuation.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM agent_runs r
    LEFT JOIN agent_sessions s ON s.id = r.session_id
    WHERE r.session_id IS NOT NULL AND (
      s.id IS NULL OR s.user_id IS DISTINCT FROM r.user_id
      OR s.org_id IS DISTINCT FROM r.org_id
    )
  ) THEN
    RAISE EXCEPTION 'Run/Session ownership is inconsistent; native cutover stopped';
  END IF;
  IF EXISTS (
    SELECT 1 FROM agent_sessions s JOIN agents a ON a.id = s.agent_id
    WHERE a.org_id IS DISTINCT FROM s.org_id
  ) THEN
    RAISE EXCEPTION 'Historical Session Agent scope is inconsistent; native cutover stopped';
  END IF;
  IF EXISTS (
    SELECT 1 FROM agent_runs r
    JOIN agents a ON a.id = r.agent_id
    WHERE a.org_id IS DISTINCT FROM r.org_id
  ) THEN
    RAISE EXCEPTION 'Captured Run Agent scope is inconsistent; native cutover stopped';
  END IF;
  IF EXISTS (
    SELECT 1 FROM agent_runs r JOIN conversations c ON c.run_id = r.id
    WHERE r.framework IS NOT NULL AND (
      r.framework IS DISTINCT FROM c.cli_agent_type
      OR r.framework_session_id IS DISTINCT FROM c.cli_agent_session_id
      OR r.legacy_conversation_history_hash IS DISTINCT FROM c.cli_agent_session_history_hash
    )
  ) THEN
    RAISE EXCEPTION 'Prepared native output mirrors diverged; native cutover stopped';
  END IF;
END $$;
--> statement-breakpoint
-- okou:batch-by-uuid
WITH batch AS MATERIALIZED (
  SELECT id, session_id FROM agent_runs
  WHERE ($1::uuid IS NULL OR id > $1::uuid) AND agent_id IS NULL
  ORDER BY id LIMIT 1000
), updated AS (
  UPDATE agent_runs r SET agent_id = s.agent_id
  FROM batch b JOIN agent_sessions s ON s.id = b.session_id
  WHERE r.id = b.id AND r.agent_id IS NULL AND s.agent_id IS NOT NULL
  RETURNING r.id
)
SELECT (SELECT id FROM batch ORDER BY id DESC LIMIT 1) AS next_cursor;
--> statement-breakpoint
-- okou:batch-by-uuid
WITH batch AS MATERIALIZED (
  SELECT id FROM agent_runs
  WHERE ($1::uuid IS NULL OR id > $1::uuid) AND framework IS NULL
  ORDER BY id LIMIT 1000
), updated AS (
  UPDATE agent_runs r SET
    framework = c.cli_agent_type,
    framework_session_id = c.cli_agent_session_id,
    legacy_conversation_history_hash = c.cli_agent_session_history_hash
  FROM batch b JOIN conversations c ON c.run_id = b.id
  WHERE r.id = b.id AND r.framework IS NULL
  RETURNING r.id
)
SELECT (SELECT id FROM batch ORDER BY id DESC LIMIT 1) AS next_cursor;
--> statement-breakpoint
-- Transfer only already-committed private-maintenance output facts. A missing
-- or mismatched legacy receipt cannot authorize the next maintenance Run.
UPDATE agent_runs r SET result = r.result || jsonb_build_object(
  'framework', c.cli_agent_type,
  'frameworkSessionId', c.cli_agent_session_id
)
FROM conversations c, agent_sessions s
WHERE c.run_id = r.id AND s.id = r.session_id
  AND r.status IN ('completed', 'failed', 'cancelled')
  AND r.chat_thread_id IS NULL AND r.launch_snapshot->>'framework' = 'pi'
  AND c.cli_agent_type = 'pi' AND c.cli_agent_session_id = r.id::text
  AND c.cli_agent_session_history_hash IS NULL
  AND s.conversation_id = c.id
  AND r.result->>'conversationId' = c.id::text
  AND r.result->>'agentSessionId' = s.id::text
  AND r.result->'storageOutputs' @> jsonb_build_array(
    jsonb_build_object('name', 'memory', 'mountPath', '/home/user/.pi/agent/memory')
  );
--> statement-breakpoint
-- Historical admission bindings are not history-generation identities. Bind
-- only the real Conversation-producing Run of the same owned Thread/Agent.
-- okou:batch-by-uuid
WITH batch AS MATERIALIZED (
  SELECT id, user_id, agent_id, agent_session_id FROM chat_threads
  WHERE ($1::uuid IS NULL OR id > $1::uuid) AND agent_session_id IS NOT NULL
    AND framework IS NULL AND framework_session_id IS NULL
    AND framework_session_run_id IS NULL
  ORDER BY id LIMIT 1000
), native_facts AS MATERIALIZED (
  SELECT t.id, r.framework, r.framework_session_id, r.id AS generation_run_id
  FROM batch t
  JOIN agent_sessions s ON t.agent_session_id = s.id
  JOIN conversations c ON c.id = s.conversation_id
  JOIN agent_runs r ON r.id = c.run_id
  JOIN agents a ON a.id = r.agent_id
  WHERE r.chat_thread_id = t.id AND r.user_id = t.user_id
    AND r.org_id = a.org_id AND r.agent_id = t.agent_id
    AND r.framework IN ('claude-code', 'codex', 'pi')
    AND r.framework_session_id ~ '^[A-Za-z0-9_-]{1,255}$'
), updated AS (
  UPDATE chat_threads t SET
    framework = f.framework,
    framework_session_id = f.framework_session_id,
    framework_session_run_id = f.generation_run_id
  FROM native_facts f WHERE t.id = f.id
    AND t.framework IS NULL AND t.framework_session_id IS NULL
    AND t.framework_session_run_id IS NULL
  RETURNING t.id
)
SELECT (SELECT id FROM batch ORDER BY id DESC LIMIT 1) AS next_cursor;
