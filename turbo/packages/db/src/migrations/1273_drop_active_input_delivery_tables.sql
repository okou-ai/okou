-- Release 4 of the unified chat queue. Release 3 (#37082) removed every read
-- and write of active_input_deliveries and active_input_delivery_items: steering
-- uses the source chat_events ID and consumes it with a replacement event. No
-- table references either one; drop the items first, since they reference the
-- deliveries, then the deliveries. Each drop only removes the table's own
-- foreign keys (to chat_events, agent_runs and chat_threads).
DROP TABLE "active_input_delivery_items";--> statement-breakpoint
DROP TABLE "active_input_deliveries";
