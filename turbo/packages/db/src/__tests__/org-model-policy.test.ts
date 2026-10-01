import { describe, expect, it } from "vitest";
import { schema } from "../index";
import { orgModelPolicies } from "../schema/org-model-policy";

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
    .map((config: { name?: string }) => {
      return config.name;
    })
    .filter((name: string | undefined): name is string => {
      return Boolean(name);
    });
}

describe("orgModelPolicies schema", () => {
  it("exports the model-first policy table through the shared schema", () => {
    expect(schema.orgModelPolicies).toBe(orgModelPolicies);
  });

  it("keeps the expected policy column names stable", () => {
    expect(orgModelPolicies.orgId.name).toBe("org_id");
    expect(orgModelPolicies.model.name).toBe("model");
    expect(orgModelPolicies.defaultProviderType.name).toBe(
      "default_provider_type",
    );
    expect(orgModelPolicies.credentialScope.name).toBe("credential_scope");
    expect(orgModelPolicies.modelProviderId.name).toBe("model_provider_id");
  });

  it("declares credential ownership checks for org and member routes", () => {
    expect(getExtraConfigNames(orgModelPolicies)).toEqual(
      expect.arrayContaining([
        "chk_org_model_policies_credential_scope",
        "chk_org_model_policies_member_scope_no_provider_id",
        "chk_org_model_policies_builtin_route_no_provider_id",
        "chk_org_model_policies_member_scope_oauth_provider",
        "chk_org_model_policies_oauth_provider_member_scope",
      ]),
    );
  });
});
