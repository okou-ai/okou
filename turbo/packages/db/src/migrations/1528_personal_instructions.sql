CREATE TABLE "instructions" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"content" text NOT NULL,
	"bundle" jsonb NOT NULL,
	"version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "instructions_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
CREATE INDEX "idx_instructions_user" ON "instructions" USING btree ("user_id");