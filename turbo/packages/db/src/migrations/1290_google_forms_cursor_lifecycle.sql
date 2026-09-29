-- A watch is a replaceable delivery resource. Reattaching its existing cursor
-- must not discard responses that have not been delivered yet. Both pre-R1
-- and R1 upserts write watch_state_id, including when the binding is unchanged;
-- response admission advances only last_seen_submitted_time and updated_at.
CREATE FUNCTION preserve_google_forms_cursor_on_rebind() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.last_seen_submitted_time := OLD.last_seen_submitted_time;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER google_forms_cursor_rebind_preserves_progress
BEFORE UPDATE OF watch_state_id ON google_forms_automation_cursors
FOR EACH ROW EXECUTE FUNCTION preserve_google_forms_cursor_on_rebind();
--> statement-breakpoint
-- Explicit disable and source replacement end the old delivery interval.
-- Official reconciliation can pause enabled=false while intended_enabled=true;
-- that temporary pause must retain the cursor for catch-up after repair.
CREATE FUNCTION invalidate_google_forms_cursor_for_source_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.event_type = 'google-forms-response-submitted' AND (
    OLD.kind IS DISTINCT FROM NEW.kind
    OR OLD.event_type IS DISTINCT FROM NEW.event_type
    OR OLD.org_id IS DISTINCT FROM NEW.org_id
    OR OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
    OR OLD.workflow_id IS DISTINCT FROM NEW.workflow_id
    OR OLD.event_connector_id IS DISTINCT FROM NEW.event_connector_id
    OR (OLD.event_config ->> 'connectorId') IS DISTINCT FROM (NEW.event_config ->> 'connectorId')
    OR (OLD.event_config -> 'form' ->> 'id') IS DISTINCT FROM (NEW.event_config -> 'form' ->> 'id')
    OR (NEW.official_blueprint_key IS NULL AND NOT NEW.enabled)
    OR (NEW.official_blueprint_key IS NOT NULL AND NOT NEW.official_intended_enabled)
  ) THEN
    DELETE FROM public.google_forms_automation_cursors
      WHERE automation_id = OLD.id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER google_forms_cursor_source_lifecycle
AFTER UPDATE OF kind, event_type, org_id, owner_user_id, workflow_id,
  event_connector_id, event_config, enabled, official_blueprint_key,
  official_intended_enabled ON workflow_automations
FOR EACH ROW EXECUTE FUNCTION invalidate_google_forms_cursor_for_source_change();
--> statement-breakpoint
-- Existing disabled automations may still have a cursor from the old cascade
-- behavior when another enabled automation keeps the shared watch alive.
DELETE FROM google_forms_automation_cursors AS cursor
USING workflow_automations AS automation
WHERE cursor.automation_id = automation.id
  AND (
    automation.kind <> 'event'
    OR automation.event_type IS DISTINCT FROM 'google-forms-response-submitted'
    OR automation.event_connector_id IS NULL
    OR (automation.official_blueprint_key IS NULL AND NOT automation.enabled)
    OR (automation.official_blueprint_key IS NOT NULL AND NOT automation.official_intended_enabled)
  );
