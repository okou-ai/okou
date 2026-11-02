CREATE TABLE "marketing_content_grants" (
	"resource_type" text NOT NULL,
	"resource_hash" text NOT NULL,
	"subject" text NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "marketing_content_grants_resource_type_resource_hash_subject_pk" PRIMARY KEY("resource_type","resource_hash","subject"),
	CONSTRAINT "marketing_content_grant_type" CHECK ("marketing_content_grants"."resource_type" IN ('manifest', 'file')),
	CONSTRAINT "marketing_content_grant_hash" CHECK ("marketing_content_grants"."resource_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "marketing_content_grant_subject" CHECK ("marketing_content_grants"."subject" = 'public' OR "marketing_content_grants"."subject" LIKE 'user:%' OR "marketing_content_grants"."subject" LIKE 'session:%')
);
--> statement-breakpoint
CREATE TABLE "marketing_handoff_limits" (
	"subject" text PRIMARY KEY NOT NULL,
	"window_start" timestamp NOT NULL,
	"requests" integer NOT NULL,
	"bytes" bigint NOT NULL
);
