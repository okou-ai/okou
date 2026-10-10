import { integrationsDiscordMessageContract } from "@okouai/api-contracts/contracts/integrations-discord-message";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { integrationsDiscordMessageRoutes } from "../integrations-discord-message";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const channelId = "1346579924358245999";

function memberClient() {
  createRouteMocks(context).clerk.session(
    `user_${randomUUID()}`,
    `org_${randomUUID()}`,
  );
  return setupApp({ context, routes: integrationsDiscordMessageRoutes })(
    integrationsDiscordMessageContract,
  );
}

const headers = Object.freeze({ authorization: "Bearer clerk-session" });

describe("Discord message request admission", () => {
  it.each(["", "0", "-1", "1.5", "1e3", "18446744073709551616"])(
    "rejects invalid reply message ID %j through the production API",
    async (replyToMessageId) => {
      const response = await accept(
        memberClient().sendMessage({
          headers,
          body: { channelId, replyToMessageId, text: "Reply" },
        }),
        [400],
      );
      expect(response.body.error.code).toBe("BAD_REQUEST");
    },
  );

  it.each([undefined, "18446744073709551615"])(
    "keeps default-off admission for an otherwise valid reply ID %j",
    async (replyToMessageId) => {
      const response = await accept(
        memberClient().sendMessage({
          headers,
          body: { channelId, replyToMessageId, text: "Reply" },
        }),
        [403],
      );
      expect(response.body.error.code).toBe("FORBIDDEN");
      expect(response.body.error.deliveredMessages).toStrictEqual([]);
    },
  );
});
