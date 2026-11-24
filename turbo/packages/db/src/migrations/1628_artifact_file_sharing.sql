CREATE TABLE "artifact_file_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_id" uuid NOT NULL,
	"email" text NOT NULL,
	"user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_file_shares_file_email" UNIQUE("file_id","email")
);
--> statement-breakpoint
ALTER TABLE "artifact_file_shares" ADD CONSTRAINT "artifact_file_shares_file_id_run_uploaded_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."run_uploaded_files"("id") ON DELETE cascade ON UPDATE no action;