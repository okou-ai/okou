-- #42935 must be independently serving, its outgoing API SQL drained and
-- incompatible rollback artifacts excluded before this separate contraction.
-- Legacy job records are intentionally discarded; preserve the billing ledger.
-- Hold DDL locks across the data/dependency census and the atomic contraction.
LOCK TABLE "public"."commerce_jobs", "public"."data_search_jobs", "public"."social_data_jobs", "public"."socialkit_download_jobs", "public"."usage_event", "public"."usage_pricing" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
BEGIN
  -- Dynamic legacy providers and per-job pricing snapshots also need a settled
  -- financial outcome; the explicit tariff list below is not a usage census.
  IF EXISTS (
    SELECT 1 FROM public.usage_event
    WHERE (
      kind IN ('finance', 'maps', 'weather', 'seo', 'social', 'commerce', 'scrape', 'web-search', 'people-search')
      OR (kind = 'data-search' AND provider <> 'data-router')
      OR pricing_unit_price IS NOT NULL
      OR pricing_unit_size IS NOT NULL
      OR pricing_credits_limit IS NOT NULL
    )
    AND (
      status NOT IN ('processed', 'compacted')
      OR processed_at IS NULL OR credits_charged IS NULL OR billing_error IS NOT NULL
    )
  ) THEN
    RAISE EXCEPTION 'Managed Data retirement requires all legacy usage to be settled without billing errors'
      USING ERRCODE = '55000';
  END IF;

  -- Check the exact known constraints before retiring them. An unexpected
  -- replacement with the same name is not authorized by this contraction.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.usage_event'::regclass
      AND conname = 'usage_event_pricing_snapshot_check' AND contype = 'c'
      AND pg_catalog.pg_get_constraintdef(oid, true) = 'CHECK (pricing_unit_price IS NULL AND pricing_unit_size IS NULL AND pricing_credits_limit IS NULL OR pricing_unit_price IS NOT NULL AND pricing_unit_size IS NOT NULL AND pricing_credits_limit IS NOT NULL AND pricing_unit_price >= 0 AND pricing_unit_size > 0 AND pricing_credits_limit >= 0)'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.usage_pricing'::regclass
      AND conname = 'chk_usage_pricing_source_cost_usd_micros_per_credit' AND contype = 'c'
      AND pg_catalog.pg_get_constraintdef(oid, true) = 'CHECK (source_cost_usd_micros_per_credit IS NULL OR source_cost_usd_micros_per_credit >= 1 AND source_cost_usd_micros_per_credit <= ''9007199254740991''::bigint)'
  ) THEN
    RAISE EXCEPTION 'Unexpected managed Data pricing constraints'
      USING ERRCODE = '2BP01';
  END IF;
END;
$$;
--> statement-breakpoint
ALTER TABLE "public"."usage_event" DROP CONSTRAINT "usage_event_pricing_snapshot_check";
--> statement-breakpoint
ALTER TABLE "public"."usage_pricing" DROP CONSTRAINT "chk_usage_pricing_source_cost_usd_micros_per_credit";
--> statement-breakpoint
DO $$
DECLARE
  target record;
  column_number smallint;
  row_type oid;
  row_array_type oid;
  dependent_objects text;
