-- okou:non-transactional
-- Retain the existing Run fence and take fresh snapshots after waiting.
CREATE OR REPLACE FUNCTION public.start_run_built_in_admission(
  p_run_id uuid,
  p_now timestamp without time zone,
  p_max_in_flight integer,
  p_max_started integer,
  p_ttl_ms integer
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
PARALLEL UNSAFE
AS $run_built_in_admission$
DECLARE
  observed_now timestamp without time zone;
  active_count bigint;
  started_count bigint;
  admission_id uuid;
BEGIN
  PERFORM run.id FROM public.agent_runs AS run
  WHERE run.id = p_run_id FOR NO KEY UPDATE;

  observed_now := COALESCE(p_now,
    date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC'));
  UPDATE public.run_built_in_admissions
  SET status = 'expired', completed_at = observed_now, updated_at = observed_now
  WHERE run_id = p_run_id AND status = 'active' AND expires_at <= observed_now;

  SELECT count(*) FILTER (WHERE status = 'active'), count(*)
  INTO active_count, started_count
  FROM public.run_built_in_admissions WHERE run_id = p_run_id;
  IF active_count >= p_max_in_flight THEN
    RETURN jsonb_build_object('outcome', 'concurrency_limit');
  END IF;
  IF started_count >= p_max_started THEN
    RETURN jsonb_build_object('outcome', 'usage_limit');
  END IF;

  INSERT INTO public.run_built_in_admissions (run_id, kind, status, expires_at)
  VALUES (p_run_id, 'image', 'active',
    observed_now + p_ttl_ms * interval '1 millisecond')
  RETURNING id INTO admission_id;
  RETURN jsonb_build_object('outcome', 'admitted', 'id', admission_id);
END;
$run_built_in_admission$;
