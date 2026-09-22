CREATE TABLE "home_task_recommendations" (
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"entries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"generated_at" timestamp,
	"input_digest" text,
	"next_refresh_at" timestamp DEFAULT now() NOT NULL,
	"claim_id" uuid,
	"claim_expires_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "home_task_recommendations_user_id_org_id_agent_id_pk" PRIMARY KEY("user_id","org_id","agent_id"),
	CONSTRAINT "home_task_recommendations_entries_bound" CHECK (jsonb_typeof("home_task_recommendations"."entries") = 'array' AND jsonb_array_length("home_task_recommendations"."entries") <= 3 AND octet_length("home_task_recommendations"."entries"::text) <= 8192)
);
--> statement-breakpoint
ALTER TABLE "home_task_recommendations" ADD CONSTRAINT "home_task_recommendations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "home_task_recommendations_refresh_idx" ON "home_task_recommendations" USING btree ("next_refresh_at");