CREATE TABLE "chat_thread_snapshot_gc_state" (
	"bucket" text NOT NULL,
	"prefix" text NOT NULL,
	"cursor_object_key" text,
	"cycle_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	CONSTRAINT "chat_thread_snapshot_gc_state_bucket_prefix_pk" PRIMARY KEY("bucket","prefix"),
	CONSTRAINT "chat_thread_snapshot_gc_prefix_check" CHECK ("chat_thread_snapshot_gc_state"."prefix" ~ '^chat-thread-snapshots/v1/[0-9a-f]{2}$'),
	CONSTRAINT "chat_thread_snapshot_gc_cursor_check" CHECK ("chat_thread_snapshot_gc_state"."cursor_object_key" IS NULL OR starts_with("chat_thread_snapshot_gc_state"."cursor_object_key", "chat_thread_snapshot_gc_state"."prefix"))
);
