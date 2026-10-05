import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runModelsMainContract } from "@okouai/api-contracts/contracts/run-models";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { runModelsRoutes } from "../run-models";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";

const context = testContext();
const headers = { authorization: "Bearer clerk-session" };
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
  it("offers fixed Auto to a member without subscriptions", async () => {
    const member = identity();
    context.mocks.clerk.session(member.userId, member.orgId);
    const response = await accept(list(), [200]);
    expect(response.body.defaultModel).toBe("okou-1.0");
    expect(response.body.models).toStrictEqual([
      expect.objectContaining({
        model: "okou-1.0",
        modelLabel: "Auto",
        runtimeProviderType: "openrouter-codex",
        credentialScope: "org",
        modelProviderId: null,
      }),
    ]);
  });
  it("offers a connected personal Claude subscription only to its owner", async () => {
    const member = identity();
    context.mocks.clerk.session(member.userId, member.orgId);
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
        defaultProviderType: "claude-code-oauth-token",
        credentialScope: "member",
        subscriptionOptions: expect.objectContaining({
          efforts: expect.any(Array),
        }),
      }),
    );
    context.mocks.clerk.session(`user_other_${randomUUID()}`, member.orgId);
    const other = await accept(list(), [200]);
    expect(other.body.models.map((model) => model.model)).toStrictEqual(["okou-1.0"]);
  });
});
