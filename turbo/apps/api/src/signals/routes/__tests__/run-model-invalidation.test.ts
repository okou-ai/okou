import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  personalModelProvidersMainContract,
  personalModelProvidersByTypeContract,
} from "@okouai/api-contracts/contracts/personal-model-providers";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { meModelProvidersDeleteRoutes } from "../me-model-providers-delete";
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

describe("personal subscription invalidation", () => {
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
});
