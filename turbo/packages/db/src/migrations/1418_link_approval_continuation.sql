ALTER TABLE "link_wallet_spends" ADD COLUMN "approval_thread_id" uuid;--> statement-breakpoint
ALTER TABLE "link_wallet_spends" ADD COLUMN "approval_run_id" uuid;--> statement-breakpoint
ALTER TABLE "link_wallet_spends" ADD COLUMN "action_resolution" varchar(64);--> statement-breakpoint
ALTER TABLE "link_wallet_spends" ADD CONSTRAINT "link_wallet_spends_approval_thread_id_chat_threads_id_fk" FOREIGN KEY ("approval_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_link_wallet_spends_approval_deadline" ON "link_wallet_spends" USING btree ("expires_at","id") WHERE "link_wallet_spends"."approval_thread_id" IS NOT NULL;