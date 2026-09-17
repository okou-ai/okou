CREATE TABLE "account_erasure_ingress" (
	"confirmation_ref" uuid PRIMARY KEY NOT NULL,
	"audience" varchar(192) NOT NULL,
	"event_id" varchar(192) NOT NULL,
	"authority_id" uuid NOT NULL,
	"subject_kind" varchar(16) NOT NULL,
	"subject_id" varchar(192) NOT NULL,
	"generation" integer NOT NULL,
	"decision_ref" uuid NOT NULL,
	"previous_decision_ref" uuid,
	"disposition_version" integer NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"decision_sequence" bigint,
	"state" varchar(32) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_id" uuid,
	CONSTRAINT "account_erasure_ingress_shape" CHECK ("account_erasure_ingress"."subject_kind" IN ('user', 'organization') AND octet_length("account_erasure_ingress"."subject_id") BETWEEN 1 AND 192 AND octet_length("account_erasure_ingress"."audience") BETWEEN 1 AND 192 AND octet_length("account_erasure_ingress"."event_id") BETWEEN 1 AND 192 AND "account_erasure_ingress"."generation" > 0 AND "account_erasure_ingress"."disposition_version" > 0 AND "account_erasure_ingress"."deadline_at" > "account_erasure_ingress"."requested_at" AND "account_erasure_ingress"."attempts" BETWEEN 0 AND 5 AND ("account_erasure_ingress"."decision_sequence" IS NULL OR "account_erasure_ingress"."decision_sequence" > 0)),
	CONSTRAINT "account_erasure_ingress_state" CHECK ("account_erasure_ingress"."state" IN ('pending', 'external_committed', 'projection_committed', 'unresolved') AND ("account_erasure_ingress"."state" NOT IN ('external_committed', 'projection_committed') OR "account_erasure_ingress"."decision_sequence" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "account_erasure_replay" (
	"authority_id" uuid NOT NULL,
	"audience" varchar(192) NOT NULL,
	"target_id" uuid NOT NULL,
	"replay_generation" uuid NOT NULL,
	"watermark" bigint NOT NULL,
	"cursor" bigint DEFAULT 0 NOT NULL,
	"state" varchar(16) DEFAULT 'pending' NOT NULL,
	"lease_id" uuid,
	"lease_expires_at" timestamp with time zone,
	CONSTRAINT "account_erasure_replay_authority_id_target_id_replay_generation_pk" PRIMARY KEY("authority_id","target_id","replay_generation"),
	CONSTRAINT "account_erasure_replay_shape" CHECK ("account_erasure_replay"."watermark" >= 0 AND "account_erasure_replay"."cursor" >= 0 AND "account_erasure_replay"."cursor" <= "account_erasure_replay"."watermark" AND octet_length("account_erasure_replay"."audience") BETWEEN 1 AND 192 AND "account_erasure_replay"."state" IN ('pending', 'complete', 'unresolved') AND ("account_erasure_replay"."state" <> 'complete' OR "account_erasure_replay"."cursor" = "account_erasure_replay"."watermark") AND (("account_erasure_replay"."lease_id" IS NULL) = ("account_erasure_replay"."lease_expires_at" IS NULL)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "account_erasure_ingress_event" ON "account_erasure_ingress" USING btree ("audience","event_id");--> statement-breakpoint
CREATE INDEX "account_erasure_ingress_retry" ON "account_erasure_ingress" USING btree ("authority_id","audience","available_at","confirmation_ref") WHERE "account_erasure_ingress"."state" IN ('pending', 'external_committed') AND "account_erasure_ingress"."attempts" < 5;