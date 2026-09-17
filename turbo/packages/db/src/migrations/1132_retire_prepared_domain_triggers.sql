-- A-D writers are serving in release eb2f211a9af41450d0d5dad10c0c8ad12fac0a24.
-- The rollback resolver enforces that release. E privacy and invitation columns
-- are separate work. No data is rewritten and DROP uses RESTRICT, never CASCADE.
-- Take roots/guards before metadata/entitlements (billing fulfillment), connector
-- parents before configs, and sites before deployments. The runner retains its
-- 1s lock / 10s statement bounds. A fresh statement snapshot after locking sees
-- every preceding writer's committed guard and companion state.
SET LOCAL search_path = public, pg_catalog;
LOCK TABLE public.usage_pack_subscriptions,
  public.usage_pack_pending_snapshot_guards,
  public.org_metadata, public.org_plan_entitlements,
  public.org_custom_connectors, public.org_custom_connector_oauth_configs,
  public.hosted_sites, public.hosted_deployments IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  receipt jsonb;
  matched_triggers integer;
  matched_functions integer;
  named_functions integer;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed'
    OR current_setting('session_replication_role') <> 'origin' THEN
    RAISE EXCEPTION 'Prepared domain retirement requires read committed and origin';
  END IF;

  WITH expected(table_name, trigger_name, definition) AS (VALUES
      ('hosted_deployments', 'enforce_hosted_deployment_scope_0753', 'CREATE TRIGGER enforce_hosted_deployment_scope_0753 BEFORE INSERT ON public.hosted_deployments FOR EACH ROW EXECUTE FUNCTION enforce_hosted_deployment_scope_0753()'),
      ('hosted_sites', 'canonicalize_hosted_site_scope_0753', 'CREATE TRIGGER canonicalize_hosted_site_scope_0753 BEFORE INSERT OR UPDATE OF created_from_run_id, requested_slug, chat_thread_id ON public.hosted_sites FOR EACH ROW EXECUTE FUNCTION canonicalize_hosted_site_scope_0753()'),
      ('org_custom_connector_oauth_configs', 'trg_org_custom_connector_oauth_configs_mode', 'CREATE CONSTRAINT TRIGGER trg_org_custom_connector_oauth_configs_mode AFTER INSERT OR DELETE OR UPDATE ON public.org_custom_connector_oauth_configs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_org_custom_connector_oauth_mode()'),
      ('org_custom_connectors', 'trg_org_custom_connectors_oauth_mode', 'CREATE CONSTRAINT TRIGGER trg_org_custom_connectors_oauth_mode AFTER INSERT OR UPDATE ON public.org_custom_connectors DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_org_custom_connector_oauth_mode()'),
      ('org_metadata', 'ensure_legacy_org_metadata_plan_entitlement', 'CREATE TRIGGER ensure_legacy_org_metadata_plan_entitlement AFTER INSERT ON public.org_metadata FOR EACH ROW EXECUTE FUNCTION ensure_legacy_org_metadata_plan_entitlement()'),
      ('org_plan_entitlements', 'sync_legacy_org_plan_entitlement_can_buy_credits', 'CREATE TRIGGER sync_legacy_org_plan_entitlement_can_buy_credits BEFORE INSERT OR UPDATE OF plan_key ON public.org_plan_entitlements FOR EACH ROW EXECUTE FUNCTION sync_legacy_org_plan_entitlement_can_buy_credits()'),
      ('org_plan_entitlements', 'sync_legacy_org_plan_entitlement_member_invitation_allowed', 'CREATE TRIGGER sync_legacy_org_plan_entitlement_member_invitation_allowed BEFORE INSERT OR UPDATE OF status, member_invitation_allowed ON public.org_plan_entitlements FOR EACH ROW EXECUTE FUNCTION sync_legacy_org_plan_entitlement_member_invitation_allowed()'),
      ('usage_pack_subscriptions', 'sync_usage_pack_pending_snapshot_guard_0954', 'CREATE TRIGGER sync_usage_pack_pending_snapshot_guard_0954 AFTER INSERT OR DELETE OR UPDATE OF org_id, subscription_status ON public.usage_pack_subscriptions FOR EACH ROW EXECUTE FUNCTION sync_usage_pack_pending_snapshot_guard_0954()')
  )
  SELECT count(*) INTO matched_triggers
  FROM expected e JOIN pg_trigger t
    ON t.tgrelid = ('public.' || e.table_name)::regclass
    AND t.tgname = e.trigger_name
  WHERE NOT t.tgisinternal AND t.tgenabled = 'O'
    AND pg_get_triggerdef(t.oid) = e.definition;

  WITH expected(function_name, arguments, body_hash) AS (VALUES
      ('assert_org_custom_connector_oauth_mode', 'target_connector_id uuid, target_org_id text', 'a6f14e53ce5185c90693c5655a6c712f'),
      ('sync_usage_pack_pending_snapshot_guard_0954', '', 'ced36d9b55fb6907880d545aa7f36dbe'),
      ('canonicalize_hosted_site_scope_0753', '', '3506554504d6ccad1b34008dab9a9e9a'),
      ('enforce_hosted_deployment_scope_0753', '', '6f52cca2ad2bdcb63072a8c4269c9b49'),
      ('enforce_org_custom_connector_oauth_mode', '', '15e3309d90f7237e3b5c28fbf23a439d'),
      ('ensure_legacy_org_metadata_plan_entitlement', '', '0b0d44031a51ffc349f0f33cb0df53c3'),
      ('sync_legacy_org_plan_entitlement_can_buy_credits', '', 'daf97695043bdbafd864f7ff7a8f8d5d'),
      ('sync_legacy_org_plan_entitlement_member_invitation_allowed', '', 'c3d7d4a52f4ef3f9fd6250cc8a5460fc')
  )
  SELECT count(*) FILTER (WHERE
      pg_get_function_identity_arguments(p.oid) = e.arguments
      AND md5(p.prosrc) = e.body_hash AND p.proconfig IS NULL
      AND NOT p.prosecdef AND p.provolatile = 'v' AND p.prokind = 'f'
      AND NOT p.proretset AND NOT p.proisstrict AND NOT p.proleakproof
      AND p.proparallel = 'u'
      AND p.prorettype = CASE WHEN e.function_name = 'assert_org_custom_connector_oauth_mode'
        THEN 'void'::regtype ELSE 'trigger'::regtype END
      AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')),
    count(*) INTO matched_functions, named_functions
  FROM expected e JOIN pg_proc p ON p.pronamespace = 'public'::regnamespace
    AND p.proname = e.function_name;

  IF matched_triggers <> 8 OR matched_functions <> 8 OR named_functions <> 8 THEN
    RAISE EXCEPTION 'Prepared domain retirement catalog audit failed';
  END IF;

  WITH pending AS (
    SELECT org_id, count(*) AS roots FROM usage_pack_subscriptions
    WHERE subscription_status IN ('checkout_pending', 'purchase_pending')
    GROUP BY org_id
  ), guard_audit AS (
    SELECT count(*) FILTER (WHERE g.pending_snapshot_count
      IS DISTINCT FROM coalesce(p.roots, 0)) AS mismatches,
      count(*) FILTER (WHERE p.roots > 1) AS grandfathered_organizations
    FROM pending p FULL JOIN usage_pack_pending_snapshot_guards g USING (org_id)
  )
  SELECT jsonb_build_object(
    'observed_at', statement_timestamp(),
    'server_version', current_setting('server_version'),
    'matched_triggers', matched_triggers, 'matched_functions', matched_functions,
    'metadata_rows', (SELECT count(*) FROM org_metadata),
    'entitlement_rows', (SELECT count(*) FROM org_plan_entitlements),
    'connector_rows', (SELECT count(*) FROM org_custom_connectors),
    'site_rows', (SELECT count(*) FROM hosted_sites),
    'deployment_rows', (SELECT count(*) FROM hosted_deployments),
    'subscription_rows', (SELECT count(*) FROM usage_pack_subscriptions),
    'grandfathered_organizations', a.grandfathered_organizations,
    'missing_entitlements', (SELECT count(*) FROM org_metadata m
      WHERE m.tier IN ('free', 'limited-free-1', 'pro-suspend', 'pro', 'team', 'custom')
      AND NOT EXISTS (SELECT 1 FROM org_plan_entitlements e WHERE e.org_id = m.org_id)),
    'managed_credit_mismatches', (SELECT count(*) FROM org_plan_entitlements
      WHERE source IN ('stripe_subscription', 'stripe_atom_grant', 'org_metadata_bootstrap', 'org_metadata_migration')
      AND can_buy_credits IS DISTINCT FROM (plan_key IN ('free', 'pro', 'team', 'custom'))),
    'oauth_pair_mismatches', (SELECT count(*) FROM org_custom_connectors c
      WHERE (c.auth_mode = 'oauth') IS DISTINCT FROM EXISTS (
        SELECT 1 FROM org_custom_connector_oauth_configs o
        WHERE o.connector_id = c.id AND o.org_id = c.org_id)),
    'oauth_orphans', (SELECT count(*) FROM org_custom_connector_oauth_configs o
      WHERE NOT EXISTS (SELECT 1 FROM org_custom_connectors c
        WHERE c.id = o.connector_id AND c.org_id = o.org_id)),
    'missing_requested_slugs', (SELECT count(*) FROM hosted_sites WHERE requested_slug IS NULL),
    'deployment_org_mismatches', (SELECT count(*) FROM hosted_deployments d
      LEFT JOIN hosted_sites s ON s.id = d.site_id
      WHERE s.id IS NULL OR s.org_id IS DISTINCT FROM d.org_id),
    'pending_guard_mismatches', a.mismatches
  ) INTO receipt FROM guard_audit a;

  -- Historical site ownership intentionally survives run/thread deletion or
  -- metadata changes; do not invent a live-run foreign key at this boundary.
  -- Manual entitlement capabilities and grandfathered pending counts survive.
  IF EXISTS (SELECT 1 FROM jsonb_each_text(receipt) e
    WHERE e.key IN ('missing_entitlements', 'managed_credit_mismatches',
      'oauth_pair_mismatches', 'oauth_orphans', 'missing_requested_slugs',
      'deployment_org_mismatches', 'pending_guard_mismatches')
    AND e.value <> '0') THEN
    RAISE EXCEPTION 'Prepared domain retirement invariant audit failed: %', receipt;
  END IF;

  DROP TRIGGER enforce_hosted_deployment_scope_0753 ON public.hosted_deployments;
  DROP TRIGGER canonicalize_hosted_site_scope_0753 ON public.hosted_sites;
  DROP TRIGGER trg_org_custom_connector_oauth_configs_mode ON public.org_custom_connector_oauth_configs;
  DROP TRIGGER trg_org_custom_connectors_oauth_mode ON public.org_custom_connectors;
  DROP TRIGGER ensure_legacy_org_metadata_plan_entitlement ON public.org_metadata;
  DROP TRIGGER sync_legacy_org_plan_entitlement_can_buy_credits ON public.org_plan_entitlements;
  DROP TRIGGER sync_legacy_org_plan_entitlement_member_invitation_allowed ON public.org_plan_entitlements;
  DROP TRIGGER sync_usage_pack_pending_snapshot_guard_0954 ON public.usage_pack_subscriptions;
  DROP FUNCTION public.assert_org_custom_connector_oauth_mode(uuid, text);
  DROP FUNCTION public.sync_usage_pack_pending_snapshot_guard_0954();
  DROP FUNCTION public.canonicalize_hosted_site_scope_0753();
  DROP FUNCTION public.enforce_hosted_deployment_scope_0753();
  DROP FUNCTION public.enforce_org_custom_connector_oauth_mode();
  DROP FUNCTION public.ensure_legacy_org_metadata_plan_entitlement();
  DROP FUNCTION public.sync_legacy_org_plan_entitlement_can_buy_credits();
  DROP FUNCTION public.sync_legacy_org_plan_entitlement_member_invitation_allowed();

  -- A receipt is only committed evidence together with the migration journal
  -- and the runner's successful completion; a subsequent failure rolls it back.
  RAISE NOTICE 'prepared_domain_trigger_retirement_v1 %', receipt ||
    jsonb_build_object('transaction_status', 'pending_commit', 'retired_triggers', 8);
END
$$;
