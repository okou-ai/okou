import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { clearMockedEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { sendAgentPhoneMessage } from "../agentphone-client";

const AGENTPHONE_API_BASE_URL = "https://api.agentphone.test";

describe("AgentPhone client", () => {
  afterEach(() => {
    clearMockedEnv();
  });

  it("does not invent a provider message id when a successful send omits it", async () => {
    mockOptionalEnv("AGENTPHONE_API_BASE_URL", AGENTPHONE_API_BASE_URL);
    mockOptionalEnv("AGENTPHONE_API_KEY", "agentphone-test-key");
    server.use(
      http.post(`${AGENTPHONE_API_BASE_URL}/v1/messages`, () => {
        return HttpResponse.json({ status: "sent" });
      }),
    );

    await expect(
      sendAgentPhoneMessage({
        agentphoneAgentId: "agt-test",
        toNumber: "+15551234567",
        body: "Test message",
      }),
    ).rejects.toThrow("AgentPhone send response is missing a message id");
  });
});
