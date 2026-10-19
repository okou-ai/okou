-- okou:non-transactional
-- S5 of #32653: replay 1094 semantics, then verify and contract atomically.
-- 4,162 measured Goals; 100 candidate thread IDs and <=100 revokes per commit.
-- A 15-minute CALL bound leaves a restartable committed prefix on timeout.
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '15min';
--> statement-breakpoint
CREATE OR REPLACE PROCEDURE archive_retired_goals_1106()
LANGUAGE plpgsql
AS $$
DECLARE
  candidate_ids uuid[];
  cursor_id uuid;
  thread_id uuid;
  thread_row record;
  goal_row record;
  thread_org_id text;
  pending_ids uuid[];
  target record;
  archive_id uuid;
  next_seq bigint;
  event_time timestamp;
  phase text;
  initial_goal_count bigint;
  archived_count bigint := 0;
  revoked_count bigint := 0;
  deleted_count bigint := 0;
  skipped_count bigint := 0;
  unarchived_count bigint;
  active_count bigint;
  pending_count bigint;
  reserved_count bigint;
  nonterminal_count bigint;
BEGIN
  -- The final DO and all destructive DDL commit together. If the process dies
  -- before the non-transactional journal INSERT, a retry validates that complete
  -- contracted state below instead of looking up already-removed row types.
  IF to_regclass('public.thread_goals') IS NULL THEN
    RETURN;
  END IF;
  SELECT count(*) INTO initial_goal_count FROM thread_goals;
  RAISE NOTICE 'Goal contraction replay census: retained_goals=%', initial_goal_count;
  SELECT count(*) INTO unarchived_count FROM thread_goals g
  WHERE (g.retirement_archive_event_id IS NULL) <> (g.retirement_archive_seq_id IS NULL)
    OR g.retirement_archive_seq_id NOT BETWEEN 1 AND 9007199254740991
    OR (g.retirement_archive_event_id IS NULL AND (
      EXISTS (SELECT 1 FROM chat_event_snapshots s WHERE s.chat_thread_id = g.chat_thread_id)
      OR EXISTS (SELECT 1 FROM chat_events e WHERE e.chat_thread_id = g.chat_thread_id
        AND e.event_type = 'output.message' AND e.run_id IS NULL
        AND starts_with(e.payload->>'content', E'Okou Goal retired.\nGoal ID: ' || g.id::text || E'\n'))
    ));
  IF unarchived_count <> 0 THEN
    RAISE EXCEPTION 'Goal contraction blocked: malformed or unverifiable missing receipts=%', unarchived_count;
  END IF;
  SELECT count(*) INTO nonterminal_count FROM agent_runs
  WHERE trigger_source = 'goal' AND status IN ('queued', 'pending', 'running');
  IF nonterminal_count <> 0 THEN
    RAISE EXCEPTION 'Goal retirement blocked: actual Goal nonterminal=%', nonterminal_count;
  END IF;

  LOOP
    -- Include cleared Goals' threads. Reservations remain candidates so they
    -- are reported as blockers, never silently mistaken for a settled queue.
    SELECT array_agg(candidate.id ORDER BY candidate.id) INTO candidate_ids
    FROM (
      SELECT id FROM (
        SELECT chat_thread_id AS id FROM thread_goals
        WHERE retirement_archive_event_id IS NULL OR status = 'active'
        UNION
        SELECT event.chat_thread_id AS id FROM chat_events event
        WHERE event.event_type = 'input.goal' AND event.run_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM chat_events revoker WHERE revoker.revokes_event_id = event.id)
      ) remainder
      WHERE cursor_id IS NULL OR id > cursor_id
      ORDER BY id LIMIT 100
    ) candidate;
    EXIT WHEN candidate_ids IS NULL;

    FOREACH thread_id IN ARRAY candidate_ids LOOP
      LOOP
        pending_ids := NULL;
        phase := 'lock';
        BEGIN
          -- Exact runtime lock order: Goal advisory lock, then thread row.
          IF NOT pg_try_advisory_xact_lock(hashtext('goal:' || thread_id::text)) THEN
            skipped_count := skipped_count + 1;
            EXIT;
          END IF;
          SELECT * INTO thread_row FROM chat_threads WHERE id = thread_id FOR UPDATE SKIP LOCKED;
          IF NOT FOUND THEN
            IF EXISTS (SELECT 1 FROM chat_threads WHERE id = thread_id) THEN
              skipped_count := skipped_count + 1;
            ELSE
              deleted_count := deleted_count + 1;
            END IF;
            EXIT;
          END IF;

          phase := 'ownership';
          SELECT * INTO goal_row FROM thread_goals WHERE chat_thread_id = thread_id FOR UPDATE;
          SELECT org_id INTO thread_org_id FROM agents WHERE id = thread_row.agent_id FOR SHARE;
          IF thread_org_id IS NULL OR (goal_row.id IS NOT NULL AND (
            goal_row.chat_thread_id IS DISTINCT FROM thread_row.id
            OR goal_row.agent_id IS DISTINCT FROM thread_row.agent_id
            OR goal_row.owner_user_id IS DISTINCT FROM thread_row.user_id
            OR goal_row.org_id IS DISTINCT FROM thread_org_id
          )) THEN
            RAISE EXCEPTION 'inconsistent ownership';
          END IF;

          phase := 'actual Goal nonterminal';
          IF EXISTS (SELECT 1 FROM agent_runs WHERE trigger_source = 'goal' AND status IN ('queued', 'pending', 'running')) THEN
            RAISE EXCEPTION 'new Goal work';
          END IF;

          phase := 'open reservation';
          IF EXISTS (
            SELECT 1 FROM chat_events event
            JOIN active_input_delivery_items item ON item.source_event_id = event.id
            JOIN active_input_deliveries delivery ON delivery.id = item.delivery_id
            WHERE event.chat_thread_id = thread_id
              AND event.event_type = 'input.goal' AND event.run_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM chat_events revoker WHERE revoker.revokes_event_id = event.id)
              AND item.disposition IS NULL AND delivery.status = 'open'
          ) THEN
            RAISE EXCEPTION 'unresolved active input';
          END IF;

          SELECT array_agg(event.id ORDER BY event.seq_id) INTO pending_ids
          FROM (
            SELECT event.id, event.seq_id FROM chat_events event
            WHERE event.chat_thread_id = thread_id
              AND event.event_type = 'input.goal' AND event.run_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM chat_events revoker WHERE revoker.revokes_event_id = event.id)
              AND NOT EXISTS (
                SELECT 1 FROM active_input_delivery_items item
                JOIN active_input_deliveries delivery ON delivery.id = item.delivery_id
                WHERE item.source_event_id = event.id
                  AND item.disposition IS NULL AND delivery.status = 'open'
              )
            ORDER BY event.seq_id LIMIT 100
          ) event;

          phase := 'pending context ownership';
          IF EXISTS (
            SELECT 1 FROM chat_events event
            LEFT JOIN thread_goals referenced_goal ON referenced_goal.id = event.context_id
            WHERE event.id = ANY(pending_ids) AND (
              event.context_type IS DISTINCT FROM 'goal' OR event.context_id IS NULL
              OR (referenced_goal.id IS NOT NULL AND (
                referenced_goal.chat_thread_id IS DISTINCT FROM thread_id
                OR referenced_goal.agent_id IS DISTINCT FROM thread_row.agent_id
                OR referenced_goal.owner_user_id IS DISTINCT FROM thread_row.user_id
                OR referenced_goal.org_id IS DISTINCT FROM thread_org_id
              ))
            )
          ) THEN
            RAISE EXCEPTION 'inconsistent pending context';
          END IF;

          phase := 'archive';
          IF goal_row.id IS NOT NULL AND goal_row.retirement_archive_event_id IS NULL THEN
            archive_id := gen_random_uuid();
            event_time := timezone('UTC', clock_timestamp());
            UPDATE chat_threads SET last_chat_event_seq_id = last_chat_event_seq_id + 2
            WHERE id = thread_id RETURNING last_chat_event_seq_id - 1 INTO next_seq;
            INSERT INTO chat_events (id, chat_thread_id, event_type, payload, seq_id, created_at)
            VALUES (archive_id, thread_id, 'output.message', jsonb_build_object('content',
              format(E'Okou Goal retired.\nGoal ID: %s\nOriginal recorded status: %s\n%s\n\nFull original objective:\n',
                goal_row.id, goal_row.status,
                CASE WHEN goal_row.status = 'active'
                  THEN 'Retirement changed this Goal from active to paused; this does not mark the objective complete.'
                  ELSE 'The recorded status is preserved; retirement does not mark the objective complete.' END
              ) || goal_row.objective), next_seq, event_time);
            INSERT INTO chat_events (chat_thread_id, event_type, seq_id, created_at)
            VALUES (thread_id, 'goal.close', next_seq + 1, event_time);
            UPDATE thread_goals SET
              status = CASE WHEN status = 'active' THEN 'paused' ELSE status END,
              retirement_archive_event_id = archive_id,
              retirement_archive_seq_id = next_seq,
              updated_at = event_time
            WHERE id = goal_row.id;
            archived_count := archived_count + 1;
          ELSIF goal_row.status = 'active' THEN
            -- An archived Goal cannot reactivate under the deployed S1 fence.
            RAISE EXCEPTION 'archived Goal reactivated';
          ELSIF goal_row.id IS NULL AND pending_ids IS NULL THEN
            deleted_count := deleted_count + 1;
          END IF;

          phase := 'revoke';
          FOR target IN SELECT * FROM chat_events WHERE id = ANY(pending_ids) ORDER BY seq_id LOOP
            UPDATE chat_threads SET last_chat_event_seq_id = last_chat_event_seq_id + 1
            WHERE id = thread_id RETURNING last_chat_event_seq_id INTO next_seq;
            INSERT INTO chat_events (
              chat_thread_id, event_type, revokes_event_id, context_type, context_id, seq_id, created_at
            ) VALUES (
              thread_id, 'control.revoke', target.id, target.context_type, target.context_id, next_seq,
              greatest(timezone('UTC', clock_timestamp()), target.created_at + interval '1 millisecond')
            );
            revoked_count := revoked_count + 1;
          END LOOP;
        EXCEPTION WHEN OTHERS OR query_canceled THEN
          -- Never propagate a failing-row DETAIL, objective, or payload. The
          -- subtransaction rolls this thread back; earlier COMMITs survive.
          RAISE EXCEPTION USING ERRCODE = SQLSTATE,
            MESSAGE = format('Goal retirement failed: thread=%s goal=%s phase=%s SQLSTATE=%s',
              thread_id, goal_row.id, phase, SQLSTATE);
        END;
        COMMIT;
        EXIT WHEN coalesce(cardinality(pending_ids), 0) < 100;
      END LOOP;
      -- Also release locks when a candidate was skipped or concurrently deleted.
      COMMIT;
    END LOOP;
    cursor_id := candidate_ids[cardinality(candidate_ids)];
    RAISE NOTICE 'Goal retirement progress: archived=% revoked=% deleted=% skipped=%',
      archived_count, revoked_count, deleted_count, skipped_count;
  END LOOP;

  SELECT count(*) FILTER (WHERE retirement_archive_event_id IS NULL), count(*) FILTER (WHERE status = 'active')
    INTO unarchived_count, active_count FROM thread_goals;
  SELECT count(*) FILTER (WHERE NOT EXISTS (
      SELECT 1 FROM active_input_delivery_items item
      JOIN active_input_deliveries delivery ON delivery.id = item.delivery_id
      WHERE item.source_event_id = event.id AND item.disposition IS NULL AND delivery.status = 'open'
    )), count(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM active_input_delivery_items item
      JOIN active_input_deliveries delivery ON delivery.id = item.delivery_id
      WHERE item.source_event_id = event.id AND item.disposition IS NULL AND delivery.status = 'open'
    )) INTO pending_count, reserved_count
  FROM chat_events event
  WHERE event.event_type = 'input.goal' AND event.run_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM chat_events revoker WHERE revoker.revokes_event_id = event.id);
  SELECT count(*) INTO nonterminal_count FROM agent_runs
  WHERE trigger_source = 'goal' AND status IN ('queued', 'pending', 'running');
  IF unarchived_count <> 0 OR active_count <> 0 OR pending_count <> 0 OR reserved_count <> 0 OR nonterminal_count <> 0 THEN
    RAISE EXCEPTION 'Goal retirement remainder: unarchived=% active=% true_pending=% reserved=% actual_goal_nonterminal=% skipped=%',
      unarchived_count, active_count, pending_count, reserved_count, nonterminal_count, skipped_count;
  END IF;
  RAISE NOTICE 'Goal contraction replay reconciliation: initial_goals=% remaining_goals=%', initial_goal_count, (SELECT count(*) FROM thread_goals);
  RAISE NOTICE 'Goal retirement complete: unarchived=0 active=0 true_pending=0 reserved=0 actual_goal_nonterminal=0 archived=% revoked=% deleted=% skipped=%',
    archived_count, revoked_count, deleted_count, skipped_count;
