-- One caller-owned statement; no explicit transaction, trigger or new lock.
-- VOLATILE is required: internal statements take fresh READ COMMITTED snapshots.
CREATE FUNCTION public.update_agent_metadata(
  p_org_id text, p_agent_id uuid, p_member_id text, p_is_admin boolean,
  p_identity_changes boolean, p_visibility text, p_public_limit integer,
  p_body bytea, p_now timestamp without time zone
) RETURNS TABLE (existing jsonb, agent jsonb)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER PARALLEL UNSAFE
AS $agent_metadata$
DECLARE
  current_agent record;
  public_count bigint := 0;
  patch jsonb;
BEGIN
  -- Preserve the original lock statement, then take a fresh READ COMMITTED
  -- snapshot. In particular, an outgoing bootstrap may publish a default
  -- pointer while this statement is waiting for its existing Agent row lock.
  PERFORM a.id FROM public.agents AS a
    WHERE a.org_id = p_org_id AND a.id = p_agent_id FOR UPDATE;

  SELECT a.id, a.owner, a.visibility, m.default_agent_id
    INTO current_agent
    FROM public.agents AS a
    LEFT JOIN public.org_metadata AS m ON m.org_id = a.org_id
    WHERE a.org_id = p_org_id AND a.id = p_agent_id LIMIT 1;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  existing := pg_catalog.jsonb_build_object(
    'id', current_agent.id, 'owner', current_agent.owner,
    'visibility', current_agent.visibility,
    'defaultAgentId', current_agent.default_agent_id, 'publicAgentCount', 0);
  agent := NULL;

  -- Return locked facts for the existing HTTP error classifiers. No body text
  -- is admitted and no Agent write occurs for any rejected operation.
  IF NOT (current_agent.owner = p_member_id OR
      (p_is_admin AND current_agent.visibility = 'public')) OR
    (p_identity_changes AND current_agent.id = current_agent.default_agent_id) OR
    (p_visibility IS NOT NULL AND current_agent.owner <> p_member_id) THEN
    RETURN NEXT;
    RETURN;
  END IF;

  IF p_visibility = 'public' AND current_agent.visibility <> 'public' THEN
    SELECT pg_catalog.count(*) INTO public_count FROM public.agents AS a
      WHERE a.org_id = p_org_id AND a.visibility = 'public';
    existing := existing || pg_catalog.jsonb_build_object('publicAgentCount', public_count);
    IF public_count >= p_public_limit THEN
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  -- The bound JSON carries base64-encoded UTF8 fields. Decode text only after
  -- every rejection gate, preserving driver UTF8 conversion and NUL errors.
  patch := pg_catalog.convert_from(p_body, 'UTF8')::jsonb;
  UPDATE public.agents AS a SET
    display_name = CASE WHEN patch ? 'displayName' THEN pg_catalog.convert_from(pg_catalog.decode(patch ->> 'displayName', 'base64'), 'UTF8') ELSE a.display_name END,
    description = CASE WHEN patch ? 'description' THEN pg_catalog.convert_from(pg_catalog.decode(patch ->> 'description', 'base64'), 'UTF8') ELSE a.description END,
    sound = CASE WHEN patch ? 'sound' THEN pg_catalog.convert_from(pg_catalog.decode(patch ->> 'sound', 'base64'), 'UTF8') ELSE a.sound END,
    avatar_url = CASE WHEN patch ? 'avatarUrl' THEN pg_catalog.convert_from(pg_catalog.decode(patch ->> 'avatarUrl', 'base64'), 'UTF8') ELSE a.avatar_url END,
    visibility = CASE WHEN p_visibility IS NOT NULL THEN p_visibility ELSE a.visibility END,
    updated_at = COALESCE(p_now, pg_catalog.date_trunc('milliseconds',
      pg_catalog.timezone('UTC', pg_catalog.clock_timestamp())))
    WHERE a.org_id = p_org_id AND a.id = p_agent_id;

  SELECT pg_catalog.jsonb_build_object(
    'agentId', a.id, 'defaultAgentId', m.default_agent_id, 'owner', a.owner,
    'displayName', a.display_name, 'description', a.description,
    'sound', a.sound, 'avatarUrl', a.avatar_url, 'visibility', a.visibility)
    INTO agent FROM public.agents AS a
    LEFT JOIN public.org_metadata AS m ON m.org_id = a.org_id
    WHERE a.org_id = p_org_id AND a.id = p_agent_id LIMIT 1;
  IF agent IS NULL THEN
    RAISE EXCEPTION 'Canonical Agent missing after update: %', p_agent_id;
  END IF;
  RETURN NEXT;
END;
$agent_metadata$;
