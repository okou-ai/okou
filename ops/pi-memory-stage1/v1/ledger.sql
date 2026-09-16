-- One statement/snapshot. $1 UTC date, $2 exact org or NULL, $3 exact user or NULL.
-- $4 canonical provider -> lookup provider JSON object (normally {}). Same alias
-- contract as resolveUsagePricingProvider; never use model-name prefix matching.
-- Caller: READ ONLY, UTC, lock_timeout=1s, statement_timeout<=5s.
WITH facts AS MATERIALIZED (
  SELECT billing_context, billing_anchor_at, provider, category,
    quantity::numeric AS quantity, credits_charged::numeric AS net_credits,
    status, billing_error, 'raw'::text AS storage
  FROM usage_event
  WHERE kind = 'model'
    AND ($2::text IS NULL OR org_id = $2)
    AND ($3::text IS NULL OR user_id = $3)
    AND ((billing_anchor_at >= $1::date AND billing_anchor_at < $1::date + interval '1 day')
      OR billing_anchor_at IS NULL)
  UNION ALL
  SELECT billing_context, billing_anchor_at, provider, category,
    quantity::numeric, credits_charged::numeric,
    'processed', NULL, 'hourly'
  FROM usage_event_hourly_rollup
  WHERE kind = 'model'
    AND ($2::text IS NULL OR org_id = $2)
    AND ($3::text IS NULL OR user_id = $3)
    AND ((billing_anchor_at >= $1::date AND billing_anchor_at < $1::date + interval '1 day')
      OR billing_anchor_at IS NULL)
), valued AS (
  SELECT f.*, p.unit_price, p.unit_size, p.updated_at AS price_updated_at,
    COALESCE($4::jsonb ->> f.provider, f.provider) AS pricing_provider,
    CASE
      WHEN f.quantity < 0 THEN 'invalid_usage'
      WHEN p.id IS NULL AND fallback.id IS NOT NULL THEN 'fallback_price'
      WHEN p.id IS NULL THEN 'missing_price'
      WHEN p.unit_price < 0 OR p.unit_size <= 0 THEN 'invalid_price'
      ELSE 'available'
    END AS pricing_status,
    CASE WHEN f.quantity >= 0 AND p.unit_price >= 0 AND p.unit_size > 0
      THEN f.quantity * p.unit_price::numeric / p.unit_size::numeric / 1000::numeric
      ELSE NULL END AS gross_usd
  FROM facts f
  LEFT JOIN usage_pricing p ON p.kind = 'model'
    AND p.provider = COALESCE($4::jsonb ->> f.provider, f.provider) AND p.category = f.category
  LEFT JOIN usage_pricing fallback ON fallback.kind = 'model'
    AND fallback.provider = COALESCE($4::jsonb ->> f.provider, f.provider) AND fallback.category = '__fallback__'
), groups AS (
  SELECT billing_context, billing_anchor_at IS NOT NULL AS date_assignable,
    storage, status, billing_error, provider, category, pricing_provider,
    pricing_status, unit_price, unit_size, price_updated_at,
    count(*)::text AS physical_rows, sum(quantity)::text AS quantity,
    sum(net_credits)::text AS net_credits,
    sum(gross_usd)::text AS gross_credit_value_usd
  FROM valued
  GROUP BY billing_context, billing_anchor_at IS NOT NULL, storage, status,
    billing_error, provider, category, pricing_provider, pricing_status,
    unit_price, unit_size, price_updated_at
)
SELECT jsonb_build_object(
  'day', $1::date::text,
  'snapshot_at', transaction_timestamp(),
  'price_basis', 'usage_pricing_at_query_snapshot',
  'currency', 'USD', 'unit', 'gross_credit_value', 'credits_per_usd', 1000,
  'known_stage1_gross_usd', COALESCE((SELECT sum(gross_usd) FROM valued WHERE billing_context = 'pi_memory_stage1'), 0)::text,
  'stage1_unknown_price_rows', (SELECT count(*) FROM valued WHERE billing_context = 'pi_memory_stage1' AND pricing_status <> 'available')::text,
  'stage1_pending_rows', (SELECT count(*) FROM valued WHERE billing_context = 'pi_memory_stage1' AND status <> 'processed')::text,
  'stage1_finalized_rows', (SELECT count(*) FROM valued WHERE billing_context = 'pi_memory_stage1' AND status = 'processed')::text,
  'stage1_billing_error_rows', (SELECT count(*) FROM valued WHERE billing_context = 'pi_memory_stage1' AND billing_error IS NOT NULL)::text,
  'untagged_runless_rows_in_day', (SELECT count(*) FROM valued WHERE billing_context = 'runless')::text,
  'unanchored_model_rows_all_history_in_scope', (SELECT count(*) FROM valued WHERE billing_anchor_at IS NULL)::text,
  'groups', COALESCE((SELECT jsonb_agg(to_jsonb(g) ORDER BY billing_context, storage, provider, category, status, pricing_status) FROM groups g), '[]'::jsonb)
) AS report;
