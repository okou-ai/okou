import { integrationsSlackUploadCompleteContract } from "@okouai/api-contracts/contracts/integrations";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { integrationsSlackUploadCompleteRoutes } from "../integrations-slack-upload-complete";

const context = testContext();

describe("POST /api/integrations/slack/upload-file/complete", () => {
  it("integrations-slack-upload-complete-029 returns 401 when no auth token is provided", async () => {
    const client = setupApp({
      context,
      routes: integrationsSlackUploadCompleteRoutes,
    })(integrationsSlackUploadCompleteContract);

    const response = await accept(
      client.complete({
        headers: { authorization: "" },
        body: {
          fileId: "F123",
          channel: "C123",
        },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });
});
