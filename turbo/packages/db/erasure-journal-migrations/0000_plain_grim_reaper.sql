CREATE TABLE "erasure_journal_decisions" (
	"decision_sequence" bigint PRIMARY KEY NOT NULL,
	"authority_id" uuid NOT NULL,
	"decision_ref" uuid NOT NULL,
	"confirmation_ref" uuid NOT NULL,
	"subject_kind" varchar(16) NOT NULL,
	"subject_id" varchar(192) NOT NULL,
	"generation" integer NOT NULL,
	"previous_decision_ref" uuid,
	"disposition_version" integer NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	CONSTRAINT "erasure_journal_positive_versions" CHECK ("erasure_journal_decisions"."decision_sequence" > 0 AND "erasure_journal_decisions"."generation" > 0 AND "erasure_journal_decisions"."disposition_version" > 0),
	CONSTRAINT "erasure_journal_subject" CHECK ("erasure_journal_decisions"."subject_kind" IN ('user', 'organization') AND octet_length("erasure_journal_decisions"."subject_id") BETWEEN 1 AND 192),
	CONSTRAINT "erasure_journal_deadline" CHECK (isfinite("erasure_journal_decisions"."requested_at") AND isfinite("erasure_journal_decisions"."deadline_at") AND "erasure_journal_decisions"."deadline_at" > "erasure_journal_decisions"."requested_at")
);
--> statement-breakpoint
CREATE TABLE "erasure_journal_head" (
	"slot" integer PRIMARY KEY NOT NULL,
	"authority_id" uuid NOT NULL,
	"committed_sequence" bigint NOT NULL,
	CONSTRAINT "erasure_journal_single_head" CHECK ("erasure_journal_head"."slot" = 1),
	CONSTRAINT "erasure_journal_watermark" CHECK ("erasure_journal_head"."committed_sequence" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "erasure_journal_decision_ref" ON "erasure_journal_decisions" USING btree ("decision_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "erasure_journal_confirmation_ref" ON "erasure_journal_decisions" USING btree ("confirmation_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "erasure_journal_subject_generation" ON "erasure_journal_decisions" USING btree ("subject_kind","subject_id","generation");