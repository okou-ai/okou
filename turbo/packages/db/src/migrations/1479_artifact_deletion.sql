ALTER TABLE "artifacts" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "run_uploaded_files" ADD COLUMN "deleted_at" timestamp;