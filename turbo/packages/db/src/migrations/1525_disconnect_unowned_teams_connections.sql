-- Disconnect at most seven still-unowned legacy Teams accounts.
-- Reply routes cascade; conversation history and bot installations remain.
DO $$
DECLARE
  target_ids uuid[];
  disconnected_count integer;
  route_fk_count integer;
  unexpected_fk_count integer;
BEGIN
  SELECT count(*) FILTER (WHERE expected_route_fk),
    count(*) FILTER (WHERE NOT expected_route_fk)
  INTO route_fk_count, unexpected_fk_count
  FROM (
    SELECT conrelid = 'public.teams_chat_thread_routes'::regclass
      AND conname =
        'teams_chat_thread_routes_connection_id_teams_org_connections_id_fk'::name
      AND confdeltype = 'c'
      AND conkey = ARRAY[(
        SELECT attnum FROM pg_attribute
        WHERE attrelid = 'public.teams_chat_thread_routes'::regclass
          AND attname = 'connection_id' AND NOT attisdropped
      )]
      AND confkey = ARRAY[(
        SELECT attnum FROM pg_attribute
        WHERE attrelid = 'public.teams_org_connections'::regclass
          AND attname = 'id' AND NOT attisdropped
      )] AS expected_route_fk
    FROM pg_constraint
    WHERE contype = 'f'
      AND confrelid = 'public.teams_org_connections'::regclass
  ) AS incoming_references;
  IF route_fk_count <> 1 OR unexpected_fk_count <> 0 THEN
    RAISE EXCEPTION 'Unexpected Teams connection references; refusing disconnection';
  END IF;
  SELECT COALESCE(array_agg(candidate.id), ARRAY[]::uuid[])
  INTO target_ids
  FROM (
    SELECT id FROM teams_org_connections
    WHERE org_id IS NULL
    ORDER BY id
    LIMIT 8
  ) AS candidate;
  IF cardinality(target_ids) > 7 THEN
    RAISE EXCEPTION 'More than 7 unowned Teams connections; refusing disconnection';
  END IF;
  DELETE FROM teams_org_connections
  WHERE id = ANY(target_ids) AND org_id IS NULL;
  GET DIAGNOSTICS disconnected_count = ROW_COUNT;
  RAISE NOTICE 'Disconnected % unowned legacy Teams connections', disconnected_count;
END $$;
