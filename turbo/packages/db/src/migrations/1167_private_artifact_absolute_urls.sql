-- `privateArtifacts` was still staff-only when hostless owner references were
-- emitted. Canonicalize those production rows to the production App origin so
-- persisted artifact records and the complete URLs printed by the CLI share
-- one identity. Public CDN and external URLs do not match these predicates.
UPDATE "run_uploaded_files"
SET
  "url" = CASE
    WHEN "url" LIKE '/artifacts/%' THEN 'https://app.okou.ai' || "url"
    ELSE "url"
  END,
  "preview_image_url" = CASE
    WHEN "preview_image_url" LIKE '/artifacts/%' THEN 'https://app.okou.ai' || "preview_image_url"
    ELSE "preview_image_url"
  END,
  "updated_at" = now()
WHERE "url" LIKE '/artifacts/%'
   OR "preview_image_url" LIKE '/artifacts/%';
--> statement-breakpoint
UPDATE "private_hosted_deployments"
SET
  "artifact_url" = CASE
    WHEN "artifact_url" LIKE '/artifacts/%' THEN 'https://app.okou.ai' || "artifact_url"
    ELSE "artifact_url"
  END,
  "url" = CASE
    WHEN "url" LIKE '/artifacts/%' THEN 'https://app.okou.ai' || "url"
    ELSE "url"
  END,
  "updated_at" = now()
WHERE "artifact_url" LIKE '/artifacts/%'
   OR "url" LIKE '/artifacts/%';
--> statement-breakpoint
-- Retained deployments can contain staff-created private rows from before the
-- dedicated private table was introduced.
UPDATE "hosted_deployments"
SET
  "artifact_url" = CASE
    WHEN "artifact_url" LIKE '/artifacts/%' THEN 'https://app.okou.ai' || "artifact_url"
    ELSE "artifact_url"
  END,
  "url" = CASE
    WHEN "url" LIKE '/artifacts/%' THEN 'https://app.okou.ai' || "url"
    ELSE "url"
  END,
  "updated_at" = now()
WHERE "artifact_url" LIKE '/artifacts/%'
   OR "url" LIKE '/artifacts/%';
--> statement-breakpoint
UPDATE "artifacts"
SET
  "logical_key" = CASE
    WHEN "logical_key" LIKE 'file:/artifacts/%'
      THEN 'file:https://app.okou.ai' || substring("logical_key" FROM length('file:') + 1)
    ELSE "logical_key"
  END,
  "thumbnail" = CASE
    WHEN "thumbnail"->>'url' LIKE '/artifacts/%'
      THEN jsonb_set(
        "thumbnail",
        '{url}',
        to_jsonb('https://app.okou.ai'::text || ("thumbnail"->>'url')),
        false
      )
    ELSE "thumbnail"
  END,
  "updated_at" = now()
WHERE "logical_key" LIKE 'file:/artifacts/%'
   OR "thumbnail"->>'url' LIKE '/artifacts/%';
--> statement-breakpoint
UPDATE "built_in_generation_jobs"
SET
  "result" = jsonb_set(
    "result",
    '{url}',
    to_jsonb('https://app.okou.ai'::text || ("result"->>'url')),
    false
  ),
  "updated_at" = now()
WHERE "result"->>'url' LIKE '/artifacts/%';
--> statement-breakpoint
UPDATE "socialkit_download_jobs"
SET
  "artifact" = jsonb_set(
    "artifact",
    '{url}',
    to_jsonb('https://app.okou.ai'::text || ("artifact"->>'url')),
    false
  ),
  "updated_at" = now()
WHERE "artifact"->>'url' LIKE '/artifacts/%';
--> statement-breakpoint
UPDATE "user_artifact_favorites"
SET "artifact_url" = 'https://app.okou.ai' || "artifact_url"
WHERE "artifact_url" LIKE '/artifacts/%';
--> statement-breakpoint
UPDATE "image_artifact_edit_snapshots"
SET "artifact_url" = 'https://app.okou.ai' || "artifact_url"
WHERE "artifact_url" LIKE '/artifacts/%';
--> statement-breakpoint
UPDATE "image_artifact_edit_snapshots"
SET
  "snapshot" = jsonb_set(
    "snapshot",
    '{items}',
    (
      SELECT jsonb_agg(
        CASE
          WHEN "item"->>'url' LIKE '/artifacts/%'
            THEN jsonb_set(
              "item",
              '{url}',
              to_jsonb('https://app.okou.ai'::text || ("item"->>'url'))
            )
          ELSE "item"
        END
        ORDER BY "ordinality"
      )
      FROM jsonb_array_elements("snapshot"->'items')
        WITH ORDINALITY AS "elements"("item", "ordinality")
    ),
    false
  )
WHERE jsonb_typeof("snapshot"->'items') = 'array'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements("snapshot"->'items') AS "elements"("item")
    WHERE "item"->>'url' LIKE '/artifacts/%'
  );
