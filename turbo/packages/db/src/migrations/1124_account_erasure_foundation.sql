CREATE TABLE "account_erasure_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_kind" varchar(16) NOT NULL,
	"subject_id" varchar(192) NOT NULL,
	"generation" integer NOT NULL,
	"authority_id" uuid NOT NULL,
	"decision_ref" uuid NOT NULL,
	"decision_sequence" bigint NOT NULL,
	"confirmation_ref" uuid NOT NULL,
	"previous_decision_ref" uuid,
	"disposition_version" integer NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"capture_revision" integer DEFAULT 1 NOT NULL,
	"inventory_revision" integer DEFAULT 1 NOT NULL,
	"sealed_capture_revision" integer,
	"producer_boundary_ref" uuid,
	"retirement_release_ref" uuid,
	"state" varchar(32) DEFAULT 'pending' NOT NULL,
	CONSTRAINT "account_erasure_positive_versions" CHECK ("account_erasure_jobs"."generation" > 0 AND "account_erasure_jobs"."decision_sequence" > 0 AND "account_erasure_jobs"."disposition_version" > 0 AND "account_erasure_jobs"."capture_revision" > 0 AND "account_erasure_jobs"."inventory_revision" > 0),
	CONSTRAINT "account_erasure_subject_kind" CHECK ("account_erasure_jobs"."subject_kind" IN ('user', 'organization')),
	CONSTRAINT "account_erasure_job_outcome" CHECK ("account_erasure_jobs"."state" IN ('pending', 'retryable_failure', 'capability_unresolved', 'verified_erased', 'verified_no_applicable_data'))
);
--> statement-breakpoint
CREATE TABLE "account_erasure_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_id" uuid NOT NULL,
	"capture_revision" integer NOT NULL,
	"page_key" uuid NOT NULL,
	"digest" varchar(64) NOT NULL,
	"input_cursor_digest" varchar(64)
);
--> statement-breakpoint
CREATE TABLE "account_erasure_selector_dependencies" (
	"work_id" uuid NOT NULL,
	"sink_id" uuid NOT NULL,
	"item_key" uuid NOT NULL,
	"obligation" varchar(16) NOT NULL,
	CONSTRAINT "account_erasure_selector_dependencies_work_id_sink_id_item_key_pk" PRIMARY KEY("work_id","sink_id","item_key")
);
--> statement-breakpoint
CREATE TABLE "account_erasure_sinks" (
	"job_id" uuid NOT NULL,
	"sink_id" uuid NOT NULL,
	"domain" varchar(24) NOT NULL,
	"inventory_revision" integer NOT NULL,
	"collector_version" uuid NOT NULL,
	CONSTRAINT "account_erasure_sinks_job_id_sink_id_pk" PRIMARY KEY("job_id","sink_id"),
	CONSTRAINT "account_erasure_sink_domain" CHECK ("account_erasure_sinks"."domain" IN ('relational', 'objects', 'providers', 'telemetry', 'recovery', 'client'))
);
--> statement-breakpoint
CREATE TABLE "account_erasure_work" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"sink_id" uuid NOT NULL,
	"item_key" uuid NOT NULL,
	"generation" integer NOT NULL,
	"kind" varchar(16) NOT NULL,
	"selector_ciphertext" text,
	"selector_digest" varchar(64) NOT NULL,
	"selector_capture_revision" integer NOT NULL,
	"cursor_ciphertext" text,
	"cursor_digest" varchar(64),
	"capture_complete" boolean DEFAULT false NOT NULL,
	"enumeration_ref" uuid,
	"state" varchar(32) DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_id" uuid,
	"lease_expires_at" timestamp with time zone,
	"error_code" varchar(32),
	"request_ref" uuid,
	"evidence_ref" uuid,
	"proof_capture_revision" integer,
	"proof_inventory_revision" integer,
	"proof_boundary_ref" uuid,
	"proof_reader_ref" uuid,
	"proof_observed_at" timestamp with time zone,
	CONSTRAINT "account_erasure_work_outcome" CHECK ("account_erasure_work"."state" IN ('pending', 'retryable_failure', 'capability_unresolved', 'verified_erased', 'verified_no_applicable_data')),
	CONSTRAINT "account_erasure_work_kind" CHECK ("account_erasure_work"."kind" IN ('inventory', 'erase', 'recovery')),
	CONSTRAINT "account_erasure_terminal_proof" CHECK ("account_erasure_work"."state" NOT IN ('verified_erased', 'verified_no_applicable_data') OR ("account_erasure_work"."evidence_ref" IS NOT NULL AND "account_erasure_work"."proof_capture_revision" IS NOT NULL AND "account_erasure_work"."proof_inventory_revision" IS NOT NULL AND "account_erasure_work"."proof_boundary_ref" IS NOT NULL AND "account_erasure_work"."proof_reader_ref" IS NOT NULL AND "account_erasure_work"."proof_observed_at" IS NOT NULL AND "account_erasure_work"."enumeration_ref" IS NOT NULL)),
	CONSTRAINT "account_erasure_capture_version" CHECK ("account_erasure_work"."selector_capture_revision" > 0 AND "account_erasure_work"."generation" > 0 AND "account_erasure_work"."attempt_count" >= 0),
	CONSTRAINT "account_erasure_lease_pair" CHECK (("account_erasure_work"."lease_id" IS NULL) = ("account_erasure_work"."lease_expires_at" IS NULL)),
	CONSTRAINT "account_erasure_selector_size" CHECK ("account_erasure_work"."selector_ciphertext" IS NULL OR octet_length("account_erasure_work"."selector_ciphertext") <= 16384),
	CONSTRAINT "account_erasure_cursor_size" CHECK ("account_erasure_work"."cursor_ciphertext" IS NULL OR octet_length("account_erasure_work"."cursor_ciphertext") <= 16384),
	CONSTRAINT "account_erasure_cursor_pair" CHECK (("account_erasure_work"."cursor_ciphertext" IS NULL) = ("account_erasure_work"."cursor_digest" IS NULL)),
	CONSTRAINT "account_erasure_complete_enumeration" CHECK (NOT "account_erasure_work"."capture_complete" OR "account_erasure_work"."enumeration_ref" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "account_erasure_pages" ADD CONSTRAINT "account_erasure_pages_work_id_account_erasure_work_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."account_erasure_work"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_erasure_selector_dependencies" ADD CONSTRAINT "account_erasure_selector_dependencies_work_id_account_erasure_work_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."account_erasure_work"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_erasure_sinks" ADD CONSTRAINT "account_erasure_sinks_job_id_account_erasure_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."account_erasure_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_erasure_work" ADD CONSTRAINT "account_erasure_work_job_id_account_erasure_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."account_erasure_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_erasure_work" ADD CONSTRAINT "account_erasure_work_sink_fk" FOREIGN KEY ("job_id","sink_id") REFERENCES "public"."account_erasure_sinks"("job_id","sink_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_erasure_subject_generation" ON "account_erasure_jobs" USING btree ("subject_kind","subject_id","generation");--> statement-breakpoint
CREATE UNIQUE INDEX "account_erasure_decision" ON "account_erasure_jobs" USING btree ("decision_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "account_erasure_authority_sequence" ON "account_erasure_jobs" USING btree ("authority_id","decision_sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "account_erasure_page_identity" ON "account_erasure_pages" USING btree ("work_id","capture_revision","page_key");--> statement-breakpoint
CREATE UNIQUE INDEX "account_erasure_work_identity" ON "account_erasure_work" USING btree ("job_id","sink_id","item_key","generation");--> statement-breakpoint
CREATE INDEX "account_erasure_work_claim" ON "account_erasure_work" USING btree ("job_id","available_at","id");--> statement-breakpoint
CREATE INDEX "account_erasure_work_capture" ON "account_erasure_work" USING btree ("job_id","selector_capture_revision");