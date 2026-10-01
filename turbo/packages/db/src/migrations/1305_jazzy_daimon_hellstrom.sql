CREATE TABLE "agentphone_message_visibility" (
	"message_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "agentphone_message_visibility_message_id_org_id_user_id_pk" PRIMARY KEY("message_id","org_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "agentphone_messages" ADD COLUMN "group_id" varchar(255);--> statement-breakpoint
ALTER TABLE "agentphone_message_visibility" ADD CONSTRAINT "agentphone_message_visibility_message_id_agentphone_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."agentphone_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agentphone_message_visibility_member" ON "agentphone_message_visibility" USING btree ("org_id","user_id","message_id");--> statement-breakpoint
CREATE INDEX "idx_agentphone_messages_group_time" ON "agentphone_messages" USING btree ("agentphone_agent_id","group_id","received_at","created_at");