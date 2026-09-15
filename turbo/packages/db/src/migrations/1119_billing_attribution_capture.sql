-- Capture only reconciliation identifiers and the original allowance anchor.
-- The BEFORE INSERT trigger is inside both canonical run creation transactions,
-- including the data-modifying CTE launch, and also covers outgoing API writers.
CREATE FUNCTION billing_usage_source(trigger_source text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN trigger_source = 'web' THEN 'chat'
    WHEN trigger_source IN ('automation-schedule', 'automation-event', 'goal') THEN 'automation'
    WHEN trigger_source IN ('slack', 'teams', 'telegram', 'email', 'agentphone', 'github', 'agent') THEN trigger_source
    ELSE 'other'
  END
$$;
--> statement-breakpoint
CREATE FUNCTION ensure_billing_run_attribution(billing_id uuid, billed_org text, billed_user text, original_start timestamp, billing_source text) RETURNS void
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
END
$$;
--> statement-breakpoint
CREATE FUNCTION capture_billing_run_attribution() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM ensure_billing_run_attribution(NEW.id, NEW.org_id, NEW.user_id, NEW.created_at, billing_usage_source(NEW.trigger_source));
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER capture_billing_run_attribution BEFORE INSERT ON agent_runs
  FOR EACH ROW EXECUTE FUNCTION capture_billing_run_attribution();
--> statement-breakpoint
CREATE FUNCTION reject_billing_attribution_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.run_id, NEW.org_id, NEW.user_id, NEW.run_started_at, NEW.source, NEW.captured_at)
      IS DISTINCT FROM (OLD.run_id, OLD.org_id, OLD.user_id, OLD.run_started_at, OLD.source, OLD.captured_at)
      OR (OLD.usage_observed AND NOT NEW.usage_observed) THEN
    RAISE EXCEPTION 'billing run attribution is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER billing_run_attribution_immutable BEFORE UPDATE ON billing_run_attribution
  FOR EACH ROW EXECUTE FUNCTION reject_billing_attribution_update();
--> statement-breakpoint
CREATE FUNCTION capture_usage_billing_attribution() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE original record; attribution billing_run_attribution%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.billing_run_id, NEW.billing_anchor_at, NEW.billing_context, NEW.org_id, NEW.user_id)
        IS NOT DISTINCT FROM
       (OLD.billing_run_id, OLD.billing_anchor_at, OLD.billing_context, OLD.org_id, OLD.user_id) THEN
      RETURN NEW;
    END IF;
    IF OLD.billing_context IN ('run', 'runless') THEN
      RAISE EXCEPTION 'usage billing attribution is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.billing_run_id IS NOT NULL AND NEW.billing_run_id IS DISTINCT FROM OLD.billing_run_id THEN
      RAISE EXCEPTION 'original billing run identity is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.run_id IS NOT NULL AND NEW.billing_run_id IS NOT NULL AND NEW.run_id <> NEW.billing_run_id THEN
    RAISE EXCEPTION 'live and billing run identities disagree' USING ERRCODE = '23514';
  END IF;
  NEW.billing_run_id := COALESCE(NEW.billing_run_id, NEW.run_id);
  IF NEW.billing_run_id IS NOT NULL THEN
    SELECT * INTO attribution FROM billing_run_attribution WHERE run_id = NEW.billing_run_id;
    IF NOT FOUND THEN
      SELECT id, org_id, user_id, created_at, trigger_source INTO original FROM agent_runs WHERE id = NEW.billing_run_id;
      IF FOUND THEN
        PERFORM ensure_billing_run_attribution(original.id, original.org_id, original.user_id, original.created_at, billing_usage_source(original.trigger_source));
        SELECT * INTO STRICT attribution FROM billing_run_attribution WHERE run_id = NEW.billing_run_id;
      ELSE
        NEW.billing_context := 'missing_run';
        NEW.billing_anchor_at := NULL;
        RETURN NEW;
      END IF;
    END IF;
    IF attribution.org_id <> NEW.org_id OR attribution.user_id <> NEW.user_id
       OR (NEW.billing_anchor_at IS NOT NULL AND NEW.billing_anchor_at <> attribution.run_started_at) THEN
      RAISE EXCEPTION 'usage billing attribution conflict for run %', NEW.billing_run_id USING ERRCODE = '23514';
    END IF;
    NEW.billing_context := 'run';
    NEW.billing_anchor_at := attribution.run_started_at;
  ELSIF NEW.billing_context = 'runless' THEN
    IF TG_TABLE_NAME = 'usage_event' THEN
      NEW.billing_anchor_at := NEW.created_at;
    ELSIF NEW.billing_anchor_at IS NULL THEN
      RAISE EXCEPTION 'compacted runless usage requires its original anchor' USING ERRCODE = '23514';
    END IF;
  ELSE
    -- A NULL legacy link is not proof of a runless event. No invented timestamp.
    NEW.billing_context := 'legacy_unknown';
    NEW.billing_anchor_at := NULL;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER capture_usage_billing_attribution BEFORE INSERT OR UPDATE OF billing_run_id, billing_anchor_at, billing_context, org_id, user_id ON usage_event
  FOR EACH ROW EXECUTE FUNCTION capture_usage_billing_attribution();
