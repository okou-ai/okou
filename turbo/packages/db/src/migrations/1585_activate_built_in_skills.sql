-- Freeze both catalogs while validating parity and changing the read authority.
LOCK TABLE "skills", "built_in_skills" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  legacy_count integer;
  new_count integer;
  matching_count integer;
  sync_commits integer;
BEGIN
  WITH expected(url) AS (
    VALUES
      ('https://github.com/okou-ai/okou-skills/tree/main/computer-use'),
      ('https://github.com/okou-ai/okou-skills/tree/main/gen'),
      ('https://github.com/okou-ai/okou-skills/tree/main/workflow-setup')
  )
  SELECT count(legacy.url), (SELECT count(*) FROM built_in_skills),
    count(*) FILTER (WHERE legacy.url IS NOT NULL
      AND replacement.version_hash = legacy.version_hash
      AND replacement.content_bundle = legacy.content_bundle
      AND replacement.content_bundle_source_version_hash = legacy.content_bundle_source_version_hash
      AND replacement.commit_sha = legacy.commit_sha
      AND NOT replacement.authoritative),
    count(DISTINCT replacement.commit_sha)
  INTO legacy_count, new_count, matching_count, sync_commits
  FROM expected
  LEFT JOIN skills legacy USING (url)
  LEFT JOIN built_in_skills replacement USING (url);

  -- Empty databases initialize through the normal built-in Skill publisher.
  IF (legacy_count <> 0 OR new_count <> 0)
    AND (legacy_count <> 3 OR new_count <> 3 OR matching_count <> 3 OR sync_commits <> 1) THEN
    RAISE EXCEPTION 'Built-in Skill catalog parity check failed before activation';
  END IF;
END $$;
--> statement-breakpoint
UPDATE "built_in_skills" SET "authoritative" = true;
--> statement-breakpoint
ALTER TABLE "built_in_skills" ALTER COLUMN "authoritative" SET DEFAULT true;
