import { randomUUID } from "node:crypto";

import { piLangfuseTracesContract } from "@okouai/api-contracts/contracts/pi-langfuse";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { generateOkouToken, generateSandboxToken } from "../../auth/tokens";
import { webhooksAgentLangfuseRoutes } from "../webhooks-agent-langfuse";

const context = testContext();

describe("Pi trace relay authentication", () => {
  it.each(["missing", "invalid", "runner-token", "another-run"])(
    "rejects %s authentication before trace export",
    async (credential) => {
      const runId = randomUUID();
      const userId = `user_${randomUUID()}`;
      const orgId = `org_${randomUUID()}`;
      const tokens: Record<string, string | undefined> = {
        missing: undefined,
        invalid: "invalid-token",
        "runner-token": generateSandboxToken(userId, runId, orgId),
        "another-run": generateOkouToken(userId, randomUUID(), orgId),
      };
      const token = tokens[credential];
      const result = await accept(
        setupApp({ context, routes: webhooksAgentLangfuseRoutes })(
          piLangfuseTracesContract,
        ).export({
          params: { runId },
          headers: token ? { authorization: `Bearer ${token}` } : {},
          extraHeaders: { "content-type": "application/json" },
          body: '{"resourceSpans":[]}',
        }),
        [401],
      );
      expect(result.body.error.code).toBe("UNAUTHORIZED");
    },
  );
});
