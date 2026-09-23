ALTER TABLE "email_outbox" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "feishu_chat_ingress" ADD COLUMN "sender_open_id" varchar(255);--> statement-breakpoint
ALTER TABLE "feishu_chat_ingress" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
CREATE INDEX "email_outbox_owner_user_id_idx" ON "email_outbox" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "feishu_chat_ingress_unattributed_idx" ON "feishu_chat_ingress" USING btree ("id") WHERE "feishu_chat_ingress"."sender_open_id" IS NULL;--> statement-breakpoint
CREATE INDEX "feishu_chat_ingress_owner_user_id_idx" ON "feishu_chat_ingress" USING btree ("owner_user_id");