ALTER TABLE "org_custom_connectors" ADD COLUMN "firewall" jsonb;--> statement-breakpoint
ALTER TABLE "org_custom_connectors" ADD CONSTRAINT "chk_org_custom_connectors_firewall" CHECK (((
          "org_custom_connectors"."firewall" IS NULL
          AND "org_custom_connectors"."permission_bundle_ref" IS DISTINCT FROM 'builtin:custom@1'
        ) OR (
          "org_custom_connectors"."firewall" IS NOT NULL
          AND "org_custom_connectors"."permission_bundle_ref" = 'builtin:custom@1'
          AND "org_custom_connectors"."mcp_endpoint" IS NULL
          AND jsonb_typeof("org_custom_connectors"."firewall") = 'object'
          AND jsonb_typeof("org_custom_connectors"."firewall"->'permissions') = 'array'
        )) IS TRUE);