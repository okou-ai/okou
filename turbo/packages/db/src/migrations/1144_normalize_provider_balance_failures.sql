-- Preserve retained terminal presentation before retiring text inference from
-- run readers. This changes only the cause, never raw diagnostics or HTTP status.
CREATE FUNCTION pg_temp.provider_balance_failure_1144(message text, claude boolean)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  trimmed text;
  normalized text;
  body jsonb;
  provider_error jsonb;
  first_brace integer;
  last_brace integer;
BEGIN
  IF message IS NULL THEN
    RETURN false;
  END IF;
  trimmed := regexp_replace(message, '^[[:space:]]+|[[:space:]]+$', '', 'g');
  normalized := lower(trimmed);
  IF claude AND normalized = 'credit balance is too low' THEN
    RETURN true;
  END IF;
  IF normalized LIKE 'api error: 402 %'
    AND strpos(normalized, 'requires more credits') > 0
    AND strpos(normalized, 'can only afford') > 0 THEN
    RETURN true;
  END IF;
  IF trimmed !~* '^(api error: [0-9]{3} |unexpected status [0-9]{3} [^:]+:)' THEN
    RETURN false;
  END IF;
  first_brace := strpos(message, '{');
  last_brace := length(message) - strpos(reverse(message), '}') + 1;
  IF first_brace = 0 OR strpos(message, '}') = 0 OR last_brace < first_brace THEN
    RETURN false;
  END IF;
  BEGIN
    body := substring(message FROM first_brace FOR last_brace - first_brace + 1)::jsonb;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RETURN false;
  END;
  IF jsonb_typeof(body) <> 'object' THEN
    RETURN false;
  END IF;

  -- Match the established provider envelope order and optional-field types.
  -- The first valid envelope wins; an invalid one cannot create a billing cause.
  FOREACH provider_error IN ARRAY ARRAY[
    body->'error',
    CASE WHEN body->>'type' = 'response.failed' THEN body->'response'->'error' END,
    CASE WHEN body->>'type' = 'error' THEN body END,
    CASE WHEN jsonb_typeof(body->'choices') = 'array' THEN body->'choices'->0->'error' END
  ] LOOP
    IF jsonb_typeof(provider_error) = 'object'
      AND (NOT provider_error ? 'type' OR jsonb_typeof(provider_error->'type') = 'string')
      AND (NOT provider_error ? 'code' OR jsonb_typeof(provider_error->'code') IN ('string', 'number'))
      AND (NOT provider_error ? 'message' OR jsonb_typeof(provider_error->'message') = 'string') THEN
      RETURN coalesce(
        lower(provider_error->>'code') IN (
          'billing', 'billing_error', 'insufficient_quota', 'payment_required',
          'billing_hard_limit_reached', 'insufficient_credits'
        )
        OR lower(provider_error->>'type') IN (
          'billing', 'billing_error', 'insufficient_quota', 'payment_required',
          'billing_hard_limit_reached', 'insufficient_credits'
        )
        OR provider_error->'code' = '402'::jsonb
        OR (provider_error->>'type' = 'invalid_request_error'
          AND starts_with(provider_error->>'message',
            'Your credit balance is too low to access the Anthropic API.')),
        false
      );
    END IF;
  END LOOP;
  RETURN false;
END;
$$;
--> statement-breakpoint
UPDATE "agent_runs"
SET "failure_reason" = 'provider_insufficient_credits'
WHERE "status" = 'failed'
  AND ("failure_reason" IS NULL OR "failure_reason" = 'insufficient_credits')
  AND pg_temp.provider_balance_failure_1144(
    "error",
    "model_provider" = 'built-in'
      OR "launch_snapshot"->>'framework' = 'claude-code'
      OR ("launch_snapshot"->>'framework' IS NULL
        AND coalesce("model_runtime_provider", "model_provider") IN (
          'anthropic-api-key', 'claude-code-oauth-token',
          'openrouter-api-key', 'vercel-ai-gateway'
        ))
  );
--> statement-breakpoint
DROP FUNCTION pg_temp.provider_balance_failure_1144(text, boolean);
