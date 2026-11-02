-- One caller-owned statement, preserving the existing Agent serialization lock.
-- VOLATILE keeps each statement's fresh READ COMMITTED snapshot after a wait.
CREATE FUNCTION public.update_user_builtin_connectors(
  p_org_id text, p_user_id text, p_agent_id uuid, p_operation text,
  p_slugs bytea
) RETURNS TABLE (connector_slugs jsonb)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER PARALLEL UNSAFE
AS $user_builtin_connectors$
DECLARE
  encoded_slugs jsonb;
  desired_slugs text[];
BEGIN
  PERFORM a.id FROM public.agents AS a
    WHERE a.org_id = p_org_id AND a.id = p_agent_id
      AND (a.visibility = 'public' OR a.owner = p_user_id)
    LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  encoded_slugs := pg_catalog.convert_from(p_slugs, 'UTF8')::jsonb;
  IF p_operation = 'replace' THEN
    DELETE FROM public.user_connectors AS c
      WHERE c.org_id = p_org_id AND c.user_id = p_user_id
        AND c.agent_id = p_agent_id;
  END IF;

  IF pg_catalog.jsonb_array_length(encoded_slugs) > 0 THEN
    -- Decode the complete input before its write, at the original binding
    -- frontier: after replace's DELETE, before remove's DELETE or any INSERT.
    SELECT pg_catalog.array_agg(pg_catalog.convert_from(
      pg_catalog.decode(item.encoded, 'base64'), 'UTF8') ORDER BY item.ordinality)
      INTO desired_slugs
      FROM pg_catalog.jsonb_array_elements_text(encoded_slugs)
        WITH ORDINALITY AS item(encoded, ordinality);
    IF p_operation = 'remove' THEN
      DELETE FROM public.user_connectors AS c
        WHERE c.org_id = p_org_id AND c.user_id = p_user_id
          AND c.agent_id = p_agent_id
          AND c.connector_slug = ANY(desired_slugs);
    ELSE
      INSERT INTO public.user_connectors(org_id, user_id, agent_id, connector_slug)
        SELECT p_org_id, p_user_id, p_agent_id, slug
          FROM pg_catalog.unnest(desired_slugs) AS input(slug)
        ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  IF p_operation = 'replace' THEN
    -- The caller returns its original deduplicated request for replace.
    RETURN QUERY SELECT '[]'::jsonb;
  ELSE
    RETURN QUERY SELECT COALESCE(pg_catalog.jsonb_agg(c.connector_slug), '[]'::jsonb)
      FROM public.user_connectors AS c
      WHERE c.org_id = p_org_id AND c.user_id = p_user_id
        AND c.agent_id = p_agent_id;
  END IF;
END;
$user_builtin_connectors$;
