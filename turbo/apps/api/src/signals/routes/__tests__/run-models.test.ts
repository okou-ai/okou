import { randomUUID } from "node:crypto";
import {
  personalModelProviderAccountsByIdContract,
  personalModelProvidersMainContract,
} from "@okouai/api-contracts/contracts/personal-model-providers";
import { runModelsMainContract } from "@okouai/api-contracts/contracts/run-models";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import { describe, expect, it } from "vitest";
import { setupApp } from "../../../__tests__/test-helpers";
import { accept, testContext } from "../../../__tests__/test-context";
import { meModelProviderAccountRoutes } from "../me-model-provider-accounts";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { runModelsRoutes } from "../run-models";
import { userModelPreferenceRoutes } from "../user-model-preference";
import { mockClaudeCodeTokenEndpoint } from "./helpers/api-bdd-auth-device";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function signIn(userId: string, orgId: string) {
  createRouteMocks(context).clerk.session(userId, orgId, "org:member");
}

async function listRunModels() {
  const api = setupApp({ context, routes: runModelsRoutes })(
    runModelsMainContract,
  );
  const response = await accept(api.list({ headers }), [200]);
  return response.body.models;
}

async function connectClaudeSubscription() {
  mockClaudeCodeTokenEndpoint();
  const api = setupApp({ context, routes: meModelProvidersUpsertRoutes })(
    personalModelProvidersMainContract,
  );
  const response = await accept(
    api.upsert({
      headers,
      body: { type: "claude-code-oauth-token", secret: "member-claude-token" },
    }),
    [201],
  );
  return {
    accountId: response.body.provider.id,
    providerId: response.body.provider.modelProviderId,
  };
}

describe("available run models", () => {
  it("run-models-001 offers only Auto to a member without subscriptions", async () => {
    signIn(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const models = await listRunModels();

    expect(models).toStrictEqual([
      {
        model: "auto",
        modelLabel: "Auto",
        modelProviderId: null,
        memberEffective: expect.objectContaining({
          runtimeProviderType: "openrouter-codex",
          credentialScope: "org",
        }),
      },
    ]);
  });

  it("run-models-002 offers a personal Claude subscription only to its owner", async () => {
    const orgId = `org_${randomUUID()}`;
    signIn(`user_${randomUUID()}`, orgId);
    await connectClaudeSubscription();

    const ownerModels = await listRunModels();
    signIn(`user_${randomUUID()}`, orgId);
    const otherModels = await listRunModels();

    const subscriptionModel = ownerModels.find((model) => {
      return (
        model.memberEffective.runtimeProviderType === "claude-code-oauth-token"
      );
    });
    expect(subscriptionModel?.memberEffective.credentialScope).toBe("member");
    expect(
      subscriptionModel?.subscriptionOptions?.efforts.length,
    ).toBeGreaterThan(0);
    expect(
      otherModels.map((model) => {
        return model.model;
      }),
    ).toStrictEqual(["auto"]);
  });

  it("run-models-004 returns a selected subscription model to Auto after disconnection", async () => {
    signIn(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const { accountId, providerId } = await connectClaudeSubscription();
    const subscriptionModel = (await listRunModels()).find((model) => {
      return model.modelProviderId === providerId;
    })?.model;
    if (!subscriptionModel) {
      throw new Error("Expected the connected subscription to offer a model");
    }
    const preferences = setupApp({
      context,
      routes: userModelPreferenceRoutes,
    })(userModelPreferenceContract);
    const selected = await accept(
      preferences.update({
        headers,
        body: { selectedModel: subscriptionModel, serviceTier: null },
      }),
      [200],
    );
    expect(selected.body.selectedModel).toBe(subscriptionModel);

    const accounts = setupApp({
      context,
      routes: meModelProviderAccountRoutes,
    })(personalModelProviderAccountsByIdContract);
    await accept(
      accounts.delete({ headers, params: { id: accountId } }),
      [204],
    );

    expect(
      (await listRunModels()).map((model) => {
        return model.model;
      }),
    ).toStrictEqual(["auto"]);
    const preference = await accept(preferences.get({ headers }), [200]);
    expect(preference.body).toMatchObject({
      selectedModel: "auto",
      serviceTier: null,
    });
  });
});
