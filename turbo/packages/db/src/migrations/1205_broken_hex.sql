CREATE TABLE "chat_thread_ssh_access_overrides" (
	"chat_thread_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"enabled" boolean NOT NULL,
	CONSTRAINT "chat_thread_ssh_access_overrides_pk" PRIMARY KEY("chat_thread_id","connection_id")
);
--> statement-breakpoint
CREATE TABLE "chat_thread_vnc_access_overrides" (
	"chat_thread_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"enabled" boolean NOT NULL,
	CONSTRAINT "chat_thread_vnc_access_overrides_pk" PRIMARY KEY("chat_thread_id","connection_id")
);
--> statement-breakpoint
ALTER TABLE "ssh_connections" ADD COLUMN "default_enabled_for_chats" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "vnc_connections" ADD COLUMN "default_enabled_for_chats" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_thread_ssh_access_overrides" ADD CONSTRAINT "chat_thread_ssh_access_overrides_thread_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_thread_ssh_access_overrides" ADD CONSTRAINT "chat_thread_ssh_access_overrides_connection_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."ssh_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_thread_vnc_access_overrides" ADD CONSTRAINT "chat_thread_vnc_access_overrides_thread_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_thread_vnc_access_overrides" ADD CONSTRAINT "chat_thread_vnc_access_overrides_connection_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."vnc_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_chat_thread_ssh_access_overrides_connection" ON "chat_thread_ssh_access_overrides" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "idx_chat_thread_vnc_access_overrides_connection" ON "chat_thread_vnc_access_overrides" USING btree ("connection_id");