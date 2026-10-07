-- Backfill every retained hash, including generations captured by active Runs.
-- This is separate from the ADD COLUMN transaction so ordinary catalog reads
-- are not blocked by an ACCESS EXCLUSIVE lock during the payload rewrite.
-- A still-serving outgoing API can insert payload-only rows after this scan;
-- Release 1 readers keep a bounded SQL projection fallback for those rows.
UPDATE "connector_catalog_entries" AS entry
SET
  "label" = entry.payload ->> 'label',
  "description" = entry.payload ->> 'description',
  "category" = entry.payload ->> 'category',
  "icon" = entry.payload -> 'icon',
  "tags" = ARRAY(SELECT jsonb_array_elements_text(entry.payload -> 'tags')),
  "generation" = ARRAY(SELECT jsonb_array_elements_text(entry.payload -> 'generation')),
  "auth_methods" = entry.payload -> 'authMethods',
  "mcp" = entry.payload -> 'mcp',
  "skill" = entry.payload -> 'skill',
  "firewall" = entry.payload -> 'firewall',
  "permission_summary" = CASE
    WHEN entry.payload ? 'mcp' OR entry.payload #>> '{firewall,kind}' = 'none'
      THEN jsonb_build_object(
        'hasPermissions', false,
        'permissionCount', 0,
        'hasCategories', false,
        'hasDefaultPolicyOverrides', false
      )
    ELSE (
      SELECT jsonb_build_object(
        'hasPermissions', count(*) > 0,
        'permissionCount', count(*),
        'hasCategories', entry.payload #> '{firewall,categories}' <> 'null'::jsonb,
        -- Compact policy overrides exist exactly when an actual permission is
        -- denied, or the unknown-permission policy is not allow. Names only
        -- mentioned in defaultAllowed do not count as catalog permissions.
        'hasDefaultPolicyOverrides',
          entry.payload #>> '{firewall,defaultUnknownPolicy}' <> 'allow'
          OR count(*) FILTER (
            WHERE entry.payload #> '{firewall,defaultAllowed}' <> 'null'::jsonb
              AND NOT (entry.payload #> '{firewall,defaultAllowed}' ? permission_name)
          ) > 0
      )
      FROM (
        SELECT DISTINCT permission ->> 'name' AS permission_name
        FROM jsonb_array_elements(entry.payload #> '{firewall,config,apis}') AS api
        CROSS JOIN LATERAL jsonb_array_elements(
          COALESCE(api -> 'permissions', '[]'::jsonb)
        ) AS permission
      ) AS permissions
    )
  END
WHERE entry.auth_methods IS NULL;
