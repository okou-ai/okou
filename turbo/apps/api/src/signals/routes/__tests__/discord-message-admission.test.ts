import { integrationsDiscordMessageContract } from "@okouai/api-contracts/contracts/integrations-discord-message";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { integrationsDiscordMessageRoutes } from "../integrations-discord-message";
import { createRouteMocks } from "./helpers/route-test";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();
const channelId = "1346579924358245999";

function memberClient(
  actor = { userId: `user_${randomUUID()}`, orgId: `org_${randomUUID()}` },
) {
  createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
  return setupApp({ context, routes: integrationsDiscordMessageRoutes })(
    integrationsDiscordMessageContract,
  );
}

const headers = Object.freeze({ authorization: "Bearer clerk-session" });

describe("Discord message request admission", () => {
  it("rejects messages when Discord is explicitly disabled", async () => {
    const actor = {
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    };
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.DiscordIntegration]: false,
    });
    const response = await accept(
      memberClient(actor).sendMessage({
        headers,
        body: { channelId, text: "Reply" },
      }),
      [403],
    );
    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(response.body.error.deliveredMessages).toStrictEqual([]);
  });
});
