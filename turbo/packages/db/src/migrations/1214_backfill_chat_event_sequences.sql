-- vm0:non-transactional
-- Bounded, restartable watermark backfill after the bridge is installed.
SET lock_timeout = '1s';
--> statement-breakpoint
-- The procedure commits each 1000-row batch; the CALL covers the entire scan.
SET statement_timeout = '10min';
--> statement-breakpoint
CREATE OR REPLACE PROCEDURE "backfill_chat_event_sequences"()
LANGUAGE plpgsql
AS $$
DECLARE
  last_thread uuid := '00000000-0000-0000-0000-000000000000';
  next_thread uuid;
BEGIN
  LOOP
    WITH batch AS MATERIALIZED (
      SELECT id, last_chat_event_seq_id
      FROM chat_threads
      WHERE id > last_thread AND last_chat_event_seq_id > 0
      ORDER BY id LIMIT 1000
      -- Draining Web sends lock the thread before their bridge allocation.
      -- Acquire its FK-compatible lock before creating/locking a sequence row.
      FOR KEY SHARE
    ), copied AS (
      INSERT INTO chat_event_sequences (chat_thread_id, last_seq_id)
      SELECT id, last_chat_event_seq_id FROM batch ORDER BY id
      ON CONFLICT (chat_thread_id) DO UPDATE
        SET last_seq_id = GREATEST(chat_event_sequences.last_seq_id, EXCLUDED.last_seq_id)
      RETURNING chat_thread_id
    )
    SELECT id INTO next_thread FROM batch ORDER BY id DESC LIMIT 1;
    COMMIT;
    EXIT WHEN next_thread IS NULL;
    last_thread := next_thread;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM chat_threads AS thread
    LEFT JOIN chat_event_sequences AS sequence ON sequence.chat_thread_id = thread.id
    WHERE thread.last_chat_event_seq_id > 0
      AND COALESCE(sequence.last_seq_id, 0) < thread.last_chat_event_seq_id
  ) THEN
    RAISE EXCEPTION 'chat event sequence backfill is incomplete';
  END IF;
END;
$$;
--> statement-breakpoint
CALL "backfill_chat_event_sequences"();
--> statement-breakpoint
DROP PROCEDURE "backfill_chat_event_sequences"();
--> statement-breakpoint
RESET lock_timeout;
--> statement-breakpoint
RESET statement_timeout;
