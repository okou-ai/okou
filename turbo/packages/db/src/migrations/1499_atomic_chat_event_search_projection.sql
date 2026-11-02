-- okou:non-transactional
CREATE OR REPLACE FUNCTION public.publish_chat_event_search_projection(
  p_messages jsonb,
  p_revoked_event_ids uuid[],
  p_watermark_thread_id uuid,
  p_watermark_seq_id bigint
) RETURNS TABLE(indexed_events integer, deleted_docs integer)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
PARALLEL UNSAFE
AS $function$
DECLARE
  v_indexed_events integer := 0;
  v_deleted_docs integer := 0;
BEGIN
  IF jsonb_array_length(p_messages) > 0 THEN
    INSERT INTO public.chat_event_search_messages (
      chat_thread_id, seq_id, run_id, user_id, org_id, agent_id,
      role, created_at, text, text_bigram
    )
    SELECT message.chat_thread_id, message.seq_id, message.run_id,
      message.user_id, message.org_id, message.agent_id, message.role,
      message.created_at, message.text, message.text_bigram
    FROM jsonb_to_recordset(p_messages) AS message(
      chat_thread_id uuid, seq_id bigint, run_id uuid, user_id text,
      org_id text, agent_id uuid, role text,
      created_at timestamp without time zone, text text, text_bigram text
    )
    ON CONFLICT (chat_thread_id, seq_id) DO NOTHING;
    GET DIAGNOSTICS v_indexed_events = ROW_COUNT;
  END IF;

  -- Keep INSERT arbitration before a fresh Read Committed DELETE snapshot.
  -- A single data-modifying CTE can miss a revoked row committed by a waiter.
  IF cardinality(p_revoked_event_ids) > 0 THEN
    DELETE FROM public.chat_event_search_messages AS message
    WHERE EXISTS (
      SELECT 1 FROM public.chat_events AS event
      WHERE event.id = ANY(p_revoked_event_ids)
        AND event.chat_thread_id = message.chat_thread_id
        AND event.seq_id = message.seq_id
    );
    GET DIAGNOSTICS v_deleted_docs = ROW_COUNT;
  END IF;

  IF p_watermark_thread_id IS NOT NULL THEN
    INSERT INTO public.chat_event_search_message_watermarks AS watermark (
      chat_thread_id, indexed_seq_id
    ) VALUES (p_watermark_thread_id, p_watermark_seq_id)
    ON CONFLICT (chat_thread_id) DO UPDATE
    SET indexed_seq_id = GREATEST(watermark.indexed_seq_id, EXCLUDED.indexed_seq_id);
  END IF;

  RETURN QUERY SELECT v_indexed_events, v_deleted_docs;
END;
$function$;
