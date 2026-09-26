CREATE TABLE "usage_chat_projection_work" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"desired_revision" integer DEFAULT 1 NOT NULL,
	"applied_revision" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp DEFAULT now() NOT NULL,
	"lease_id" uuid,
	"lease_expires_at" timestamp,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "usage_chat_projection_revisions_check" CHECK ("usage_chat_projection_work"."desired_revision" > 0 AND "usage_chat_projection_work"."applied_revision" >= 0 AND "usage_chat_projection_work"."applied_revision" <= "usage_chat_projection_work"."desired_revision"),
	CONSTRAINT "usage_chat_projection_lease_check" CHECK (("usage_chat_projection_work"."lease_id" IS NULL) = ("usage_chat_projection_work"."lease_expires_at" IS NULL)),
	CONSTRAINT "usage_chat_projection_failures_check" CHECK ("usage_chat_projection_work"."failure_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "usage_chat_projection_work" ADD CONSTRAINT "usage_chat_projection_work_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_usage_chat_projection_due" ON "usage_chat_projection_work" USING btree ("available_at","run_id") WHERE "usage_chat_projection_work"."applied_revision" < "usage_chat_projection_work"."desired_revision";