-- Retire the Ultrafast service tier: clear mutable selections and catalog
-- offers so threads and member defaults fall back to the Standard tier.
-- Historical runs, chat events, thread metadata events, and usage records stay
-- immutable; their readers treat a stored Ultrafast tier as Standard.
DO $$
DECLARE
  thread_count bigint;
  member_count bigint;
  route_count bigint;
BEGIN
  UPDATE chat_threads
  SET codex_service_tier = NULL
  WHERE codex_service_tier = 'ultrafast';
  GET DIAGNOSTICS thread_count = ROW_COUNT;

  UPDATE org_members_metadata
  SET service_tier = NULL
  WHERE service_tier = 'ultrafast';
  GET DIAGNOSTICS member_count = ROW_COUNT;

  UPDATE model_routes
  SET service_tiers = array_remove(service_tiers, 'ultrafast'),
      default_service_tier = NULLIF(default_service_tier, 'ultrafast')
  WHERE 'ultrafast' = ANY(service_tiers)
    OR default_service_tier = 'ultrafast';
  GET DIAGNOSTICS route_count = ROW_COUNT;

  RAISE NOTICE 'Ultrafast retirement: threads=%, members=%, routes=%',
    thread_count, member_count, route_count;
END $$;
