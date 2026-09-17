CREATE TABLE "morning_brief_generations" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"scheduled_for" timestamp NOT NULL,
	"collection_kind" text NOT NULL,
	"collection_version" integer NOT NULL,
	"execution_purpose" text NOT NULL,
	"attempt_id" uuid NOT NULL,
	"state" text NOT NULL,
	"membership_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"model" text NOT NULL,
	"prompt_version" integer NOT NULL,
	"result_schema_version" integer NOT NULL,
	"language" text NOT NULL,
	"language_source" text NOT NULL,
	"input_digest" text NOT NULL,
	"input_items" integer NOT NULL,
	"included_items" integer NOT NULL,
	"input_reduced" boolean NOT NULL,
	"source_coverage" text NOT NULL,
	"reserved_at" timestamp NOT NULL,
	"reservation_expires_at" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL,
	"finished_at" timestamp,
	"decision" text,
	"skip_reason" text,
	"result_title" text,
	"result_markdown" text,
	"result_bytes" integer,
	"failure_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "morning_brief_generations_pk" PRIMARY KEY("org_id","user_id","scheduled_for","collection_kind","collection_version"),
	CONSTRAINT "chk_morning_brief_generation_purpose" CHECK ("morning_brief_generations"."execution_purpose" IN ('preview')),
	CONSTRAINT "chk_morning_brief_generation_state" CHECK ("morning_brief_generations"."state" IN ('reserved', 'succeeded', 'output_rejected', 'provider_failed', 'not_invoked', 'result_discarded', 'invocation_outcome_unknown', 'skipped_empty', 'skipped_incomplete')),
	CONSTRAINT "chk_morning_brief_generation_language_source" CHECK ("morning_brief_generations"."language_source" IN ('member-locale', 'default')),
	CONSTRAINT "chk_morning_brief_generation_coverage" CHECK ("morning_brief_generations"."source_coverage" IN ('complete', 'partial', 'empty')),
	CONSTRAINT "chk_morning_brief_generation_failure_reason" CHECK ("morning_brief_generations"."failure_reason" IS NULL
          OR "morning_brief_generations"."failure_reason" IN ('not_configured', 'provider_error', 'response_unreadable', 'transport_failed', 'output_truncated', 'unexpected_tool_calls', 'invalid_json', 'invalid_shape', 'unknown_source_reference', 'empty_deliver', 'result_too_large', 'reservation_expired', 'owner_revoked', 'binding_changed', 'persistence_failed')),
	CONSTRAINT "chk_morning_brief_generation_skip_reason" CHECK (("morning_brief_generations"."decision" = 'skip') = ("morning_brief_generations"."skip_reason" IS NOT NULL)),
	CONSTRAINT "chk_morning_brief_generation_finished" CHECK (("morning_brief_generations"."state" = 'reserved') = ("morning_brief_generations"."finished_at" IS NULL)),
	CONSTRAINT "chk_morning_brief_generation_decision" CHECK (("morning_brief_generations"."state" = 'succeeded') = ("morning_brief_generations"."decision" IS NOT NULL)
          AND ("morning_brief_generations"."decision" = 'deliver') =
            ("morning_brief_generations"."result_markdown" IS NOT NULL
             AND "morning_brief_generations"."result_title" IS NOT NULL
             AND "morning_brief_generations"."result_bytes" IS NOT NULL)
          AND ("morning_brief_generations"."result_bytes" IS NULL OR "morning_brief_generations"."result_bytes" > 0)),
	CONSTRAINT "chk_morning_brief_generation_included_items" CHECK ("morning_brief_generations"."included_items" >= 0 AND "morning_brief_generations"."included_items" <= "morning_brief_generations"."input_items"),
	CONSTRAINT "chk_morning_brief_generation_reservation" CHECK ("morning_brief_generations"."reservation_expires_at" > "morning_brief_generations"."reserved_at"
          AND "morning_brief_generations"."expires_at" > "morning_brief_generations"."reserved_at")
);
--> statement-breakpoint
CREATE TABLE "morning_brief_platform_generation_receipts" (
	"attempt_id" uuid PRIMARY KEY NOT NULL,
	"operation" text NOT NULL,
	"provider" text NOT NULL,
	"requested_model" text NOT NULL,
	"returned_model" text,
	"provider_generation_id" text,
	"outcome" text NOT NULL,
	"cost_state" text NOT NULL,
	"cost_value" numeric(24, 12),
	"cost_unit" text,
	"cost_source" text,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"reasoning_tokens" integer,
	"cached_tokens" integer,
	"total_tokens" integer,
	"started_at" timestamp NOT NULL,
	"finished_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_morning_brief_platform_receipt_outcome" CHECK ("morning_brief_platform_generation_receipts"."outcome" IN ('response_received', 'provider_error', 'response_unreadable', 'invocation_unknown')),
	CONSTRAINT "chk_morning_brief_platform_receipt_cost_state" CHECK ("morning_brief_platform_generation_receipts"."cost_state" IN ('reported', 'unavailable', 'invocation_unknown')),
	CONSTRAINT "chk_morning_brief_platform_receipt_cost_source" CHECK ("morning_brief_platform_generation_receipts"."cost_source" IS NULL
          OR "morning_brief_platform_generation_receipts"."cost_source" IN ('chat_completion_usage_cost', 'generation_total_cost')),
	CONSTRAINT "chk_morning_brief_platform_receipt_tokens" CHECK (("morning_brief_platform_generation_receipts"."prompt_tokens" IS NULL OR "morning_brief_platform_generation_receipts"."prompt_tokens" >= 0)
          AND ("morning_brief_platform_generation_receipts"."completion_tokens" IS NULL OR "morning_brief_platform_generation_receipts"."completion_tokens" >= 0)
          AND ("morning_brief_platform_generation_receipts"."reasoning_tokens" IS NULL OR "morning_brief_platform_generation_receipts"."reasoning_tokens" >= 0)
          AND ("morning_brief_platform_generation_receipts"."cached_tokens" IS NULL OR "morning_brief_platform_generation_receipts"."cached_tokens" >= 0)
          AND ("morning_brief_platform_generation_receipts"."total_tokens" IS NULL OR "morning_brief_platform_generation_receipts"."total_tokens" >= 0)),
	CONSTRAINT "chk_morning_brief_platform_receipt_cost" CHECK (("morning_brief_platform_generation_receipts"."cost_state" = 'reported') =
            ("morning_brief_platform_generation_receipts"."cost_value" IS NOT NULL
             AND "morning_brief_platform_generation_receipts"."cost_unit" IS NOT NULL
             AND "morning_brief_platform_generation_receipts"."cost_source" IS NOT NULL)
          AND ("morning_brief_platform_generation_receipts"."cost_value" IS NULL OR "morning_brief_platform_generation_receipts"."cost_value" >= 0)),
	CONSTRAINT "chk_morning_brief_platform_receipt_times" CHECK ("morning_brief_platform_generation_receipts"."finished_at" >= "morning_brief_platform_generation_receipts"."started_at")
);
--> statement-breakpoint
ALTER TABLE "morning_brief_generations" ADD CONSTRAINT "fk_morning_brief_generations_occurrence" FOREIGN KEY ("org_id","user_id","scheduled_for","collection_kind","collection_version") REFERENCES "public"."morning_brief_collection_occurrences"("org_id","user_id","scheduled_for","collection_kind","collection_version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_morning_brief_generations_owner_expiry" ON "morning_brief_generations" USING btree ("org_id","user_id","expires_at");--> statement-breakpoint
CREATE INDEX "idx_morning_brief_platform_generation_receipts_started" ON "morning_brief_platform_generation_receipts" USING btree ("started_at");