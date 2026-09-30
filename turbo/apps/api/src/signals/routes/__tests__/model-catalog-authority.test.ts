import { modelCatalogContract } from "@okouai/api-contracts/contracts/model-catalog";
import { modelPoliciesMainContract } from "@okouai/api-contracts/contracts/model-policies";
import type { UpdateOrgModelPolicy } from "@okouai/api-contracts/contracts/model-providers";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createRouteMocks } from "./helpers/route-test";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { modelCatalogRoutes } from "../model-catalog";
import { modelPoliciesRoutes } from "../model-policies";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import { userModelPreferenceRoutes } from "../user-model-preference";

const context = testContext();
const mocks = createRouteMocks(context);
const authOrgApi = createAuthOrgAgentsBddApi(context);
const headers = { authorization: "Bearer clerk-session" };

function catalogApi() {
  return setupApp({ context, routes: modelCatalogRoutes })(
    modelCatalogContract,
  );
}

function policiesApi() {
  return setupApp({ context, routes: modelPoliciesRoutes })(
    modelPoliciesMainContract,
  );
}

function signInAdmin(): void {
  const actor = authOrgApi.user();
  if (!actor.orgId) {
    throw new Error("Expected an organization member");
  }
  mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
}

function builtIn(model: UpdateOrgModelPolicy["model"]): UpdateOrgModelPolicy {
  return {
    model,
    defaultProviderType: "built-in",
    credentialScope: "org",
    modelProviderId: null,
  };
}

async function listPolicies() {
  return (await accept(policiesApi().list({ headers }), [200])).body;
}

describe("model catalog authority", () => {
  it("exposes the database system default and display price tiers", async () => {
    signInAdmin();
    const { body } = await accept(catalogApi().get({ headers }), [200]);

    expect(body.systemDefaultModel).toBe("okou-1.0");
    expect(
      body.models.find((row) => {
        return row.model === "okou-1.0";
      })?.priceTier,
    ).toBe("$");
    // A replaced model has no route of its own, hence no price tier.
    expect(
      body.models.find((row) => {
        return row.model === "claude-fable-5";
      })?.priceTier,
    ).toBeNull();
  });

  it("projects the system default policy without storing a per-organization row", async () => {
    signInAdmin();
    const initial = await listPolicies();

    expect(initial.policies).toStrictEqual([
      expect.objectContaining({
        model: "okou-1.0",
        isDefault: true,
        defaultProviderType: "built-in",
        credentialScope: "org",
      }),
    ]);
    expect(initial.workspaceDefaultModel).toBe("okou-1.0");
    expect(initial.workspaceDefaultPolicyId).toBe(initial.policies[0]?.id);

    // A write that omits the default keeps it; nothing is persisted for it,
    // so the policy revision is unchanged by an empty write.
    const written = await accept(
      policiesApi().update({
        headers,
        body: { revision: initial.revision, policies: [] },
      }),
      [200],
    );
    expect(written.body.revision).toBe(initial.revision);
    expect(written.body.policies).toStrictEqual(initial.policies);
  });

  it("admits a new policy only for an active catalog model", async () => {
    signInAdmin();
    const { revision } = await listPolicies();

    const retired = await policiesApi().update({
      headers,
      body: { revision, policies: [builtIn("claude-fable-5")] },
    });
    expect(retired.status).toBe(400);

    // Active in the catalog; the retired `allow_new_org_policy` flag is false
    // for this row and no longer decides admission.
    const added = await accept(
      policiesApi().update({
        headers,
        body: { revision, policies: [builtIn("claude-opus-5-5")] },
      }),
      [200],
    );
    expect(
      added.body.policies.map((policy) => {
        return policy.model;
      }),
    ).toStrictEqual(["okou-1.0", "claude-opus-5-5"]);
    expect(added.body.modelsAvailableToAdd).not.toContain("claude-fable-5");
    expect(added.body.modelsAvailableToAdd).not.toContain("okou-1.0");
  });

  it("stores the final replacement for a legacy model preference", async () => {
    signInAdmin();
    const { revision } = await listPolicies();
    await accept(
      policiesApi().update({
        headers,
        body: { revision, policies: [builtIn("claude-fable-5-1")] },
      }),
      [200],
    );
    const preferences = setupApp({
      context,
      routes: userModelPreferenceRoutes,
    })(userModelPreferenceContract);

    const updated = await accept(
      preferences.update({
        headers,
        body: { selectedModel: "claude-fable-5", serviceTier: null },
      }),
      [200],
    );
    expect(updated.body.selectedModel).toBe("claude-fable-5-1");

    const unknown = await preferences.update({
      headers,
      body: { selectedModel: "not-a-catalog-model", serviceTier: null },
    });
    expect(unknown.status).toBe(400);
  });
});
