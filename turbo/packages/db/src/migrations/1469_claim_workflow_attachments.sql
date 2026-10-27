CREATE TABLE "claimed_workflow_attachments" (
	"run_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"object_key" text NOT NULL,
	CONSTRAINT "claimed_workflow_attachments_run_id_object_key_pk" PRIMARY KEY("run_id","object_key")
);
--> statement-breakpoint
ALTER TABLE "claimed_workflow_attachments" ADD CONSTRAINT "claimed_workflow_attachments_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "claimed_workflow_attachments_object_idx" ON "claimed_workflow_attachments" USING btree ("org_id","object_key");