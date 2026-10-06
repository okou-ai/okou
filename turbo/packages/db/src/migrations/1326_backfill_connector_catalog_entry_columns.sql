UPDATE "connector_catalog_entries"
SET
  "label" = "payload" ->> 'label',
  "description" = "payload" ->> 'description',
  "category" = "payload" ->> 'category',
  "auth_methods" = "payload" -> 'authMethods',
  "firewall" = "payload" -> 'firewall',
  "storage_name" = CASE WHEN "payload" -> 'skill' ->> 'kind' = 'bundled'
    THEN "payload" -> 'skill' ->> 'storageName' ELSE NULL END,
  "version_id" = CASE WHEN "payload" -> 'skill' ->> 'kind' = 'bundled'
    THEN "payload" -> 'skill' ->> 'versionId' ELSE NULL END;
