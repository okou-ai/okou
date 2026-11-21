-- okou:non-transactional
-- Outgoing API binaries map this result to 404. Retain the signature until
-- those binaries have drained and can no longer be selected for rollback.
CREATE OR REPLACE FUNCTION public.delete_agent_rows(
  p_agent_id uuid,
  p_org_id text,
  p_member_user_id text,
  p_is_org_admin boolean
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
PARALLEL SAFE
AS $function$
  SELECT jsonb_build_object('kind', 'missing');
$function$;