--> statement-breakpoint
CREATE TRIGGER capture_hourly_billing_attribution BEFORE INSERT OR UPDATE OF billing_run_id, billing_anchor_at, billing_context, org_id, user_id ON usage_event_hourly_rollup
  FOR EACH ROW EXECUTE FUNCTION capture_usage_billing_attribution();

--> statement-breakpoint
CREATE FUNCTION capture_generation_billing_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.billing_context <> 'legacy_unknown' THEN
    IF (NEW.billing_run_id, NEW.billing_context) IS DISTINCT FROM (OLD.billing_run_id, OLD.billing_context) THEN
      RAISE EXCEPTION 'generation billing identity is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.run_id IS NOT NULL THEN
    IF NEW.billing_run_id IS NOT NULL AND NEW.billing_run_id <> NEW.run_id THEN
      RAISE EXCEPTION 'generation billing identity conflict' USING ERRCODE = '23514';
    END IF;
    NEW.billing_run_id := NEW.run_id;
    NEW.billing_context := 'run';
  ELSIF TG_OP = 'INSERT' THEN
    NEW.billing_context := 'runless';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER capture_generation_billing_identity BEFORE INSERT OR UPDATE OF billing_run_id, billing_context ON built_in_generation_jobs
  FOR EACH ROW EXECUTE FUNCTION capture_generation_billing_identity();

--> statement-breakpoint
CREATE FUNCTION mark_billing_usage_observed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.billing_context = 'run' THEN
    UPDATE billing_run_attribution SET usage_observed = true
      WHERE run_id = NEW.billing_run_id AND NOT usage_observed;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER mark_raw_billing_usage_observed AFTER INSERT OR UPDATE OF billing_run_id, billing_context ON usage_event
  FOR EACH ROW EXECUTE FUNCTION mark_billing_usage_observed();
--> statement-breakpoint
CREATE TRIGGER mark_hourly_billing_usage_observed AFTER INSERT OR UPDATE OF billing_run_id, billing_context ON usage_event_hourly_rollup
  FOR EACH ROW EXECUTE FUNCTION mark_billing_usage_observed();
--> statement-breakpoint
-- Caller contract: the durable coordinator must first prove producer quiescence
-- and reconcile outstanding billing obligations for exactly these IDs. This
-- unused A1 boundary does not authorize or activate account deletion.
CREATE FUNCTION purge_quiescent_provisional_billing_attribution(billed_org text, billed_user text, quiescent_run_ids uuid[]) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE removed integer;
BEGIN
  IF billed_org IS NULL OR billed_user IS NULL OR cardinality(quiescent_run_ids) IS NULL
      OR cardinality(quiescent_run_ids) > 500 THEN
    RAISE EXCEPTION 'provisional billing purge requires an exact owner and at most 500 quiescent runs' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('vm0'), hashtext('usage_event_compaction'));
  DELETE FROM billing_run_attribution a
    WHERE a.org_id = billed_org AND a.user_id = billed_user
      AND a.run_id = ANY(quiescent_run_ids) AND NOT a.usage_observed
      AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.id = a.run_id)
      AND NOT EXISTS (SELECT 1 FROM built_in_generation_jobs j WHERE j.billing_run_id = a.run_id OR j.run_id = a.run_id)
      AND NOT EXISTS (SELECT 1 FROM usage_event u WHERE u.billing_run_id = a.run_id OR u.run_id = a.run_id)
      AND NOT EXISTS (SELECT 1 FROM usage_event_hourly_rollup h WHERE h.billing_run_id = a.run_id OR h.run_id = a.run_id)
      AND NOT EXISTS (SELECT 1 FROM usage_allowance_allocations x WHERE x.run_id = a.run_id)
      AND NOT EXISTS (SELECT 1 FROM org_usage_allowance_windows w WHERE w.created_by_run_id = a.run_id);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END
$$;
