-- Only archive after the serving release and an earlier verified release can read it.
-- All dependent writes, including the FK cascades, commit in this one statement.
WITH stage AS MATERIALIZED (
  SELECT archive_reader_release FROM proactive_dispatch_handoff
  WHERE singleton AND phase = 'standalone' AND archive_reader_release <> $1
    AND archive_reader_verified_at <= now() - interval '5 minutes'
  FOR UPDATE NOWAIT
), definitions AS MATERIALIZED (
  SELECT jsonb_array_elements_text($2::text::jsonb) AS name
), retiring_workflows AS MATERIALIZED (
  SELECT w.* FROM workflows w CROSS JOIN stage
  WHERE w.visibility = 'private' AND w.official_definition_name IN (SELECT name FROM definitions)
  ORDER BY w.id FOR UPDATE OF w NOWAIT
), automations AS MATERIALIZED (
  SELECT a.id, a.workflow_id, a.org_id, a.owner_user_id, a.kind, a.official_blueprint_key
  FROM workflow_automations a JOIN retiring_workflows w ON w.id = a.workflow_id
  ORDER BY a.id FOR UPDATE OF a NOWAIT
), bindings AS MATERIALIZED (
  SELECT b.workflow_id, b.org_id, b.user_id, b.chat_thread_id,
    t.org_id AS thread_org, t.user_id AS thread_user, t.hidden AS thread_hidden
  FROM workflow_user_automation_threads b JOIN retiring_workflows w ON w.id = b.workflow_id
  LEFT JOIN chat_threads t ON t.id = b.chat_thread_id
), run_sources AS MATERIALIZED (
  SELECT r.id AS run_id, r.org_id, r.user_id, a.id AS automation_id, a.workflow_id
  FROM automations a JOIN agent_runs r ON r.workflow_automation_id = a.id
), enrollments AS MATERIALIZED (
  SELECT e.org_id, e.user_id, e.state FROM morning_brief_enrollments e CROSS JOIN stage
  ORDER BY e.org_id, e.user_id FOR UPDATE OF e NOWAIT
), checks AS MATERIALIZED (
  SELECT
    CASE
      WHEN EXISTS (
        SELECT FROM automations a JOIN retiring_workflows w ON w.id = a.workflow_id
        WHERE (a.org_id, a.owner_user_id) <> (w.org_id, w.owner_user_id) OR a.kind <> 'schedule'
          OR a.official_blueprint_key IS NULL OR CASE w.official_definition_name
            WHEN 'morning-brief' THEN a.official_blueprint_key <> 'daily-delivery'
            WHEN 'internal-test-morning-brief' THEN a.official_blueprint_key <> 'daily-delivery'
            WHEN 'agent-suggestions' THEN a.official_blueprint_key <> 'hourly-check'
            WHEN 'proactive-learning' THEN a.official_blueprint_key <> 'nightly-learning' ELSE false END
      ) THEN 'Retained workflow contains an unrecognized or differently owned automation'
      WHEN EXISTS (
        SELECT FROM bindings b JOIN retiring_workflows w ON w.id = b.workflow_id
        WHERE (b.org_id, b.user_id) <> (w.org_id, w.owner_user_id) OR (b.chat_thread_id IS NOT NULL
          AND (b.thread_org, b.thread_user) IS DISTINCT FROM (b.org_id, b.user_id))
      ) THEN 'Historical task thread ownership differs from its installation'
      WHEN EXISTS (
        SELECT FROM bindings b WHERE b.chat_thread_id IS NOT NULL AND b.thread_hidden IS NOT TRUE
      ) THEN 'Historical task thread is not hidden'
      WHEN EXISTS (
        SELECT FROM run_sources r JOIN retiring_workflows w ON w.id = r.workflow_id
        WHERE (r.org_id, r.user_id) IS DISTINCT FROM (w.org_id, w.owner_user_id)
      ) THEN 'Historical run ownership differs from its automation'
      WHEN EXISTS (
        SELECT FROM legacy_proactive_schedules l WHERE l.intended_enabled AND NOT EXISTS (
          SELECT FROM proactive_schedules s WHERE (s.org_id, s.user_id, s.task) = (l.org_id, l.user_id, l.task))
      ) THEN 'A retained member choice has no standalone schedule'
      WHEN EXISTS (
        SELECT FROM enrollments e WHERE e.state IN ('checking', 'pending') AND NOT EXISTS (
          SELECT FROM proactive_schedules s WHERE (s.org_id, s.user_id, s.task) = (e.org_id, e.user_id, 'morning-brief'))
      ) THEN 'An enrollment decision has no standalone schedule'
    END AS invalid,
    CASE
      WHEN EXISTS (
        SELECT FROM automations a JOIN chat_automation_context c ON c.automation_id = a.id
        JOIN chat_events e ON e.context_id = c.id AND e.chat_thread_id = c.chat_thread_id
        WHERE e.event_type = 'input.automation' AND e.context_type = 'automation' AND e.run_id IS NULL
          AND NOT EXISTS (SELECT FROM chat_events v WHERE v.revokes_event_id = e.id)
      ) OR EXISTS (
        SELECT FROM chat_events e WHERE e.event_type = 'input.prompt' AND e.run_id IS NULL
          AND e.required_official_workflow_ids IS NOT NULL
          AND e.required_official_workflow_ids && ARRAY(SELECT id FROM retiring_workflows)
          AND NOT EXISTS (SELECT FROM chat_events v WHERE v.revokes_event_id = e.id)
      ) THEN 'Pending legacy input prevents retirement'
      WHEN EXISTS (
        SELECT FROM agent_runs r WHERE r.status IN ('queued', 'pending', 'running') AND (
          EXISTS (SELECT FROM automations a WHERE a.id = r.workflow_automation_id)
          OR EXISTS (SELECT FROM jsonb_array_elements(r.official_workflow_provenance->'definitions') d
            WHERE d->>'name' IN (SELECT name FROM definitions)))
      ) THEN 'Nonterminal legacy run prevents retirement'
      WHEN EXISTS (
        SELECT FROM agent_run_callbacks c JOIN agent_runs r ON r.id = c.run_id
        WHERE c.status = 'pending' AND (EXISTS (SELECT FROM automations a WHERE a.id = r.workflow_automation_id)
          OR EXISTS (SELECT FROM jsonb_array_elements(r.official_workflow_provenance->'definitions') d
            WHERE d->>'name' IN (SELECT name FROM definitions)))
      ) THEN 'Pending legacy callback prevents retirement'
      WHEN EXISTS (
        SELECT FROM morning_brief_schedule_claims c JOIN automations a ON a.id = c.automation_id
        WHERE c.settlement = 'unsettled'
      ) THEN 'Unsettled legacy schedule claim prevents retirement'
    END AS busy
  FROM stage
), ready AS MATERIALIZED (
  SELECT FROM checks WHERE invalid IS NULL AND busy IS NULL
), archived AS (
  INSERT INTO archived_proactive_workflows
    (id, org_id, name, visibility, instruction, attachments, content_bundle, owner_user_id,
     display_name, description, archived_official_snapshot, official_definition_name,
     import_source, import_session_id, created_by, updated_by, created_at, updated_at, chat_thread_id)
  SELECT w.id, w.org_id, w.name, w.visibility, w.instruction, w.attachments, w.content_bundle, w.owner_user_id,
     w.display_name, w.description, w.archived_official_snapshot, w.official_definition_name,
     w.import_source, w.import_session_id, w.created_by, w.updated_by, w.created_at, w.updated_at, b.chat_thread_id
  FROM retiring_workflows w CROSS JOIN ready LEFT JOIN bindings b ON b.workflow_id = w.id
  RETURNING id, org_id, owner_user_id, official_definition_name, chat_thread_id
), archived_runs AS (
  INSERT INTO archived_proactive_workflow_runs (run_id, workflow_id, automation_id)
  SELECT r.run_id, r.workflow_id, r.automation_id FROM run_sources r JOIN archived a ON a.id = r.workflow_id
  RETURNING run_id
), task_threads AS (
  SELECT org_id, owner_user_id, chat_thread_id, CASE official_definition_name
    WHEN 'morning-brief' THEN 'morning-brief' WHEN 'internal-test-morning-brief' THEN 'morning-brief'
    WHEN 'agent-suggestions' THEN 'suggestions' WHEN 'proactive-learning' THEN 'learning' END AS task
  FROM archived WHERE chat_thread_id IS NOT NULL
), bound_schedules AS (
  -- A later opt-in reuses the thread. A concurrent settings save serializes on this
  -- same key. Existing choices, next slots and newer bindings always win.
  INSERT INTO proactive_schedules AS s
    (org_id, user_id, task, chat_thread_id, intended_enabled, enabled, consecutive_failures, reconciliation_status)
  SELECT b.org_id, b.owner_user_id, b.task, b.chat_thread_id, false, false, 0, 'current'
  FROM task_threads b WHERE b.task IS NOT NULL AND (
    EXISTS (SELECT FROM org_members_metadata m WHERE (m.org_id, m.user_id) = (b.org_id, b.owner_user_id))
    OR EXISTS (SELECT FROM proactive_schedules p WHERE (p.org_id, p.user_id, p.task) = (b.org_id, b.owner_user_id, b.task)))
  ON CONFLICT (org_id, user_id, task) DO UPDATE SET chat_thread_id = excluded.chat_thread_id
    WHERE s.chat_thread_id IS NULL
), removed AS (
  DELETE FROM workflows w USING archived a WHERE w.id = a.id RETURNING w.id
), removed_enrollments AS (
  DELETE FROM morning_brief_enrollments e USING enrollments k, ready
  WHERE (e.org_id, e.user_id) = (k.org_id, k.user_id) RETURNING e.user_id
)
SELECT checks.invalid, checks.busy, stage.archive_reader_release AS "rollbackRelease",
  (SELECT count(*)::int FROM removed) AS workflows, (SELECT count(*)::int FROM automations) AS automations,
  (SELECT count(*)::int FROM removed_enrollments) AS enrollments, (SELECT count(*)::int FROM archived_runs) AS runs
FROM checks CROSS JOIN stage
