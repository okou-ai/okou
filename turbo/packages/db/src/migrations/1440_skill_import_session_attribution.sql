ALTER TABLE "workflows" ADD COLUMN "import_session_id" uuid;--> statement-breakpoint
CREATE INDEX "idx_workflows_import_session" ON "workflows" USING btree ("import_session_id");