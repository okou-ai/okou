-- Production first prepares snapshots while the outgoing API can still read the catalog.
-- The release runs this transaction again after traffic cutover and request drain.
DO $column$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute WHERE attrelid = 'workflows'::regclass
      AND attname = 'archived_official_snapshot' AND NOT attisdropped
  ) THEN
    ALTER TABLE workflows ADD COLUMN IF NOT EXISTS archived_official_snapshot jsonb;
  END IF;
END
$column$;
--> statement-breakpoint
DO $archive$
BEGIN
  IF to_regclass('official_workflow_catalog_state') IS NOT NULL THEN
    -- Freeze the last accepted source while copying. A concurrent publisher cannot
    -- change the accepted revision between our backfill and the contraction.
    LOCK TABLE official_workflow_catalog_state, official_workflow_catalog_releases,
      official_workflow_definition_revisions IN SHARE MODE;

    WITH accepted AS (
      SELECT entry->>'name' AS name, entry->>'revision' AS revision, entry->>'lifecycle' AS lifecycle
      FROM official_workflow_catalog_state state
      JOIN official_workflow_catalog_releases release ON release.id = state.accepted_release_id
      CROSS JOIN LATERAL jsonb_array_elements(release.payload->'definitions') entry
      WHERE state.authority = 'official' AND release.payload->>'schemaVersion' = '4'
    ), snapshots AS (
      SELECT a.name, jsonb_build_object('lifecycle', a.lifecycle,
        'revision', jsonb_build_object('definition', r.payload, 'contentBundle', r.content_bundle)) AS snapshot
      FROM accepted a
      JOIN official_workflow_definition_revisions r
        ON r.definition_name = a.name AND r.revision = a.revision
      WHERE r.payload->>'name' = a.name AND r.payload->>'revision' = a.revision
        AND r.payload->>'schemaVersion' IN ('2', '3')
        AND jsonb_typeof(r.payload#>'{workflow,displayName}') = 'string'
        AND jsonb_typeof(r.payload#>'{workflow,description}') = 'string'
        AND jsonb_typeof(r.payload#>'{workflow,instruction}') = 'string'
        AND jsonb_typeof(r.payload#>'{workflow,files}') = 'array'
        AND NOT jsonb_path_exists(r.payload, '$.workflow.files[*] ? (
          @.type() != "object" || !exists(@.path) || @.path.type() != "string" ||
          !exists(@.content) || @.content.type() != "string")')
        AND jsonb_typeof(r.payload->'blueprints') = 'array'
        AND jsonb_typeof(r.content_bundle) = 'object' AND a.lifecycle IN ('active', 'retired')
    )
    UPDATE workflows w SET archived_official_snapshot = s.snapshot
    FROM snapshots s WHERE w.official_definition_name = s.name
      AND w.official_definition_name NOT IN ('morning-brief', 'internal-test-morning-brief', 'agent-suggestions', 'proactive-learning')
      AND w.archived_official_snapshot IS DISTINCT FROM s.snapshot;
  END IF;

  IF EXISTS (
    SELECT 1 FROM workflows WHERE official_installation_state = 'installed'
      AND official_definition_name NOT IN ('morning-brief', 'internal-test-morning-brief', 'agent-suggestions', 'proactive-learning')
      AND archived_official_snapshot IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot retire catalog: an installed historical Official Workflow has no readable snapshot';
  END IF;
END
$archive$;
--> statement-breakpoint
-- okou:after-api-promotion
DROP TABLE IF EXISTS official_workflow_reconciliation_work, official_workflow_catalog_state,
  official_workflow_catalog_releases, official_workflow_definition_revisions;
