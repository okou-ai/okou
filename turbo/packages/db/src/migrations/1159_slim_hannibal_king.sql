CREATE TABLE "pi_stable_context_artifact_resources" (
	"artifact_digest" varchar(64) NOT NULL,
	"ordinal" integer NOT NULL,
	"storage_id" uuid NOT NULL,
	"storage_version_id" varchar(64) NOT NULL,
	CONSTRAINT "pi_stable_context_artifact_resources_pk" PRIMARY KEY("artifact_digest","ordinal"),
	CONSTRAINT "pi_stable_context_artifact_resources_ordinal_check" CHECK ("pi_stable_context_artifact_resources"."ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pi_stable_context_artifacts" (
	"digest" varchar(64) PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"projection" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pi_stable_context_erasure_fences" (
	"subject_kind" varchar(16) NOT NULL,
	"subject_digest" varchar(64) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pi_stable_context_erasure_fences_pk" PRIMARY KEY("subject_kind","subject_digest"),
	CONSTRAINT "pi_stable_context_erasure_fences_kind_check" CHECK ("pi_stable_context_erasure_fences"."subject_kind" IN ('organization', 'user'))
);
--> statement-breakpoint
CREATE TABLE "pi_stable_context_generations" (
	"org_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"generation" bigint DEFAULT 1 NOT NULL,
	"publication_state" varchar(16) DEFAULT 'ready' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pi_stable_context_generations_pk" PRIMARY KEY("org_id","agent_id","subject"),
	CONSTRAINT "pi_stable_context_generations_state_check" CHECK ("pi_stable_context_generations"."publication_state" IN ('pending', 'ready')),
	CONSTRAINT "pi_stable_context_generations_generation_check" CHECK ("pi_stable_context_generations"."generation" > 0)
);
--> statement-breakpoint
CREATE TABLE "pi_stable_context_heads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"variant_digest" varchar(64) NOT NULL,
	"generation" bigint DEFAULT 1 NOT NULL,
	"agent_generation" bigint DEFAULT 1 NOT NULL,
	"user_generation" bigint DEFAULT 1 NOT NULL,
	"input_digest" varchar(64),
	"status" varchar(16) DEFAULT 'missing' NOT NULL,
	"input" jsonb,
	"artifact_digest" varchar(64),
	"validity_horizon" timestamp,
	"lease_id" uuid,
	"lease_expires_at" timestamp,
	"available_at" timestamp DEFAULT now() NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error_class" varchar(128),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pi_stable_context_heads_status_check" CHECK ("pi_stable_context_heads"."status" IN ('missing', 'pending', 'running', 'ready', 'unindexable', 'failed')),
	CONSTRAINT "pi_stable_context_heads_generation_check" CHECK ("pi_stable_context_heads"."generation" > 0 AND "pi_stable_context_heads"."agent_generation" > 0 AND "pi_stable_context_heads"."user_generation" > 0),
	CONSTRAINT "pi_stable_context_heads_input_check" CHECK (("pi_stable_context_heads"."status" = 'missing' AND "pi_stable_context_heads"."input" IS NULL AND "pi_stable_context_heads"."input_digest" IS NULL) OR ("pi_stable_context_heads"."status" <> 'missing' AND "pi_stable_context_heads"."input" IS NOT NULL AND "pi_stable_context_heads"."input_digest" IS NOT NULL)),
	CONSTRAINT "pi_stable_context_heads_artifact_check" CHECK (("pi_stable_context_heads"."status" = 'ready' AND "pi_stable_context_heads"."artifact_digest" IS NOT NULL) OR ("pi_stable_context_heads"."status" <> 'ready' AND "pi_stable_context_heads"."artifact_digest" IS NULL)),
	CONSTRAINT "pi_stable_context_heads_lease_check" CHECK (("pi_stable_context_heads"."status" = 'running' AND "pi_stable_context_heads"."lease_id" IS NOT NULL AND "pi_stable_context_heads"."lease_expires_at" IS NOT NULL) OR ("pi_stable_context_heads"."status" <> 'running' AND "pi_stable_context_heads"."lease_id" IS NULL AND "pi_stable_context_heads"."lease_expires_at" IS NULL)),
	CONSTRAINT "pi_stable_context_heads_attempt_check" CHECK ("pi_stable_context_heads"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pi_stable_context_publications" (
	"org_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"publication_key" text NOT NULL,
	"generation" bigint NOT NULL,
	"token" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pi_stable_context_publications_pk" PRIMARY KEY("org_id","agent_id","subject","publication_key"),
	CONSTRAINT "pi_stable_context_publications_generation_check" CHECK ("pi_stable_context_publications"."generation" > 0)
);
--> statement-breakpoint
ALTER TABLE "pi_stable_context_artifact_resources" ADD CONSTRAINT "pi_stable_context_artifact_resources_artifact_fk" FOREIGN KEY ("artifact_digest") REFERENCES "public"."pi_stable_context_artifacts"("digest") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pi_stable_context_artifact_resources" ADD CONSTRAINT "pi_stable_context_artifact_resources_storage_fk" FOREIGN KEY ("storage_id") REFERENCES "public"."storages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pi_stable_context_artifact_resources" ADD CONSTRAINT "pi_stable_context_artifact_resources_version_fk" FOREIGN KEY ("storage_version_id") REFERENCES "public"."storage_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pi_stable_context_artifacts" ADD CONSTRAINT "pi_stable_context_artifacts_agent_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pi_stable_context_heads" ADD CONSTRAINT "pi_stable_context_heads_artifact_digest_pi_stable_context_artifacts_digest_fk" FOREIGN KEY ("artifact_digest") REFERENCES "public"."pi_stable_context_artifacts"("digest") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pi_stable_context_heads" ADD CONSTRAINT "pi_stable_context_heads_agent_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pi_stable_context_artifact_resources_version_idx" ON "pi_stable_context_artifact_resources" USING btree ("artifact_digest","storage_version_id","ordinal");--> statement-breakpoint
CREATE INDEX "pi_stable_context_artifact_resources_storage_idx" ON "pi_stable_context_artifact_resources" USING btree ("storage_id");--> statement-breakpoint
CREATE INDEX "pi_stable_context_artifacts_owner_idx" ON "pi_stable_context_artifacts" USING btree ("org_id","user_id","agent_id");--> statement-breakpoint
CREATE INDEX "pi_stable_context_artifacts_created_at_idx" ON "pi_stable_context_artifacts" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pi_stable_context_heads_owner_variant_idx" ON "pi_stable_context_heads" USING btree ("org_id","user_id","agent_id","variant_digest");--> statement-breakpoint
CREATE INDEX "pi_stable_context_heads_pending_idx" ON "pi_stable_context_heads" USING btree ("available_at","id") WHERE "pi_stable_context_heads"."status" IN ('pending', 'failed');--> statement-breakpoint
CREATE INDEX "pi_stable_context_heads_lease_idx" ON "pi_stable_context_heads" USING btree ("lease_expires_at","id") WHERE "pi_stable_context_heads"."status" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "pi_stable_context_publications_token_idx" ON "pi_stable_context_publications" USING btree ("token");