import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { publicChatActor } from "./helpers/public-chat-actor";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();
const api = createRunsApi(context);
const { configureSubscriptionPiModel } = createChatEventsFixture(context);

describe("Runner built-in and personal dispatch", () => {
  it("dispatches Auto with managed Pi routing and persisted attribution", async () => {
    const owned = await publicChatActor(context);
    await owned.run(async () => {
      const run = await api.createThreadRun(owned.actor, {
        agentId: owned.agentId,
        prompt: "Use the captured Auto route",
        model: "auto",
      });
      const input = await owned.executionInput(run.runId);
      expect(input).toMatchObject({
        cliAgentType: "pi",
        billableFirewalls: ["model-provider:openrouter-codex"],
        modelUsageProvider: "@preset/okou-1-0",
        modelUsageLongContextMinTotalInputTokens: 100_001,
        piModelConfig: {
          provider: "openrouter",
          baseUrl: "https://openrouter.ai/api/v1",
          model: "@preset/okou-1-0",
          catalogModel: "auto",
        },
      });
      await expect(api.readRun(owned.actor, run.runId)).resolves.toMatchObject({
        status: "running",
        source: {
          providerType: "built-in",
          runtimeProviderType: "openrouter-codex",
          model: "auto",
        },
      });
    });
  });

  it("keeps Auto on the managed Pi preset when Codex execution is enabled", async () => {
    const owned = await publicChatActor(context);
    owned.ownsFeatureSwitches();
    if (!owned.actor.orgId) {
      throw new Error("Expected a workspace owner");
    }
    const switchOwner = { ...owned.actor, orgId: owned.actor.orgId };
    await owned.run(async () => {
      await updateFeatureSwitchesForUser(context, switchOwner, {
        [FeatureSwitchKey.CodexExecution]: true,
      });
      const run = await api.createThreadRun(owned.actor, {
        agentId: owned.agentId,
        prompt: "Use Auto with Codex execution enabled",
        model: "auto",
      });
      const input = await owned.executionInput(run.runId);
      expect(input).toMatchObject({
        cliAgentType: "pi",
        piModelConfig: {
          provider: "openrouter",
          baseUrl: "https://openrouter.ai/api/v1",
          model: "@preset/okou-1-0",
          catalogModel: "auto",
        },
      });
      await expect(api.readRun(owned.actor, run.runId)).resolves.toMatchObject({
        status: "running",
        source: { providerType: "built-in", model: "auto" },
      });
    });
  });

  it("dispatches a captured personal Pi subscription without built-in billing", async () => {
    const owned = await publicChatActor(context);
    await owned.run(async () => {
      await configureSubscriptionPiModel(owned.actor);
      const run = await api.createThreadRun(owned.actor, {
        agentId: owned.agentId,
        prompt: "Use my own subscription",
        model: "gpt-6-luna",
      });
      const input = await owned.executionInput(run.runId);
      expect(input).toMatchObject({
        cliAgentType: "pi",
        billableFirewalls: [],
        modelUsageProvider: "gpt-6-luna",
        modelUsageLongContextMinTotalInputTokens: 0,
        piModelConfig: { provider: "openai-codex" },
      });
      await expect(api.readRun(owned.actor, run.runId)).resolves.toMatchObject({
        status: "running",
        source: { providerType: "codex-oauth-token", model: "gpt-6-luna" },
      });
    });
  });
});
