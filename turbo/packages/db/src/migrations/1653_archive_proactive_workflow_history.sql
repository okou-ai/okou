CREATE TABLE "archived_proactive_workflow_runs" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"workflow_id" uuid NOT NULL,
	"automation_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "archived_proactive_workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"name" varchar(64) NOT NULL,
	"visibility" varchar(16) DEFAULT 'private' NOT NULL,
	"instruction" text,
	"attachments" jsonb,
	"content_bundle" jsonb,
	"owner_user_id" text NOT NULL,
	"display_name" varchar(256),
	"description" text,
	"archived_official_snapshot" jsonb,
	"official_definition_name" varchar(64),
	"import_source" varchar(32),
	"import_session_id" uuid,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"chat_thread_id" uuid,
	CONSTRAINT "chk_archived_proactive_workflow_private" CHECK ("archived_proactive_workflows"."visibility" = 'private' AND "archived_proactive_workflows"."official_definition_name" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "proactive_dispatch_handoff" ADD COLUMN "archive_reader_release" text;--> statement-breakpoint
ALTER TABLE "proactive_dispatch_handoff" ADD COLUMN "archive_reader_verified_at" timestamp;--> statement-breakpoint
ALTER TABLE "archived_proactive_workflow_runs" ADD CONSTRAINT "archived_proactive_workflow_runs_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archived_proactive_workflow_runs" ADD CONSTRAINT "archived_proactive_workflow_runs_workflow_id_archived_proactive_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."archived_proactive_workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archived_proactive_workflows" ADD CONSTRAINT "archived_proactive_workflows_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_archived_proactive_runs_workflow" ON "archived_proactive_workflow_runs" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "idx_archived_proactive_workflow_thread" ON "archived_proactive_workflows" USING btree ("chat_thread_id");--> statement-breakpoint
CREATE INDEX "idx_archived_proactive_workflow_owner" ON "archived_proactive_workflows" USING btree ("org_id","owner_user_id");