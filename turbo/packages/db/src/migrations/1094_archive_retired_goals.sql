-- okou:non-transactional
-- S2 of #32653. The receipt migration is separately journaled before this CALL.
-- 4,162 measured Goals; 100 candidate thread IDs and <=100 revokes per commit.
-- A 15-minute CALL bound leaves a restartable committed prefix on timeout.
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '15min';
--> statement-breakpoint
CREATE OR REPLACE PROCEDURE archive_retired_goals_1094()
LANGUAGE plpgsql
AS $$
DECLARE
  candidate_ids uuid[];
  cursor_id uuid;
  thread_id uuid;
  thread_row chat_threads%ROWTYPE;
  goal_row thread_goals%ROWTYPE;
  thread_org_id text;
  pending_ids uuid[];
  target chat_events%ROWTYPE;
  archive_id uuid;
  next_seq bigint;
  event_time timestamp;
  phase text;
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
  RAISE NOTICE 'Goal retirement complete: unarchived=0 active=0 true_pending=0 reserved=0 actual_goal_nonterminal=0 archived=% revoked=% deleted=% skipped=%',
    archived_count, revoked_count, deleted_count, skipped_count;
END;
$$;
--> statement-breakpoint
CALL archive_retired_goals_1094();
--> statement-breakpoint
DROP PROCEDURE archive_retired_goals_1094();
--> statement-breakpoint
RESET lock_timeout;
--> statement-breakpoint
RESET statement_timeout;
