import { describe, expect, it, onTestFinished } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { testContext } from "../../../__tests__/test-context";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

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
      model: null,
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

  it("claims fixed Auto as an OpenRouter Chat Completions route when enabled", async () => {
    await seedBuiltInModelKey("okou-1.0");
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped actor");
    }
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      { [FeatureSwitchKey.PiOpenRouterChatCompletions]: true },
    );
    const run = await sendChatRun(actor, {
      agentId,
      model: null,
      prompt: "Use fixed Auto over Chat Completions",
    });
    const claimed = await claimChatRun(runnerGroup, run.runId);
    onTestFinished(async () => {
      await cancelChatRun(actor, run.runId, claimed.sandboxHeaders);
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
