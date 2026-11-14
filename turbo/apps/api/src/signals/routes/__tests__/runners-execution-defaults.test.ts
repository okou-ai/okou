import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { publicChatActor } from "./helpers/public-chat-actor";

const context = testContext();
const api = createRunsApi(context);
const bdd = createBddApi(context);

describe("Direct Run launch defaults", () => {
  it("pins the dispatch timezone and retains restrictions and identity with compact context", async () => {
    mockEnv("APP_URL", "https://claim-defaults.example");
    const owned = await publicChatActor(context);
    await owned.run(async () => {
      await bdd.updateUserTimezone(owned.actor, "America/Los_Angeles");
      const queued = await api.createThreadRun(owned.actor, {
        agentId: owned.agentId,
        prompt: "prepare the accepted Run with current missing preferences",
      });
      await bdd.updateUserTimezone(owned.actor, "Asia/Shanghai");

      const { execution } = await owned.runExecution(queued.runId);
      expect(execution.userTimezone).toBe("America/Los_Angeles");
      expect(execution.disallowedTools).toStrictEqual(
        expect.arrayContaining(["CronCreate", "Skill(loop)"]),
      );
      expect(execution.platformEnvironment).toMatchObject({
        OKOU_APP_URL: "https://claim-defaults.example",
        OKOU_AGENT_ID: owned.agentId,
        OKOU_CHAT_THREAD_ID: queued.threadId,
        OKOU_TOKEN: expect.any(String),
      });
    });
  });
});
