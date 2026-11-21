ALTER TABLE "workflows" DROP CONSTRAINT "workflows_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
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