BEGIN
  -- RESTRICT protects tracked external table consumers. It does not protect
  -- local triggers, inheritance or string-bodied routines.
  SELECT string_agg(object_name, ', ' ORDER BY object_name)
  INTO dependent_objects
  FROM (
    SELECT pg_catalog.pg_describe_object('pg_catalog.pg_proc'::regclass, routine.oid, 0) AS object_name
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
      AND routine.prosrc ~* '\m(commerce_jobs|data_search_jobs|social_data_jobs|socialkit_download_jobs|usage_event|usage_pricing|pricing_unit_price|pricing_unit_size|pricing_credits_limit|source_cost_usd_micros_per_credit)\M'
    UNION
    SELECT pg_catalog.pg_describe_object('pg_catalog.pg_trigger'::regclass, oid, 0)
    FROM pg_catalog.pg_trigger
    WHERE tgrelid IN (
      'public.commerce_jobs'::regclass, 'public.data_search_jobs'::regclass,
      'public.social_data_jobs'::regclass, 'public.socialkit_download_jobs'::regclass,
      'public.usage_event'::regclass, 'public.usage_pricing'::regclass
    ) AND NOT tgisinternal
    UNION
    SELECT format('inheritance %s -> %s', inhparent::regclass, inhrelid::regclass)
    FROM pg_catalog.pg_inherits
    WHERE inhparent IN (
      'public.commerce_jobs'::regclass, 'public.data_search_jobs'::regclass,
      'public.social_data_jobs'::regclass, 'public.socialkit_download_jobs'::regclass,
      'public.usage_event'::regclass, 'public.usage_pricing'::regclass
    ) OR inhrelid IN (
      'public.commerce_jobs'::regclass, 'public.data_search_jobs'::regclass,
      'public.social_data_jobs'::regclass, 'public.socialkit_download_jobs'::regclass,
      'public.usage_event'::regclass, 'public.usage_pricing'::regclass
    )
  ) AS dependencies;
  IF dependent_objects IS NOT NULL THEN
    RAISE EXCEPTION 'Unexpected managed Data storage dependencies: %', dependent_objects
      USING ERRCODE = '2BP01';
  END IF;

  -- DROP COLUMN also silently removes its local indexes/checks. After removing
  -- only the two verified checks above, no further column consumer may remain.
  FOR target IN
    SELECT * FROM (VALUES
      ('public.usage_event'::regclass, 'pricing_unit_price'),
      ('public.usage_event'::regclass, 'pricing_unit_size'),
      ('public.usage_event'::regclass, 'pricing_credits_limit'),
      ('public.usage_pricing'::regclass, 'source_cost_usd_micros_per_credit')
    ) AS columns(relation_id, column_name)
  LOOP
    SELECT attnum INTO column_number
    FROM pg_catalog.pg_attribute
    WHERE attrelid = target.relation_id AND attname = target.column_name
      AND NOT attisdropped AND atttypid = 'bigint'::regtype AND NOT attnotnull;
    IF column_number IS NULL THEN
      RAISE EXCEPTION 'Expected nullable bigint column %.%', target.relation_id, target.column_name;
    END IF;
    SELECT relation.reltype, row.typarray INTO row_type, row_array_type
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_type AS row ON row.oid = relation.reltype
    WHERE relation.oid = target.relation_id;

    SELECT string_agg(object_name, ', ' ORDER BY object_name)
    INTO dependent_objects
    FROM (
      SELECT pg_catalog.pg_describe_object(classid, objid, objsubid) AS object_name
      FROM pg_catalog.pg_depend
      WHERE refclassid = 'pg_catalog.pg_class'::regclass
        AND refobjid = target.relation_id AND refobjsubid = column_number
      UNION
      SELECT pg_catalog.pg_describe_object(classid, objid, objsubid)
      FROM pg_catalog.pg_depend
      WHERE classid IN ('pg_catalog.pg_rewrite'::regclass, 'pg_catalog.pg_proc'::regclass)
        AND refclassid = 'pg_catalog.pg_class'::regclass
        AND refobjid = target.relation_id AND refobjsubid = 0
      UNION
      SELECT pg_catalog.pg_describe_object(classid, objid, objsubid)
      FROM pg_catalog.pg_depend
      WHERE refclassid = 'pg_catalog.pg_type'::regclass
        AND refobjid IN (row_type, row_array_type)
        AND NOT (
          classid = 'pg_catalog.pg_type'::regclass AND objid = row_array_type
          AND refobjid = row_type AND deptype = 'i'
        )
    ) AS dependencies;
    IF dependent_objects IS NOT NULL THEN
      RAISE EXCEPTION 'Unexpected %.% dependencies: %', target.relation_id, target.column_name, dependent_objects
        USING ERRCODE = '2BP01';
    END IF;
  END LOOP;
