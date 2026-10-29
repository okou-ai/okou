CREATE TABLE "agent_suggestion_items" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"id" uuid NOT NULL,
	"status" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"content" jsonb,
	"selected_option_id" text,
	"feedbacks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_suggestion_items_org_id_user_id_id_pk" PRIMARY KEY("org_id","user_id","id"),
	CONSTRAINT "agent_suggestion_items_status" CHECK ("agent_suggestion_items"."status" IN ('active', 'consumed', 'removed')),
	CONSTRAINT "agent_suggestion_items_active_content" CHECK ("agent_suggestion_items"."status" <> 'active' OR "agent_suggestion_items"."content" IS NOT NULL),
	CONSTRAINT "agent_suggestion_items_feedback_bound" CHECK (jsonb_typeof("agent_suggestion_items"."feedbacks") = 'array' AND jsonb_array_length("agent_suggestion_items"."feedbacks") <= 100)
);
--> statement-breakpoint
CREATE INDEX "agent_suggestion_items_active_order" ON "agent_suggestion_items" USING btree ("org_id","user_id","priority" DESC NULLS LAST,"created_at","id") WHERE "agent_suggestion_items"."status" = 'active';--> statement-breakpoint
CREATE INDEX "agent_suggestion_items_pending_feedback" ON "agent_suggestion_items" USING btree ("org_id","user_id","updated_at","id") WHERE jsonb_path_exists("agent_suggestion_items"."feedbacks", '$[*] ? (@.learnedAt == null)');--> statement-breakpoint
CREATE INDEX "agent_suggestion_items_expiry" ON "agent_suggestion_items" USING btree ("expires_at","org_id","user_id","id");--> statement-breakpoint
CREATE INDEX "agent_suggestion_items_receipts" ON "agent_suggestion_items" USING btree ("org_id","user_id","updated_at" DESC NULLS LAST,"id") WHERE "agent_suggestion_items"."status" <> 'active';
--> statement-breakpoint
-- Disposable cards are intentionally discarded; no legacy data is copied.
-- Keep only the outgoing table schema until old API invocations have drained.
DELETE FROM "agent_suggestions";
