CREATE TABLE "chat_thread_folder_memberships" (
	"chat_thread_id" uuid PRIMARY KEY NOT NULL,
	"folder_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_thread_folders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"sort_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chat_thread_folders_name_check" CHECK (char_length(btrim("chat_thread_folders"."name")) BETWEEN 1 AND 100 AND "chat_thread_folders"."name" = btrim("chat_thread_folders"."name"))
);
--> statement-breakpoint
ALTER TABLE "chat_thread_folder_memberships" ADD CONSTRAINT "chat_thread_folder_memberships_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_thread_folder_memberships" ADD CONSTRAINT "chat_thread_folder_memberships_folder_id_chat_thread_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."chat_thread_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_thread_folders" ADD CONSTRAINT "chat_thread_folders_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_chat_thread_folder_memberships_folder" ON "chat_thread_folder_memberships" USING btree ("folder_id","chat_thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_chat_thread_folders_scope_name" ON "chat_thread_folders" USING btree ("user_id","org_id","agent_id",lower("name"));--> statement-breakpoint
CREATE INDEX "idx_chat_thread_folders_scope_order" ON "chat_thread_folders" USING btree ("user_id","org_id","agent_id","sort_key","id");