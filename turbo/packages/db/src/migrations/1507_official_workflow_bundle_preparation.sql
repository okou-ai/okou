-- okou:non-transactional
-- Reader preparation only. Legacy writers remain valid; no catalog or provenance is converted.
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '60s';
--> statement-breakpoint
DO $$ BEGIN
  PERFORM set_config('lock_timeout', '1s', true);
  ALTER TABLE "official_workflow_definition_revisions" ALTER COLUMN "storage_name" DROP NOT NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  PERFORM set_config('lock_timeout', '1s', true);
  ALTER TABLE "official_workflow_definition_revisions" ALTER COLUMN "storage_id" DROP NOT NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  PERFORM set_config('lock_timeout', '1s', true);
  ALTER TABLE "official_workflow_definition_revisions" ALTER COLUMN "storage_version" DROP NOT NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  PERFORM set_config('lock_timeout', '1s', true);
  ALTER TABLE "official_workflow_definition_revisions" ADD COLUMN IF NOT EXISTS "content_bundle" jsonb;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  PERFORM set_config('lock_timeout', '1s', true);
  ALTER TABLE "agent_runs" DROP CONSTRAINT IF EXISTS "agent_runs_official_workflow_provenance_check";
  ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_official_workflow_provenance_check" CHECK ((
          "agent_runs"."official_workflow_provenance" IS NULL OR (
            jsonb_typeof("agent_runs"."official_workflow_provenance") = 'object'
            AND "agent_runs"."official_workflow_provenance" ?& ARRAY['schemaVersion', 'definitions']
            AND ("agent_runs"."official_workflow_provenance" - 'schemaVersion' - 'definitions') = '{}'::jsonb
            AND "agent_runs"."official_workflow_provenance"->'schemaVersion' = '2'::jsonb
            AND jsonb_typeof("agent_runs"."official_workflow_provenance"->'definitions') = 'array'
            AND jsonb_array_length("agent_runs"."official_workflow_provenance"->'definitions') > 0
            AND NOT jsonb_path_exists("agent_runs"."official_workflow_provenance", '$.definitions[*] ? (
              @.type() != "object" || !exists(@.name) || @.name.type() != "string" ||
              !(@.name like_regex "^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$") ||
              !exists(@.revision) || @.revision.type() != "string" || !(@.revision like_regex "^[0-9a-f]{64}$") ||
              exists(@.keyvalue() ? (@.key != "name" && @.key != "revision" && @.key != "contentBundle")) ||
              !exists(@.contentBundle) || @.contentBundle.type() != "object" ||
              !exists(@.contentBundle.sha256) || @.contentBundle.sha256.type() != "string" ||
              !(@.contentBundle.sha256 like_regex "^[0-9a-f]{64}$") ||
              !exists(@.contentBundle.archiveBytes) || @.contentBundle.archiveBytes.type() != "number" ||
              @.contentBundle.archiveBytes < 1 || @.contentBundle.archiveBytes > 33554432 ||
              @.contentBundle.archiveBytes.floor() != @.contentBundle.archiveBytes ||
              exists(@.contentBundle.keyvalue() ? (@.key != "sha256" && @.key != "archiveBytes"))
            )')
          ) OR (
            jsonb_typeof("agent_runs"."official_workflow_provenance") = 'object' AND
            "agent_runs"."official_workflow_provenance" ?& ARRAY[
              'schemaVersion',
              'definitions'
            ] AND
            (
              "agent_runs"."official_workflow_provenance" -
              'schemaVersion' -
              'definitions'
            ) = '{}'::jsonb AND
            "agent_runs"."official_workflow_provenance" -> 'schemaVersion' = '1'::jsonb AND
            jsonb_typeof(
              "agent_runs"."official_workflow_provenance" -> 'definitions'
            ) = 'array' AND
            jsonb_array_length(
              "agent_runs"."official_workflow_provenance" -> 'definitions'
            ) > 0 AND
            NOT jsonb_path_exists(
              "agent_runs"."official_workflow_provenance",
              '$.definitions[*] ? (
                @.type() != "object" ||
                !exists(@.name) ||
                @.name.type() != "string" ||
                !(@.name like_regex "^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$") ||
                !exists(@.revision) ||
                @.revision.type() != "string" ||
                !(@.revision like_regex "^[0-9a-f]{64}$") ||
                !exists(@.artifact) ||
                @.artifact.type() != "object" ||
                exists(
                  @.keyvalue() ? (
                    @.key != "name" &&
                    @.key != "revision" &&
                    @.key != "artifact"
                  )
                ) ||
                !exists(@.artifact.orgId) ||
                @.artifact.orgId != "__system__" ||
                !exists(@.artifact.userId) ||
                @.artifact.userId != "__org__" ||
                !exists(@.artifact.storageName) ||
                @.artifact.storageName.type() != "string" ||
                !(@.artifact.storageName like_regex "^.{1,255}.?$") ||
                !exists(@.artifact.storageId) ||
                @.artifact.storageId.type() != "string" ||
                !(@.artifact.storageId like_regex "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$") ||
                !exists(@.artifact.storageVersion) ||
                @.artifact.storageVersion.type() != "string" ||
                !(@.artifact.storageVersion like_regex "^[0-9a-f]{64}$") ||
                exists(
                  @.artifact.keyvalue() ? (
                    @.key != "orgId" &&
                    @.key != "userId" &&
                    @.key != "storageName" &&
                    @.key != "storageId" &&
                    @.key != "storageVersion"
                  )
                )
              )'
            )
          )
        )) NOT VALID;
