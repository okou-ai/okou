-- Expand without a table scan under the runner default lock/statement limits.
-- Validation runs in the next migration transaction, after these locks release.
ALTER TABLE "usage_event_hourly_rollup" DROP CONSTRAINT "usage_event_hourly_rollup_billing_context_check";--> statement-breakpoint
ALTER TABLE "usage_event" DROP CONSTRAINT "usage_event_billing_context_check";--> statement-breakpoint
ALTER TABLE "usage_event_hourly_rollup" ADD CONSTRAINT "usage_event_hourly_rollup_billing_context_check" CHECK ((
        ("usage_event_hourly_rollup"."billing_context" = 'run' AND "usage_event_hourly_rollup"."billing_run_id" IS NOT NULL AND "usage_event_hourly_rollup"."billing_anchor_at" IS NOT NULL)
        OR ("usage_event_hourly_rollup"."billing_context" = 'runless' AND "usage_event_hourly_rollup"."billing_run_id" IS NULL AND "usage_event_hourly_rollup"."billing_anchor_at" IS NOT NULL)
        OR ("usage_event_hourly_rollup"."billing_context" = 'pi_memory_stage1' AND "usage_event_hourly_rollup"."billing_run_id" IS NULL AND "usage_event_hourly_rollup"."run_id" IS NULL AND "usage_event_hourly_rollup"."billing_anchor_at" IS NOT NULL AND "usage_event_hourly_rollup"."kind" = 'model')
        OR ("usage_event_hourly_rollup"."billing_context" = 'missing_run' AND "usage_event_hourly_rollup"."billing_run_id" IS NOT NULL AND "usage_event_hourly_rollup"."billing_anchor_at" IS NULL)
        OR ("usage_event_hourly_rollup"."billing_context" = 'legacy_unknown' AND "usage_event_hourly_rollup"."billing_run_id" IS NULL AND "usage_event_hourly_rollup"."billing_anchor_at" IS NULL)
      )) NOT VALID;--> statement-breakpoint
ALTER TABLE "usage_event" ADD CONSTRAINT "usage_event_billing_context_check" CHECK ((
        ("usage_event"."billing_context" = 'run' AND "usage_event"."billing_run_id" IS NOT NULL AND "usage_event"."billing_anchor_at" IS NOT NULL)
        OR ("usage_event"."billing_context" = 'runless' AND "usage_event"."billing_run_id" IS NULL AND "usage_event"."billing_anchor_at" IS NOT NULL)
        OR ("usage_event"."billing_context" = 'pi_memory_stage1' AND "usage_event"."billing_run_id" IS NULL AND "usage_event"."run_id" IS NULL AND "usage_event"."billing_anchor_at" IS NOT NULL AND "usage_event"."kind" = 'model' AND "usage_event"."billing_anchor_at" = "usage_event"."created_at")
        OR ("usage_event"."billing_context" = 'missing_run' AND "usage_event"."billing_run_id" IS NOT NULL AND "usage_event"."billing_anchor_at" IS NULL)
        OR ("usage_event"."billing_context" = 'legacy_unknown' AND "usage_event"."billing_run_id" IS NULL AND "usage_event"."billing_anchor_at" IS NULL)
      )) NOT VALID;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION capture_usage_billing_attribution() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE original record; attribution billing_run_attribution%ROWTYPE;
BEGIN
  IF NEW.billing_context = 'pi_memory_stage1' AND
      (NEW.run_id IS NOT NULL OR NEW.billing_run_id IS NOT NULL OR NEW.kind <> 'model') THEN
    RAISE EXCEPTION 'Stage 1 usage requires runless model identity' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.billing_run_id, NEW.billing_anchor_at, NEW.billing_context, NEW.org_id, NEW.user_id)
        IS NOT DISTINCT FROM
       (OLD.billing_run_id, OLD.billing_anchor_at, OLD.billing_context, OLD.org_id, OLD.user_id) THEN
      RETURN NEW;
    END IF;
    IF OLD.billing_context IN ('run', 'runless', 'pi_memory_stage1') THEN
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
  ELSIF NEW.billing_context IN ('runless', 'pi_memory_stage1') THEN
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
