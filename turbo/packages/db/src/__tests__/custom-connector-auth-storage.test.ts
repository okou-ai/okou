import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { connectorOauthStates } from "../schema/connector-oauth-state";
import { connectors } from "../schema/connector";
import { orgCustomConnectorOauthConfigs } from "../schema/org-custom-connector-oauth-config";
import { orgCustomConnectors } from "../schema/org-custom-connector";
import { secrets } from "../schema/secret";

function names(items: readonly { readonly name?: string }[]): string[] {
  return items.flatMap((item) => {
    return item.name ? [item.name] : [];
  });
}

describe("custom connector auth storage schema", () => {
  it("keeps one organization-owned connector root and one OAuth config", () => {
    const connectorConfig = getTableConfig(orgCustomConnectors);
    const oauthConfig = getTableConfig(orgCustomConnectorOauthConfigs);

    expect(orgCustomConnectors.authMode.notNull).toBe(true);
    expect(orgCustomConnectors.enabled.notNull).toBe(true);
    expect(orgCustomConnectors.storageVersion.notNull).toBe(true);
    expect(orgCustomConnectors.storageVersion.hasDefault).toBe(true);
    expect(orgCustomConnectors.storageVersion.columnType).toBe("PgBigInt53");
    expect(names(connectorConfig.uniqueConstraints)).toContain(
      "idx_org_custom_connectors_id_org",
    );
    expect(names(connectorConfig.checks)).toEqual(
      expect.arrayContaining([
        "chk_org_custom_connectors_slug",
        "chk_org_custom_connectors_auth_mode",
        "chk_org_custom_connectors_mcp",
        "chk_org_custom_connectors_storage_version_positive",
        "chk_org_custom_connectors_skill_size",
        "chk_org_custom_connectors_skill_publication_pair",
      ]),
    );
    const authModeCheck = connectorConfig.checks.find((check) => {
      return check.name === "chk_org_custom_connectors_auth_mode";
    });
    const definitionCheck = connectorConfig.checks.find((check) => {
      return check.name === "chk_org_custom_connectors_mcp";
    });
    expect(authModeCheck).toBeDefined();
    expect(definitionCheck).toBeDefined();
    if (!authModeCheck || !definitionCheck) {
      throw new Error("Missing Custom connector authentication checks");
    }
    const dialect = new PgDialect();
    expect(dialect.sqlToQuery(authModeCheck.value).sql).toContain(
      "IN ('none', 'manual', 'oauth', 'automatic')",
    );
    const definitionSql = dialect.sqlToQuery(definitionCheck.value).sql;
    expect(definitionSql).toContain("\"auth_mode\" = 'none'");
    expect(definitionSql).toContain("\"auth_mode\" IN ('none', 'automatic')");
    expect(definitionSql).toContain("jsonb_path_exists");
    expect(definitionSql).toContain("\"header_injections\" = '[]'::jsonb");
    expect(definitionSql).toContain("\"query_injections\" = '[]'::jsonb");
    expect(definitionSql).toContain("\"fields\" = '[]'::jsonb");

    expect(orgCustomConnectorOauthConfigs.connectorId.primary).toBe(true);
    expect(oauthConfig.foreignKeys).toHaveLength(1);
    expect(oauthConfig.foreignKeys[0]?.onDelete).toBe("cascade");
    expect(names(oauthConfig.checks)).toEqual(
      expect.arrayContaining([
        "chk_org_custom_connector_oauth_configs_provider_adapter",
        "chk_org_custom_connector_oauth_configs_pkce_method",
        "chk_org_custom_connector_oauth_configs_token_auth_method",
      ]),
    );
  });

  it("separates built-in and custom connection identities", () => {
    const connectorConfig = getTableConfig(connectors);
    const stateConfig = getTableConfig(connectorOauthStates);

    expect(connectors.connectorSlug.notNull).toBe(false);
    expect(connectors.customConnectorId.notNull).toBe(false);
    expect(names(connectorConfig.checks)).toContain("chk_connectors_identity");
    expect(
      connectorConfig.indexes.map((index) => {
        return index.config.name;
      }),
    ).toEqual(
      expect.arrayContaining([
        "idx_connectors_org_user_slug",
        "idx_connectors_org_user_custom_connector",
      ]),
    );
    expect(names(connectorConfig.uniqueConstraints)).toContain(
      "idx_connectors_id_org_user",
    );
    expect(
      connectorConfig.indexes.find((index) => {
        return index.config.name === "idx_connectors_org_user_slug";
      })?.config.where,
    ).toBeDefined();

    expect(connectorOauthStates.connectorSlug.notNull).toBe(false);
    expect(connectorOauthStates.accountMutation.name).toBe("account_mutation");
    expect(connectorOauthStates.accountMutation.notNull).toBe(true);
    expect(connectorOauthStates.storageVersion.notNull).toBe(false);
    expect(connectorOauthStates.storageVersion.columnType).toBe("PgBigInt53");
    expect(names(stateConfig.checks)).toEqual(
      expect.arrayContaining([
        "chk_connector_oauth_states_identity",
        "chk_connector_oauth_states_custom_storage_version",
      ]),
    );
  });

  it("owns OAuth tokens by connection", () => {
    const secretConfig = getTableConfig(secrets);

    expect(
      secretConfig.indexes.map((index) => {
        return index.config.name;
      }),
    ).toEqual(
      expect.arrayContaining([
        "idx_secrets_connector_name",
        "idx_secrets_org_user_name_type",
      ]),
    );
    expect(secretConfig.foreignKeys[0]?.onDelete).toBe("cascade");
  });
});
