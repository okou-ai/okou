import { describe, expect, it, onTestFinished } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";

const context = testContext();
const {
  api,
  entitledNativeChatActor,
  seedBuiltInModelKey,
  sendChatRun,
  claimChatRun,
  cancelChatRun,
} = createChatEventsFixture(context);

describe("fixed Auto through public admission and runner claim", () => {
  it("claims fixed Auto through the platform OpenRouter preset", async () => {
    await seedBuiltInModelKey("okou-1.0");
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    const run = await sendChatRun(actor, {
      agentId,
      model: "okou-1.0",
      prompt: "Use fixed Auto",
    });
    const claimed = await claimChatRun(runnerGroup, run.runId);
    onTestFinished(async () => {
      await cancelChatRun(actor, run.runId, claimed.sandboxHeaders);
    });
    const log = await api.readRun(actor, run.runId);
    expect(log.source).toMatchObject({
      model: "okou-1.0",
      providerType: "built-in",
      credentialScope: "org",
    });
    expect(claimed.claim.cliAgentType).toBe("pi");
    expect(claimed.claim.piModelConfig).toMatchObject({
      provider: "openrouter",
      model: "@preset/okou-1-0",
      catalogModel: "okou-1.0",
    });
  });
});