END $$;
--> statement-breakpoint
ALTER TABLE "agent_runs" VALIDATE CONSTRAINT "agent_runs_official_workflow_provenance_check";
--> statement-breakpoint
DO $$ BEGIN
  PERFORM set_config('lock_timeout', '1s', true);
  ALTER TABLE "official_workflow_definition_revisions" DROP CONSTRAINT IF EXISTS "official_workflow_definition_revision_delivery_check";
  ALTER TABLE "official_workflow_definition_revisions" ADD CONSTRAINT "official_workflow_definition_revision_delivery_check" CHECK ((
          ("official_workflow_definition_revisions"."storage_name" IS NOT NULL AND "official_workflow_definition_revisions"."storage_id" IS NOT NULL AND "official_workflow_definition_revisions"."storage_version" IS NOT NULL)
          OR ("official_workflow_definition_revisions"."storage_name" IS NULL AND "official_workflow_definition_revisions"."storage_id" IS NULL AND "official_workflow_definition_revisions"."storage_version" IS NULL AND "official_workflow_definition_revisions"."content_bundle" IS NOT NULL)
        )) NOT VALID;
END $$;
--> statement-breakpoint
ALTER TABLE "official_workflow_definition_revisions" VALIDATE CONSTRAINT "official_workflow_definition_revision_delivery_check";
--> statement-breakpoint
DO $$ BEGIN
  PERFORM set_config('lock_timeout', '1s', true);
  ALTER TABLE "official_workflow_definition_revisions" DROP CONSTRAINT IF EXISTS "official_workflow_definition_revision_bundle_check";
  ALTER TABLE "official_workflow_definition_revisions" ADD CONSTRAINT "official_workflow_definition_revision_bundle_check" CHECK ("official_workflow_definition_revisions"."content_bundle" IS NULL OR (
          jsonb_typeof("official_workflow_definition_revisions"."content_bundle") = 'object'
          AND "official_workflow_definition_revisions"."content_bundle" ?& ARRAY['sha256', 'archiveBytes']
          AND ("official_workflow_definition_revisions"."content_bundle" - 'sha256' - 'archiveBytes') = '{}'::jsonb
          AND jsonb_typeof("official_workflow_definition_revisions"."content_bundle"->'sha256') = 'string'
          AND "official_workflow_definition_revisions"."content_bundle"->>'sha256' ~ '^[0-9a-f]{64}$'
          AND jsonb_typeof("official_workflow_definition_revisions"."content_bundle"->'archiveBytes') = 'number'
          AND ("official_workflow_definition_revisions"."content_bundle"->>'archiveBytes')::numeric BETWEEN 1 AND 33554432
          AND trunc(("official_workflow_definition_revisions"."content_bundle"->>'archiveBytes')::numeric) = ("official_workflow_definition_revisions"."content_bundle"->>'archiveBytes')::numeric
        )) NOT VALID;
END $$;
--> statement-breakpoint
ALTER TABLE "official_workflow_definition_revisions" VALIDATE CONSTRAINT "official_workflow_definition_revision_bundle_check";
--> statement-breakpoint
RESET lock_timeout;
--> statement-breakpoint
RESET statement_timeout;
