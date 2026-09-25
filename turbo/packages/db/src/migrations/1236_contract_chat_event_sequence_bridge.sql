-- Release 2 of the chat event split-write rollout. Release only after Release 1
-- is serving in its activated mode and every legacy-mode operation has drained;
-- see docs/chat-event-split-write-rollout.md. The runtime writes only
-- chat_event_sequences, so an inactive database must fail before contraction.
-- A database without chat threads has no legacy allocations or operations and
-- is activated here, so fresh development and CI databases need no manual step.
LOCK TABLE chat_threads, chat_event_write_control IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM chat_threads) THEN
    UPDATE chat_event_write_control
    SET activated_at = COALESCE(activated_at, timezone('UTC', now()))
    WHERE id = 'global';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM chat_event_write_control
    WHERE id = 'global' AND activated_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Chat event sequence contraction requires activated split writes'
      USING ERRCODE = '55000';
  END IF;
END;
$$;
--> statement-breakpoint
DROP TRIGGER bridge_chat_event_sequence_allocation ON chat_threads;
--> statement-breakpoint
DROP FUNCTION bridge_chat_event_sequence_allocation();
--> statement-breakpoint
ALTER TABLE chat_threads DROP COLUMN last_chat_event_seq_id;
