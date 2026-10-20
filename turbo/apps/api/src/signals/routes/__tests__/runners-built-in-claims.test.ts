import { randomUUID } from "node:crypto";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { publicChatActor } from "./helpers/public-chat-actor";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";

const context = testContext();
const api = createRunsApi(context);
const { configureSubscriptionPiModel } = createChatEventsFixture(context);

describe("Runner built-in claim authorization", () => {
  it("denies PATs before decryption and leaves Auto claimable by an official Runner", async () => {
    const kms = useSecretKmsProbe();
    const owned = await publicChatActor(context, { isolatePg: true });
    const { actor, agentId, runnerGroup } = owned;

    await owned.run(async () => {
      const bdd = createBddApi(context);
      const member = bdd.user({
        orgId: actor.orgId,
        orgRole: "org:member",
      });
      const foreign = bdd.user();
      const ownerKey = await api.createCliToken(actor);
      const memberKey = await api.createCliToken(member);
      const foreignKey = await api.createCliToken(foreign);
      const queued = await api.createThreadRun(actor, {
        agentId,
        prompt: "use the captured Auto route",
        model: "auto",
      });
      await flushWaitUntilForTest();
      const decryptions = kms.decryptCalls;

      const ownerDenied = await owned.claimPatRun(
        `Bearer ${ownerKey.token}`,
        queued.runId,
        [403],
      );
      expect(ownerDenied.body).toMatchObject({
        error: {
          code: "FORBIDDEN",
          message: "Built-in model jobs require an official runner",
        },
      });
      const spoofed = await owned.claimPatRun(
        `Bearer ${ownerKey.token}`,
        queued.runId,
        [403],
        {
          runnerIdentity: {
            runnerId: randomUUID(),
            heartbeatGeneration: 1,
          },
          runnerHostname: "self-reported-official-runner",
          capabilities: { piModelConfigGenerations: [2, 3, 5] },
        },
        { "X-Client-Version": "9999.0.0" },
      );
      expect(spoofed.body).toStrictEqual(ownerDenied.body);
      for (const key of [memberKey, foreignKey]) {
        const denied = await api.requestClaimRunnerJobAs(
          `Bearer ${key.token}`,
          queued.runId,
          [403],
        );
        expect(denied.body).toMatchObject({
          error: { code: "FORBIDDEN", message: "Job does not belong to user" },
        });
      }
      expect(kms.decryptCalls).toBe(decryptions);

      await api.requestClaimRunnerJob(true, queued.runId, [404], {
        capabilities: { piModelConfigGenerations: [2, 3] },
      });
      expect(kms.decryptCalls).toBe(decryptions);
      await expect(api.readRun(actor, queued.runId)).resolves.toMatchObject({
        status: "pending",
        source: {
          providerType: "built-in",
          runtimeProviderType: "openrouter-codex",
          model: "auto",
        },
      });

      const { claim } = await owned.claimChatRun(runnerGroup, queued.runId);
      expect(claim).toMatchObject({
        cliAgentType: "pi",
        piModelConfig: {
          provider: "openrouter",
          baseUrl: "https://openrouter.ai/api/v1",
          model: "@preset/okou-1-0",
          catalogModel: "auto",
        },
      });
      await expect(api.readRun(actor, queued.runId)).resolves.toMatchObject({
        status: "running",
      });
      const claimedDecryptions = kms.decryptCalls;
      await api.requestClaimRunnerJob(true, queued.runId, [404]);
      expect(kms.decryptCalls).toBe(claimedDecryptions);
    });
  });

  it("keeps Auto on the managed Pi preset when Codex execution is enabled", async () => {
    const owned = await publicChatActor(context, { isolatePg: true });
    owned.ownsFeatureSwitches();
    const { actor, agentId, runnerGroup } = owned;
    if (!actor.orgId) {
      throw new Error("Expected a workspace owner");
    }
    const switchOwner = { ...actor, orgId: actor.orgId };
    await owned.run(async () => {
      await updateFeatureSwitchesForUser(context, switchOwner, {
        [FeatureSwitchKey.CodexExecution]: true,
      });
      const queued = await api.createThreadRun(actor, {
        agentId,
        prompt: "use Auto with Codex execution enabled",
        model: "auto",
      });
      const key = await api.createCliToken(actor);
      await owned.claimPatRun(`Bearer ${key.token}`, queued.runId, [403]);
      const { claim } = await owned.claimChatRun(runnerGroup, queued.runId);
      expect(claim).toMatchObject({
        cliAgentType: "pi",
        piModelConfig: {
          provider: "openrouter",
          baseUrl: "https://openrouter.ai/api/v1",
          model: "@preset/okou-1-0",
          catalogModel: "auto",
        },
      });
      await expect(api.readRun(actor, queued.runId)).resolves.toMatchObject({
        status: "running",
        source: { providerType: "built-in", model: "auto" },
      });
    });
  });

  it("preserves PAT claims for a captured personal Pi subscription", async () => {
    const owned = await publicChatActor(context, { isolatePg: true });
    const { actor, agentId } = owned;
    await owned.run(async () => {
      await configureSubscriptionPiModel(actor);
      const key = await api.createCliToken(actor);
      const queued = await api.createThreadRun(actor, {
        agentId,
        prompt: "use my own subscription",
        model: "gpt-6-luna",
      });
      const response = await owned.claimPatRun(
        `Bearer ${key.token}`,
        queued.runId,
        [200],
      );
      expect(response.body).toMatchObject({
        cliAgentType: "pi",
        piModelConfig: { provider: "openai-codex" },
      });
      await expect(api.readRun(actor, queued.runId)).resolves.toMatchObject({
        status: "running",
        source: { providerType: "codex-oauth-token", model: "gpt-6-luna" },
      });
    });
  });
});
