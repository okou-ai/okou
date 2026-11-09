-- Retained revision payloads own complete executable source, including files.
-- Bundle publication remains the admission boundary for current execution.
-- This contracts unused bindings only; historical Storage objects and captured
-- Run provenance are not rewritten or deleted.
DO $$
DECLARE
  before_fingerprint text;
  after_fingerprint text;
  revision_count bigint;
  unmaterialized_count bigint;
  invalid_source record;
BEGIN
  -- Version 1 is retained immutable source, including its original blueprint
  -- derivation/runtime metadata. Archival completeness is independent of the
  -- current execution format; rewriting the version would change its identity.
  SELECT definition_name, revision, failed_checks INTO invalid_source
  FROM (
    SELECT r.definition_name, r.revision, array_remove(ARRAY[
      CASE WHEN jsonb_typeof(r.payload) IS DISTINCT FROM 'object' THEN 'payload-not-object'::text END,
      CASE WHEN r.payload->'schemaVersion' IS NULL THEN 'schema-version-missing'::text END,
      CASE WHEN r.payload->'schemaVersion' NOT IN ('1'::jsonb, '2'::jsonb, '3'::jsonb) THEN 'unsupported-schema-version'::text END,
      CASE WHEN r.payload->>'name' IS DISTINCT FROM r.definition_name THEN 'name-mismatch'::text END,
      CASE WHEN r.payload->>'revision' IS DISTINCT FROM r.revision THEN 'revision-mismatch'::text END,
      CASE WHEN jsonb_typeof(r.payload->'workflow') IS DISTINCT FROM 'object' THEN 'workflow-not-object'::text END,
      CASE WHEN jsonb_typeof(r.payload->'workflow'->'displayName') IS DISTINCT FROM 'string' THEN 'display-name-not-string'::text END,
      CASE WHEN jsonb_typeof(r.payload->'workflow'->'description') IS DISTINCT FROM 'string' THEN 'description-not-string'::text END,
      CASE WHEN jsonb_typeof(r.payload->'workflow'->'instruction') IS DISTINCT FROM 'string' THEN 'instruction-not-string'::text END,
      CASE WHEN jsonb_typeof(r.payload->'workflow'->'files') IS DISTINCT FROM 'array' THEN 'files-not-array'::text END,
      CASE WHEN jsonb_typeof(r.payload->'blueprints') IS DISTINCT FROM 'array' THEN 'blueprints-not-array'::text END,
      CASE WHEN jsonb_path_exists(r.payload, '$.workflow.files[*] ? (
          @.type() != "object" || !exists(@.path) || @.path.type() != "string" ||
          !exists(@.content) || @.content.type() != "string"
        )') THEN 'invalid-file-entry'::text END
    ], NULL) AS failed_checks
    FROM official_workflow_definition_revisions r
  ) source_state
  WHERE cardinality(failed_checks) > 0
  ORDER BY definition_name, revision
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'C05: a retained Official revision lacks complete immutable source'
      USING DETAIL = jsonb_build_object(
        'definitionName', invalid_source.definition_name,
        'revision', invalid_source.revision,
        'failedChecks', invalid_source.failed_checks
      )::text;
  END IF;

  IF EXISTS (
    SELECT 1 FROM official_workflow_catalog_state s
    JOIN official_workflow_catalog_releases c ON c.id = s.accepted_release_id
    WHERE c.payload->'schemaVersion' IS DISTINCT FROM '4'::jsonb
      OR jsonb_typeof(c.payload->'definitions') IS DISTINCT FROM 'array'
  ) OR EXISTS (
    SELECT 1 FROM official_workflow_catalog_state s
    JOIN official_workflow_catalog_releases c ON c.id = s.accepted_release_id
    CROSS JOIN LATERAL jsonb_array_elements(c.payload->'definitions') d
    LEFT JOIN official_workflow_definition_revisions r
      ON r.definition_name = d->>'name' AND r.revision = d->>'revision'
    WHERE c.payload->'schemaVersion' IS DISTINCT FROM '4'::jsonb
      OR r.content_bundle IS NULL
      OR r.content_bundle IS DISTINCT FROM d->'contentBundle'
  ) THEN
    RAISE EXCEPTION 'C05: accepted Official catalog lacks matching revision bundles';
  END IF;

  -- The retained Workflow cleanup operator only accepts org-owned custom-skill
  -- roots. Its obsolete Official-binding guard can retire only when these sets
  -- are disjoint; no previously protected root may become a cleanup candidate.
  IF EXISTS (
    SELECT 1 FROM official_workflow_definition_revisions r
    JOIN storage_versions v ON v.id = r.storage_version
    JOIN storages s ON s.id = r.storage_id OR s.id = v.storage_id
    WHERE s.user_id = '__org__' AND starts_with(s.name, 'custom-skill@')
  ) THEN
    RAISE EXCEPTION 'C05: an Official binding protects a Workflow cleanup candidate';
  END IF;

  -- PostgreSQL can auto-drop owned objects (including expression indexes and
  -- column-specific triggers) even without CASCADE. Reject every unexpected
  -- column dependency before applying the generated contraction.
  IF EXISTS (
    SELECT 1 FROM pg_depend d
    JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
    LEFT JOIN pg_constraint c ON d.classid = 'pg_constraint'::regclass AND c.oid = d.objid
    WHERE d.refclassid = 'pg_class'::regclass
      AND d.refobjid = 'official_workflow_definition_revisions'::regclass
      AND a.attname IN ('storage_name', 'storage_id', 'storage_version')
      AND (c.oid IS NULL
        OR c.conrelid <> 'official_workflow_definition_revisions'::regclass
        OR c.conname NOT IN (
          'official_workflow_definition_revision_delivery_check',
          'official_workflow_definition_revisions_storage_id_storages_id_fk',
          'official_workflow_definition_revisions_storage_version_storage_versions_id_fk'
        ))
  ) THEN
    RAISE EXCEPTION 'C05: unexpected object depends on retired Official bindings';
  END IF;

  SELECT count(*), count(*) FILTER (WHERE content_bundle IS NULL),
    md5(COALESCE(jsonb_agg(to_jsonb(r) - 'storage_name' - 'storage_id' - 'storage_version'
      ORDER BY definition_name, revision)::text, '[]'))
  INTO revision_count, unmaterialized_count, before_fingerprint
  FROM official_workflow_definition_revisions r;

  ALTER TABLE "official_workflow_definition_revisions" DROP CONSTRAINT "official_workflow_definition_revision_delivery_check";
  ALTER TABLE "official_workflow_definition_revisions" DROP CONSTRAINT "official_workflow_definition_revisions_storage_id_storages_id_fk";
  ALTER TABLE "official_workflow_definition_revisions" DROP CONSTRAINT "official_workflow_definition_revisions_storage_version_storage_versions_id_fk";
  ALTER TABLE "official_workflow_definition_revisions" DROP COLUMN "storage_name";
  ALTER TABLE "official_workflow_definition_revisions" DROP COLUMN "storage_id";
  ALTER TABLE "official_workflow_definition_revisions" DROP COLUMN "storage_version";

  SELECT md5(COALESCE(jsonb_agg(to_jsonb(r) ORDER BY definition_name, revision)::text, '[]'))
  INTO after_fingerprint FROM official_workflow_definition_revisions r;
  IF before_fingerprint IS DISTINCT FROM after_fingerprint THEN
    RAISE EXCEPTION 'C05: retained Official revision content changed during contraction';
  END IF;
  RAISE NOTICE 'C05 official revisions preserved: rows=%, unmaterialized=%, fingerprint=%',
    revision_count, unmaterialized_count, after_fingerprint;
END $$;
