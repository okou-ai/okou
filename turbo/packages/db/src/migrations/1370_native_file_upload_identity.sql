CREATE TABLE "browser_user_action_file_uploads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"request_token_hash" text NOT NULL,
	"index" integer NOT NULL,
	"name" varchar(128) NOT NULL,
	"type" varchar(128) NOT NULL,
	"size" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"object_key" text NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "browser_user_action_file_uploads" ADD CONSTRAINT "browser_user_action_file_uploads_request_token_hash_browser_user_action_requests_request_token_hash_fk" FOREIGN KEY ("request_token_hash") REFERENCES "public"."browser_user_action_requests"("request_token_hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_browser_user_action_file_uploads_action" ON "browser_user_action_file_uploads" USING btree ("request_token_hash");--> statement-breakpoint
CREATE INDEX "idx_browser_user_action_file_uploads_expiry" ON "browser_user_action_file_uploads" USING btree ("expires_at");