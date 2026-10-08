-- Custom SQL migration file, put your code below! --
CREATE OR REPLACE FUNCTION reject_cloudflare_access_scope_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.scope IS NOT DISTINCT FROM NEW.scope
    AND OLD.user_id IS NOT DISTINCT FROM NEW.user_id
    AND OLD.org_id IS NOT DISTINCT FROM NEW.org_id THEN
    RETURN NEW;
  END IF;

  IF OLD.org_id IS DISTINCT FROM NEW.org_id
    OR NOT (
      OLD.scope = 'organization'
      AND OLD.user_id IS NULL
      AND NEW.scope = 'personal'
      AND NEW.user_id IS NOT NULL
    ) THEN
    RAISE EXCEPTION 'Cloudflare Access scope and owner change is not permitted'
      USING ERRCODE = '23514', CONSTRAINT = 'cloudflare_access_scope_change_guard';
  END IF;

  IF EXISTS (
    SELECT 1 FROM ssh_connections
    WHERE cloudflare_access_id = OLD.id
      AND org_id = OLD.org_id
      AND user_id IS DISTINCT FROM NEW.user_id
  ) THEN
    RAISE EXCEPTION 'Other owners still reference this Cloudflare Access configuration'
      USING ERRCODE = '23514', CONSTRAINT = 'cloudflare_access_scope_change_guard';
  END IF;
  RETURN NEW;
END;
$$;