END;
$$;
--> statement-breakpoint
CALL archive_retired_goals_1106();
--> statement-breakpoint
SET statement_timeout = '10s';
--> statement-breakpoint
-- One statement/transaction owns verification and DDL. SHARE locks freeze clears,
-- retention/publication, event reservations and ownership; ACCESS EXCLUSIVE is
-- intrinsic to contraction. These locks are never held during the replay above.
DO $$
DECLARE
  phase text := 'lock';
  goals_count bigint := 0;
  invalid_count bigint := 0;
  uncovered_count bigint := 0;
  pending_count bigint := 0;
  reserved_count bigint := 0;
  nonterminal_count bigint := 0;
  dependency_count bigint := 0;
BEGIN
  IF to_regclass('public.thread_goals') IS NULL THEN
    IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'agent_runs'::regclass
        AND attname = 'goal_id' AND NOT attisdropped)
      OR to_regclass('public.idx_agent_runs_goal') IS NOT NULL
      OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'agent_runs'::regclass
        AND conname IN ('agent_runs_goal_id_thread_goals_id_fk', 'agent_runs_metadata_without_goal_check'))
      OR (SELECT count(*) FROM pg_constraint WHERE conrelid = 'agent_runs'::regclass
        AND conname IN ('agent_runs_metadata_presence_check', 'agent_runs_autonomy_budget_check')
        AND convalidated) <> 2 THEN
      RAISE EXCEPTION 'incomplete contracted schema';
    END IF;
    RAISE NOTICE 'Goal contraction retry: physical objects already absent; validated constraints retained';
    RETURN;
  END IF;

  LOCK TABLE agent_runs, thread_goals IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE chat_threads, agents, chat_events, chat_event_snapshots,
    active_input_deliveries, active_input_delivery_items IN SHARE MODE;
  phase := 'residuals and ownership';
  SELECT count(*), count(*) FILTER (WHERE
      g.retirement_archive_event_id IS NULL OR g.retirement_archive_seq_id IS NULL
      OR g.retirement_archive_seq_id NOT BETWEEN 1 AND 9007199254740991
      OR g.status = 'active'
      OR t.id IS NULL OR a.id IS NULL
      OR g.agent_id IS DISTINCT FROM t.agent_id
      OR g.owner_user_id IS DISTINCT FROM t.user_id
      OR g.org_id IS DISTINCT FROM a.org_id)
    INTO goals_count, invalid_count
  FROM thread_goals g LEFT JOIN chat_threads t ON t.id = g.chat_thread_id
  LEFT JOIN agents a ON a.id = t.agent_id;
  WITH unrevoked AS (
    SELECT e.id FROM chat_events e
    WHERE e.event_type = 'input.goal' AND e.run_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM chat_events r WHERE r.revokes_event_id = e.id)
  ), classified AS (
    SELECT EXISTS (SELECT 1 FROM active_input_delivery_items item
      JOIN active_input_deliveries delivery ON delivery.id = item.delivery_id
      WHERE item.source_event_id = e.id AND item.disposition IS NULL AND delivery.status = 'open') AS reserved
    FROM unrevoked e
  ) SELECT count(*) FILTER (WHERE NOT reserved), count(*) FILTER (WHERE reserved)
    INTO pending_count, reserved_count FROM classified;
  SELECT count(*) INTO nonterminal_count FROM agent_runs
  WHERE trigger_source = 'goal' AND status IN ('queued', 'pending', 'running');
  IF invalid_count <> 0 OR pending_count <> 0 OR reserved_count <> 0 OR nonterminal_count <> 0 THEN
    RAISE EXCEPTION 'unsafe residuals';
  END IF;

  phase := 'literal preservation';
  -- All original text comparison remains in PostgreSQL, including exact UTF-8
  -- bytes, identity and the complete immutable status-specific 1094 notice.
  SELECT count(*) INTO invalid_count
  FROM thread_goals g JOIN chat_events e ON e.id = g.retirement_archive_event_id
  WHERE e.chat_thread_id IS DISTINCT FROM g.chat_thread_id
    OR e.seq_id IS DISTINCT FROM g.retirement_archive_seq_id
    OR e.event_type <> 'output.message' OR e.run_id IS NOT NULL
    OR e.revokes_event_id IS NOT NULL OR e.context_type IS NOT NULL OR e.context_id IS NOT NULL
    OR e.run_event_id IS NOT NULL OR e.run_event_sequence_number IS NOT NULL
    OR EXISTS (SELECT 1 FROM chat_events r WHERE r.revokes_event_id = e.id)
    OR e.payload - 'content' IS DISTINCT FROM '{}'::jsonb
    OR jsonb_typeof(e.payload->'content') IS DISTINCT FROM 'string'
    OR NOT EXISTS (
      SELECT 1 FROM (VALUES (g.status::text), (CASE WHEN g.status = 'paused' THEN 'active' END)) original(status)
      WHERE original.status IS NOT NULL AND convert_to(e.payload->>'content', 'UTF8') = convert_to(
        format(E'Okou Goal retired.\nGoal ID: %s\nOriginal recorded status: %s\n%s\n\nFull original objective:\n',
          g.id, original.status,
          CASE WHEN original.status = 'active'
            THEN 'Retirement changed this Goal from active to paused; this does not mark the objective complete.'
            ELSE 'The recorded status is preserved; retirement does not mark the objective complete.' END
        ) || g.objective, 'UTF8')
    );
  -- A valid V7 publication covers snapshot-only receipts; it is not a new
  -- external-object content certificate. S2's full certificate and the canonical
  -- reader's checksum/schema/order checks remain authoritative for those bytes.
  SELECT count(*) INTO uncovered_count FROM thread_goals g
  WHERE NOT EXISTS (SELECT 1 FROM chat_events e
      WHERE e.id = g.retirement_archive_event_id AND e.chat_thread_id = g.chat_thread_id
        AND e.seq_id = g.retirement_archive_seq_id)
    AND NOT EXISTS (SELECT 1 FROM chat_event_snapshots s
      JOIN chat_threads t ON t.id = s.chat_thread_id
      WHERE s.chat_thread_id = g.chat_thread_id AND s.archive_schema_version = 7
        AND s.last_seq_id BETWEEN g.retirement_archive_seq_id AND 9007199254740991
        AND s.last_seq_id <= t.last_chat_event_seq_id
        AND s.terminal_event_id IS NOT NULL
        AND s.terminal_seq_id BETWEEN g.retirement_archive_seq_id AND s.last_seq_id
        AND (s.last_seq_id <> g.retirement_archive_seq_id OR s.last_event_id = g.retirement_archive_event_id)
        AND (s.terminal_seq_id <> g.retirement_archive_seq_id OR s.terminal_event_id = g.retirement_archive_event_id)
        AND s.object_key ~ ('^chat-events/' || g.chat_thread_id::text || '/' || s.last_seq_id::text || '(-r1)?-[0-9a-f]{64}[.]ndjson[.]gz$'));
  IF invalid_count <> 0 OR uncovered_count <> 0 THEN
    RAISE EXCEPTION 'unverified preservation';
  END IF;

  phase := 'catalog dependencies';
  -- DROP COLUMN automatically deletes dependent checks even without CASCADE.
  -- Refuse anything beyond the three explicitly reviewed column dependencies.
  SELECT count(DISTINCT (d.classid, d.objid)) INTO dependency_count FROM pg_depend d
  JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
  WHERE d.refclassid = 'pg_class'::regclass AND a.attrelid = 'agent_runs'::regclass AND a.attname = 'goal_id'
    AND NOT (d.classid = 'pg_constraint'::regclass AND d.objid IN (
      SELECT oid FROM pg_constraint WHERE conrelid = 'agent_runs'::regclass
        AND conname IN ('agent_runs_metadata_presence_check', 'agent_runs_goal_id_thread_goals_id_fk')))
    AND NOT (d.classid = 'pg_class'::regclass AND d.objid = 'idx_agent_runs_goal'::regclass);
  SELECT dependency_count + count(*) INTO dependency_count FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')
    AND p.proname <> 'archive_retired_goals_1106'
    AND p.prosrc ~ '\m(thread_goals|goal_id)\M';
  IF dependency_count <> 0 THEN
    RAISE EXCEPTION 'unexpected dependent objects';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'agent_runs'::regclass
    AND conname = 'agent_runs_metadata_without_goal_check' AND convalidated) THEN
    RAISE EXCEPTION 'replacement metadata constraint is not validated';
  END IF;

  phase := 'physical contraction';
  ALTER TABLE agent_runs DROP CONSTRAINT agent_runs_metadata_presence_check;
  ALTER TABLE agent_runs RENAME CONSTRAINT agent_runs_metadata_without_goal_check TO agent_runs_metadata_presence_check;
  ALTER TABLE agent_runs DROP CONSTRAINT agent_runs_goal_id_thread_goals_id_fk;
  DROP INDEX idx_agent_runs_goal;
  ALTER TABLE agent_runs DROP COLUMN goal_id;
  DROP TABLE thread_goals RESTRICT;
  RAISE NOTICE 'Goal contraction complete: retained_receipts=% invalid=0 uncovered=0 pending=0 reserved=0 actual_goal_nonterminal=0 unexpected_dependencies=0', goals_count;
EXCEPTION WHEN OTHERS OR query_canceled THEN
  -- No PostgreSQL failing-row DETAIL or arbitrary dependency definition escapes.
  RAISE EXCEPTION USING ERRCODE = SQLSTATE,
    MESSAGE = format('Goal contraction failed: phase=%s SQLSTATE=%s retained_receipts=%s invalid=%s uncovered=%s pending=%s reserved=%s actual_goal_nonterminal=%s unexpected_dependencies=%s',
      phase, SQLSTATE, goals_count, invalid_count, uncovered_count, pending_count, reserved_count, nonterminal_count, dependency_count);
END;
$$;
--> statement-breakpoint
DROP PROCEDURE archive_retired_goals_1106();
--> statement-breakpoint
RESET lock_timeout;
--> statement-breakpoint
RESET statement_timeout;
