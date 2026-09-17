CREATE TABLE "agent_run_inference_objects" (
	"run_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"hash" varchar(64) NOT NULL,
	CONSTRAINT "agent_run_inference_objects_run_id_kind_hash_pk" PRIMARY KEY("run_id","kind","hash")
);
--> statement-breakpoint
CREATE TABLE "pi_inference_objects" (
	"hash" varchar(64) PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pi_inference_object_hash_check" CHECK ("pi_inference_objects"."hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "pi_inference_object_kind_check" CHECK ("pi_inference_objects"."kind" IN ('configuration', 'context', 'h1', 'secrets')),
	CONSTRAINT "pi_inference_object_size_check" CHECK (octet_length("pi_inference_objects"."content") <= 33554432)
);
--> statement-breakpoint
ALTER TABLE "agent_run_sandbox_intent" ADD COLUMN "terminal_effects_pending_at" timestamp;--> statement-breakpoint
ALTER TABLE "agent_run_sandbox_lease" ADD COLUMN "claimed_owner_epoch" integer;--> statement-breakpoint
ALTER TABLE "agent_run_sandbox_lease" ADD COLUMN "claimed_generation" integer;--> statement-breakpoint
ALTER TABLE "agent_run_inference_objects" ADD CONSTRAINT "agent_run_inference_objects_run_id_agent_run_inference_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_run_inference"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_inference_objects" ADD CONSTRAINT "agent_run_inference_objects_hash_pi_inference_objects_hash_fk" FOREIGN KEY ("hash") REFERENCES "public"."pi_inference_objects"("hash") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_run_inference_object_hash_idx" ON "agent_run_inference_objects" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "pi_inference_object_gc_idx" ON "pi_inference_objects" USING btree ("created_at","hash");--> statement-breakpoint
CREATE INDEX "agent_run_sandbox_intent_terminal_idx" ON "agent_run_sandbox_intent" USING btree ("terminal_effects_pending_at","run_id") WHERE "agent_run_sandbox_intent"."terminal_effects_pending_at" IS NOT NULL;