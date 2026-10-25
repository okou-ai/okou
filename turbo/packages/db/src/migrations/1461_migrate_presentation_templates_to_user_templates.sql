-- Release only after the customTemplates catalog is available to every affected
-- member and legacy imports/writers have drained. This moves the remaining
-- legacy rows; it does not switch the catalog or retire the old API.
--
-- Like 1186, this is a metadata move: preserve template IDs, source/page object
-- keys, audit fields and Storage identities/versions. Only the package's lookup
-- name changes. Legacy `public` already means organization-visible.
--
-- DELETE ... RETURNING claims each source row through its ordinary write so a
-- concurrent edit cannot be read and then silently discarded. The entire DO
-- statement is atomic: a missing package or destination conflict restores all
-- source rows, inserted destinations and renamed volumes. A successful replay
-- sees no remaining source rows and makes no changes.
DO $$
DECLARE
  legacy "presentation_templates"%ROWTYPE;
  renamed_volumes bigint;
BEGIN
  FOR legacy IN
    DELETE FROM "presentation_templates" RETURNING *
  LOOP
    INSERT INTO "user_templates" (
      "id", "org_id", "owner_user_id", "visibility", "title",
      "source_storage_key", "source_filename", "manifest",
      "created_by", "updated_by", "created_at", "updated_at"
    ) VALUES (
      legacy."id",
      legacy."org_id",
      legacy."owner_user_id",
      CASE legacy."visibility"
        WHEN 'public' THEN 'organization'
        ELSE 'private'
      END,
      legacy."title",
      legacy."source_storage_key",
      legacy."source_filename",
      jsonb_build_object(
        'kind', 'presentation',
        'pageKeys', to_jsonb(legacy."page_keys")
      ),
      legacy."created_by",
      legacy."updated_by",
      legacy."created_at",
      legacy."updated_at"
    );

    -- Require a committed HEAD belonging to this exact organization-owned
    -- volume. An absent, unfinished or mismatched package must not become a
    -- template that the new catalog advertises but a Run cannot mount.
    UPDATE "storages" AS s
    SET "name" = 'user-template@' || legacy."id"::text
    FROM "storage_versions" AS v
    WHERE s."org_id" = legacy."org_id"
      AND s."user_id" = '__org__'
      AND s."name" = 'presentation-template@' || legacy."id"::text
      AND v."id" = s."head_version_id"
      AND v."storage_id" = s."id";
    GET DIAGNOSTICS renamed_volumes = ROW_COUNT;

    IF renamed_volumes <> 1 THEN
      RAISE EXCEPTION
        'Expected one committed guidance package for presentation template %, found %',
        legacy."id", renamed_volumes;
    END IF;
  END LOOP;
END $$;
