import { onTestFinished } from "vitest";
import { modelCatalogContract } from "@okouai/api-contracts/contracts/model-catalog";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  clearModelCatalogSystemDefaultFixture,
  setModelCatalogSystemDefaultFixture,
} from "../../../test-fixtures/model-catalog";
import { modelPoliciesMainContract } from "@okouai/api-contracts/contracts/model-policies";
import { modelPoliciesRoutes } from "../model-policies";
import { createRouteMocks } from "./helpers/route-test";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { modelCatalogRoutes } from "../model-catalog";

const context = testContext();
const mocks = createRouteMocks(context);
const authOrgApi = createAuthOrgAgentsBddApi(context);

function apiClient() {
  return setupApp({ context, routes: modelCatalogRoutes })(
    modelCatalogContract,
  );
}

function signIn(): void {
  const actor = authOrgApi.user({ orgRole: "org:member" });
  if (!actor.orgId) {
    throw new Error("Expected an organization member");
  }
  mocks.clerk.session(actor.userId, actor.orgId, "org:member");
}

function policiesApi() {
  return setupApp({ context, routes: modelPoliciesRoutes })(
    modelPoliciesMainContract,
  );
}

// Tests that mutate the global catalog row live only in this file (its tests
// run sequentially) and restore the row in the same test.
describe("GET /api/model-catalog", () => {
  it("returns the global catalog with replacements resolved", async () => {
    signIn();
    const response = await accept(
      apiClient().get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    const { models, routes, systemDefaultModel } = response.body;
    expect(systemDefaultModel).toBe("okou-1.0");
    expect(
      models.filter((row) => {
        return row.isSystemDefault;
      }),
    ).toStrictEqual([
      {
        model: "okou-1.0",
        displayName: "Auto",
        sortOrder: 10,
        isSystemDefault: true,
        replacedBy: null,
        resolvedModel: "okou-1.0",
        priceTier: "$",
      },
    ]);
    expect(
      models.find((row) => {
        return row.model === "claude-fable-5";
      }),
    ).toStrictEqual({
      model: "claude-fable-5",
      displayName: "Claude Fable 5",
      sortOrder: 30,
      isSystemDefault: false,
      replacedBy: "claude-fable-5-1",
      resolvedModel: "claude-fable-5-1",
      priceTier: null,
    });
    expect(
      models.find((row) => {
        return row.model === "claude-fable-5-1";
      })?.resolvedModel,
    ).toBe("claude-fable-5-1");
    // Retired models keep their row and resolve to the approved replacement,
    // including the cross-provider DeepSeek V4 Pro -> GPT 6 Luna.
    expect(
      models
        .filter((row) => {
          return row.replacedBy !== null;
        })
        .map((row) => {
          return [row.model, row.resolvedModel];
        }),
    ).toStrictEqual([
      ["claude-fable-5", "claude-fable-5-1"],
      ["claude-opus-4-8", "claude-opus-5-5"],
      ["claude-sonnet-4-6", "claude-sonnet-5-5"],
      ["gpt-5.5", "gpt-6-luna"],
      ["deepseek-v4-pro", "gpt-6-luna"],
    ]);
    // A replaced model has no routes of its own; nothing is copied from the
    // retired model's provider onto its replacement.
    expect(
      routes.filter((route) => {
        return models.some((row) => {
          return row.model === route.model && row.replacedBy !== null;
        });
      }),
    ).toStrictEqual([]);
    const sortOrders = models.map((row) => {
      return row.sortOrder;
    });
    expect(sortOrders).toStrictEqual(
      [...sortOrders].sort((left, right) => {
        return left - right;
      }),
    );

    expect(
      routes.filter((route) => {
        return route.model === "okou-1.0";
      }),
    ).toStrictEqual([
      {
        model: "okou-1.0",
        providerType: "built-in",
        concreteProviderType: "openrouter-codex",
        subscriptionType: null,
        upstreamModel: "@preset/okou-1-0",
        enabled: true,
        priority: 0,
        serviceTiers: [],
        defaultServiceTier: null,
        efforts: [],
        defaultEffort: null,
        priceTier: "$",
      },
    ]);
    expect(
      routes.filter((route) => {
        return (
          route.model === "gpt-6-astra" &&
          route.providerType === "codex-oauth-token"
        );
      }),
    ).toStrictEqual([
      expect.objectContaining({ subscriptionType: null }),
      expect.objectContaining({
        subscriptionType: "codex-oauth-token",
        serviceTiers: ["priority"],
      }),
    ]);
    for (const route of routes) {
      expect(Object.keys(route)).not.toContain("pricingProvider");
    }
  });

  it("fails loudly instead of choosing a default when none is configured", async () => {
    signIn();
    const restore = await clearModelCatalogSystemDefaultFixture();
    onTestFinished(restore);

    const response = await apiClient().get({
      headers: { authorization: "Bearer clerk-session" },
    });

    expect(response.status).toBe(500);
  });

  it("changes every organization's default when the database default changes", async () => {
    signIn();
    const restore = await setModelCatalogSystemDefaultFixture("gpt-6-luna");
    onTestFinished(restore);

    const catalog = await accept(
      apiClient().get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(catalog.body.systemDefaultModel).toBe("gpt-6-luna");

    const policies = (
      await accept(
        policiesApi().list({
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      )
    ).body;
    expect(policies.workspaceDefaultModel).toBe("gpt-6-luna");
    expect(
      policies.policies.map((policy) => {
        return [policy.model, policy.isDefault];
      }),
    ).toStrictEqual([["gpt-6-luna", true]]);
  });

  it("requires an authenticated organization session", async () => {
    const unauthenticated = await apiClient().get({ headers: {} });
    expect(unauthenticated.status).toBe(401);

    const actor = authOrgApi.user();
    mocks.clerk.session(actor.userId, null);
    const withoutOrganization = await apiClient().get({
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(withoutOrganization.status).toBe(401);
  });
});
