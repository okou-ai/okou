UPDATE "connector_catalog_entries"
SET "mcp_endpoint" = "payload" -> 'mcp' ->> 'endpoint';
