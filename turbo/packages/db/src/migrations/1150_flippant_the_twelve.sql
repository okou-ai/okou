CREATE TABLE "x_usage_billing_scopes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"activated_from_day" date,
	"closed_through_day" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "x_usage_observation_receipts" (
	"run_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"payload_digest" varchar(64) NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"utc_day" date NOT NULL,
	"net_quantity" bigint NOT NULL,
	CONSTRAINT "x_usage_observation_receipts_run_id_source_id_pk" PRIMARY KEY("run_id","source_id"),
	CONSTRAINT "x_usage_receipt_digest_check" CHECK ("x_usage_observation_receipts"."payload_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "x_usage_receipt_quantity_check" CHECK ("x_usage_observation_receipts"."net_quantity" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "x_usage_receipt_day_check" CHECK (isfinite("x_usage_observation_receipts"."observed_at") AND "x_usage_observation_receipts"."utc_day" = ("x_usage_observation_receipts"."observed_at" AT TIME ZONE 'UTC')::date)
);
--> statement-breakpoint
CREATE TABLE "x_usage_resource_claims" (
	"scope_id" uuid NOT NULL,
	"utc_day" date NOT NULL,
	"namespace" varchar(10) NOT NULL,
	"resource_id" varchar(32) NOT NULL,
	CONSTRAINT "x_usage_resource_claims_scope_id_utc_day_namespace_resource_id_pk" PRIMARY KEY("scope_id","utc_day","namespace","resource_id"),
	CONSTRAINT "x_usage_claim_day_check" CHECK (isfinite("x_usage_resource_claims"."utc_day")),
	CONSTRAINT "x_usage_claim_namespace_check" CHECK ("x_usage_resource_claims"."namespace" IN ('post', 'user')),
	CONSTRAINT "x_usage_claim_id_check" CHECK ("x_usage_resource_claims"."resource_id" ~ '^[0-9]{1,32}$')
);
--> statement-breakpoint
CREATE TABLE "x_usage_run_bindings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"configuration_revision" varchar(128) NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_x_usage_binding_run" UNIQUE("id","run_id"),
	CONSTRAINT "x_usage_binding_validity_check" CHECK ("x_usage_run_bindings"."valid_until" > "x_usage_run_bindings"."valid_from" AND isfinite("x_usage_run_bindings"."valid_from") AND isfinite("x_usage_run_bindings"."valid_until")),
	CONSTRAINT "x_usage_binding_revision_check" CHECK (length(btrim("x_usage_run_bindings"."configuration_revision")) > 0)
);
--> statement-breakpoint
ALTER TABLE "x_usage_observation_receipts" ADD CONSTRAINT "x_usage_receipt_binding_run_fk" FOREIGN KEY ("binding_id","run_id") REFERENCES "public"."x_usage_run_bindings"("id","run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "x_usage_resource_claims" ADD CONSTRAINT "x_usage_resource_claims_scope_id_x_usage_billing_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."x_usage_billing_scopes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "x_usage_run_bindings" ADD CONSTRAINT "x_usage_run_bindings_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "x_usage_run_bindings" ADD CONSTRAINT "x_usage_run_bindings_scope_id_x_usage_billing_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."x_usage_billing_scopes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_x_usage_receipt_binding" ON "x_usage_observation_receipts" USING btree ("binding_id");--> statement-breakpoint
CREATE INDEX "idx_x_usage_receipt_day" ON "x_usage_observation_receipts" USING btree ("utc_day");--> statement-breakpoint
CREATE INDEX "idx_x_usage_claim_day" ON "x_usage_resource_claims" USING btree ("utc_day");--> statement-breakpoint
CREATE INDEX "idx_x_usage_binding_run" ON "x_usage_run_bindings" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_x_usage_binding_org" ON "x_usage_run_bindings" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_x_usage_binding_user" ON "x_usage_run_bindings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_x_usage_binding_expiry" ON "x_usage_run_bindings" USING btree ("valid_until");