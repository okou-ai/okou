-- Temporary old-API bridge. Remove only in PR2 after the legacy entry point drains.
CREATE OR REPLACE FUNCTION "bridge_chat_event_sequence_allocation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  allocation_count bigint;
  allocated_seq bigint;
BEGIN
  allocation_count := NEW.last_chat_event_seq_id - OLD.last_chat_event_seq_id;
  IF allocation_count < 0 THEN
    RAISE EXCEPTION 'chat event allocation watermark cannot decrease' USING ERRCODE = '23514';
  END IF;
  IF allocation_count = 0 THEN
    RETURN NEW;
  END IF;
  INSERT INTO chat_event_sequences (chat_thread_id, last_seq_id)
  VALUES (NEW.id, OLD.last_chat_event_seq_id + allocation_count)
  ON CONFLICT (chat_thread_id) DO UPDATE
    SET last_seq_id = GREATEST(chat_event_sequences.last_seq_id, OLD.last_chat_event_seq_id) + allocation_count
  RETURNING last_seq_id INTO allocated_seq;
  NEW.last_chat_event_seq_id := allocated_seq;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "bridge_chat_event_sequence_allocation"
BEFORE UPDATE OF "last_chat_event_seq_id" ON "chat_threads"
FOR EACH ROW EXECUTE FUNCTION "bridge_chat_event_sequence_allocation"();
--> statement-breakpoint
INSERT INTO "chat_event_write_control" ("id") VALUES ('global') ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "preserve_chat_event_write_activation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.activated_at IS NOT NULL AND (TG_OP = 'DELETE' OR NEW.activated_at IS DISTINCT FROM OLD.activated_at) THEN
    RAISE EXCEPTION 'chat event split write activation is irreversible' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "preserve_chat_event_write_activation"
BEFORE UPDATE OR DELETE ON "chat_event_write_control"
FOR EACH ROW EXECUTE FUNCTION "preserve_chat_event_write_activation"();
