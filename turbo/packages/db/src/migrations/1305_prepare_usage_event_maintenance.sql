-- PR1 preserves the existing legacy domain and moves its existing entrances
-- to one callable boundary. PR2 can reuse this exact boundary transactionally
-- to drain prepared writers before activating/replacing the native entry.
-- No new advisory key or runtime acquisition is introduced.
CREATE FUNCTION acquire_usage_event_legacy(lock_key text, shared_mode boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF lock_key IS NULL OR shared_mode IS NULL THEN
    RAISE EXCEPTION 'legacy usage coordination requires a key and mode' USING ERRCODE = '22023';
  END IF;
  IF shared_mode THEN
    PERFORM pg_advisory_xact_lock_shared(hashtext('vm0'), hashtext(lock_key));
  ELSE
    PERFORM pg_advisory_xact_lock(hashtext('vm0'), hashtext(lock_key));
  END IF;
END
$$;
--> statement-breakpoint
-- Intentionally inactive native entry in PR1. Old APIs still upgrade metadata
-- to FOR UPDATE after the credit key; acquiring KEY SHARE ahead of that key
-- would deadlock mixed old/prepared settlement. PR1 prepares the call sites and
-- NO KEY UPDATE existence check, not native activation. After verifying this
-- prepared serving/rollback floor and draining older callers, PR2 must obtain
-- the legacy exclusive boundary in its activation transaction before replacing
-- this body. API callers acquire legacy FIRST and call this function separately
-- afterward, so calls queued at the legacy boundary cannot retain an old body.
CREATE FUNCTION acquire_usage_event_maintenance(billed_org text, exclusive_mode boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF exclusive_mode IS NULL OR (billed_org IS NULL AND NOT exclusive_mode) THEN
    RAISE EXCEPTION 'usage maintenance requires an org or exclusive scope' USING ERRCODE = '22023';
  END IF;
END
$$;
--> statement-breakpoint
-- Preserve the installed signature, exact quiescent-owner contract and single
-- legacy entrance. Route it through the same preparation entry; never edit
-- shipped migration 1119 or activate cleanup by defining this function.
CREATE OR REPLACE FUNCTION purge_quiescent_provisional_billing_attribution(billed_org text, billed_user text, quiescent_run_ids uuid[]) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE removed integer;
BEGIN
  IF billed_org IS NULL OR billed_user IS NULL OR cardinality(quiescent_run_ids) IS NULL
      OR cardinality(quiescent_run_ids) > 500 THEN
    RAISE EXCEPTION 'provisional billing purge requires an exact owner and at most 500 quiescent runs' USING ERRCODE = '22023';
  END IF;
  PERFORM acquire_usage_event_legacy('usage_event_compaction', false);
  PERFORM acquire_usage_event_maintenance(billed_org, true);
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
