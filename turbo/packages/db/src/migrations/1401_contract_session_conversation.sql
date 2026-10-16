-- #37970 contracts storage omitted from the serving runtime since 1399.
-- Run/Memory retain their own history references. Dropping these old mirrors
-- must not decrement blob counters or delete retained Runs and Chat messages.
-- All checks run before DDL. There is no bulk backfill under the DDL locks.
-- Cold production clones can need more than 10s for the native-facts scan.
-- This read-only budget must not extend into the AccessExclusive phase.
SET LOCAL statement_timeout = '60s';
--> statement-breakpoint
DO $$
BEGIN
  -- PostgreSQL 17+ arms an inactive transaction timer when SET LOCAL enables
  -- it below. An inherited active timer would not restart at the DDL boundary.
  IF current_setting('transaction_timeout', true) IS DISTINCT FROM '0' THEN
    RAISE EXCEPTION 'Session/Conversation contraction requires PostgreSQL 17+ with transaction_timeout initially disabled';
  END IF;

  IF EXISTS (
    SELECT 1 FROM agent_runs
    WHERE status IN ('pending', 'running')
      AND launch_snapshot->>'schemaVersion' IS DISTINCT FROM '5'
  ) THEN
    RAISE EXCEPTION 'Session/Conversation contraction requires legacy Run drain';
  END IF;
END;
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM conversations c JOIN agent_runs r ON r.id = c.run_id
    WHERE r.framework IS NULL OR r.framework_session_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Session/Conversation native facts were not transferred to Run';
  END IF;
END;
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class
    WHERE oid IN ('public.agent_sessions'::regclass, 'public.conversations'::regclass,
      'public.agent_runs'::regclass, 'public.chat_threads'::regclass)
      AND (relkind <> 'r' OR relrowsecurity OR relforcerowsecurity)
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE NOT tgisinternal AND tgrelid IN (
      'public.agent_sessions'::regclass, 'public.conversations'::regclass,
      'public.agent_runs'::regclass, 'public.chat_threads'::regclass
    )
  ) THEN
    RAISE EXCEPTION 'Unexpected Session/Conversation relation policy or trigger';
  END IF;

  -- PostgreSQL silently removes column-owned indexes and constraints even with
  -- DROP COLUMN RESTRICT. Only the two reviewed indexes and Run FK may go.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
    JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_class'::regclass
      AND d.objid = i.indexrelid AND d.refclassid = 'pg_catalog.pg_class'::regclass
    JOIN pg_catalog.pg_attribute a ON a.attrelid = d.refobjid
      AND a.attnum = d.refobjsubid AND a.attrelid = i.indrelid
    WHERE (
      (i.indrelid = 'public.agent_runs'::regclass AND a.attname IN ('session_id', 'continued_from_session_id')) OR
      (i.indrelid = 'public.chat_threads'::regclass AND a.attname IN ('agent_session_id', 'agent_session_run_id'))
    ) AND c.relname NOT IN ('idx_agent_runs_session', 'chat_threads_agent_session_unique')
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid
      AND a.attnum = ANY(c.conkey)
    WHERE (
      (c.conrelid = 'public.agent_runs'::regclass AND a.attname IN ('session_id', 'continued_from_session_id')) OR
      (c.conrelid = 'public.chat_threads'::regclass AND a.attname IN ('agent_session_id', 'agent_session_run_id'))
    ) AND c.conname <> 'agent_runs_session_id_agent_sessions_id_fk'
  ) THEN
    RAISE EXCEPTION 'Unexpected Session/Conversation column index or constraint';
  END IF;

  -- Function bodies can contain SQL that pg_depend does not track.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
      AND p.prokind IN ('f', 'p')
      AND pg_get_functiondef(p.oid) ~* '\m(agent_sessions|conversations|agent_runs|chat_threads|continued_from_session_id|agent_session_id|agent_session_run_id)\M'
  ) THEN
    RAISE EXCEPTION 'Unexpected routine referencing Session/Conversation storage';
  END IF;
END;
$$;
--> statement-breakpoint
SET LOCAL statement_timeout = '10s';
--> statement-breakpoint
SET LOCAL lock_timeout = '100ms';
--> statement-breakpoint
-- Bound the whole remaining transaction, including later lock waits, client
-- gaps and the runner's journal INSERT. Timeout terminates this connection and
-- rolls back uncommitted DDL; lock release still includes abort cleanup.
SET LOCAL transaction_timeout = '2s';
--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_session_id_agent_sessions_id_fk";
--> statement-breakpoint
DROP TABLE "agent_sessions" RESTRICT;
--> statement-breakpoint
DROP TABLE "conversations" RESTRICT;
--> statement-breakpoint
DROP INDEX "idx_agent_runs_session";
--> statement-breakpoint
DROP INDEX "chat_threads_agent_session_unique";
--> statement-breakpoint
ALTER TABLE "agent_runs" DROP COLUMN "continued_from_session_id" RESTRICT,
  DROP COLUMN "session_id" RESTRICT;
--> statement-breakpoint
ALTER TABLE "chat_threads" DROP COLUMN "agent_session_id" RESTRICT,
  DROP COLUMN "agent_session_run_id" RESTRICT;
