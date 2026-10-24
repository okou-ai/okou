CREATE TABLE "data_router_requests" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "data_router_requests" ADD CONSTRAINT "data_router_requests_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_data_router_requests_run" ON "data_router_requests" USING btree ("run_id");