-- okou:non-transactional
-- Online-safe FK cutover from image_artifacts.file_id -> run_uploaded_files(id)
-- to image_artifacts.file_id -> files(id): add NOT VALID first, validate under
-- SHARE UPDATE EXCLUSIVE (non-blocking for reads/writes), then drop legacy FK.
SET lock_timeout = '1s';
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conrelid = 'public.image_artifacts'::regclass
			AND conname = 'image_artifacts_file_id_files_id_fk'
	) THEN
		ALTER TABLE "image_artifacts"
			ADD CONSTRAINT "image_artifacts_file_id_files_id_fk"
			FOREIGN KEY ("file_id") REFERENCES "public"."files"("id")
			ON DELETE cascade ON UPDATE no action
			NOT VALID;
	END IF;
END
$$;
--> statement-breakpoint
SET statement_timeout = '10min';
--> statement-breakpoint
ALTER TABLE "image_artifacts" VALIDATE CONSTRAINT "image_artifacts_file_id_files_id_fk";
--> statement-breakpoint
ALTER TABLE "image_artifacts" DROP CONSTRAINT IF EXISTS "image_artifacts_file_id_run_uploaded_files_id_fk";
--> statement-breakpoint
RESET statement_timeout;
--> statement-breakpoint
RESET lock_timeout;
