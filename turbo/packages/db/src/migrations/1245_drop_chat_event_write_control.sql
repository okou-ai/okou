-- The last reader of the activation marker left in #36703 (API 1.676.0); the
-- production rollback resolver refuses older API targets. Dropping the table
-- also drops its preserve_chat_event_write_activation trigger.
DROP TABLE "chat_event_write_control" CASCADE;--> statement-breakpoint
DROP FUNCTION "preserve_chat_event_write_activation"();
