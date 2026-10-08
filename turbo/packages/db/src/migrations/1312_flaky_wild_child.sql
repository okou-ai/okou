CREATE TABLE "agentphone_group_message_receipts" (
	"agentphone_message_id" varchar(255) PRIMARY KEY NOT NULL,
	"webhook_id" varchar(255)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agentphone_group_message_receipts_webhook_id" ON "agentphone_group_message_receipts" USING btree ("webhook_id");