-- Billing readers group usage by chat thread through the live agent_runs row.
-- Capture that grouping identity next to the rest of the content-free billing
-- attribution so the readers stop depending on a row erasure must delete.
-- Only the opaque identifier is stored; titles stay in chat_threads, and the
-- reader resolves the live thread row for anything it displays.
--
-- Monotone unknown -> known fill. It never overwrites a captured identity, so
-- the run trigger, the usage trigger and the operator backfill are
-- interchangeable and re-runnable in any order.
CREATE FUNCTION ensure_billing_run_thread(billing_id uuid, original_thread uuid) RETURNS void
LANGUAGE sql AS $$
  UPDATE billing_run_attribution
    SET thread_id = original_thread,
        thread_context = CASE WHEN original_thread IS NULL THEN 'threadless' ELSE 'thread' END
    WHERE run_id = billing_id AND thread_context = 'unknown';
$$;
--> statement-breakpoint
-- The usage-side capture reaches this for an older live run, where the run row
-- is the only available source. A missing run updates nothing: absence is not
-- evidence that the run had no thread. The run INSERT trigger cannot see its
-- own not-yet-inserted row here and passes the value explicitly instead.
CREATE OR REPLACE FUNCTION ensure_billing_run_attribution(billing_id uuid, billed_org text, billed_user text, original_start timestamp, billing_source text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE matched uuid;
BEGIN
  INSERT INTO billing_run_attribution (run_id, org_id, user_id, run_started_at, source)
    VALUES (billing_id, billed_org, billed_user, original_start, billing_source)
  ON CONFLICT (run_id) DO UPDATE SET run_id = EXCLUDED.run_id
    WHERE billing_run_attribution.org_id = EXCLUDED.org_id
      AND billing_run_attribution.user_id = EXCLUDED.user_id
      AND billing_run_attribution.run_started_at = EXCLUDED.run_started_at
      AND billing_run_attribution.source = EXCLUDED.source
  RETURNING run_id INTO matched;
  IF matched IS NULL THEN
    RAISE EXCEPTION 'billing attribution conflict for run %', billing_id USING ERRCODE = '23514';
  END IF;
  UPDATE billing_run_attribution a
    SET thread_id = r.chat_thread_id,
        thread_context = CASE WHEN r.chat_thread_id IS NULL THEN 'threadless' ELSE 'thread' END
    FROM agent_runs r
    WHERE a.run_id = billing_id AND r.id = billing_id AND a.thread_context = 'unknown';
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION capture_billing_run_attribution() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM ensure_billing_run_attribution(NEW.id, NEW.org_id, NEW.user_id, NEW.created_at, billing_usage_source(NEW.trigger_source));
  PERFORM ensure_billing_run_thread(NEW.id, NEW.chat_thread_id);
  RETURN NEW;
END
$$;
--> statement-breakpoint
-- A known grouping identity is as immutable as the rest of the attribution row.
CREATE OR REPLACE FUNCTION reject_billing_attribution_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.run_id, NEW.org_id, NEW.user_id, NEW.run_started_at, NEW.source, NEW.captured_at)
      IS DISTINCT FROM (OLD.run_id, OLD.org_id, OLD.user_id, OLD.run_started_at, OLD.source, OLD.captured_at)
      OR (OLD.usage_observed AND NOT NEW.usage_observed) THEN
    RAISE EXCEPTION 'billing run attribution is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.thread_context <> 'unknown'
      AND (NEW.thread_id, NEW.thread_context) IS DISTINCT FROM (OLD.thread_id, OLD.thread_context) THEN
    RAISE EXCEPTION 'billing run thread attribution is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
