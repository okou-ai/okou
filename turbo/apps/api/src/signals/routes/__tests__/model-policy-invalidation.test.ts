import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  personalModelProvidersMainContract,
  personalModelProvidersByTypeContract,
} from "@okouai/api-contracts/contracts/personal-model-providers";
import {
  modelProviderConnectionsMainContract,
  modelProviderConnectionsByIdContract,
} from "@okouai/api-contracts/contracts/model-provider-gateways";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { meModelProvidersDeleteRoutes } from "../me-model-providers-delete";
import { modelProviderGatewayRoutes } from "../model-provider-gateways";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function identity(): { userId: string; orgId: string } {
  const userId = `user_projection_${randomUUID()}`;
  const orgId = `org_projection_${randomUUID()}`;
  mocks.clerk.session(userId, orgId, "org:admin");
  return { userId, orgId };
}

describe("model policy invalidation", () => {
  it("publishes account changes only to the owner without account details", async () => {
    const { userId, orgId } = identity();
    const client = setupApp({ context, routes: meModelProvidersUpsertRoutes })(
      personalModelProvidersMainContract,
    );
    await accept(
      client.upsert({
        headers: authHeaders(),
        body: {
          type: "claude-code-oauth-token",
          secret: "sk-ant-synthetic-projection",
        },
      }),
      [201],
    );
    expect(context.mocks.ably.channelGet).toHaveBeenCalledWith(
      `user:${userId}`,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "modelPoliciesChanged",
      null,
    );
    expect(context.mocks.ably.channelGet).not.toHaveBeenCalledWith(
      `org:${orgId}`,
    );

    // Failure to publish must not undo the committed disconnect.
    context.mocks.ably.publish.mockRejectedValue(
      new Error("Realtime unavailable"),
    );
    const byType = setupApp({ context, routes: meModelProvidersDeleteRoutes })(
      personalModelProvidersByTypeContract,
    );
    await accept(
      byType.delete({
        headers: authHeaders(),
        params: { type: "claude-code-oauth-token" },
      }),
      [204],
    );
    await accept(
      byType.delete({
        headers: authHeaders(),
        params: { type: "claude-code-oauth-token" },
      }),
      [404],
    );
  });

  it("publishes organization surface changes after successful mutations", async () => {
    const { orgId } = identity();
    const clients = setupApp({ context, routes: modelProviderGatewayRoutes });
    const main = clients(modelProviderConnectionsMainContract);
    const byId = clients(modelProviderConnectionsByIdContract);
    const surfaces = [
      {
        protocol: "openai-responses" as const,
        apiBaseUrl: "https://gateway.example.com/v1",
        authHeaderName: "Authorization",
        authHeaderTemplate: "Bearer {{secret}}",
        modelMappings: { "gpt-5.6-sol": "enterprise-model" },
      },
    ];
    const created = await accept(
      main.create({
        headers: authHeaders(),
        body: {
          displayName: "Company gateway",
          secret: "synthetic-gateway-key",
          surfaces,
        },
      }),
      [201],
    );
    expect(context.mocks.ably.channelGet).toHaveBeenCalledWith(`org:${orgId}`);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "modelPoliciesChanged",
      null,
    );
    await accept(
      byId.update({
        headers: authHeaders(),
        params: { id: created.body.id },
        body: { displayName: "Updated gateway", surfaces },
      }),
      [200],
    );
    const listed = await accept(main.list({ headers: authHeaders() }), [200]);
    expect(listed.body.connections).toContainEqual(
      expect.objectContaining({
        id: created.body.id,
        displayName: "Updated gateway",
      }),
    );
    context.mocks.ably.publish.mockRejectedValue(
      new Error("Realtime unavailable"),
    );
    await accept(
      byId.delete({ headers: authHeaders(), params: { id: created.body.id } }),
      [204],
    );
    const after = await accept(main.list({ headers: authHeaders() }), [200]);
    expect(after.body.connections).toStrictEqual([]);
  });
});
