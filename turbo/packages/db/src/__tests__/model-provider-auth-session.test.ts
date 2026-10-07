import { describe, expect, it } from "vitest";
import { schema } from "../index";
import { modelProviderAuthSessions } from "../schema/model-provider-auth-session";

function getExtraConfigNames(table: object): string[] {
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

  return builder(columns)
    .map((config: { name?: string; config?: { name?: string } }) => {
      return config.name ?? config.config?.name;
    })
    .filter((name: string | undefined): name is string => {
      return Boolean(name);
    });
}

describe("modelProviderAuthSessions schema", () => {
  it("exports the model provider auth session table through the shared schema", () => {
    expect(schema.modelProviderAuthSessions).toBe(modelProviderAuthSessions);
  });

  it("keeps the expected column names stable", () => {
    expect(modelProviderAuthSessions.id.name).toBe("id");
    expect(modelProviderAuthSessions.orgId.name).toBe("org_id");
    expect(modelProviderAuthSessions.userId.name).toBe("user_id");
    expect(modelProviderAuthSessions.connectorType.name).toBe("connector_type");
    expect(modelProviderAuthSessions.source.name).toBe("source");
    expect(modelProviderAuthSessions.status.name).toBe("status");
    expect(modelProviderAuthSessions.approvalUrl.name).toBe("approval_url");
    expect(modelProviderAuthSessions.verificationCode.name).toBe(
      "verification_code",
    );
    expect(modelProviderAuthSessions.encryptedProviderState.name).toBe(
      "encrypted_provider_state",
    );
    expect(modelProviderAuthSessions.errorMessage.name).toBe("error_message");
    expect(modelProviderAuthSessions.createdAt.name).toBe("created_at");
    expect(modelProviderAuthSessions.updatedAt.name).toBe("updated_at");
    expect(modelProviderAuthSessions.expiresAt.name).toBe("expires_at");
    expect(modelProviderAuthSessions.completedAt.name).toBe("completed_at");
    expect(modelProviderAuthSessions.cancelledAt.name).toBe("cancelled_at");
  });

  it("declares lifecycle lookup indexes", () => {
    expect(getExtraConfigNames(modelProviderAuthSessions)).toEqual(
      expect.arrayContaining([
        "idx_model_provider_auth_sessions_owner_status",
        "idx_model_provider_auth_sessions_expiration",
      ]),
    );
  });
});
