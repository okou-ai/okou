import { command } from "ccstate";
import { sql } from "drizzle-orm";
import { boolean, number, object, enum as zEnum } from "zod";
import { parseRawRows } from "../../lib/db-raw-rows";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";

const handoffResult = object({
  phase: zEnum(["automation", "draining", "standalone"]),
  ready: boolean(),
  changed: boolean(),
  queued: number(),
  running: number(),
  claims: number(),
  callbacks: number(),
  missingCursors: number(),
  copied: number(),
  removed: number(),
});

/** Each invocation observes the legacy obligations and publishes at most one release-wide transition. */
export const handoffProactiveDispatch$ = command(
  async (
    { set },
    request: { action: "drain" | "activate"; apply: boolean },
    signal: AbortSignal,
  ) => {
    const drain = request.action === "drain";
    const from = drain ? "automation" : "draining";
    const to = drain ? "draining" : "standalone";
    const at = nowDate().toISOString();
    const [result] = parseRawRows(
      handoffResult,
      await set(writeDb$).execute(sql`WITH state AS MATERIALIZED (
    SELECT phase,changed_at FROM proactive_dispatch_handoff WHERE singleton ${request.apply ? sql`FOR UPDATE` : sql.empty()}
  ), legacy AS MATERIALIZED (
    SELECT a.id FROM workflow_automations a JOIN workflows w ON w.id=a.workflow_id
    WHERE w.org_id=a.org_id AND w.owner_user_id=a.owner_user_id AND w.visibility='private' AND a.kind='schedule' AND a.schedule_type='cron'
      AND (w.official_definition_name,a.official_blueprint_key) IN
       (('morning-brief','daily-delivery'),('internal-test-morning-brief','daily-delivery'),('agent-suggestions','hourly-check'),('proactive-learning','nightly-learning'))
  ), work AS MATERIALIZED (SELECT
     (SELECT count(*)::int FROM legacy a JOIN chat_automation_context c ON c.automation_id=a.id JOIN chat_events e ON e.context_id=c.id
       WHERE e.context_type='automation' AND e.event_type='input.automation' AND e.run_id IS NULL AND NOT EXISTS (SELECT 1 FROM chat_events r WHERE r.revokes_event_id=e.id)) AS queued,
     (SELECT count(*)::int FROM legacy a JOIN agent_runs r ON r.workflow_automation_id=a.id WHERE r.status IN ('queued','pending','running')) AS running,
     (SELECT count(*)::int FROM legacy a JOIN morning_brief_schedule_claims c ON c.automation_id=a.id WHERE c.settlement='unsettled') AS claims,
     (SELECT count(*)::int FROM legacy a JOIN agent_runs r ON r.workflow_automation_id=a.id JOIN agent_run_callbacks c ON c.run_id=r.id
        WHERE c.internal_kind IN ('workflow-automation:cron','workflow-automation:loop') AND c.status='pending') AS callbacks,
     (SELECT count(*)::int FROM legacy_proactive_schedules WHERE installed AND enabled AND intended_enabled AND reconciliation_status='current' AND next_run_at IS NULL) AS "missingCursors"
  ), gate AS MATERIALIZED (
    SELECT state.phase, state.phase=${from} AND (${drain} OR (
      state.changed_at <= ${at}::timestamp - interval '5 minutes' AND
      work.queued+work.running+work.claims+work.callbacks+work."missingCursors"=0)) AS ready FROM state CROSS JOIN work
  ), transition AS (
    UPDATE proactive_dispatch_handoff h SET phase=${to},changed_at=${at}::timestamp FROM gate
    WHERE h.singleton AND h.phase=${from} AND gate.ready AND ${request.apply} RETURNING h.phase
  ), copied AS (
    INSERT INTO proactive_schedules AS s (org_id,user_id,task,intended_enabled,enabled,timezone,next_run_at,last_run_at,last_run_id,
      consecutive_failures,reconciliation_status,deferred_anchor_at,deferred_until,deferred_reason,chat_thread_id)
    SELECT l.org_id,l.user_id,l.task,l.intended_enabled,l.enabled,l.timezone,l.next_run_at,l.last_run_at,l.last_run_id,
      l.consecutive_failures,l.reconciliation_status,l.deferred_anchor_at,l.deferred_until,l.deferred_reason,l.chat_thread_id
      FROM legacy_proactive_schedules l WHERE EXISTS (SELECT 1 FROM transition)
    ON CONFLICT (org_id,user_id,task) DO UPDATE SET
      intended_enabled=CASE WHEN s.preference_revision=0 THEN excluded.intended_enabled ELSE s.intended_enabled END,
      enabled=CASE WHEN s.preference_revision=0 THEN excluded.enabled ELSE s.enabled END,
      timezone=CASE WHEN s.preference_revision=0 THEN excluded.timezone ELSE s.timezone END,
      next_run_at=CASE WHEN s.preference_revision=0 THEN excluded.next_run_at ELSE s.next_run_at END,
      consecutive_failures=CASE WHEN s.preference_revision=0 THEN excluded.consecutive_failures ELSE s.consecutive_failures END,
      reconciliation_status=CASE WHEN s.preference_revision=0 THEN excluded.reconciliation_status ELSE s.reconciliation_status END,
      deferred_anchor_at=CASE WHEN s.preference_revision=0 THEN excluded.deferred_anchor_at ELSE s.deferred_anchor_at END,
      deferred_until=CASE WHEN s.preference_revision=0 THEN excluded.deferred_until ELSE s.deferred_until END,
      deferred_reason=CASE WHEN s.preference_revision=0 THEN excluded.deferred_reason ELSE s.deferred_reason END,
      last_run_at=excluded.last_run_at,
      last_run_id=excluded.last_run_id,
      chat_thread_id=CASE WHEN s.preference_revision=0 THEN excluded.chat_thread_id ELSE coalesce(s.chat_thread_id,excluded.chat_thread_id) END WHERE (s.preference_revision=0 AND ROW(s.intended_enabled,s.enabled,s.timezone,s.next_run_at,s.consecutive_failures,s.reconciliation_status,s.deferred_anchor_at,s.deferred_until,s.deferred_reason,s.chat_thread_id)
       IS DISTINCT FROM ROW(excluded.intended_enabled,excluded.enabled,excluded.timezone,excluded.next_run_at,excluded.consecutive_failures,excluded.reconciliation_status,excluded.deferred_anchor_at,excluded.deferred_until,excluded.deferred_reason,excluded.chat_thread_id))
       OR (s.last_run_at,s.last_run_id) IS DISTINCT FROM (excluded.last_run_at,excluded.last_run_id)
       OR (s.chat_thread_id IS NULL AND excluded.chat_thread_id IS NOT NULL) RETURNING 1
  ), removed AS (DELETE FROM proactive_schedules s WHERE EXISTS (SELECT 1 FROM transition) AND s.preference_revision=0 AND NOT EXISTS
      (SELECT 1 FROM legacy_proactive_schedules l WHERE (l.org_id,l.user_id,l.task)=(s.org_id,s.user_id,s.task)) RETURNING 1)
    SELECT coalesce((SELECT phase FROM transition),gate.phase) AS phase,
      (gate.ready OR gate.phase=${to}) AS ready,EXISTS (SELECT 1 FROM transition) AS changed,work.*,
      (SELECT count(*)::int FROM copied) AS copied,(SELECT count(*)::int FROM removed) AS removed FROM gate CROSS JOIN work`),
    );
    signal.throwIfAborted();
    if (!result) {
      throw new Error("Missing proactive dispatch handoff");
    }
    return result;
  },
);
