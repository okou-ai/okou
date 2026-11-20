LOCK TABLE public.compose_jobs IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.compose_jobs WHERE status IN ('pending', 'running')) THEN
    RAISE EXCEPTION 'Cannot retire compose_jobs while compose operations are active';
  END IF;
END
$$;--> statement-breakpoint
DROP TABLE public.compose_jobs;
