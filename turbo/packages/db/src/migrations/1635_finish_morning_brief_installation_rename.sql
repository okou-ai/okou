-- Preserve installed workflow and automation IDs when retiring the catalog publisher.
UPDATE "workflows"
SET "name" = 'morning-brief', "official_definition_name" = 'morning-brief', "updated_at" = now()
WHERE "official_definition_name" = 'internal-test-morning-brief';
