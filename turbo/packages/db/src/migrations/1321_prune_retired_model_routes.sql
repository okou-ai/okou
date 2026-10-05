-- Run only after Custom configuration retirement and its API rollback floor.
-- Keep the fixed Auto route, personal subscriptions and the independent memory
-- binding. Model labels/replacement chains and all historical pricing remain.
DO $migration$
BEGIN
  IF to_regclass('public.org_model_policies') IS NOT NULL
     OR to_regclass('public.model_provider_connections') IS NOT NULL
     OR to_regclass('public.model_provider_surfaces') IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM pg_attribute
       WHERE attrelid = 'public.org_metadata'::regclass
         AND attname = 'model_mode' AND NOT attisdropped
     ) THEN
    RAISE EXCEPTION 'Retired model route cleanup requires Custom configuration retirement';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.model_routes
    WHERE model = 'okou-1.0'
      AND provider_type = 'built-in'
      AND concrete_provider_type = 'openrouter-codex'
      AND subscription_type IS NULL
      AND upstream_model = '@preset/okou-1-0'
      AND enabled
  ) OR NOT EXISTS (
    SELECT 1 FROM public.model_routes
    WHERE model = 'deepseek-v4.1-flash'
      AND provider_type = 'built-in'
      AND concrete_provider_type = 'openrouter-codex'
      AND subscription_type IS NULL
      AND upstream_model = 'deepseek/deepseek-v4.1-flash'
      AND enabled
  ) THEN
    RAISE EXCEPTION 'Retired model route cleanup requires the active Auto and memory bindings';
  END IF;
END
$migration$;
--> statement-breakpoint
DELETE FROM public.model_routes
WHERE NOT COALESCE(
  (
    provider_type IN ('claude-code-oauth-token', 'codex-oauth-token')
    AND concrete_provider_type = provider_type
    AND subscription_type = provider_type
  )
  OR (
    provider_type = 'built-in'
    AND concrete_provider_type = 'openrouter-codex'
    AND subscription_type IS NULL
    AND (
      (model = 'okou-1.0' AND upstream_model = '@preset/okou-1-0')
      OR (
        model = 'deepseek-v4.1-flash'
        AND upstream_model = 'deepseek/deepseek-v4.1-flash'
      )
    )
  ),
  false
);
