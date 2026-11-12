import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { completePublicClaudeRun } from "./helpers/public-native-run";
import { publicChatActor } from "./helpers/public-chat-actor";

const context = testContext();
const api = createRunsApi(context);
const { connectors } = createChatEventsFixture(context);

describe.each([false, true])(
  "Runner dispatch permissions (Chat accounts: %s)",
  (chatAccounts) => {
    it("delivers authorized connector permissions to its bound process", async () => {
      const owned = await publicChatActor(context);
      owned.ownsFeatureSwitches();
      await owned.run(async () => {
        await connectors.connectManualGrant(
          owned.actor,
          "figma",
          "api-token",
          { accessToken: "dispatch-figma-token" },
          owned.agentId,
        );
        await connectors.updateFeatureSwitches(owned.actor, {
          connectorChatAccountAccess: chatAccounts,
        });
        const run = await api.createThreadRun(owned.actor, {
          agentId: owned.agentId,
          prompt: "Execute with current connector permissions",
          model: "claude-fable-5-1",
        });
        const input = await owned.claimRunnerRun(run.runId);
        expect(input.networkPolicies?.figma).toStrictEqual({
          allow: ["file_content:read"],
          ask: [],
          deny: [],
          unknownPolicy: "allow",
        });
        const envelope = api.dispatchedRun(run.runId);
        const owner = await api.requestRunRunner(owned.actor, run.runId, [200]);
        expect(owner.body).toMatchObject({
          runnerId: envelope.runnerId,
          runnerHeartbeatGeneration: envelope.heartbeatGeneration,
        });
        await completePublicClaudeRun(
          context,
          run,
          { authorization: `Bearer ${input.sandboxToken}` },
          "The selected Runner completed",
        );
        await expect(
          api.readRun(owned.actor, run.runId),
        ).resolves.toMatchObject({ status: "completed" });
      });
    });

    it("releases cancelled execution before dispatching a later Run with retained permissions", async () => {
      const owned = await publicChatActor(context);
      owned.ownsFeatureSwitches();
      await owned.run(async () => {
        await connectors.connectManualGrant(
          owned.actor,
          "figma",
          "api-token",
          { accessToken: "cancelled-dispatch-figma-token" },
          owned.agentId,
        );
        await connectors.updateFeatureSwitches(owned.actor, {
          connectorChatAccountAccess: chatAccounts,
        });
        const cancelled = await api.createThreadRun(owned.actor, {
          agentId: owned.agentId,
          prompt: "Cancel this execution",
          model: "claude-fable-5-1",
        });
        const input = await owned.claimRunnerRun(cancelled.runId);
        await api.requestCancelRun(owned.actor, cancelled.runId, [200]);
        await createWebhookCallbackApi(context).requestAgentComplete(
          { runId: cancelled.runId, exitCode: 137 },
          { authorization: `Bearer ${input.sandboxToken}` },
          [200],
        );
        await flushWaitUntilForTest();
        await expect(
          api.readRun(owned.actor, cancelled.runId),
        ).resolves.toMatchObject({ status: "cancelled" });
        const next = await api.createThreadRun(owned.actor, {
          agentId: owned.agentId,
          threadId: cancelled.threadId,
          prompt: "Continue with authorized connector access",
        });
        const execution = await owned.claimRunnerRun(next.runId);
        expect(execution.networkPolicies?.figma).toStrictEqual({
          allow: ["file_content:read"],
          ask: [],
          deny: [],
          unknownPolicy: "allow",
        });
        await expect(
          api.readRun(owned.actor, next.runId),
        ).resolves.toMatchObject({ status: "running" });
      });
    });
  },
);
