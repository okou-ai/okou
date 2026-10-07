import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runModelsMainContract } from "@okouai/api-contracts/contracts/run-models";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { runModelsRoutes } from "../run-models";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";

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
  it("offers Auto as the null selection to a member without subscriptions", async () => {
    const member = identity();
    mocks.clerk.session(member.userId, member.orgId);
    const response = await accept(list(), [200]);
    expect(response.body).not.toHaveProperty("defaultModel");
    expect(response.body.models).toStrictEqual([
      expect.objectContaining({
        model: null,
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
    ).toStrictEqual([null]);
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
});
