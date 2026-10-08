-- Luna's product effort ceiling is xhigh on every provider route.
-- Keep stored preferences and historical runs unchanged: route resolution
-- falls back from an unavailable saved effort to the new route default.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM model_routes
    WHERE model IN ('gpt-5.6-luna', 'gpt-6-luna')
      AND ('max' = ANY(efforts) OR default_effort IS NULL)
      AND NOT ('xhigh' = ANY(efforts))
  ) THEN
    RAISE EXCEPTION 'Cannot retire Luna max on a route without xhigh';
  END IF;
END
$$;
--> statement-breakpoint
UPDATE model_routes
SET efforts = array_remove(efforts, 'max'),
    default_effort = CASE
      WHEN default_effort = 'max' OR default_effort IS NULL THEN 'xhigh'
      ELSE default_effort
    END,
    updated_at = now()
WHERE model IN ('gpt-5.6-luna', 'gpt-6-luna')
  AND ('max' = ANY(efforts) OR default_effort IS NULL);
