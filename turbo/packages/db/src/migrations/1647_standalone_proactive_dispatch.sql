-- Earlier CHECKs accepted subsets of these values. Enforce the expanded checks on writes without scanning history under the DDL lock.
CREATE TABLE "proactive_dispatch_handoff" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"phase" text NOT NULL,
	"changed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_proactive_handoff_singleton" CHECK ("proactive_dispatch_handoff"."singleton"),
	CONSTRAINT "chk_proactive_handoff_phase" CHECK ("proactive_dispatch_handoff"."phase" IN ('automation', 'draining', 'standalone'))
);
--> statement-breakpoint
CREATE TABLE "proactive_occurrences" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"task" text NOT NULL,
	"scheduled_at" timestamp NOT NULL,
	"preference_revision" integer NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"run_id" uuid,
	"suggestions_enabled" boolean,
	"card_delivery_enabled" boolean,
	"settled_at" timestamp,
	CONSTRAINT "chk_proactive_occurrence_task" CHECK ("proactive_occurrences"."task" IN ('morning-brief','suggestions','learning'))
);
--> statement-breakpoint
ALTER TABLE "billing_run_attribution" DROP CONSTRAINT "billing_run_attribution_credit_policy_check";--> statement-breakpoint
ALTER TABLE "billing_run_attribution" DROP CONSTRAINT "billing_run_attribution_source_check";--> statement-breakpoint
ALTER TABLE "chat_events" DROP CONSTRAINT "chat_events_context_type_check";--> statement-breakpoint
ALTER TABLE "proactive_schedules" ADD COLUMN "preference_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_proactive_occurrence_thread" ON "proactive_occurrences" USING btree ("chat_thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_proactive_occurrence_slot" ON "proactive_occurrences" USING btree ("org_id","user_id","task","scheduled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_proactive_occurrence_run" ON "proactive_occurrences" USING btree ("run_id") WHERE "proactive_occurrences"."run_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_proactive_occurrence_outstanding" ON "proactive_occurrences" USING btree ("org_id","user_id","task") WHERE "proactive_occurrences"."settled_at" IS NULL;--> statement-breakpoint
ALTER TABLE "billing_run_attribution" ADD CONSTRAINT "billing_run_attribution_credit_policy_check" CHECK ("billing_run_attribution"."credit_charge_policy" IN ('standard', 'official_workflow_free', 'platform_proactive')) NOT VALID;--> statement-breakpoint
ALTER TABLE "billing_run_attribution" ADD CONSTRAINT "billing_run_attribution_source_check" CHECK ("billing_run_attribution"."source" IN ('chat', 'automation', 'proactive', 'slack', 'discord', 'wechat', 'teams', 'telegram', 'email', 'agentphone', 'github', 'agent', 'other')) NOT VALID;--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_context_type_check" CHECK ("chat_events"."context_type" IN (
          'web',
          'slack',
          'discord', 'wechat',
          'feishu',
          'teams',
          'telegram',
          'agentphone',
          'email',
          'automation',
          'proactive',
          'agent_run'
        )) NOT VALID;
--> statement-breakpoint
INSERT INTO proactive_dispatch_handoff (phase) VALUES ('automation');
