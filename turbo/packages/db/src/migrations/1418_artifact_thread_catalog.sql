-- okou:non-transactional
-- Expand before API promotion: outgoing writers may omit every new field.
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '10s';
--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "chat_thread_id" uuid;
--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "display_kind" varchar(32);
--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "source_url" text;
--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "alias_url" text;
--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "video_source_url" text;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.artifacts'::regclass
      AND conname = 'artifacts_chat_thread_id_chat_threads_id_fk'
  ) THEN
    ALTER TABLE "artifacts"
      ADD CONSTRAINT "artifacts_chat_thread_id_chat_threads_id_fk"
      FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id")
      ON DELETE SET NULL ON UPDATE NO ACTION NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
-- The projection is evidence of origin only at this migration boundary.
-- Ambiguous Run ownership is left unknown; control.interrupt targets a Run
-- but does not own it. Shared snapshots never borrow a projection file.
-- Each selected UUID advances the cursor even when no origin can be proven.
-- okou:batch-by-uuid
WITH batch AS MATERIALIZED (
  SELECT id, kind, logical_key, entity_id, projection_file_id,
    projection_created_at, title
  FROM artifacts
  WHERE ($1::uuid IS NULL OR id > $1::uuid)
    AND display_kind IS NULL
  ORDER BY id LIMIT 1000
), projection AS MATERIALIZED (
  SELECT batch.*,
    CASE
      WHEN batch.kind = 'file' AND batch.logical_key LIKE 'shared-thread:%'
        THEN 'shared-thread'
      WHEN file.metadata ->> 'generatedBy' = 'zero-joggai-avatar-video'
        THEN 'avatar'
      ELSE batch.kind
    END AS catalog_kind,
    CASE
      WHEN batch.kind = 'file' AND batch.logical_key LIKE 'shared-thread:%'
        THEN shared.source_chat_thread_id
      ELSE COALESCE(file.chat_thread_id, owning_event.chat_thread_id)
    END AS origin_thread_id,
    file.url AS file_url,
    CASE
      WHEN jsonb_typeof(file.metadata -> 'aliasUrl') = 'string'
        AND file.metadata ->> 'aliasUrl' <> ''
      THEN file.metadata ->> 'aliasUrl'
      ELSE NULL
    END AS alias_url,
    CASE WHEN file.url <> '' AND (
      file.content_type LIKE 'video/%'
      OR (file.content_type IS NULL
        AND lower(reverse(split_part(reverse(batch.title), '.', 1)))
          IN ('mp4', 'webm', 'mov'))
    ) THEN file.url ELSE NULL END AS video_url
  FROM batch
  LEFT JOIN run_uploaded_files file
    ON file.id = batch.projection_file_id
    AND NOT (batch.kind = 'file' AND batch.logical_key LIKE 'shared-thread:%')
  LEFT JOIN shared_threads shared
    ON shared.id = batch.entity_id
    AND batch.kind = 'file' AND batch.logical_key LIKE 'shared-thread:%'
  LEFT JOIN LATERAL (
    SELECT min(event.chat_thread_id::text)::uuid AS chat_thread_id
    FROM chat_events event
    WHERE event.run_id = file.run_id
      AND event.event_type <> 'control.interrupt'
    HAVING count(DISTINCT event.chat_thread_id) = 1
  ) owning_event ON file.chat_thread_id IS NULL
), updated AS (
  UPDATE artifacts target
  SET chat_thread_id = COALESCE(target.chat_thread_id, projection.origin_thread_id),
    display_kind = projection.catalog_kind,
    source_url = projection.file_url,
    alias_url = COALESCE(target.alias_url, projection.alias_url),
    video_source_url = projection.video_url
  FROM projection
  WHERE target.id = projection.id
    AND target.display_kind IS NULL
    AND target.projection_file_id IS NOT DISTINCT FROM projection.projection_file_id
    AND target.projection_created_at = projection.projection_created_at
  RETURNING target.id
)
SELECT (SELECT id FROM batch ORDER BY id DESC LIMIT 1) AS next_cursor;
--> statement-breakpoint
SET statement_timeout = '10min';
--> statement-breakpoint
ALTER TABLE "artifacts" VALIDATE CONSTRAINT "artifacts_chat_thread_id_chat_threads_id_fk";
--> statement-breakpoint
-- Recover even when an interrupted concurrent build left an invalid index.
DROP INDEX CONCURRENTLY IF EXISTS "artifacts_thread_author_created_idx";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "artifacts_thread_author_created_idx" ON "artifacts" USING btree ("chat_thread_id","org_id","author_user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "artifacts"."chat_thread_id" IS NOT NULL;
--> statement-breakpoint
RESET statement_timeout;
--> statement-breakpoint
RESET lock_timeout;
