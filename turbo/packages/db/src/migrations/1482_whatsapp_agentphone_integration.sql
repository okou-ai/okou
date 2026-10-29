CREATE TABLE "whatsapp_connection_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	"consumed_phone_handle" varchar(254),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_user_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone_handle" varchar(254) NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agentphone_chat_thread_routes" ALTER COLUMN "agentphone_user_link_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agentphone_chat_thread_routes" ADD COLUMN "whatsapp_user_link_id" uuid;--> statement-breakpoint
ALTER TABLE "agentphone_messages" ADD COLUMN "whatsapp_user_link_id" uuid;--> statement-breakpoint
CREATE INDEX "idx_whatsapp_connection_codes_hash_expires" ON "whatsapp_connection_codes" USING btree ("code_hash","expires_at");--> statement-breakpoint
CREATE INDEX "idx_whatsapp_connection_codes_expires" ON "whatsapp_connection_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_whatsapp_connection_codes_user_org" ON "whatsapp_connection_codes" USING btree ("user_id","org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_whatsapp_user_links_phone_handle" ON "whatsapp_user_links" USING btree ("phone_handle");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_whatsapp_user_links_user_org" ON "whatsapp_user_links" USING btree ("user_id","org_id");--> statement-breakpoint
CREATE INDEX "idx_whatsapp_user_links_org" ON "whatsapp_user_links" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "agentphone_chat_thread_routes" ADD CONSTRAINT "agentphone_chat_thread_routes_whatsapp_user_link_id_whatsapp_user_links_id_fk" FOREIGN KEY ("whatsapp_user_link_id") REFERENCES "public"."whatsapp_user_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agentphone_messages" ADD CONSTRAINT "agentphone_messages_whatsapp_user_link_id_whatsapp_user_links_id_fk" FOREIGN KEY ("whatsapp_user_link_id") REFERENCES "public"."whatsapp_user_links"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agentphone_chat_routes_whatsapp_root" ON "agentphone_chat_thread_routes" USING btree ("whatsapp_user_link_id","root_message_id");--> statement-breakpoint
CREATE INDEX "idx_agentphone_messages_whatsapp_link" ON "agentphone_messages" USING btree ("whatsapp_user_link_id");--> statement-breakpoint
ALTER TABLE "agentphone_chat_thread_routes" ADD CONSTRAINT "chk_agentphone_chat_route_one_link" CHECK (num_nonnulls("agentphone_chat_thread_routes"."agentphone_user_link_id", "agentphone_chat_thread_routes"."whatsapp_user_link_id") = 1);