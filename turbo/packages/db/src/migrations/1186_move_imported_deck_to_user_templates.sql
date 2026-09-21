-- Move the one imported deck out of `presentation_templates` and into
-- `user_templates`.
--
-- `user_templates` is where a template compiled from an uploaded file lives
-- now, and its presentation arm carries everything the older table did:
-- the same source formats, the same package limits, and the same required
-- `SKILL.md` + `design-system.md`. `presentation_templates` holds exactly one
-- row in production — the public "Okou Brand" deck imported into the staff
-- organization on 2026-09-18 — so the fold-in starts by moving that row and
-- nothing else. The table, its routes and its picker stay in place for rows
-- imported after this ships; they are retired on their own change.
--
-- Named by id rather than by predicate on purpose. A predicate over the whole
-- table would also sweep a deck imported between this commit and the deploy,
-- and `user_templates` is behind the `customTemplates` switch: an organization
-- without that switch would watch its deck leave the presentation picker and
-- arrive in a catalog it cannot open. The named row is in the staff
-- organization, where the switch is on for every member.
--
-- Three facts make the move a metadata change rather than a copy:
--
--   * `source_storage_key` and `page_keys` are private-artifact object keys
--     owned by the upload route, not by either template table, so the new row
--     references the very same objects. `page_keys` becomes the manifest's
--     `pageKeys` with its order intact — element 0 is still the cover.
--   * The compiled package is a volume named after the row id, so reusing the
--     id makes the rename exact: `presentation-template@{id}` becomes
--     `user-template@{id}` for the same `(org_id, '__org__')` storage. The
--     R2 prefix, the versions and the HEAD pointer are untouched.
--   * `public` and `organization` are the same audience under two names —
--     every member of the owning organization — so the visibility carries
--     over rather than being re-decided here.
--
-- `aspect_ratio` does not carry over. It is the legacy column #26578 retired
-- for new imports, and this row left it null.
--
-- The inverse is the same three statements read backwards, which is what a
-- revert would run: insert back into `presentation_templates`, rename the
-- volume to `presentation-template@{id}`, delete the `user_templates` row.
DO $$
DECLARE
  template_id constant uuid := '97438eb9-80bf-45e1-b5ab-727fabadd2ec';
  moved_org text;
  renamed_volumes bigint;
BEGIN
  INSERT INTO "user_templates" (
    "id",
    "org_id",
    "owner_user_id",
    "visibility",
    "title",
    "source_storage_key",
    "source_filename",
    "manifest",
    "created_by",
    "updated_by",
    "created_at",
    "updated_at"
  )
  SELECT
    p."id",
    p."org_id",
    p."owner_user_id",
    CASE p."visibility" WHEN 'public' THEN 'organization' ELSE 'private' END,
    p."title",
    p."source_storage_key",
    p."source_filename",
    jsonb_build_object(
      'kind', 'presentation',
      'pageKeys', to_jsonb(p."page_keys")
    ),
    p."created_by",
    p."updated_by",
    p."created_at",
    p."updated_at"
  FROM "presentation_templates" AS p
  WHERE p."id" = template_id
  ON CONFLICT ("id") DO NOTHING
  RETURNING "org_id" INTO moved_org;

  -- Absent everywhere except production: a replayed schema, a developer
  -- database and a branch restored after the move all reach this point with
  -- nothing to do, and the rename below must not run against them.
  IF moved_org IS NULL THEN
    RAISE NOTICE 'Imported deck % is not present; nothing to move', template_id;
    RETURN;
  END IF;

  UPDATE "storages"
  SET
    "name" = 'user-template@' || template_id::text,
    "updated_at" = now()
  WHERE "org_id" = moved_org
    AND "user_id" = '__org__'
    AND "name" = 'presentation-template@' || template_id::text;
  GET DIAGNOSTICS renamed_volumes = ROW_COUNT;

  -- The row exists because a package was validated and committed, so its
  -- volume exists too. A row without one would leave a template whose
  -- guidance a run cannot mount, which is worse than not moving it.
  IF renamed_volumes <> 1 THEN
    RAISE EXCEPTION
      'Expected one guidance package volume for %, found %',
      template_id, renamed_volumes;
  END IF;

  DELETE FROM "presentation_templates" WHERE "id" = template_id;

  RAISE NOTICE 'Moved imported deck % into user_templates', template_id;
END $$;
