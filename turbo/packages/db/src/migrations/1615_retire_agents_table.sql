CREATE TABLE "legacy_agent_api_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"owner" text NOT NULL,
	"name" varchar(64) NOT NULL,
	"visibility" varchar(16) DEFAULT 'public' NOT NULL,
	"display_name" varchar(256),
	"description" text,
	"instructions" text DEFAULT '' NOT NULL,
	"instructions_bundle" jsonb,
	"sound" varchar(64),
	"avatar_url" varchar(1024),
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Freeze legacy writes until their copy and the drop commit together.
LOCK TABLE public.agents IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
INSERT INTO public.legacy_agent_api_profiles
  (id, org_id, owner, name, visibility, display_name, description, instructions,
   instructions_bundle, sound, avatar_url, updated_at)
SELECT id, org_id, owner, name, visibility, display_name, description, instructions,
       instructions_bundle, sound, avatar_url, updated_at
FROM public.agents;
--> statement-breakpoint
DROP FUNCTION public.update_agent_metadata(text, uuid, text, boolean, boolean, text, integer, bytea, timestamp without time zone);
--> statement-breakpoint
DROP TABLE public.agents RESTRICT;--> statement-breakpoint
CREATE INDEX "idx_legacy_agent_api_workspace" ON "legacy_agent_api_profiles" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_legacy_agent_api_workspace_name" ON "legacy_agent_api_profiles" USING btree ("org_id","name");
--> statement-breakpoint
-- One caller-owned statement; no explicit transaction, trigger or new lock.
-- VOLATILE is required: internal statements take fresh READ COMMITTED snapshots.
CREATE OR REPLACE FUNCTION public.update_legacy_agent_api_metadata(
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
  PERFORM a.id FROM public.legacy_agent_api_profiles AS a
    WHERE a.org_id = p_org_id AND a.id = p_agent_id FOR UPDATE;

  SELECT a.id, a.owner, a.visibility, CASE WHEN a.name = 'default-agent' AND a.visibility = 'public' THEN a.id END AS default_executor_id
    INTO current_agent
    FROM public.legacy_agent_api_profiles AS a
    WHERE a.org_id = p_org_id AND a.id = p_agent_id LIMIT 1;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  existing := pg_catalog.jsonb_build_object(
    'id', current_agent.id, 'owner', current_agent.owner,
    'visibility', current_agent.visibility,
    'defaultAgentId', current_agent.default_executor_id, 'publicAgentCount', 0);
  agent := NULL;

  -- Return locked facts for the existing HTTP error classifiers. No body text
  -- is admitted and no Agent write occurs for any rejected operation.
  IF NOT (current_agent.owner = p_member_id OR
      (p_is_admin AND current_agent.visibility = 'public')) OR
    (p_identity_changes AND current_agent.id = current_agent.default_executor_id) OR
    (p_visibility IS NOT NULL AND current_agent.owner <> p_member_id) THEN
    RETURN NEXT;
    RETURN;
  END IF;

  IF p_visibility = 'public' AND current_agent.visibility <> 'public' THEN
    SELECT pg_catalog.count(*) INTO public_count FROM public.legacy_agent_api_profiles AS a
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
  UPDATE public.legacy_agent_api_profiles AS a SET
    display_name = CASE WHEN patch ? 'displayName' THEN pg_catalog.convert_from(pg_catalog.decode(patch ->> 'displayName', 'base64'), 'UTF8') ELSE a.display_name END,
    description = CASE WHEN patch ? 'description' THEN pg_catalog.convert_from(pg_catalog.decode(patch ->> 'description', 'base64'), 'UTF8') ELSE a.description END,
    sound = CASE WHEN patch ? 'sound' THEN pg_catalog.convert_from(pg_catalog.decode(patch ->> 'sound', 'base64'), 'UTF8') ELSE a.sound END,
    avatar_url = CASE WHEN patch ? 'avatarUrl' THEN pg_catalog.convert_from(pg_catalog.decode(patch ->> 'avatarUrl', 'base64'), 'UTF8') ELSE a.avatar_url END,
    visibility = CASE WHEN p_visibility IS NOT NULL THEN p_visibility ELSE a.visibility END,
    updated_at = COALESCE(p_now, pg_catalog.date_trunc('milliseconds',
      pg_catalog.timezone('UTC', pg_catalog.clock_timestamp())))
    WHERE a.org_id = p_org_id AND a.id = p_agent_id;

  SELECT pg_catalog.jsonb_build_object(
    'agentId', a.id, 'defaultAgentId', CASE WHEN a.name = 'default-agent' AND a.visibility = 'public' THEN a.id END, 'owner', a.owner,
    'displayName', a.display_name, 'description', a.description,
    'sound', a.sound, 'avatarUrl', a.avatar_url, 'visibility', a.visibility)
    INTO agent FROM public.legacy_agent_api_profiles AS a
    WHERE a.org_id = p_org_id AND a.id = p_agent_id LIMIT 1;
  IF agent IS NULL THEN
    RAISE EXCEPTION 'Canonical Agent missing after update: %', p_agent_id;
  END IF;
  RETURN NEXT;
END;
$agent_metadata$;
