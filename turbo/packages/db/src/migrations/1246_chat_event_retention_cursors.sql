CREATE TABLE "chat_event_retention_cursors" (
	"scope_key" text PRIMARY KEY NOT NULL,
	"last_created_at" timestamp NOT NULL,
	"last_event_id" uuid NOT NULL,
	"sweep_started_at" timestamp NOT NULL
);
