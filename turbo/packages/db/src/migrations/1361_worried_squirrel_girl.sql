CREATE TABLE "chat_event_snapshot_gc_state" (
	"bucket" text PRIMARY KEY NOT NULL,
	"cursor_object_key" text,
	"cycle_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	CONSTRAINT "chat_event_snapshot_gc_cursor_check" CHECK ("chat_event_snapshot_gc_state"."cursor_object_key" IS NULL OR starts_with("chat_event_snapshot_gc_state"."cursor_object_key", 'chat-events/'))
);
