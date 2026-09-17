CREATE TABLE "pi_memory_stage1_days" (
	"user_id" text PRIMARY KEY NOT NULL,
	"day" date NOT NULL,
	"org_id" text NOT NULL,
	"trigger_thread_id" uuid NOT NULL,
	"requested_at" timestamp NOT NULL,
	"consumed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "pi_memory_stage1_selections" (
	"user_id" text NOT NULL,
	"slot" integer NOT NULL,
	"day" date NOT NULL,
	"org_id" text NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"memory_storage_id" uuid NOT NULL,
	"pi_session_id" varchar(255) NOT NULL,
	"source_run_id" uuid NOT NULL,
	"source_history_hash" varchar(64) NOT NULL,
	"source_completed_at" timestamp NOT NULL,
	"source_activity_at" timestamp NOT NULL,
	CONSTRAINT "pi_memory_stage1_selections_user_id_slot_pk" PRIMARY KEY("user_id","slot"),
	CONSTRAINT "pi_memory_stage1_selections_thread_unique" UNIQUE("user_id","chat_thread_id"),
	CONSTRAINT "pi_memory_stage1_selections_slot_check" CHECK ("pi_memory_stage1_selections"."slot" BETWEEN 1 AND 2)
);
--> statement-breakpoint
CREATE TABLE "pi_memory_stage1_watermarks" (
	"memory_storage_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"source_activity_at" timestamp NOT NULL,
	"source_history_hash" varchar(64) NOT NULL,
	CONSTRAINT "pi_memory_stage1_watermarks_memory_storage_id_chat_thread_id_pk" PRIMARY KEY("memory_storage_id","chat_thread_id")
);
--> statement-breakpoint
ALTER TABLE "pi_memory_stage1_selections" ADD CONSTRAINT "pi_memory_stage1_selections_user_id_pi_memory_stage1_days_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."pi_memory_stage1_days"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pi_memory_stage1_watermarks" ADD CONSTRAINT "pi_memory_stage1_watermarks_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pi_memory_stage1_watermarks" ADD CONSTRAINT "pi_memory_stage1_watermarks_storage_owner_fk" FOREIGN KEY ("memory_storage_id","org_id","user_id") REFERENCES "public"."storages"("id","org_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_pi_memory_stage1_days_pending" ON "pi_memory_stage1_days" USING btree ("day") WHERE "pi_memory_stage1_days"."consumed_at" IS NULL;