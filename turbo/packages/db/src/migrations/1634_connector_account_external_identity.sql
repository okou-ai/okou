UPDATE connectors account SET external_issuer = binding.issuer
FROM connector_account_oauth_bindings binding WHERE binding.connector_account_id = account.id;
--> statement-breakpoint
UPDATE connectors account SET external_issuer = binding.issuer
FROM custom_connector_account_oauth_bindings binding WHERE binding.connector_account_id = account.id;
--> statement-breakpoint
-- The historical Webflow placeholder never identified an authorized account.
UPDATE connectors SET external_id = NULL
WHERE connector_slug = 'webflow' AND external_id = 'unknown';
--> statement-breakpoint
-- Keep the established account identity and its access policy. Only the latest
-- accepted credentials/metadata replace it; dependants follow the retained ID.
CREATE TEMP TABLE connector_identity_merge ON COMMIT DROP AS
SELECT id, canonical_id, credential_id
FROM (
  SELECT id,
    first_value(id) OVER (
      PARTITION BY org_id, user_id, connector_slug, custom_connector_id, external_id, external_issuer
      ORDER BY is_default DESC, created_at, id
    ) AS canonical_id,
    first_value(id) OVER (
      PARTITION BY org_id, user_id, connector_slug, custom_connector_id, external_id, external_issuer
      ORDER BY created_at DESC, updated_at DESC, id
    ) AS credential_id,
    count(*) OVER (
      PARTITION BY org_id, user_id, connector_slug, custom_connector_id, external_id, external_issuer
    ) AS copies
  FROM connectors WHERE external_id IS NOT NULL AND external_id <> ''
) ranked WHERE copies > 1;
--> statement-breakpoint
-- Do not silently discard separately linked drafts or managed installations.
-- If historical rows cannot be merged losslessly, abort the entire migration.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM mail_drafts d
    JOIN connector_identity_merge m ON m.id = d.connector_id
    GROUP BY m.canonical_id, d.outlook_message_id
    HAVING d.outlook_message_id IS NOT NULL AND count(*) > 1
  ) OR EXISTS (
    SELECT 1 FROM mail_drafts d
    JOIN connector_identity_merge m ON m.id = d.connector_id
    GROUP BY m.canonical_id, d.gmail_draft_id
    HAVING d.gmail_draft_id IS NOT NULL AND count(*) > 1
  ) OR EXISTS (
    SELECT 1 FROM feishu_org_connections c
    JOIN connector_identity_merge m ON m.id = c.connector_id
    GROUP BY m.canonical_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Connector identity consolidation found conflicting draft or installation references; no accounts were changed';
  END IF;
END $$;
--> statement-breakpoint
UPDATE connectors canonical SET
  auth_method = latest.auth_method, automatic_auth_type = latest.automatic_auth_type,
  storage_version = latest.storage_version, external_username = latest.external_username,
  external_email = latest.external_email, oauth_scopes = latest.oauth_scopes,
  oauth_granted_scopes = latest.oauth_granted_scopes, token_expires_at = latest.token_expires_at,
  needs_reconnect = latest.needs_reconnect, reconnect_reason = latest.reconnect_reason,
  updated_at = latest.updated_at
FROM (SELECT DISTINCT canonical_id, credential_id FROM connector_identity_merge) m
JOIN connectors latest ON latest.id = m.credential_id
WHERE canonical.id = m.canonical_id AND canonical.id <> latest.id;
--> statement-breakpoint
DELETE FROM secrets value USING connector_identity_merge m
WHERE value.connector_id = m.canonical_id AND m.canonical_id <> m.credential_id;
--> statement-breakpoint
UPDATE secrets value SET connector_id = m.canonical_id
FROM (SELECT DISTINCT canonical_id, credential_id FROM connector_identity_merge) m
WHERE value.connector_id = m.credential_id AND m.credential_id <> m.canonical_id;
--> statement-breakpoint
DELETE FROM variables value USING connector_identity_merge m
WHERE value.connector_id = m.canonical_id AND m.canonical_id <> m.credential_id;
--> statement-breakpoint
UPDATE variables value SET connector_id = m.canonical_id
FROM (SELECT DISTINCT canonical_id, credential_id FROM connector_identity_merge) m
WHERE value.connector_id = m.credential_id AND m.credential_id <> m.canonical_id;
--> statement-breakpoint
DELETE FROM connector_account_oauth_bindings value USING connector_identity_merge m
WHERE value.connector_account_id = m.canonical_id AND m.canonical_id <> m.credential_id;
--> statement-breakpoint
UPDATE connector_account_oauth_bindings value SET connector_account_id = m.canonical_id
FROM (SELECT DISTINCT canonical_id, credential_id FROM connector_identity_merge) m
WHERE value.connector_account_id = m.credential_id AND m.credential_id <> m.canonical_id;
--> statement-breakpoint
DELETE FROM custom_connector_account_oauth_bindings value USING connector_identity_merge m
WHERE value.connector_account_id = m.canonical_id AND m.canonical_id <> m.credential_id;
--> statement-breakpoint
UPDATE custom_connector_account_oauth_bindings value SET connector_account_id = m.canonical_id
FROM (SELECT DISTINCT canonical_id, credential_id FROM connector_identity_merge) m
WHERE value.connector_account_id = m.credential_id AND m.credential_id <> m.canonical_id;
--> statement-breakpoint
-- Explicit denial wins when duplicate account policies overlap in a chat.
INSERT INTO chat_thread_connector_access_overrides (chat_thread_id, connector_id, enabled)
SELECT access.chat_thread_id, m.canonical_id, bool_and(access.enabled)
FROM chat_thread_connector_access_overrides access
JOIN connector_identity_merge m ON m.id = access.connector_id
GROUP BY access.chat_thread_id, m.canonical_id
ON CONFLICT (chat_thread_id, connector_id) DO UPDATE SET
  enabled = chat_thread_connector_access_overrides.enabled AND EXCLUDED.enabled;
--> statement-breakpoint
DELETE FROM chat_thread_connector_access_overrides access
USING connector_identity_merge m
WHERE access.connector_id = m.id AND m.id <> m.canonical_id;
--> statement-breakpoint
UPDATE chat_thread_connector_selections dependant SET connector_id = m.canonical_id
FROM connector_identity_merge m
WHERE dependant.connector_id = m.id AND m.id <> m.canonical_id;
--> statement-breakpoint
UPDATE connector_oauth_completions dependant SET connection_id = m.canonical_id
FROM connector_identity_merge m
WHERE dependant.connection_id = m.id AND m.id <> m.canonical_id;
--> statement-breakpoint
UPDATE feishu_org_connections dependant SET connector_id = m.canonical_id
FROM connector_identity_merge m
WHERE dependant.connector_id = m.id AND m.id <> m.canonical_id;
--> statement-breakpoint
UPDATE mail_drafts dependant SET connector_id = m.canonical_id
FROM connector_identity_merge m
WHERE dependant.connector_id = m.id AND m.id <> m.canonical_id;
--> statement-breakpoint
UPDATE notion_workflow_pending_events dependant SET connector_id = m.canonical_id
FROM connector_identity_merge m
WHERE dependant.connector_id = m.id AND m.id <> m.canonical_id;
--> statement-breakpoint
UPDATE workflow_automations dependant SET event_connector_id = m.canonical_id
FROM connector_identity_merge m
WHERE dependant.event_connector_id = m.id AND m.id <> m.canonical_id;
--> statement-breakpoint
CREATE TEMP TABLE gmail_watch_states_identity_merge ON COMMIT DROP AS
SELECT watch.id, first_value(watch.id) OVER (
  PARTITION BY m.canonical_id, watch.topic_name
  ORDER BY (watch.connector_id = m.canonical_id) DESC, watch.updated_at DESC, watch.id
) AS canonical_id
FROM gmail_watch_states watch JOIN connector_identity_merge m ON m.id = watch.connector_id;
--> statement-breakpoint
-- Preserve the union of replay guards and the newest cached provider snapshot.
DELETE FROM gmail_processed_events event USING (
  SELECT id FROM (
    SELECT event.id, row_number() OVER (
      PARTITION BY m.canonical_id, event.automation_id, event.history_id, event.message_id ORDER BY event.created_at, event.id
    ) AS copies FROM gmail_processed_events event JOIN gmail_watch_states_identity_merge m ON m.id = event.watch_state_id
    
  ) ranked WHERE copies > 1
) duplicate WHERE event.id = duplicate.id;
--> statement-breakpoint
UPDATE gmail_processed_events event SET watch_state_id = m.canonical_id
FROM gmail_watch_states_identity_merge m WHERE event.watch_state_id = m.id AND m.id <> m.canonical_id;
--> statement-breakpoint
DELETE FROM gmail_watch_states watch USING gmail_watch_states_identity_merge m
WHERE watch.id = m.id AND m.id <> m.canonical_id;
--> statement-breakpoint
UPDATE gmail_watch_states watch SET connector_id = m.canonical_id
FROM connector_identity_merge m WHERE watch.connector_id = m.id AND m.id <> m.canonical_id;
--> statement-breakpoint
CREATE TEMP TABLE google_calendar_watch_states_identity_merge ON COMMIT DROP AS
SELECT watch.id, first_value(watch.id) OVER (
  PARTITION BY m.canonical_id, watch.calendar_id
  ORDER BY (watch.connector_id = m.canonical_id) DESC, watch.updated_at DESC, watch.id
) AS canonical_id
FROM google_calendar_watch_states watch JOIN connector_identity_merge m ON m.id = watch.connector_id;
--> statement-breakpoint
-- Preserve the union of replay guards and the newest cached provider snapshot.
DELETE FROM google_calendar_event_snapshots event USING (
  SELECT id FROM (
    SELECT event.id, row_number() OVER (
      PARTITION BY m.canonical_id, event.calendar_event_id ORDER BY event.event_updated_at DESC NULLS LAST, event.updated_at DESC, event.id
    ) AS copies FROM google_calendar_event_snapshots event JOIN google_calendar_watch_states_identity_merge m ON m.id = event.watch_state_id
    
  ) ranked WHERE copies > 1
) duplicate WHERE event.id = duplicate.id;
--> statement-breakpoint
-- Preserve the union of replay guards and the newest cached provider snapshot.
DELETE FROM google_calendar_processed_events event USING (
  SELECT id FROM (
    SELECT event.id, row_number() OVER (
      PARTITION BY m.canonical_id, event.automation_id, event.calendar_event_id, event.event_change_key ORDER BY event.created_at, event.id
    ) AS copies FROM google_calendar_processed_events event JOIN google_calendar_watch_states_identity_merge m ON m.id = event.watch_state_id
    
  ) ranked WHERE copies > 1
) duplicate WHERE event.id = duplicate.id;
--> statement-breakpoint
UPDATE google_calendar_event_snapshots event SET watch_state_id = m.canonical_id
FROM google_calendar_watch_states_identity_merge m WHERE event.watch_state_id = m.id AND m.id <> m.canonical_id;
--> statement-breakpoint
UPDATE google_calendar_processed_events event SET watch_state_id = m.canonical_id
FROM google_calendar_watch_states_identity_merge m WHERE event.watch_state_id = m.id AND m.id <> m.canonical_id;
--> statement-breakpoint
DELETE FROM google_calendar_watch_states watch USING google_calendar_watch_states_identity_merge m
WHERE watch.id = m.id AND m.id <> m.canonical_id;
--> statement-breakpoint
UPDATE google_calendar_watch_states watch SET connector_id = m.canonical_id
FROM connector_identity_merge m WHERE watch.connector_id = m.id AND m.id <> m.canonical_id;
--> statement-breakpoint
CREATE TEMP TABLE google_forms_watch_states_identity_merge ON COMMIT DROP AS
SELECT watch.id, first_value(watch.id) OVER (
  PARTITION BY m.canonical_id, watch.form_id
  ORDER BY (watch.connector_id = m.canonical_id) DESC, watch.updated_at DESC, watch.id
) AS canonical_id
FROM google_forms_watch_states watch JOIN connector_identity_merge m ON m.id = watch.connector_id;
--> statement-breakpoint
-- Preserve the union of replay guards and the newest cached provider snapshot.
DELETE FROM google_forms_processed_events event USING (
  SELECT id FROM (
    SELECT event.id, row_number() OVER (
      PARTITION BY m.canonical_id, event.automation_id, event.response_id, event.last_submitted_time ORDER BY event.created_at, event.id
    ) AS copies FROM google_forms_processed_events event JOIN google_forms_watch_states_identity_merge m ON m.id = event.watch_state_id
    
  ) ranked WHERE copies > 1
) duplicate WHERE event.id = duplicate.id;
--> statement-breakpoint
UPDATE google_forms_automation_cursors event SET watch_state_id = m.canonical_id
FROM google_forms_watch_states_identity_merge m WHERE event.watch_state_id = m.id AND m.id <> m.canonical_id;
--> statement-breakpoint
UPDATE google_forms_processed_events event SET watch_state_id = m.canonical_id
FROM google_forms_watch_states_identity_merge m WHERE event.watch_state_id = m.id AND m.id <> m.canonical_id;
--> statement-breakpoint
DELETE FROM google_forms_watch_states watch USING google_forms_watch_states_identity_merge m
WHERE watch.id = m.id AND m.id <> m.canonical_id;
--> statement-breakpoint
UPDATE google_forms_watch_states watch SET connector_id = m.canonical_id
FROM connector_identity_merge m WHERE watch.connector_id = m.id AND m.id <> m.canonical_id;
--> statement-breakpoint
CREATE TEMP TABLE google_workspace_event_subscription_states_identity_merge ON COMMIT DROP AS
SELECT watch.id, first_value(watch.id) OVER (
  PARTITION BY m.canonical_id, watch.provider, watch.target_resource, watch.pubsub_topic, watch.event_types_key
  ORDER BY (watch.connector_id = m.canonical_id) DESC, watch.updated_at DESC, watch.id
) AS canonical_id
FROM google_workspace_event_subscription_states watch JOIN connector_identity_merge m ON m.id = watch.connector_id;
--> statement-breakpoint
-- Preserve the union of replay guards and the newest cached provider snapshot.
DELETE FROM google_workspace_processed_events event USING (
  SELECT id FROM (
    SELECT event.id, row_number() OVER (
      PARTITION BY m.canonical_id, event.automation_id, event.cloud_event_id ORDER BY event.created_at, event.id
    ) AS copies FROM google_workspace_processed_events event JOIN google_workspace_event_subscription_states_identity_merge m ON m.id = event.subscription_state_id
    
  ) ranked WHERE copies > 1
) duplicate WHERE event.id = duplicate.id;
--> statement-breakpoint
-- Preserve the union of replay guards and the newest cached provider snapshot.
DELETE FROM google_workspace_processed_events event USING (
  SELECT id FROM (
    SELECT event.id, row_number() OVER (
      PARTITION BY m.canonical_id, event.automation_id, event.transcript_name ORDER BY event.created_at, event.id
    ) AS copies FROM google_workspace_processed_events event JOIN google_workspace_event_subscription_states_identity_merge m ON m.id = event.subscription_state_id
    WHERE event.transcript_name IS NOT NULL
  ) ranked WHERE copies > 1
) duplicate WHERE event.id = duplicate.id;
--> statement-breakpoint
UPDATE google_workspace_processed_events event SET subscription_state_id = m.canonical_id
FROM google_workspace_event_subscription_states_identity_merge m WHERE event.subscription_state_id = m.id AND m.id <> m.canonical_id;
--> statement-breakpoint
DELETE FROM google_workspace_event_subscription_states watch USING google_workspace_event_subscription_states_identity_merge m
WHERE watch.id = m.id AND m.id <> m.canonical_id;
--> statement-breakpoint
UPDATE google_workspace_event_subscription_states watch SET connector_id = m.canonical_id
FROM connector_identity_merge m WHERE watch.connector_id = m.id AND m.id <> m.canonical_id;
--> statement-breakpoint
DELETE FROM connectors duplicate USING connector_identity_merge m
WHERE duplicate.id = m.id AND m.id <> m.canonical_id;
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_connectors_builtin_external_identity" ON "connectors" USING btree ("org_id","user_id","connector_slug","external_id","external_issuer") WHERE "connectors"."connector_slug" IS NOT NULL AND "connectors"."external_id" IS NOT NULL AND "connectors"."external_id" <> '';--> statement-breakpoint
CREATE UNIQUE INDEX "idx_connectors_custom_external_identity" ON "connectors" USING btree ("org_id","user_id","custom_connector_id","external_id","external_issuer") WHERE "connectors"."custom_connector_id" IS NOT NULL AND "connectors"."external_id" IS NOT NULL AND "connectors"."external_id" <> '';