END;
$$;
--> statement-breakpoint
-- These exact retired tariffs include baseline migrations, dev seeds and
-- dynamic legacy Data providers. Keep every unrelated price and all usage,
-- hourly rollup and wallet history; Router credits are already priced 1:1.
DELETE FROM "public"."usage_pricing"
WHERE (kind, provider, category) IN (
  ('commerce', 'dataforseo', 'provider_cost_usd_micros'),
  ('data-search', 'firecrawl/alexandria/affiliate-com', 'provider_cost_usd_micros'),
  ('data-search', 'firecrawl/alexandria/firecrawl-trends', 'provider_cost_usd_micros'),
  ('data-search', 'firecrawl/alexandria/fiscal-ai', 'provider_cost_usd_micros'),
  ('data-search', 'firecrawl/alexandria/oriane', 'provider_cost_usd_micros'),
  ('data-search', 'firecrawl/alexandria/particle', 'provider_cost_usd_micros'),
  ('data-search', 'firecrawl/alexandria/play-google-com', 'provider_cost_usd_micros'),
  ('data-search', 'firecrawl/alexandria/similarweb', 'provider_cost_usd_micros'),
  ('data-search', 'firecrawl/alexandria/upspring', 'provider_cost_usd_micros'),
  ('data-search', 'firecrawl/alexandria/web-archive-org', 'provider_cost_usd_micros'),
  ('data-search', 'monid/apollo', 'provider_cost_usd_micros'),
  ('data-search', 'monid/hunterio', 'provider_cost_usd_micros'),
  ('finance', 'apidojo', 'request'),
  ('maps', 'google-maps', 'geocoding'),
  ('maps', 'google-maps', 'places.details.enterprise'),
  ('maps', 'google-maps', 'places.details.essentials'),
  ('maps', 'google-maps', 'places.details.pro'),
  ('maps', 'google-maps', 'places.text_search.enterprise'),
  ('maps', 'google-maps', 'places.text_search.pro'),
  ('maps', 'google-maps', 'routes.directions'),
  ('maps', 'google-maps', 'routes.directions.advanced'),
  ('maps', 'google-maps-grounding', 'provider_cost_usd_micros'),
  ('maps', 'openstreetmap', 'osm.download'),
  ('maps', 'openstreetmap', 'osm.render.png'),
  ('people-search', 'perplexity', 'request'),
  ('scrape', 'firecrawl', 'enhanced.links'),
  ('scrape', 'firecrawl', 'enhanced.markdown'),
  ('scrape', 'firecrawl', 'standard.links'),
  ('scrape', 'firecrawl', 'standard.markdown'),
  ('seo', 'dataforseo', 'provider_cost_usd_micros'),
  ('social', 'monid/douyin', 'provider_cost_usd_micros'),
  ('social', 'monid/facebook', 'provider_cost_usd_micros'),
  ('social', 'monid/instagram', 'provider_cost_usd_micros'),
  ('social', 'monid/threads', 'provider_cost_usd_micros'),
  ('social', 'monid/tiktok', 'provider_cost_usd_micros'),
  ('social', 'monid/wechat', 'provider_cost_usd_micros'),
  ('social', 'monid/weibo', 'provider_cost_usd_micros'),
  ('social', 'monid/x', 'provider_cost_usd_micros'),
  ('social', 'monid/xiaohongshu', 'provider_cost_usd_micros'),
  ('social', 'monid/youtube', 'provider_cost_usd_micros'),
  ('social', 'socialkit', 'request'),
  ('weather', 'google-air-quality', 'current'),
  ('weather', 'google-weather', 'current'),
  ('weather', 'google-weather', 'forecast.daily'),
  ('weather', 'google-weather', 'forecast.hourly'),
  ('weather', 'google-weather', 'history.hourly'),
  ('web-search', 'perplexity', 'request')
);
--> statement-breakpoint
ALTER TABLE "public"."usage_event" DROP COLUMN "pricing_unit_price" RESTRICT;
--> statement-breakpoint
ALTER TABLE "public"."usage_event" DROP COLUMN "pricing_unit_size" RESTRICT;
--> statement-breakpoint
ALTER TABLE "public"."usage_event" DROP COLUMN "pricing_credits_limit" RESTRICT;
--> statement-breakpoint
ALTER TABLE "public"."usage_pricing" DROP COLUMN "source_cost_usd_micros_per_credit" RESTRICT;
--> statement-breakpoint
DROP TABLE "public"."commerce_jobs" RESTRICT;
--> statement-breakpoint
DROP TABLE "public"."data_search_jobs" RESTRICT;
--> statement-breakpoint
DROP TABLE "public"."social_data_jobs" RESTRICT;
--> statement-breakpoint
DROP TABLE "public"."socialkit_download_jobs" RESTRICT;
