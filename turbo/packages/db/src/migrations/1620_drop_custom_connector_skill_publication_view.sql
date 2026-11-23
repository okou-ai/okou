-- An explicit grant may identify a consumer outside the application code.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS publication
    CROSS JOIN LATERAL (
      SELECT grantee FROM pg_catalog.aclexplode(publication.relacl)
      UNION ALL
      SELECT privilege.grantee
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
      WHERE attribute.attrelid = publication.oid
    ) AS privileges
    WHERE publication.oid = 'public.org_custom_connector_skill_publications'::regclass
      AND privileges.grantee <> publication.relowner
  ) THEN
    RAISE EXCEPTION 'View still has non-owner grants: public.org_custom_connector_skill_publications'
      USING ERRCODE = '2BP01';
  END IF;
END
$$;
--> statement-breakpoint
DROP VIEW "public"."org_custom_connector_skill_publications" RESTRICT;
