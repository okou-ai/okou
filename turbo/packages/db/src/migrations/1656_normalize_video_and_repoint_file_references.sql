-- okou:non-transactional
-- Release 2 pre-FK data normalization:
-- 1. Backfill any missing real files referenced by image_artifacts / file artifacts / video_artifacts
--    into `files` and repoint shadow `run_uploaded_files` pointers to canonical `files.id`.
-- 2. Normalize historical `artifacts.kind = 'video'` (and `display_kind = 'video'`) to `kind = 'file'`
--    while preserving `category = 'video'` (or `'other'` for avatars) and `display_kind = 'avatar'`.
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '30s';
--> statement-breakpoint
-- 1a. Ensure every canonical file referenced by image_artifacts exists in `files`.
-- okou:batch-by-uuid
WITH batch AS MATERIALIZED (
	SELECT ia."id", ia."file_id", ia."generation_job_id"
	FROM "image_artifacts" ia
	WHERE ($1::uuid IS NULL OR ia."id" > $1::uuid)
		AND NOT EXISTS (
			SELECT 1
			FROM "files" f
			WHERE f."id" = ia."file_id"
		)
	ORDER BY ia."id"
	LIMIT 1000
),
resolved AS (
	SELECT DISTINCT ON (COALESCE(real_ruf."id", ruf."id"))
		COALESCE(real_ruf."id", ruf."id") AS "id",
		COALESCE(
			NULLIF(real_ruf."org_id", ''),
			NULLIF(ruf."org_id", ''),
			NULLIF(ct."org_id", ''),
			NULLIF(ar."org_id", ''),
			NULLIF(job."org_id", ''),
			NULLIF(art."org_id", '')
		) AS "org_id",
		COALESCE(real_ruf."user_id", ruf."user_id") AS "owner_user_id",
		COALESCE(
			NULLIF(real_ruf."storage_key", ''),
			NULLIF(ruf."storage_key", ''),
			NULLIF(real_ruf."metadata"->>'s3Key', ''),
			NULLIF(ruf."metadata"->>'s3Key', '')
		) AS "storage_key",
		COALESCE(real_ruf."filename", ruf."filename") AS "filename",
		COALESCE(real_ruf."content_type", ruf."content_type") AS "content_type",
		COALESCE(real_ruf."size_bytes", ruf."size_bytes") AS "size_bytes",
		COALESCE(real_ruf."checksum_sha256", ruf."checksum_sha256") AS "checksum_sha256",
		COALESCE(real_ruf."created_at", ruf."created_at") AS "created_at",
		COALESCE(real_ruf."deleted_at", ruf."deleted_at") AS "deleted_at"
	FROM batch ia
	INNER JOIN "run_uploaded_files" ruf ON ruf."id" = ia."file_id"
	LEFT JOIN "run_uploaded_files" real_ruf
		ON NULLIF(ruf."storage_key", '') IS NULL
		AND ruf."external_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		AND real_ruf."id" = ruf."external_id"::uuid
		AND real_ruf."id" <> ruf."id"
		AND NULLIF(real_ruf."storage_key", '') IS NOT NULL
	LEFT JOIN "chat_threads" ct ON ct."id" = COALESCE(real_ruf."chat_thread_id", ruf."chat_thread_id")
	LEFT JOIN "agent_runs" ar ON ar."id" = COALESCE(real_ruf."run_id", ruf."run_id")
	LEFT JOIN "built_in_generation_jobs" job ON job."id" = ia."generation_job_id"
	LEFT JOIN LATERAL (
		SELECT a."org_id"
		FROM "artifacts" a
		WHERE a."kind" = 'image'
			AND a."entity_id" = ia."id"
		LIMIT 1
	) art ON true
	ORDER BY COALESCE(real_ruf."id", ruf."id"), ia."id"
),
inserted AS (
	INSERT INTO "files" (
		"id",
		"org_id",
		"owner_user_id",
		"storage_key",
		"filename",
		"content_type",
		"size_bytes",
		"checksum_sha256",
		"origin",
		"created_at",
		"deleted_at"
	)
	SELECT
		resolved."id",
		resolved."org_id",
		resolved."owner_user_id",
		resolved."storage_key",
		resolved."filename",
		resolved."content_type",
		resolved."size_bytes",
		resolved."checksum_sha256",
		'agent',
		resolved."created_at",
		resolved."deleted_at"
	FROM resolved
	WHERE resolved."org_id" IS NOT NULL
	ON CONFLICT ("id") DO NOTHING
	RETURNING "id"
)
SELECT (SELECT "id" FROM batch ORDER BY "id" DESC LIMIT 1) AS next_cursor;
--> statement-breakpoint
-- 1b. Repoint shadow image_artifacts rows onto their canonical files.id, merging duplicates safely.
-- okou:batch-by-uuid
WITH batch AS MATERIALIZED (
	SELECT
		ia."id",
		ia."file_id" AS "shadow_file_id",
		real_f."id" AS "target_file_id"
	FROM "image_artifacts" ia
	INNER JOIN "run_uploaded_files" ruf
		ON ruf."id" = ia."file_id"
		AND NULLIF(ruf."storage_key", '') IS NULL
		AND ruf."external_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		AND ruf."external_id"::uuid <> ia."file_id"
	INNER JOIN "files" real_f ON real_f."id" = ruf."external_id"::uuid
	WHERE ($1::uuid IS NULL OR ia."id" > $1::uuid)
	ORDER BY ia."id"
	LIMIT 1000
),
classified AS (
	SELECT
		b."id",
		b."shadow_file_id",
		b."target_file_id",
		existing_ia."id" AS "existing_ia_id",
		COALESCE(
			existing_ia."id",
			FIRST_VALUE(b."id") OVER (PARTITION BY b."target_file_id" ORDER BY b."id")
		) AS "survivor_ia_id",
		ROW_NUMBER() OVER (PARTITION BY b."target_file_id" ORDER BY b."id") AS "rn"
	FROM batch b
	LEFT JOIN "image_artifacts" existing_ia ON existing_ia."file_id" = b."target_file_id"
),
repointed_ia AS (
	UPDATE "image_artifacts" ia
	SET "file_id" = c."target_file_id",
		"updated_at" = now()
	FROM classified c
	WHERE ia."id" = c."id"
		AND c."existing_ia_id" IS NULL
		AND c."rn" = 1
	RETURNING ia."id", c."target_file_id", c."shadow_file_id"
),
updated_winner_artifacts AS (
	UPDATE "artifacts" a
	SET "projection_file_id" = r."target_file_id",
		"updated_at" = now()
	FROM repointed_ia r
	WHERE a."kind" = 'image'
		AND a."entity_id" = r."id"
		AND a."projection_file_id" = r."shadow_file_id"
	RETURNING a."id"
),
dup_rows AS (
	SELECT
		c."id" AS "dup_ia_id",
		c."survivor_ia_id",
		c."target_file_id",
		dup_art."id" AS "dup_art_id",
		dup_art."visibility" AS "dup_visibility",
		surv_art."id" AS "surv_art_id",
		ROW_NUMBER() OVER (PARTITION BY c."survivor_ia_id" ORDER BY dup_art."deleted_at" NULLS FIRST, c."id") AS "art_rn"
	FROM classified c
	LEFT JOIN "artifacts" dup_art
		ON dup_art."kind" = 'image'
		AND dup_art."entity_id" = c."id"
	LEFT JOIN "artifacts" surv_art
		ON surv_art."kind" = 'image'
		AND surv_art."entity_id" = c."survivor_ia_id"
	WHERE c."existing_ia_id" IS NOT NULL OR c."rn" > 1
),
repointed_dup_art AS (
	UPDATE "artifacts" a
	SET "entity_id" = d."survivor_ia_id",
		"projection_file_id" = d."target_file_id",
		"updated_at" = now()
	FROM dup_rows d
	WHERE a."id" = d."dup_art_id"
		AND d."surv_art_id" IS NULL
		AND d."art_rn" = 1
	RETURNING a."id"
),
merged_dup_shares AS (
	INSERT INTO "artifact_user_shares" ("user_id", "org_id", "artifact_id", "email", "created_at")
	SELECT s."user_id", s."org_id", d."surv_art_id", s."email", s."created_at"
	FROM dup_rows d
	INNER JOIN "artifact_user_shares" s ON s."artifact_id" = d."dup_art_id"
	WHERE d."surv_art_id" IS NOT NULL
	ON CONFLICT ("user_id", "org_id", "artifact_id") DO NOTHING
	RETURNING "artifact_id"
),
merged_dup_favorites AS (
	INSERT INTO "artifact_favorites" ("org_id", "user_id", "artifact_id", "created_at")
	SELECT fav."org_id", fav."user_id", d."surv_art_id", fav."created_at"
	FROM dup_rows d
	INNER JOIN "artifact_favorites" fav ON fav."artifact_id" = d."dup_art_id"
	WHERE d."surv_art_id" IS NOT NULL
	ON CONFLICT ("org_id", "user_id", "artifact_id") DO NOTHING
	RETURNING "artifact_id"
),
deleted_dup_favorites AS (
	DELETE FROM "artifact_favorites" fav
	USING dup_rows d
	WHERE fav."artifact_id" = d."dup_art_id"
		AND (d."surv_art_id" IS NOT NULL OR d."art_rn" > 1)
	RETURNING fav."artifact_id"
),
merged_dup_visibility AS (
	UPDATE "artifacts" surv
	SET "visibility" = CASE
			WHEN surv."visibility" = 'public' OR agg."max_rank" = 2 THEN 'public'
			WHEN surv."visibility" = 'organization' OR agg."max_rank" = 1 THEN 'organization'
			ELSE surv."visibility"
		END,
		"updated_at" = now()
	FROM (
		SELECT
			d."surv_art_id",
			MAX(
				CASE
					WHEN d."dup_visibility" = 'public' THEN 2
					WHEN d."dup_visibility" = 'organization' THEN 1
					ELSE 0
				END
			) AS "max_rank"
		FROM dup_rows d
		WHERE d."surv_art_id" IS NOT NULL
			AND d."dup_art_id" IS NOT NULL
		GROUP BY d."surv_art_id"
	) agg
	WHERE surv."id" = agg."surv_art_id"
		AND agg."max_rank" > CASE
			WHEN surv."visibility" = 'public' THEN 2
			WHEN surv."visibility" = 'organization' THEN 1
			ELSE 0
		END
	RETURNING surv."id"
),
deleted_dup_artifacts AS (
	DELETE FROM "artifacts" a
	USING dup_rows d
	WHERE a."id" = d."dup_art_id"
		AND (d."surv_art_id" IS NOT NULL OR d."art_rn" > 1)
	RETURNING a."id"
),
deleted_dup_ia AS (
	DELETE FROM "image_artifacts" ia
	USING dup_rows d
	WHERE ia."id" = d."dup_ia_id"
	RETURNING ia."id"
)
SELECT (SELECT "id" FROM batch ORDER BY "id" DESC LIMIT 1) AS next_cursor;
--> statement-breakpoint
-- 2a. Backfill any missing real files referenced by artifacts(kind = 'file').
-- okou:batch-by-uuid
WITH batch AS MATERIALIZED (
	SELECT a."id", a."org_id", a."entity_id"
	FROM "artifacts" a
	WHERE ($1::uuid IS NULL OR a."id" > $1::uuid)
		AND a."kind" = 'file'
		AND a."logical_key" NOT LIKE 'shared-thread:%'
		AND NOT EXISTS (
			SELECT 1
			FROM "files" f
			WHERE f."id" = a."entity_id"
		)
	ORDER BY a."id"
	LIMIT 1000
),
resolved AS (
	SELECT DISTINCT ON (COALESCE(real_ruf."id", ruf."id"))
		COALESCE(real_ruf."id", ruf."id") AS "id",
		COALESCE(
			NULLIF(real_ruf."org_id", ''),
			NULLIF(ruf."org_id", ''),
			NULLIF(b."org_id", '')
		) AS "org_id",
		COALESCE(real_ruf."user_id", ruf."user_id") AS "owner_user_id",
		COALESCE(
			NULLIF(real_ruf."storage_key", ''),
			NULLIF(ruf."storage_key", ''),
			NULLIF(real_ruf."metadata"->>'s3Key', ''),
			NULLIF(ruf."metadata"->>'s3Key', '')
		) AS "storage_key",
		COALESCE(real_ruf."filename", ruf."filename") AS "filename",
		COALESCE(real_ruf."content_type", ruf."content_type") AS "content_type",
		COALESCE(real_ruf."size_bytes", ruf."size_bytes") AS "size_bytes",
		COALESCE(real_ruf."checksum_sha256", ruf."checksum_sha256") AS "checksum_sha256",
		CASE
			WHEN COALESCE(real_ruf."classification", ruf."classification") = 'input' THEN 'user'
			ELSE 'agent'
		END AS "origin",
		COALESCE(real_ruf."created_at", ruf."created_at") AS "created_at",
		COALESCE(real_ruf."deleted_at", ruf."deleted_at") AS "deleted_at"
	FROM batch b
	INNER JOIN "run_uploaded_files" ruf
		ON ruf."id" = b."entity_id"
		AND NOT (ruf."metadata" ? 'siteId')
		AND COALESCE(ruf."metadata"->>'generatedBy', '') <> 'zero-official-website'
	LEFT JOIN "run_uploaded_files" real_ruf
		ON NULLIF(ruf."storage_key", '') IS NULL
		AND ruf."external_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		AND real_ruf."id" = ruf."external_id"::uuid
		AND real_ruf."id" <> ruf."id"
		AND NULLIF(real_ruf."storage_key", '') IS NOT NULL
	ORDER BY COALESCE(real_ruf."id", ruf."id"), b."id"
),
inserted AS (
	INSERT INTO "files" (
		"id",
		"org_id",
		"owner_user_id",
		"storage_key",
		"filename",
		"content_type",
		"size_bytes",
		"checksum_sha256",
		"origin",
		"created_at",
		"deleted_at"
	)
	SELECT
		resolved."id",
		resolved."org_id",
		resolved."owner_user_id",
		resolved."storage_key",
		resolved."filename",
		resolved."content_type",
		resolved."size_bytes",
		resolved."checksum_sha256",
		resolved."origin",
		resolved."created_at",
		resolved."deleted_at"
	FROM resolved
	WHERE resolved."org_id" IS NOT NULL
	ON CONFLICT ("id") DO NOTHING
	RETURNING "id"
)
SELECT (SELECT "id" FROM batch ORDER BY "id" DESC LIMIT 1) AS next_cursor;
--> statement-breakpoint
-- 2b. Repoint shadow artifacts(kind = 'file').entity_id onto canonical files.id without colliding.
-- okou:batch-by-uuid
WITH batch AS MATERIALIZED (
	SELECT
		a."id",
		a."deleted_at",
		a."updated_at",
		real_f."id" AS "target_file_id"
	FROM "artifacts" a
	INNER JOIN "run_uploaded_files" ruf
		ON ruf."id" = a."entity_id"
		AND NULLIF(ruf."storage_key", '') IS NULL
		AND ruf."external_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		AND ruf."external_id"::uuid <> a."entity_id"
	INNER JOIN "files" real_f ON real_f."id" = ruf."external_id"::uuid
	WHERE ($1::uuid IS NULL OR a."id" > $1::uuid)
		AND a."kind" = 'file'
		AND a."logical_key" NOT LIKE 'shared-thread:%'
	ORDER BY a."id"
	LIMIT 1000
),
eligible AS (
	SELECT DISTINCT ON (b."target_file_id")
		b."id",
		b."target_file_id"
	FROM batch b
	WHERE NOT EXISTS (
		SELECT 1
		FROM "artifacts" other
		WHERE other."kind" = 'file'
			AND other."entity_id" = b."target_file_id"
			AND other."id" <> b."id"
	)
	ORDER BY b."target_file_id", b."deleted_at" NULLS FIRST, b."updated_at" DESC, b."id" DESC
),
updated AS (
	UPDATE "artifacts" a
	SET "entity_id" = e."target_file_id",
		"projection_file_id" = e."target_file_id",
		"updated_at" = now()
	FROM eligible e
	WHERE a."id" = e."id"
	RETURNING a."id"
)
SELECT (SELECT "id" FROM batch ORDER BY "id" DESC LIMIT 1) AS next_cursor;
--> statement-breakpoint
-- 3a. Backfill any missing real files referenced by historical video artifacts into `files`.
-- okou:batch-by-uuid
WITH batch AS MATERIALIZED (
	SELECT
		a."id",
		a."org_id",
		COALESCE(va."file_id", a."projection_file_id") AS "raw_file_id"
	FROM "artifacts" a
	LEFT JOIN "video_artifacts" va ON va."id" = a."entity_id"
	WHERE ($1::uuid IS NULL OR a."id" > $1::uuid)
		AND a."kind" = 'video'
	ORDER BY a."id"
	LIMIT 1000
),
resolved AS (
	SELECT DISTINCT ON (COALESCE(real_ruf."id", ruf."id"))
		COALESCE(real_ruf."id", ruf."id") AS "id",
		COALESCE(
			NULLIF(real_ruf."org_id", ''),
			NULLIF(ruf."org_id", ''),
			NULLIF(b."org_id", '')
		) AS "org_id",
		COALESCE(real_ruf."user_id", ruf."user_id") AS "owner_user_id",
		COALESCE(
			NULLIF(real_ruf."storage_key", ''),
			NULLIF(ruf."storage_key", ''),
			NULLIF(real_ruf."metadata"->>'s3Key', ''),
			NULLIF(ruf."metadata"->>'s3Key', '')
		) AS "storage_key",
		COALESCE(real_ruf."filename", ruf."filename") AS "filename",
		COALESCE(real_ruf."content_type", ruf."content_type") AS "content_type",
		COALESCE(real_ruf."size_bytes", ruf."size_bytes") AS "size_bytes",
		COALESCE(real_ruf."checksum_sha256", ruf."checksum_sha256") AS "checksum_sha256",
		COALESCE(real_ruf."created_at", ruf."created_at") AS "created_at",
		COALESCE(real_ruf."deleted_at", ruf."deleted_at") AS "deleted_at"
	FROM batch b
	INNER JOIN "run_uploaded_files" ruf ON ruf."id" = b."raw_file_id"
	LEFT JOIN "run_uploaded_files" real_ruf
		ON NULLIF(ruf."storage_key", '') IS NULL
		AND ruf."external_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		AND real_ruf."id" = ruf."external_id"::uuid
		AND real_ruf."id" <> ruf."id"
		AND NULLIF(real_ruf."storage_key", '') IS NOT NULL
	WHERE b."raw_file_id" IS NOT NULL
	ORDER BY COALESCE(real_ruf."id", ruf."id"), b."id"
),
inserted AS (
	INSERT INTO "files" (
		"id",
		"org_id",
		"owner_user_id",
		"storage_key",
		"filename",
		"content_type",
		"size_bytes",
		"checksum_sha256",
		"origin",
		"created_at",
		"deleted_at"
	)
	SELECT
		resolved."id",
		resolved."org_id",
		resolved."owner_user_id",
		resolved."storage_key",
		resolved."filename",
		resolved."content_type",
		resolved."size_bytes",
		resolved."checksum_sha256",
		'agent',
		resolved."created_at",
		resolved."deleted_at"
	FROM resolved
	WHERE resolved."org_id" IS NOT NULL
	ON CONFLICT ("id") DO NOTHING
	RETURNING "id"
)
SELECT (SELECT "id" FROM batch ORDER BY "id" DESC LIMIT 1) AS next_cursor;
--> statement-breakpoint
-- 3b. Normalize historical artifacts.kind = 'video' (and display_kind = 'video') to kind = 'file'.
-- okou:batch-by-uuid
WITH batch AS MATERIALIZED (
	SELECT
		a."id",
		a."kind",
		a."entity_id",
		a."projection_file_id",
		a."display_kind",
		a."visibility",
		a."category",
		a."deleted_at",
		COALESCE(va."file_id", a."projection_file_id") AS "raw_file_id"
	FROM "artifacts" a
	LEFT JOIN "video_artifacts" va
		ON a."kind" = 'video'
		AND va."id" = a."entity_id"
	WHERE ($1::uuid IS NULL OR a."id" > $1::uuid)
		AND (a."kind" = 'video' OR a."display_kind" = 'video')
	ORDER BY a."id"
	LIMIT 1000
),
video_targets AS (
	SELECT
		b."id",
		b."display_kind",
		b."visibility",
		b."category",
		COALESCE(real_f."id", b."raw_file_id") AS "canonical_file_id",
		COALESCE(real_f."id", b."raw_file_id", b."entity_id") AS "target_entity_id",
		existing."id" AS "existing_file_art_id",
		ROW_NUMBER() OVER (
			PARTITION BY COALESCE(real_f."id", b."raw_file_id", b."entity_id")
			ORDER BY b."deleted_at" NULLS FIRST, b."id"
		) AS "rn",
		FIRST_VALUE(b."id") OVER (
			PARTITION BY COALESCE(real_f."id", b."raw_file_id", b."entity_id")
			ORDER BY b."deleted_at" NULLS FIRST, b."id"
		) AS "batch_winner_id"
	FROM batch b
	LEFT JOIN "run_uploaded_files" ruf
		ON b."raw_file_id" IS NOT NULL
		AND ruf."id" = b."raw_file_id"
		AND NULLIF(ruf."storage_key", '') IS NULL
		AND ruf."external_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		AND ruf."external_id"::uuid <> b."raw_file_id"
	LEFT JOIN "files" real_f ON real_f."id" = ruf."external_id"::uuid
	LEFT JOIN "artifacts" existing
		ON existing."kind" = 'file'
		AND existing."entity_id" = COALESCE(real_f."id", b."raw_file_id", b."entity_id")
	WHERE b."kind" = 'video'
),
converted_winners AS (
	UPDATE "artifacts" a
	SET "kind" = 'file',
		"entity_id" = vt."target_entity_id",
		"projection_file_id" = COALESCE(vt."canonical_file_id", a."projection_file_id"),
		"display_kind" = CASE WHEN a."display_kind" = 'video' THEN NULL ELSE a."display_kind" END,
		"category" = COALESCE(
			a."category",
			CASE WHEN a."display_kind" = 'avatar' THEN 'other' ELSE 'video' END
		),
		"updated_at" = now()
	FROM video_targets vt
	WHERE a."id" = vt."id"
		AND vt."existing_file_art_id" IS NULL
		AND vt."rn" = 1
	RETURNING a."id"
),
colliding_videos AS (
	SELECT
		vt."id" AS "dup_art_id",
		COALESCE(vt."existing_file_art_id", vt."batch_winner_id") AS "surv_art_id",
		vt."visibility" AS "dup_visibility"
	FROM video_targets vt
	WHERE vt."existing_file_art_id" IS NOT NULL OR vt."rn" > 1
),
merged_video_shares AS (
	INSERT INTO "artifact_user_shares" ("user_id", "org_id", "artifact_id", "email", "created_at")
	SELECT s."user_id", s."org_id", c."surv_art_id", s."email", s."created_at"
	FROM colliding_videos c
	INNER JOIN "artifact_user_shares" s ON s."artifact_id" = c."dup_art_id"
	ON CONFLICT ("user_id", "org_id", "artifact_id") DO NOTHING
	RETURNING "artifact_id"
),
merged_video_favorites AS (
	INSERT INTO "artifact_favorites" ("org_id", "user_id", "artifact_id", "created_at")
	SELECT fav."org_id", fav."user_id", c."surv_art_id", fav."created_at"
	FROM colliding_videos c
	INNER JOIN "artifact_favorites" fav ON fav."artifact_id" = c."dup_art_id"
	ON CONFLICT ("org_id", "user_id", "artifact_id") DO NOTHING
	RETURNING "artifact_id"
),
deleted_video_favorites AS (
	DELETE FROM "artifact_favorites" fav
	USING colliding_videos c
	WHERE fav."artifact_id" = c."dup_art_id"
	RETURNING fav."artifact_id"
),
merged_video_visibility AS (
	UPDATE "artifacts" surv
	SET "visibility" = CASE
			WHEN surv."visibility" = 'public' OR agg."max_rank" = 2 THEN 'public'
			WHEN surv."visibility" = 'organization' OR agg."max_rank" = 1 THEN 'organization'
			ELSE surv."visibility"
		END,
		"category" = COALESCE(surv."category", 'video'),
		"updated_at" = now()
	FROM (
		SELECT
			c."surv_art_id",
			MAX(
				CASE
					WHEN c."dup_visibility" = 'public' THEN 2
					WHEN c."dup_visibility" = 'organization' THEN 1
					ELSE 0
				END
			) AS "max_rank"
		FROM colliding_videos c
		GROUP BY c."surv_art_id"
	) agg
	WHERE surv."id" = agg."surv_art_id"
		AND (
			surv."category" IS NULL
			OR agg."max_rank" > CASE
				WHEN surv."visibility" = 'public' THEN 2
				WHEN surv."visibility" = 'organization' THEN 1
				ELSE 0
			END
		)
	RETURNING surv."id"
),
deleted_colliding_videos AS (
	DELETE FROM "artifacts" a
	USING colliding_videos c
	WHERE a."id" = c."dup_art_id"
	RETURNING a."id"
),
cleared_display_kind AS (
	UPDATE "artifacts" a
	SET "display_kind" = NULL,
		"category" = COALESCE(a."category", 'video'),
		"updated_at" = now()
	FROM batch b
	WHERE a."id" = b."id"
		AND b."kind" <> 'video'
		AND b."display_kind" = 'video'
	RETURNING a."id"
)
SELECT (SELECT "id" FROM batch ORDER BY "id" DESC LIMIT 1) AS next_cursor;
--> statement-breakpoint
RESET statement_timeout;
--> statement-breakpoint
RESET lock_timeout;
