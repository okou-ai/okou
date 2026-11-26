CREATE TABLE "proactive_schedules" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"task" text NOT NULL,
	"intended_enabled" boolean NOT NULL,
	"enabled" boolean NOT NULL,
	"timezone" text,
	"next_run_at" timestamp,
	"last_run_at" timestamp,
	"last_run_id" uuid,
	"consecutive_failures" integer NOT NULL,
	"reconciliation_status" text,
	"deferred_anchor_at" timestamp,
	"deferred_until" timestamp,
	"deferred_reason" text,
	"chat_thread_id" uuid,
	CONSTRAINT "proactive_schedules_org_id_user_id_task_pk" PRIMARY KEY("org_id","user_id","task"),
	CONSTRAINT "chk_proactive_schedule_task" CHECK ("proactive_schedules"."task" IN ('morning-brief', 'suggestions', 'learning'))
);
--> statement-breakpoint
ALTER TABLE "proactive_schedules" ADD CONSTRAINT "proactive_schedules_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_proactive_schedules_due" ON "proactive_schedules" USING btree ("next_run_at") WHERE "proactive_schedules"."enabled" AND "proactive_schedules"."next_run_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_proactive_schedules_user" ON "proactive_schedules" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_proactive_schedules_thread" ON "proactive_schedules" USING btree ("chat_thread_id") WHERE "proactive_schedules"."chat_thread_id" IS NOT NULL;--> statement-breakpoint
CREATE VIEW "public"."legacy_proactive_schedules" WITH (security_invoker = true) AS (
  WITH definitions(name, task, blueprint) AS (
    VALUES ('morning-brief', 'morning-brief', 'daily-delivery'),
           ('internal-test-morning-brief', 'morning-brief', 'daily-delivery'),
           ('agent-suggestions', 'suggestions', 'hourly-check'),
           ('proactive-learning', 'learning', 'nightly-learning')
  ), installations AS (
    SELECT w.org_id, w.owner_user_id AS user_id, d.task, d.blueprint, w.id
    FROM workflows w JOIN definitions d ON d.name = w.official_definition_name
    WHERE w.visibility = 'private'
  ), owners AS (
    SELECT org_id, user_id, task FROM installations
    UNION
    SELECT org_id, user_id, 'morning-brief' FROM morning_brief_enrollments
    WHERE state IN ('pending', 'cancelled')
    UNION
    SELECT m.org_id, m.user_id, d.task FROM org_members_metadata m
    CROSS JOIN (VALUES ('suggestions'), ('learning')) d(task)
    WHERE m.proactive_suggestions_enabled IS TRUE
  )
  SELECT o.org_id, o.user_id, o.task,
    CASE WHEN o.task = 'morning-brief'
      THEN COALESCE(a.official_intended_enabled, e.state = 'pending', false)
      ELSE COALESCE(m.proactive_suggestions_enabled, false)
    END AS intended_enabled,
    COALESCE(a.enabled, false) AS enabled,
    COALESCE(a.timezone, CASE WHEN o.task = 'suggestions' THEN 'UTC' ELSE m.timezone END) AS timezone,
    a.next_run_at, a.last_run_at, a.last_run_id,
    COALESCE(a.consecutive_failures, 0) AS consecutive_failures,
    a.official_reconciliation_status AS reconciliation_status,
    a.deferred_anchor_at, a.deferred_until, a.deferred_reason,
    t.id AS chat_thread_id, a.id IS NOT NULL AS installed, m.timezone AS member_timezone
  FROM owners o
  LEFT JOIN installations i USING (org_id, user_id, task)
  LEFT JOIN workflow_automations a ON a.workflow_id = i.id
    AND a.org_id = o.org_id AND a.owner_user_id = o.user_id
    AND a.official_blueprint_key = i.blueprint AND a.kind = 'schedule' AND a.schedule_type = 'cron'
  LEFT JOIN morning_brief_enrollments e ON o.task = 'morning-brief'
    AND e.org_id = o.org_id AND e.user_id = o.user_id
  LEFT JOIN org_members_metadata m ON m.org_id = o.org_id AND m.user_id = o.user_id
  LEFT JOIN workflow_user_automation_threads b ON b.workflow_id = i.id
    AND b.org_id = o.org_id AND b.user_id = o.user_id
  LEFT JOIN chat_threads t ON t.id = b.chat_thread_id AND t.org_id = o.org_id AND t.user_id = o.user_id
  WHERE e.state IS DISTINCT FROM 'departed'
);
--> statement-breakpoint
-- Take the initial snapshot without changing dispatch ownership or advancing any slot.
-- Repeat the projection from live state after the old dispatcher has drained at cutover.
INSERT INTO proactive_schedules (
  org_id, user_id, task, intended_enabled, enabled, timezone,
  next_run_at, last_run_at, last_run_id, consecutive_failures, reconciliation_status,
  deferred_anchor_at, deferred_until, deferred_reason, chat_thread_id
)
SELECT org_id, user_id, task, intended_enabled, enabled, timezone,
  next_run_at, last_run_at, last_run_id, consecutive_failures, reconciliation_status,
  deferred_anchor_at, deferred_until, deferred_reason, chat_thread_id
FROM legacy_proactive_schedules;
