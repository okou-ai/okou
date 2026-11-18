import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { MODEL_PROVIDER_ENV_PLACEHOLDERS } from "@okouai/api-contracts/contracts/model-provider-firewalls";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { publicChatActor } from "./helpers/public-chat-actor";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { decryptSecretForTests } from "./helpers/encrypt-secret";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();
const api = createRunsApi(context);
const firewall = createFirewallApi(context);
const webhooks = createWebhookCallbackApi(context);
const MANAGED_KEY = "okou-fake-managed-model-key-sentinel-3f9c1e7a";
const { configureSubscriptionPiModel } = createChatEventsFixture(context);

describe("Runner built-in and personal dispatch", () => {
  it("dispatches managed Auto placeholders and resolves only the Run-owned credential", async () => {
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
        platformEnvironment: { OKOU_CURRENT_INTEGRATION: "web" },
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
      if (!input.encryptedSecrets) {
        throw new Error("Expected the remaining global secret envelope");
      }
      expect(JSON.stringify(input)).not.toContain(MANAGED_KEY);
      expect(decryptSecretForTests(input.encryptedSecrets)).not.toContain(
        MANAGED_KEY,
      );
      expect(input.environment?.OPENAI_API_KEY).toBe(
        MODEL_PROVIDER_ENV_PLACEHOLDERS.OPENAI_API_KEY,
      );
      const authHeaders = {
        Authorization: `Bearer ${secretTemplate("OPENROUTER_API_KEY")}`,
      };
      if (!input.firewallToken) {
        throw new Error("Expected the host firewall authority");
      }
      expect(input.secretValues).not.toContain(input.firewallToken);
      const firewallHeaders = {
        authorization: `Bearer ${input.firewallToken!}`,
      };
      await webhooks.requestAgentHeartbeat(
        { runId: run.runId },
        firewallHeaders,
        [401],
      );
      await firewall.requestFirewallAuth(
        { authorization: `Bearer ${input.platformEnvironment.OKOU_TOKEN!}` },
        { authHeaders },
        [401],
      );
      await firewall.requestFirewallAuth(
        { authorization: `Bearer ${input.sandboxToken}` },
        { authHeaders },
        [400],
      );
      await firewall.requestFirewallAuth(
        {
          authorization: `Bearer ${input.sandboxToken.replace("vm0_sandbox_", "vm0_firewall_")}`,
        },
        { authHeaders },
        [401],
      );
      for (const { headers, encryptedSecrets } of [
        { headers: firewallHeaders, encryptedSecrets: undefined },
        { headers: firewallHeaders, encryptedSecrets: input.encryptedSecrets },
        {
          headers: { authorization: `Bearer ${input.sandboxToken}` },
          encryptedSecrets: input.encryptedSecrets,
        },
      ]) {
        const resolved = await firewall.requestFirewallAuth(
          headers,
          { encryptedSecrets, authHeaders, firewallBillable: true },
          [200],
        );
        expect(resolved.body).toMatchObject({
          headers: { Authorization: `Bearer ${MANAGED_KEY}` },
          resolvedSecrets: ["OPENROUTER_API_KEY"],
          expiresAt: expect.any(Number),
        });
      }
      const mapped = await firewall.requestFirewallAuth(
        firewallHeaders,
        {
          authHeaders,
          secretConnectorMap: { OPENROUTER_API_KEY: "codex-oauth-token" },
          secretConnectorMetadataMap: {
            OPENROUTER_API_KEY: {
              sourceType: "model-provider",
              sourceId: run.runId,
              sourceUserId: owned.actor.userId,
              metadataKey: "codex-oauth-token",
            },
          },
        },
        [424],
      );
      expect(mapped.body).toMatchObject({
        error: { code: "CONNECTOR_NOT_CONFIGURED" },
      });
      const unpairedMetadata = await firewall.requestFirewallAuth(
        firewallHeaders,
        {
          authHeaders,
          secretConnectorMetadataMap: {
            OPENROUTER_API_KEY: {
              sourceType: "model-provider",
              sourceId: run.runId,
              sourceUserId: owned.actor.userId,
              metadataKey: "codex-oauth-token",
            },
          },
        },
        [424],
      );
      expect(unpairedMetadata.body).toMatchObject({
        error: { code: "CONNECTOR_NOT_CONFIGURED" },
      });
      const inspected = await api.readRun(owned.actor, run.runId);
      expect(JSON.stringify(inspected)).not.toContain(input.firewallToken);
      expect(inspected).toMatchObject({
        status: "running",
        source: {
          providerType: "built-in",
          runtimeProviderType: "openrouter-codex",
          model: "auto",
        },
      });
      await api.requestCancelRun(owned.actor, run.runId, [200]);
      await firewall.requestFirewallAuth(
        firewallHeaders,
        { authHeaders },
        [403],
      );
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
      const { oauth } = await configureSubscriptionPiModel(owned.actor);
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
        piModelConfig: {
          provider: "openai-codex",
          model: "gpt-6-luna",
          thinkingLevel: "xhigh",
        },
      });
      await expect(api.readRun(owned.actor, run.runId)).resolves.toMatchObject({
        status: "running",
        source: { providerType: "codex-oauth-token", model: "gpt-6-luna" },
      });
      if (!input.secretConnectorMap || !input.secretConnectorMetadataMap) {
        throw new Error("Expected the personal model's account references");
      }
      const personal = await firewall.requestFirewallAuth(
        { authorization: `Bearer ${input.firewallToken!}` },
        {
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("CHATGPT_ACCESS_TOKEN")}`,
          },
          secretConnectorMap: input.secretConnectorMap,
          secretConnectorMetadataMap: input.secretConnectorMetadataMap,
        },
        [200],
      );
      expect(personal.body).toMatchObject({
        headers: {
          Authorization: `Bearer ${oauth.oauthTokenResponses[0]?.access_token}`,
        },
        resolvedSecrets: ["CHATGPT_ACCESS_TOKEN"],
      });
      const unavailable = await firewall.requestFirewallAuth(
        { authorization: `Bearer ${input.firewallToken!}` },
        {
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("OPENROUTER_API_KEY")}`,
          },
        },
        [424],
      );
      expect(unavailable.body).toMatchObject({
        error: { code: "CONNECTOR_NOT_CONFIGURED" },
      });
    });
  });
});
