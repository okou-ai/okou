-- Keep legacy Storage data intact; detach only prepared canonical Seed Skills.
UPDATE "skills"
SET "storage_id" = NULL, "s3_key" = NULL
WHERE "url" IN (
  'https://github.com/okou-ai/okou-skills/tree/main/gen',
  'https://github.com/okou-ai/okou-skills/tree/main/computer-use',
  'https://github.com/okou-ai/okou-skills/tree/main/workflow-setup'
)
  AND "content_bundle" IS NOT NULL
  AND "content_bundle_source_version_hash" = "version_hash"
  AND ("storage_id" IS NOT NULL OR "s3_key" IS NOT NULL);
