-- Permit in-place promotion of a Personal Access configuration to its own
-- organization without detaching the owner's SSH hosts. Authorization that
-- the acting user is this owner and an org admin remains at the API boundary.
CREATE OR REPLACE FUNCTION reject_cloudflare_access_scope_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.scope IS NOT DISTINCT FROM NEW.scope
    AND OLD.user_id IS NOT DISTINCT FROM NEW.user_id
    AND OLD.org_id IS NOT DISTINCT FROM NEW.org_id THEN
    RETURN NEW;
  END IF;

  IF OLD.org_id IS DISTINCT FROM NEW.org_id OR NOT (
    (OLD.scope = 'organization' AND OLD.user_id IS NULL
      AND NEW.scope = 'personal' AND NEW.user_id IS NOT NULL)
    OR
    (OLD.scope = 'personal' AND OLD.user_id IS NOT NULL
      AND NEW.scope = 'organization' AND NEW.user_id IS NULL)
  ) THEN
    RAISE EXCEPTION 'Cloudflare Access scope and owner change is not permitted'
      USING ERRCODE = '23514', CONSTRAINT = 'cloudflare_access_scope_change_guard';
  END IF;

  -- A demotion may retain only the new owner's bindings; promotion must not
  -- inherit bindings from anyone other than the previous Personal owner.
  IF EXISTS (
    SELECT 1 FROM ssh_connections
    WHERE cloudflare_access_id = OLD.id
      AND org_id = OLD.org_id
      AND user_id IS DISTINCT FROM COALESCE(NEW.user_id, OLD.user_id)
  ) THEN
    RAISE EXCEPTION 'Other owners still reference this Cloudflare Access configuration'
      USING ERRCODE = '23514', CONSTRAINT = 'cloudflare_access_scope_change_guard';
  END IF;
  RETURN NEW;
END;
$$;
