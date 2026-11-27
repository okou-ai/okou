import { randomUUID } from "node:crypto";
import {
  AUTO_RUN_UPSTREAM_MODEL,
  AUTO_SELECTED_MODEL,
} from "@okouai/core/auto-run-model";
import { describe, expect, it } from "vitest";
import { string } from "zod";
import { testContext } from "../../../__tests__/test-context";
import {
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { mockOptionalEnv } from "../../../lib/env";
import { createBddApi } from "./helpers/api-bdd";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  createChatEventsFixture,
  modelProviderSecretPlaceholder,
  okouTokenFromExecution,
} from "./helpers/chat-events-fixture";
import { publicRunOwner } from "./helpers/public-run-owner";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";

const MANAGED_OPENROUTER_SENTINEL =
  "okou-fake-managed-model-key-sentinel-3f9c1e7a";

describe("Runner built-in and personal dispatch", () => {
  const context = testContext();

  it(
    "runners-built-in-execution-001 dispatches managed Auto placeholders and resolves only the Run-owned credential",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = createChatEventsFixture(context);
      const bdd = createBddApi(context);
      const runs = createRunsApi(context);
      const firewall = createFirewallApi(context);
      const actor = bdd.user();
      const owner = publicRunOwner(context, actor);

      fixture.chatCallbacks.acceptChatObjectStorage();
      fixture.api.acceptStorageDownloads();
      fixture.api.acceptTelemetryIngest();
      mockOptionalEnv("OPENROUTER_API_KEY", undefined);
      fixture.chatCallbacks.disableVapid();
      await fixture.api.configureRunnerGroup();

      const kms = useSecretKmsProbe(
        () => {
          return Promise.reject(new Error("KMS unavailable during startup"));
        },
        () => {
          return Promise.reject(new Error("KMS unavailable during startup"));
        },
      );

      await owner.run(() => {
        return bdd.bootstrapLimitedFreeOnboarding(actor);
      });

      const run = await owner.run(() => {
        return fixture.sendChatRun(actor, {
          prompt: "Run managed Auto from Web without KMS",
          model: null,
        });
      });
      const execution = await owner.executionInput(run.runId);

      expect(execution.cliAgentType).toBe("pi");
      expect(execution.piModelConfig).toMatchObject({
        provider: "openrouter",
        model: AUTO_RUN_UPSTREAM_MODEL,
        catalogModel: AUTO_SELECTED_MODEL,
      });
      expect(execution.platformEnvironment.OKOU_CURRENT_INTEGRATION).toBe(
        "web",
      );
      expect(execution.billableFirewalls).toContain(
        "model-provider:openrouter-codex",
      );
      expect(execution.modelUsageLongContextMinTotalInputTokens).toBe(100_001);
      expect(execution.environment?.OPENAI_API_KEY).toBe(
        modelProviderSecretPlaceholder(
          "openrouter-codex",
          "OPENROUTER_API_KEY",
        ),
      );
      expect(kms.generateDataKeyCalls).toBe(0);
      expect(kms.decryptCalls).toBe(0);
      expect(JSON.stringify(execution)).not.toContain(
        MANAGED_OPENROUTER_SENTINEL,
      );

      const heartbeatWithBoundary = await runs.requestHeartbeatRunnerAs(
        `Bearer ${execution.firewallToken}`,
        [401],
      );
      expect(heartbeatWithBoundary.status).toBe(401);

      const managedAuthBody = {
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("OPENROUTER_API_KEY")}`,
        },
        firewallBillable: true,
      };
      const executionToken = okouTokenFromExecution(execution);
      const resolutionWithExecutionToken = await firewall.requestFirewallAuth(
        { authorization: `Bearer ${executionToken}` },
        managedAuthBody,
        [401],
      );
      expect(resolutionWithExecutionToken.status).toBe(401);

      const resolutionWithSandboxToken = await firewall.requestFirewallAuth(
        { authorization: `Bearer ${execution.sandboxToken}` },
        managedAuthBody,
        [401],
      );
      expect(resolutionWithSandboxToken.status).toBe(401);

      const incompatibleRefResolution = await firewall.requestFirewallAuth(
        { authorization: `Bearer ${execution.firewallToken}` },
        {
          ...managedAuthBody,
          secretConnectorMap: {
            OPENROUTER_API_KEY: "codex-oauth-token",
          },
          secretConnectorMetadataMap: {
            OPENROUTER_API_KEY: {
              sourceType: "model-provider",
              sourceUserId: actor.userId,
              sourceId: randomUUID(),
              metadataKey: "codex-oauth-token",
            },
          },
        },
        [424],
      );
      expect(incompatibleRefResolution.status).toBe(424);

      const validResolution = await firewall.requestFirewallAuth(
        { authorization: `Bearer ${execution.firewallToken}` },
        managedAuthBody,
        [200],
      );
      expect(validResolution.status).toBe(200);
      if (validResolution.status !== 200) {
        throw new Error("Expected boundary credential resolution to succeed");
      }
      expect(validResolution.body.headers.Authorization).toBe(
        `Bearer ${MANAGED_OPENROUTER_SENTINEL}`,
      );
      expect(validResolution.body.resolvedSecrets).toStrictEqual([
        "OPENROUTER_API_KEY",
      ]);
      expect(validResolution.body.expiresAt).toStrictEqual(expect.any(Number));

      const readback = await fixture.api.readRun(actor, run.runId);
      expect(readback).toMatchObject({
        status: "running",
        source: {
          providerType: "built-in",
          runtimeProviderType: "openrouter-codex",
          model: AUTO_SELECTED_MODEL,
        },
      });
      expect(JSON.stringify(readback)).not.toContain(execution.firewallToken);

      const cancelled = await owner.run(() => {
        return fixture.api.requestCancelRun(actor, run.runId, [200]);
      });
      expect(cancelled.status).toBe(200);

      const afterCancelResolution = await firewall.requestFirewallAuth(
        { authorization: `Bearer ${execution.firewallToken}` },
        managedAuthBody,
        [403],
      );
      expect(afterCancelResolution.status).toBe(403);
    },
  );

  it(
    "runners-built-in-execution-003 dispatches a captured personal Pi subscription without built-in billing",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = createChatEventsFixture(context);
      const bdd = createBddApi(context);
      const firewall = createFirewallApi(context);
      const actor = bdd.user();
      const owner = publicRunOwner(context, actor);

      fixture.chatCallbacks.acceptChatObjectStorage();
      fixture.api.acceptStorageDownloads();
      fixture.api.acceptTelemetryIngest();
      mockOptionalEnv("OPENROUTER_API_KEY", undefined);
      fixture.chatCallbacks.disableVapid();
      await fixture.api.configureRunnerGroup();

      await owner.run(() => {
        return bdd.bootstrapLimitedFreeOnboarding(actor);
      });
      const { oauth, accountSourceId } = await owner.run(() => {
        return fixture.configureSubscriptionPiModel(
          actor,
          { accountId: "personal-codex-luna-account" },
          "gpt-6-luna",
        );
      });
      const expectedAccessToken = string().parse(
        oauth.oauthTokenResponses[0]?.access_token,
      );

      const run = await owner.run(() => {
        return fixture.sendChatRun(actor, {
          prompt: "Run Luna on personal Codex subscription",
          model: "gpt-6-luna",
        });
      });
      const execution = await owner.executionInput(run.runId);

      expect(execution.cliAgentType).toBe("pi");
      expect(execution.piModelConfig).toMatchObject({
        provider: "openai-codex",
        model: "gpt-6-luna",
        thinkingLevel: "xhigh",
      });
      expect(execution.platformEnvironment.OKOU_REASONING_EFFORT).toBe("xhigh");
      expect(execution.billableFirewalls).toStrictEqual([]);
      expect(execution.modelUsageLongContextMinTotalInputTokens).toBe(0);

      await expect(
        fixture.api.readRun(actor, run.runId),
      ).resolves.toMatchObject({
        status: "running",
        source: {
          providerType: "codex-oauth-token",
          runtimeProviderType: "codex-oauth-token",
          model: "gpt-6-luna",
          credentialScope: "member",
          account: {
            status: "connected",
            id: accountSourceId,
          },
        },
      });

      const personalResolution = await firewall.requestFirewallAuth(
        { authorization: `Bearer ${execution.firewallToken}` },
        {
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("CHATGPT_ACCESS_TOKEN")}`,
          },
          secretConnectorMap: execution.secretConnectorMap ?? undefined,
          secretConnectorMetadataMap:
            execution.secretConnectorMetadataMap ?? undefined,
        },
        [200],
      );
      expect(personalResolution.status).toBe(200);
      if (personalResolution.status !== 200) {
        throw new Error("Expected personal ChatGPT credential resolution");
      }
      expect(personalResolution.body.headers.Authorization).toBe(
        `Bearer ${expectedAccessToken}`,
      );

      const managedSecretAttempt = await firewall.requestFirewallAuth(
        { authorization: `Bearer ${execution.firewallToken}` },
        {
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("OPENROUTER_API_KEY")}`,
          },
        },
        [424],
      );
      expect(managedSecretAttempt.status).toBe(424);
      if (managedSecretAttempt.status !== 424) {
        throw new Error("Expected 424 for managed secret on personal Run");
      }
      expect(managedSecretAttempt.body.error.code).toBe(
        "CONNECTOR_NOT_CONFIGURED",
      );
    },
  );
});
