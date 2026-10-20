import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runModelsMainContract } from "@okouai/api-contracts/contracts/run-models";
import {
  personalModelProviderAccountsByIdContract,
  personalModelProvidersByTypeContract,
  personalModelProvidersMainContract,
} from "@okouai/api-contracts/contracts/personal-model-providers";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { runModelsRoutes } from "../run-models";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { meModelProviderAccountRoutes } from "../me-model-provider-accounts";
import { meModelProvidersDeleteRoutes } from "../me-model-providers-delete";
import { userModelPreferenceRoutes } from "../user-model-preference";

import { createRouteMocks } from "./helpers/route-test";
const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
function identity() {
  const suffix = randomUUID();
  return {
    orgId: `org_run_models_${suffix}`,
    userId: `user_run_models_${suffix}`,
  };
}
function list() {
  return setupApp({ context, routes: runModelsRoutes })(
    runModelsMainContract,
  ).list({ headers });
}

describe("available run models", () => {
  it("offers canonical Auto to a member without subscriptions", async () => {
    const member = identity();
    mocks.clerk.session(member.userId, member.orgId);
    const response = await accept(list(), [200]);
    expect(response.body.models).toStrictEqual([
      expect.objectContaining({
        model: "auto",
        modelLabel: "Auto",
        memberEffective: expect.objectContaining({
          runtimeProviderType: "openrouter-codex",
          credentialScope: "org",
        }),
        modelProviderId: null,
      }),
    ]);
  });
  it("offers a connected personal Claude subscription only to its owner", async () => {
    const member = identity();
    mocks.clerk.session(member.userId, member.orgId);
    await accept(
      setupApp({ context, routes: meModelProvidersUpsertRoutes })(
        personalModelProvidersMainContract,
      ).upsert({
        headers,
        body: { type: "claude-code-oauth-token", secret: "sk-ant-test" },
      }),
      [200, 201],
    );
    const response = await accept(list(), [200]);
    expect(response.body.models).toContainEqual(
      expect.objectContaining({
        memberEffective: expect.objectContaining({
          providerType: "claude-code-oauth-token",
          credentialScope: "member",
        }),
        subscriptionOptions: expect.objectContaining({
          efforts: expect.any(Array),
        }),
      }),
    );
    mocks.clerk.session(`user_other_${randomUUID()}`, member.orgId);
    const other = await accept(list(), [200]);
    expect(
      other.body.models.map((model) => {
        return model.model;
      }),
    ).toStrictEqual(["auto"]);
  });
  it("requires authentication", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
      toAuth: () => {
        return {};
      },
    });
    const response = await accept(list(), [401]);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it.each(["account", "provider"] as const)(
    "returns the selected subscription model to Auto after %s disconnection",
    async (selection) => {
      const member = identity();
      mocks.clerk.session(member.userId, member.orgId);
      const connected = await accept(
        setupApp({ context, routes: meModelProvidersUpsertRoutes })(
          personalModelProvidersMainContract,
        ).upsert({
          headers,
          body: { type: "claude-code-oauth-token", secret: "sk-ant-test" },
        }),
        [201],
      );
      const available = await accept(list(), [200]);
      const subscription = available.body.models.find((model) => {
        return model.memberEffective.providerType === "claude-code-oauth-token";
      });
      if (!subscription) {
        throw new Error("Expected a listed personal Claude model");
      }
      const preference = setupApp({
        context,
        routes: userModelPreferenceRoutes,
      })(userModelPreferenceContract);
      const selected = await accept(
        preference.update({
          headers,
          body: { selectedModel: subscription.model, serviceTier: null },
        }),
        [200],
      );
      expect(selected.body.selectedModel).toBe(subscription.model);

      if (selection === "account") {
        await accept(
          setupApp({ context, routes: meModelProviderAccountRoutes })(
            personalModelProviderAccountsByIdContract,
          ).delete({ headers, params: { id: connected.body.provider.id } }),
          [204],
        );
      } else {
        await accept(
          setupApp({ context, routes: meModelProvidersDeleteRoutes })(
            personalModelProvidersByTypeContract,
          ).delete({ headers, params: { type: "claude-code-oauth-token" } }),
          [204],
        );
      }

      const afterDisconnect = await accept(list(), [200]);
      expect(
        afterDisconnect.body.models.map((model) => {
          return model.model;
        }),
      ).toStrictEqual(["auto"]);
      const repaired = await accept(preference.get({ headers }), [200]);
      expect(repaired.body).toMatchObject({
        selectedModel: "auto",
        serviceTier: null,
      });
    },
  );
});
