CREATE TABLE "ssh_save_attempts" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"attempt_id" uuid NOT NULL,
	"saved" boolean NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ssh_save_attempts_org_id_user_id_attempt_id_pk" PRIMARY KEY("org_id","user_id","attempt_id")
);
--> statement-breakpoint
CREATE INDEX "idx_ssh_save_attempts_user" ON "ssh_save_attempts" USING btree ("user_id");