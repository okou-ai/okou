LOCK TABLE public.compose_jobs IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.compose_jobs WHERE status IN ('pending', 'running')) THEN
    RAISE EXCEPTION 'Cannot retire compose_jobs while compose operations are active';
  END IF;
END
$$;--> statement-breakpoint
DROP TABLE public.compose_jobs;--> statement-breakpoint
ALTER TABLE "github_installations" DROP CONSTRAINT "github_installations_default_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "github_installations" DROP COLUMN "default_agent_id";--> statement-breakpoint
ALTER TABLE "org_members_metadata" DROP COLUMN "pinned_agent_ids";
