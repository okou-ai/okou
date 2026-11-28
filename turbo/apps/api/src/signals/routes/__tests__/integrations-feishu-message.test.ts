import { integrationsFeishuMessageContract } from "@okouai/api-contracts/contracts/integrations";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { integrationsFeishuMessageRoutes } from "../integrations-feishu-message";

const context = testContext();

function messageClient() {
  return setupApp({ context, routes: integrationsFeishuMessageRoutes })(
    integrationsFeishuMessageContract,
  );
}

describe("POST /api/integrations/feishu/message", () => {
  it("integrations-feishu-message-001 rejects an unauthenticated Feishu send", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });

    const response = await accept(
      messageClient().sendMessage({
        headers: {},
        body: { chat: "oc_chat", text: "hello" },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });
});
