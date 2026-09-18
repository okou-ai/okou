import { describe, expect, it } from "vitest";
import { schema } from "../index";
import { builtinConnectorExternalCodeSessions } from "../schema/connector-external-code-session";
import { builtinConnectorOauthDeviceAuthorizationSessions } from "../schema/connector-oauth-device-authorization-session";

interface ExtraConfigColumn {
  readonly name?: string;
}

interface ExtraConfig {
  readonly name?: string;
  readonly config?: {
    readonly name?: string;
    readonly columns?: readonly ExtraConfigColumn[];
  };
}

function isExtraConfig(value: unknown): value is ExtraConfig {
  return typeof value === "object" && value !== null;
}

function getExtraConfigs(table: object): ExtraConfig[] {
  const symbols = Object.getOwnPropertySymbols(table);
  const builderSymbol = symbols.find((symbol) => {
    return symbol.description === "drizzle:ExtraConfigBuilder";
  });
  const columnsSymbol = symbols.find((symbol) => {
    return symbol.description === "drizzle:ExtraConfigColumns";
  });
  if (!builderSymbol || !columnsSymbol) {
    return [];
  }

  const builder = Reflect.get(table, builderSymbol);
  const columns = Reflect.get(table, columnsSymbol);
  if (typeof builder !== "function") {
    return [];
  }

  const result: unknown = builder(columns);
  if (!Array.isArray(result)) {
    return [];
  }
  return result.filter(isExtraConfig);
}

function getExtraConfigNames(table: object): string[] {
  return getExtraConfigs(table)
    .map((config) => {
      return config.name ?? config.config?.name;
    })
    .filter((name: string | undefined): name is string => {
      return Boolean(name);
    });
}

function getExtraConfigColumnNames(table: object, name: string): string[] {
  const config = getExtraConfigs(table).find((item) => {
    return (item.name ?? item.config?.name) === name;
  });
  return (
    config?.config?.columns
      ?.map((column) => {
        return column.name;
      })
      .filter((columnName: string | undefined): columnName is string => {
        return Boolean(columnName);
      }) ?? []
  );
}

describe("connector authorization session schemas", () => {
  it("exports the durable authorization session tables", () => {
    expect(schema.builtinConnectorOauthDeviceAuthorizationSessions).toBe(
      builtinConnectorOauthDeviceAuthorizationSessions,
    );
    expect(schema.builtinConnectorExternalCodeSessions).toBe(
      builtinConnectorExternalCodeSessions,
    );
  });

  it("keeps the expected column names stable", () => {
    expect(builtinConnectorOauthDeviceAuthorizationSessions.id.name).toBe("id");
    expect(builtinConnectorOauthDeviceAuthorizationSessions.orgId.name).toBe(
      "org_id",
    );
    expect(builtinConnectorOauthDeviceAuthorizationSessions.userId.name).toBe(
      "user_id",
    );
    expect(
      builtinConnectorOauthDeviceAuthorizationSessions.connectorSlug.name,
    ).toBe("connector_slug");
    expect(
      builtinConnectorOauthDeviceAuthorizationSessions.connectorSlug.notNull,
    ).toBe(true);
    expect(
      builtinConnectorOauthDeviceAuthorizationSessions.authMethod.name,
    ).toBe("auth_method");
    expect(builtinConnectorOauthDeviceAuthorizationSessions.status.name).toBe(
      "status",
    );
    expect(
      builtinConnectorOauthDeviceAuthorizationSessions.sessionTokenHash.name,
    ).toBe("session_token_hash");
    expect(
      builtinConnectorOauthDeviceAuthorizationSessions.encryptedProviderState
        .name,
    ).toBe("encrypted_provider_state");
    expect(
      builtinConnectorOauthDeviceAuthorizationSessions.accountMutation.name,
    ).toBe("account_mutation");
    expect(
      builtinConnectorOauthDeviceAuthorizationSessions.accountMutation.notNull,
    ).toBe(true);
    expect(builtinConnectorExternalCodeSessions.accountMutation.name).toBe(
      "account_mutation",
    );
    expect(builtinConnectorExternalCodeSessions.accountMutation.notNull).toBe(
      true,
    );
    expect(builtinConnectorExternalCodeSessions.completedConnectorId.name).toBe(
      "completed_connector_id",
    );
    expect(
      builtinConnectorExternalCodeSessions.completedConnectorId.notNull,
    ).toBe(false);
    expect(
      builtinConnectorOauthDeviceAuthorizationSessions.completedConnectorId
        .name,
    ).toBe("completed_connector_id");
    expect(
      builtinConnectorOauthDeviceAuthorizationSessions.completedConnectorId
        .notNull,
    ).toBe(false);
    expect(builtinConnectorOauthDeviceAuthorizationSessions.userCode.name).toBe(
      "user_code",
    );
    expect(
      builtinConnectorOauthDeviceAuthorizationSessions.verificationUri.name,
    ).toBe("verification_uri");
    expect(
      builtinConnectorOauthDeviceAuthorizationSessions.verificationUriComplete
        .name,
    ).toBe("verification_uri_complete");
    expect(
      builtinConnectorOauthDeviceAuthorizationSessions.intervalSeconds.name,
    ).toBe("interval_seconds");
    expect(
      builtinConnectorOauthDeviceAuthorizationSessions.errorCode.name,
    ).toBe("error_code");
    expect(
      builtinConnectorOauthDeviceAuthorizationSessions.errorMessage.name,
    ).toBe("error_message");
    expect(
      builtinConnectorOauthDeviceAuthorizationSessions.createdAt.name,
    ).toBe("created_at");
    expect(
      builtinConnectorOauthDeviceAuthorizationSessions.updatedAt.name,
    ).toBe("updated_at");
    expect(
      builtinConnectorOauthDeviceAuthorizationSessions.expiresAt.name,
    ).toBe("expires_at");
    expect(
      builtinConnectorOauthDeviceAuthorizationSessions.completedAt.name,
    ).toBe("completed_at");
  });

  it("declares token, owner, and expiration indexes", () => {
    expect(
      getExtraConfigNames(builtinConnectorOauthDeviceAuthorizationSessions),
    ).toStrictEqual(
      expect.arrayContaining([
        "idx_connector_oauth_device_authorization_sessions_token",
        "idx_connector_oauth_device_sessions_owner_slug_status",
        "idx_connector_oauth_device_authorization_sessions_expiration",
      ]),
    );
    expect(
      getExtraConfigColumnNames(
        builtinConnectorOauthDeviceAuthorizationSessions,
        "idx_connector_oauth_device_sessions_owner_slug_status",
      ),
    ).toStrictEqual([
      "org_id",
      "user_id",
      "connector_slug",
      "auth_method",
      "status",
    ]);
  });
});
