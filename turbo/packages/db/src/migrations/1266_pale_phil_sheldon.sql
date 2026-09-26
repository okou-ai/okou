CREATE TABLE "runner_wss_endpoints" (
	"runner_id" uuid PRIMARY KEY NOT NULL,
	"host_id" uuid NOT NULL,
	"last_probed_at" timestamp NOT NULL,
	"lease_expires_at" timestamp NOT NULL,
	"withdrawn_at" timestamp,
	"quarantined_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "runner_wss_endpoints_host_idx" ON "runner_wss_endpoints" USING btree ("host_id");--> statement-breakpoint
CREATE INDEX "runner_wss_endpoints_lease_idx" ON "runner_wss_endpoints" USING btree ("lease_expires_at");