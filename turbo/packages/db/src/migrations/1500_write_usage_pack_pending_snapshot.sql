-- okou:non-transactional
-- Seven existing pending-snapshot operations share one atomic local statement.
-- Client cancellation is checked before and after SQL; a successful commit
-- remains a complete snapshot that a later request can reuse or retire.
CREATE OR REPLACE FUNCTION public.write_usage_pack_pending_snapshot(
  p_input jsonb,
  p_clock timestamp without time zone
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER PARALLEL UNSAFE
AS $pending_snapshot$
DECLARE
  operation text := p_input->>'kind';
  organization text := p_input->>'orgId';
  root_id uuid := (p_input->>'rootId')::uuid;
  before_ids uuid[];
  before_pending uuid[];
  after_pending uuid[];
  guard_count integer;
  changed integer;
  invalid_scope boolean;
  current_subscription text;
  projected_org text;
  at timestamp without time zone;
  result jsonb;
  current_root public.usage_pack_subscriptions%ROWTYPE;
  allocation_rows jsonb;
  contexts jsonb := '[]'::jsonb;
  fingerprint jsonb := '[]'::jsonb;
  expected jsonb := '[]'::jsonb;
  entry jsonb;
  snapshot jsonb;
  target jsonb;
  matching_id uuid;
  snapshot_id uuid;
BEGIN
  IF operation IS NULL OR operation NOT IN ('prepare-purchase', 'correlate-claim', 'claim-purchase',
    'publish-purchase', 'synchronize', 'deactivate', 'delete')
    OR jsonb_typeof(p_input->'orgId') IS DISTINCT FROM 'string'
    OR (operation <> 'prepare-purchase' AND root_id IS NULL) THEN
    RAISE EXCEPTION 'Invalid pending snapshot operation' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (SELECT 1 FROM public.usage_pack_subscriptions
    WHERE (org_id = organization OR id = root_id) AND org_id <> organization) THEN
    RAISE EXCEPTION 'Usage pack subscription moved outside its locked scope';
  END IF;
  INSERT INTO public.usage_pack_pending_snapshot_guards (org_id, pending_snapshot_count)
    VALUES (organization, 0) ON CONFLICT DO NOTHING;
  -- Read the guard and roots under the same statement snapshot, including after
  -- an initial guard insertion waited for another publisher to commit.
  SELECT guard.pending_snapshot_count,
    coalesce(array_agg(root.id) FILTER (WHERE root.id IS NOT NULL), '{}'::uuid[]),
    coalesce(array_agg(root.id) FILTER (WHERE root.subscription_status IN
      ('checkout_pending', 'purchase_pending')), '{}'::uuid[])
  INTO guard_count, before_ids, before_pending
  FROM public.usage_pack_pending_snapshot_guards AS guard
  LEFT JOIN public.usage_pack_subscriptions AS root ON root.org_id = guard.org_id
  WHERE guard.org_id = organization
  GROUP BY guard.org_id, guard.pending_snapshot_count;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Usage pack pending snapshot count disappeared';
  END IF;
  IF guard_count <> cardinality(before_pending) THEN
    RAISE EXCEPTION 'Usage pack pending snapshot guard requires repair';
  END IF;

  -- The labelled block preserves business early results without skipping the
  -- common fresh after-snapshot/count publication below.
  <<business>>
  BEGIN
  CASE operation
  WHEN 'prepare-purchase' THEN
    IF EXISTS (SELECT 1 FROM public.usage_pack_subscriptions
      WHERE org_id = organization AND subscription_status = 'incomplete'
        AND stripe_checkout_session_id IS NULL AND stripe_subscription_id IS NULL) THEN
      result := jsonb_build_object('kind', operation, 'value', jsonb_build_object('kind', 'conflict'));
      EXIT business;
    END IF;
    expected := p_input->'fingerprint';
    -- The cursor fixes the original root-read snapshot/order. Each following
    -- allocation query keeps a separate fresh command snapshot, as before.
    FOR current_root IN SELECT * FROM public.usage_pack_subscriptions
      WHERE org_id = organization AND subscription_status IN ('checkout_pending', 'purchase_pending')
      ORDER BY updated_at DESC LOOP
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', a.id, 'usagePackSubscriptionId', a.usage_pack_subscription_id, 'orgId', a.org_id,
        'userId', a.user_id, 'invitationId', a.invitation_id, 'usagePackUsd', a.usage_pack_usd,
        'stripePriceId', a.stripe_price_id, 'status', a.status,
        'currentPeriodStart', (CASE WHEN floor(extract(epoch FROM a.current_period_start) * 1000) BETWEEN -8640000000000000 AND 8640000000000000 THEN floor(extract(epoch FROM a.current_period_start) * 1000)::bigint END),
        'currentPeriodEnd', (CASE WHEN floor(extract(epoch FROM a.current_period_end) * 1000) BETWEEN -8640000000000000 AND 8640000000000000 THEN floor(extract(epoch FROM a.current_period_end) * 1000)::bigint END),
        'createdAt', (CASE WHEN floor(extract(epoch FROM a.created_at) * 1000) BETWEEN -8640000000000000 AND 8640000000000000 THEN floor(extract(epoch FROM a.created_at) * 1000)::bigint END),
        'updatedAt', (CASE WHEN floor(extract(epoch FROM a.updated_at) * 1000) BETWEEN -8640000000000000 AND 8640000000000000 THEN floor(extract(epoch FROM a.updated_at) * 1000)::bigint END)
      ) ORDER BY a.id::text), '[]'::jsonb) INTO allocation_rows
      FROM public.usage_pack_allocations AS a WHERE a.usage_pack_subscription_id = current_root.id;
      entry := jsonb_build_object('subscription', jsonb_build_object(
        'id', current_root.id, 'orgId', current_root.org_id, 'tier', current_root.tier,
        'stripePlanPriceId', current_root.stripe_plan_price_id, 'stripeCustomerId', current_root.stripe_customer_id,
        'stripeCheckoutSessionId', current_root.stripe_checkout_session_id,
        'stripeSubscriptionId', current_root.stripe_subscription_id, 'subscriptionStatus', current_root.subscription_status,
        'currentPeriodStart', (CASE WHEN floor(extract(epoch FROM current_root.current_period_start) * 1000) BETWEEN -8640000000000000 AND 8640000000000000 THEN floor(extract(epoch FROM current_root.current_period_start) * 1000)::bigint END),
        'currentPeriodEnd', (CASE WHEN floor(extract(epoch FROM current_root.current_period_end) * 1000) BETWEEN -8640000000000000 AND 8640000000000000 THEN floor(extract(epoch FROM current_root.current_period_end) * 1000)::bigint END),
        'cancelAtPeriodEnd', current_root.cancel_at_period_end,
        'createdAt', (CASE WHEN floor(extract(epoch FROM current_root.created_at) * 1000) BETWEEN -8640000000000000 AND 8640000000000000 THEN floor(extract(epoch FROM current_root.created_at) * 1000)::bigint END),
        'updatedAt', (CASE WHEN floor(extract(epoch FROM current_root.updated_at) * 1000) BETWEEN -8640000000000000 AND 8640000000000000 THEN floor(extract(epoch FROM current_root.updated_at) * 1000)::bigint END)
      ), 'allocations', allocation_rows);
      contexts := contexts || jsonb_build_array(entry);
      IF current_root.stripe_checkout_session_id IS NOT NULL THEN
        fingerprint := fingerprint || jsonb_build_array(entry);
      END IF;
    END LOOP;
    SELECT coalesce(jsonb_agg(value ORDER BY value->'subscription'->>'id'), '[]'::jsonb)
      INTO fingerprint FROM jsonb_array_elements(fingerprint);
    IF fingerprint IS DISTINCT FROM expected THEN
      result := jsonb_build_object('kind', operation, 'value', jsonb_build_object('kind', 'conflict'));
      EXIT business;
    END IF;

    -- Provider-bearing snapshots are retired only after their exact prepared
    -- fingerprint matched. No provider operation executes inside this routine.
    FOR target IN SELECT value FROM jsonb_array_elements(p_input->'resolved') LOOP
      IF NOT (target->>'retained')::boolean THEN
        at := coalesce(p_clock, date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC'));
        UPDATE public.usage_pack_subscriptions SET subscription_status = 'checkout_expired', updated_at = at
        WHERE id = (target->>'id')::uuid AND org_id = target->>'orgId'
          AND subscription_status = target->>'status'
          AND stripe_checkout_session_id IS NOT DISTINCT FROM target->>'sessionId'
          AND stripe_subscription_id IS NOT DISTINCT FROM target->>'subscriptionId'
          AND subscription_status IN ('checkout_pending', 'purchase_pending');
        GET DIAGNOSTICS changed = ROW_COUNT;
        IF changed = 0 THEN
          RAISE EXCEPTION 'Usage pack purchase changed during retirement' USING ERRCODE = 'P0U01';
        END IF;
        UPDATE public.usage_pack_allocations SET status = 'inactive', updated_at = at
          WHERE usage_pack_subscription_id = (target->>'id')::uuid;
      END IF;
    END LOOP;
    IF NOT (p_input->>'retained')::boolean THEN
      FOR entry IN SELECT value FROM jsonb_array_elements(contexts) LOOP
        snapshot := entry->'subscription';
        IF snapshot->>'stripeCheckoutSessionId' IS NULL
          AND snapshot->>'subscriptionStatus' = 'purchase_pending'
          AND snapshot->>'tier' = p_input->>'tier'
          AND snapshot->>'stripePlanPriceId' = p_input->>'planPriceId'
          AND snapshot->>'stripeCustomerId' = p_input->>'customerId'
          AND jsonb_array_length(entry->'allocations') = jsonb_array_length(p_input->'allocations')
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(p_input->'allocations') AS requested(value)
            WHERE NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(entry->'allocations') AS existing(value)
              WHERE ((requested.value ? 'userId' AND existing.value->>'userId' = requested.value->>'userId'
                  AND existing.value->>'invitationId' IS NULL)
                OR (NOT (requested.value ? 'userId') AND existing.value->>'invitationId' = requested.value->>'invitationId'
                  AND existing.value->>'userId' IS NULL))
                AND existing.value->>'status' = 'pending_payment'
                AND existing.value->'usagePackUsd' = requested.value->'usagePackUsd'
                AND existing.value->>'stripePriceId' = requested.value->>'stripePriceId')) THEN
          matching_id := (snapshot->>'id')::uuid;
          EXIT;
        END IF;
      END LOOP;
    END IF;
    FOR entry IN SELECT value FROM jsonb_array_elements(contexts) LOOP
      snapshot := entry->'subscription';
      IF snapshot->>'stripeCheckoutSessionId' IS NULL
        AND (matching_id IS NULL OR (snapshot->>'id')::uuid <> matching_id) THEN
        at := coalesce(p_clock, date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC'));
        UPDATE public.usage_pack_subscriptions SET subscription_status = 'checkout_expired', updated_at = at
        WHERE id = (snapshot->>'id')::uuid AND org_id = snapshot->>'orgId'
          AND subscription_status = snapshot->>'subscriptionStatus'
          AND stripe_checkout_session_id IS NOT DISTINCT FROM snapshot->>'stripeCheckoutSessionId'
          AND stripe_subscription_id IS NOT DISTINCT FROM snapshot->>'stripeSubscriptionId'
          AND subscription_status IN ('checkout_pending', 'purchase_pending');
        GET DIAGNOSTICS changed = ROW_COUNT;
        IF changed = 0 THEN
          RAISE EXCEPTION 'Usage pack purchase changed during retirement' USING ERRCODE = 'P0U01';
        END IF;
        UPDATE public.usage_pack_allocations SET status = 'inactive', updated_at = at
          WHERE usage_pack_subscription_id = (snapshot->>'id')::uuid;
      END IF;
    END LOOP;
    IF (p_input->>'retained')::boolean THEN
      IF p_input->>'redirect' IS NULL THEN
        RAISE EXCEPTION 'Stripe checkout session did not return a URL';
      END IF;
      result := jsonb_build_object('kind', operation, 'value',
        jsonb_build_object('kind', 'redirect', 'url', p_input->>'redirect'));
      EXIT business;
    END IF;
    snapshot_id := matching_id;
    IF snapshot_id IS NULL THEN
      INSERT INTO public.usage_pack_subscriptions (org_id, tier, stripe_plan_price_id,
        stripe_customer_id, subscription_status)
      VALUES (organization, p_input->>'tier', p_input->>'planPriceId',
        p_input->>'customerId', 'purchase_pending') RETURNING id INTO snapshot_id;
      IF snapshot_id IS NULL THEN
        RAISE EXCEPTION 'Failed to create usage pack subscription snapshot';
      END IF;
      IF jsonb_array_length(p_input->'allocations') > 0 THEN
        INSERT INTO public.usage_pack_allocations (usage_pack_subscription_id, org_id,
          usage_pack_usd, stripe_price_id, user_id, invitation_id)
        SELECT snapshot_id, organization, (value->>'usagePackUsd')::integer,
          value->>'stripePriceId', value->>'userId', value->>'invitationId'
        FROM jsonb_array_elements(p_input->'allocations') WITH ORDINALITY AS requested(value, position)
        ORDER BY position;
      END IF;
    END IF;
    result := jsonb_build_object('kind', operation, 'value',
      jsonb_build_object('kind', 'snapshot', 'usagePackSubscriptionId', snapshot_id));

  WHEN 'correlate-claim' THEN
    at := coalesce(p_clock, date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC'));
    UPDATE public.usage_pack_subscriptions
    SET stripe_checkout_session_id = p_input->>'sessionId',
      subscription_status = 'checkout_pending', updated_at = at
    WHERE id = root_id AND org_id = organization
      AND stripe_customer_id = p_input->>'customerId'
      AND stripe_plan_price_id = p_input->>'planPriceId'
      AND tier = p_input->>'tier' AND subscription_status = 'incomplete'
      AND stripe_checkout_session_id IS NULL AND stripe_subscription_id IS NULL;
    GET DIAGNOSTICS changed = ROW_COUNT;
    result := jsonb_build_object('kind', operation, 'value',
      CASE WHEN changed = 1 THEN 'correlated' ELSE 'changed' END);

  WHEN 'claim-purchase' THEN
    UPDATE public.usage_pack_subscriptions
    SET subscription_status = 'incomplete', updated_at = (p_input->>'at')::timestamp
    WHERE id = root_id AND org_id = organization
      AND subscription_status = 'purchase_pending'
      AND stripe_checkout_session_id IS NULL AND stripe_subscription_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.usage_pack_subscriptions AS other
        WHERE other.org_id = organization AND other.id <> root_id AND (
          (other.subscription_status = 'incomplete' AND other.stripe_subscription_id IS NULL
            AND other.stripe_checkout_session_id IS NULL)
          OR (other.stripe_subscription_id IS NOT NULL
            AND other.subscription_status NOT IN ('canceled', 'incomplete_expired', 'invalid'))))
      AND NOT EXISTS (
        SELECT 1 FROM public.org_metadata AS plan
        WHERE plan.org_id = organization AND plan.subscription_status = 'incomplete'
          AND plan.stripe_subscription_id IS NULL
          AND plan.updated_at > (p_input->>'planClaimStaleBefore')::timestamp);
    GET DIAGNOSTICS changed = ROW_COUNT;
    result := jsonb_build_object('kind', operation, 'value', changed = 1);

  WHEN 'publish-purchase' THEN
    at := coalesce(p_clock, date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC'));
    UPDATE public.usage_pack_subscriptions
    SET stripe_subscription_id = p_input->>'subscriptionId',
      subscription_status = p_input->>'status', updated_at = at
    WHERE id = root_id AND org_id = organization AND subscription_status = 'incomplete'
      AND stripe_checkout_session_id IS NULL AND stripe_subscription_id IS NULL;
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed = 1 THEN
      result := jsonb_build_object('kind', operation, 'value', true);
    ELSE
      -- A failed conditional update may have waited for a concurrent publisher.
      -- Keep the original separate, fresh same-subscription replay read.
      SELECT stripe_subscription_id INTO current_subscription
        FROM public.usage_pack_subscriptions WHERE id = root_id;
      result := jsonb_build_object('kind', operation, 'value',
        coalesce(current_subscription = p_input->>'subscriptionId', false));
    END IF;

  WHEN 'synchronize' THEN
    at := coalesce(p_clock, date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC'));
    IF p_input ? 'checkoutSessionId' THEN
      UPDATE public.usage_pack_subscriptions
      SET tier = p_input->>'tier', stripe_plan_price_id = p_input->>'planPriceId',
        stripe_subscription_id = p_input->>'subscriptionId', subscription_status = p_input->>'status',
        cancel_at_period_end = (p_input->>'cancelAtPeriodEnd')::boolean, updated_at = at,
        stripe_checkout_session_id = p_input->>'checkoutSessionId'
      WHERE id = root_id;
    ELSE
      UPDATE public.usage_pack_subscriptions
      SET tier = p_input->>'tier', stripe_plan_price_id = p_input->>'planPriceId',
        stripe_subscription_id = p_input->>'subscriptionId', subscription_status = p_input->>'status',
        cancel_at_period_end = (p_input->>'cancelAtPeriodEnd')::boolean, updated_at = at
      WHERE id = root_id;
    END IF;
    IF (p_input->>'projectsOrgPlan')::boolean THEN
      UPDATE public.org_metadata SET subscription_status = p_input->>'status',
        cancel_at_period_end = (p_input->>'cancelAtPeriodEnd')::boolean, updated_at = at
      WHERE org_id = organization AND stripe_subscription_id = p_input->>'subscriptionId';
    END IF;
    result := jsonb_build_object('kind', operation);

  WHEN 'deactivate' THEN
    at := coalesce(p_clock, date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC'));
    UPDATE public.usage_pack_subscriptions
    SET stripe_subscription_id = p_input->>'subscriptionId',
      subscription_status = p_input->>'status', cancel_at_period_end = false, updated_at = at
    WHERE id = root_id;
    UPDATE public.usage_pack_allocations SET status = 'inactive', updated_at = at
      WHERE usage_pack_subscription_id = root_id;
    IF (p_input->>'projectsLimitedPlan')::boolean THEN
      UPDATE public.org_metadata SET tier = 'limited-free-1', stripe_subscription_id = NULL,
        subscription_status = p_input->>'status', current_period_end = NULL,
        cancel_at_period_end = false, updated_at = at
      WHERE org_id = organization AND stripe_subscription_id = p_input->>'subscriptionId'
      RETURNING org_id INTO projected_org;
      IF FOUND THEN
        at := coalesce(p_clock, date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC'));
        INSERT INTO public.org_plan_entitlements (
          org_id, plan_key, plan_rank, source, status, base_concurrency_limit,
          can_buy_concurrency, can_buy_credits, show_usage_pack, auto_recharge_allowed,
          restricted_built_in_models, workflow_webhook_trigger_allowed, audio_lifetime_limit,
          audio_daily_rate_limit, audio_daily_duration_seconds, stripe_subscription_id,
          stripe_price_id, current_period_start, current_period_end, cancel_at, expires_at,
          source_metadata, updated_at)
        VALUES (
          projected_org, 'limited-free-1', (p_input->'limits'->>'planRank')::integer,
          'stripe_subscription', 'active', (p_input->'limits'->>'baseConcurrencyLimit')::integer,
          (p_input->'limits'->>'canBuyConcurrency')::boolean,
          (p_input->'limits'->>'canBuyCredits')::boolean, false,
          (p_input->'limits'->>'autoRechargeAllowed')::boolean,
          (p_input->'limits'->>'restrictedBuiltInModels')::boolean,
          (p_input->'limits'->>'workflowWebhookAutomationAllowed')::boolean,
          (p_input->'limits'->>'audioLifetimeLimit')::integer,
          (p_input->'limits'->>'audioDailyRateLimit')::integer,
          (p_input->'limits'->>'audioDailyDurationSeconds')::integer,
          NULL, NULL, NULL, NULL, NULL, NULL, p_input->'sourceMetadata', at)
        ON CONFLICT (org_id) DO UPDATE SET
          plan_key = EXCLUDED.plan_key, plan_rank = EXCLUDED.plan_rank,
          source = EXCLUDED.source, status = EXCLUDED.status,
          base_concurrency_limit = EXCLUDED.base_concurrency_limit,
          can_buy_concurrency = EXCLUDED.can_buy_concurrency, can_buy_credits = EXCLUDED.can_buy_credits,
          show_usage_pack = EXCLUDED.show_usage_pack, auto_recharge_allowed = EXCLUDED.auto_recharge_allowed,
          restricted_built_in_models = EXCLUDED.restricted_built_in_models,
          workflow_webhook_trigger_allowed = EXCLUDED.workflow_webhook_trigger_allowed,
          audio_lifetime_limit = EXCLUDED.audio_lifetime_limit,
          audio_daily_rate_limit = EXCLUDED.audio_daily_rate_limit,
          audio_daily_duration_seconds = EXCLUDED.audio_daily_duration_seconds,
          stripe_subscription_id = EXCLUDED.stripe_subscription_id, stripe_product_id = NULL,
          stripe_price_id = EXCLUDED.stripe_price_id, current_period_start = EXCLUDED.current_period_start,
          current_period_end = EXCLUDED.current_period_end, cancel_at = EXCLUDED.cancel_at,
          expires_at = EXCLUDED.expires_at, metadata_hash = NULL,
          source_metadata = EXCLUDED.source_metadata, updated_at = EXCLUDED.updated_at;
      END IF;
    END IF;
    result := jsonb_build_object('kind', operation);

  WHEN 'delete' THEN
    at := coalesce(p_clock, date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC'));
    UPDATE public.usage_pack_subscriptions
    SET stripe_subscription_id = p_input->>'subscriptionId', subscription_status = 'canceled',
      cancel_at_period_end = false, updated_at = at
    WHERE id = root_id;
    UPDATE public.usage_pack_allocations SET status = 'inactive', updated_at = at
      WHERE usage_pack_subscription_id = root_id;
    result := jsonb_build_object('kind', operation);
  END CASE;
  END business;

  -- Even changed/false/idempotent outcomes still publish the after-snapshot.
  SELECT coalesce(bool_or(root.org_id <> organization), false),
    coalesce(array_agg(root.id) FILTER (WHERE root.org_id = organization
      AND root.subscription_status IN ('checkout_pending', 'purchase_pending')), '{}'::uuid[])
  INTO invalid_scope, after_pending
  FROM public.usage_pack_subscriptions AS root
  WHERE root.org_id = organization OR root.id = ANY(before_ids);
  IF invalid_scope THEN
    RAISE EXCEPTION 'Usage pack subscription moved outside its locked scope';
  END IF;
  IF cardinality(after_pending) > 1 AND EXISTS (
    SELECT 1 FROM unnest(after_pending) AS pending(id) WHERE NOT (id = ANY(before_pending))) THEN
    RAISE EXCEPTION 'Another usage-pack purchase is already pending for this organization';
  END IF;
  IF cardinality(before_pending) <> cardinality(after_pending) THEN
    UPDATE public.usage_pack_pending_snapshot_guards
    SET pending_snapshot_count = cardinality(after_pending)
    WHERE org_id = organization AND pending_snapshot_count = cardinality(before_pending);
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed = 0 THEN
      RAISE EXCEPTION 'Usage pack pending snapshot count changed during publication'
        USING ERRCODE = 'P0U01';
    END IF;
  END IF;
  RETURN result;
END;
$pending_snapshot$;
