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
  it("claims fixed Auto as an OpenRouter Chat Completions preset route", async () => {
    await seedBuiltInModelKey("okou-1.0");
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    const run = await sendChatRun(actor, {
      agentId,
      model: null,
      prompt: "Use fixed Auto",
    });
    // A Runner that predates generation 5 leaves the job queued.
    await api.heartbeatRunner(runnerGroup);
    await api.requestClaimRunnerJob(true, run.runId, [404], {
      capabilities: { piModelConfigGenerations: [1, 2, 3] },
    });
    await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
      status: "pending",
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
    expect(claimed.claim.piModelConfig).toStrictEqual({
      schemaVersion: 5,
      dialect: "openai-completions",
      transport: "sse",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "@preset/okou-1-0",
      catalogModel: "okou-1.0",
      credentialBindings: [
        {
          kind: "api-key",
          environment: "OPENAI_API_KEY",
          secretName: "OPENROUTER_API_KEY",
        },
      ],
    });
  });
});
