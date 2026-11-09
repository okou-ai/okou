import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { publicChatActor } from "./helpers/public-chat-actor";

const context = testContext();
const api = createRunsApi(context);
const bdd = createBddApi(context);

describe("Runner Claim launch defaults", () => {
  it("uses a newly configured timezone and retains launch restrictions and identity", async () => {
    mockEnv("APP_URL", "https://claim-defaults.example");
    const owned = await publicChatActor(context);
    await owned.run(async () => {
      const queued = await api.createThreadRun(owned.actor, {
        agentId: owned.agentId,
        prompt: "prepare the accepted Run with current missing preferences",
      });
      await bdd.updateUserTimezone(owned.actor, "Asia/Shanghai");

      const { claim } = await owned.claimChatRun(
        owned.runnerGroup,
        queued.runId,
      );
      expect(claim.userTimezone).toBe("Asia/Shanghai");
      expect(claim.disallowedTools).toStrictEqual(
        expect.arrayContaining(["CronCreate", "Skill(loop)"]),
      );
      expect(claim.platformEnvironment).toMatchObject({
        OKOU_APP_URL: "https://claim-defaults.example",
        OKOU_AGENT_ID: owned.agentId,
        OKOU_CHAT_THREAD_ID: queued.threadId,
        OKOU_TOKEN: expect.any(String),
      });
    });
  });
});
