CREATE TABLE "chat_event_snapshot_gc_state" (
	"bucket" text NOT NULL,
	"prefix" text NOT NULL,
	"cursor_object_key" text,
	"cycle_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	CONSTRAINT "chat_event_snapshot_gc_state_bucket_prefix_pk" PRIMARY KEY("bucket","prefix"),
	CONSTRAINT "chat_event_snapshot_gc_prefix_check" CHECK ("chat_event_snapshot_gc_state"."prefix" ~ '^chat-events/[0-9a-f]{3}$'),
	CONSTRAINT "chat_event_snapshot_gc_cursor_check" CHECK ("chat_event_snapshot_gc_state"."cursor_object_key" IS NULL OR starts_with("chat_event_snapshot_gc_state"."cursor_object_key", "chat_event_snapshot_gc_state"."prefix"))
);
