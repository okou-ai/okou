CREATE TABLE "morning_brief_installed_preferences" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"projection_version" integer NOT NULL,
	"workflow_id" uuid NOT NULL,
	"automation_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"chat_thread_id" uuid,
	"enabled" boolean NOT NULL,
	"cron_expression" text,
	"timezone" text NOT NULL,
	"next_run_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "morning_brief_installed_preferences_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "morning_brief_installed_preferences" ADD CONSTRAINT "fk_morning_brief_installed_preferences_member" FOREIGN KEY ("org_id","user_id") REFERENCES "public"."org_members_cache"("org_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "morning_brief_installed_preferences" ADD CONSTRAINT "fk_morning_brief_installed_preferences_agent" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "morning_brief_installed_preferences" ADD CONSTRAINT "fk_morning_brief_installed_preferences_thread" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_morning_brief_installed_preferences_user" ON "morning_brief_installed_preferences" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_morning_brief_installed_preferences_agent" ON "morning_brief_installed_preferences" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_morning_brief_installed_preferences_thread" ON "morning_brief_installed_preferences" USING btree ("chat_thread_id");