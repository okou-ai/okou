import { builtinConnectorNoAuthGrantContract } from "@okouai/api-contracts/contracts/connectors";
import { mcpConnectorsContract } from "@okouai/api-contracts/contracts/mcp-connectors";
import { describe, expect, it, onTestFinished } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { TEST_WITH_FOUR_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { settleIncludingAbort } from "../../utils";
import { builtinConnectorsRoutes } from "../connectors";
import { mcpConnectorsRoutes } from "../mcp-connectors";
import { mockClaudeCodeTokenEndpoint } from "./helpers/api-bdd-auth-device";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import {
  createChatEventsFixture,
  okouTokenFromExecution,
} from "./helpers/chat-events-fixture";
import { captureConnectorExternalState } from "./helpers/public-connector-actor";
import { publicRunOwner } from "./helpers/public-run-owner";

describe("builtin MCP Run admission", () => {
  const context = testContext();

  it(
    "builtin-mcp-run-001 pins execution input, refreshes discovery and keeps MCP credentials behind firewall auth",
    { timeout: TEST_WITH_FOUR_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = createChatEventsFixture(context);
      const firewall = createFirewallApi(context);
      const actor = fixture.bdd.user();
      const fixedClockMs = now();
      let accepted = captureConnectorExternalState(context);
      let previous: (() => void) | undefined;
      let restoreSetupWebhook: (() => void) | undefined;
      onTestFinished(() => {
        previous?.();
      });

      const owner = publicRunOwner(context, actor, {
        clockTime: fixedClockMs,
        continueAcceptedOperations: true,
        restoreEnvironment: () => {
          previous ??= captureConnectorExternalState(context);
          accepted();
          restoreSetupWebhook?.();
        },
      });
      function runOwned<T>(operation: () => Promise<T>) {
        return owner.run(() => {
          const pending = settleIncludingAbort(operation);
          accepted = captureConnectorExternalState(context);
          return pending.then((result) => {
            if (!result.ok) {
              throw result.error;
            }
            return result.value;
          });
        });
      }

      fixture.chatCallbacks.acceptChatObjectStorage();
      fixture.api.acceptStorageDownloads();
      fixture.api.acceptTelemetryIngest();
      mockOptionalEnv("OPENROUTER_API_KEY", undefined);
      fixture.chatCallbacks.disableVapid();
      mockClaudeCodeTokenEndpoint();

      const firstManualSecret = "manual-mcp-secret-initial";
      const secondManualSecret = "manual-mcp-secret-replacement";

      const noAuthClient = setupApp({
        context,
        routes: builtinConnectorsRoutes,
      })(builtinConnectorNoAuthGrantContract);

      const [publicResponse, firstManualResponse] = await Promise.all([
        runOwned(() => {
          return accept(
            noAuthClient.connect({
              headers: fixture.sessionHeaders(actor),
              params: { connectorSlug: "public-mcp" },
              body: {
                authMethod: "none",
                account: { intent: "add" },
              },
            }),
            [200],
          );
        }),
        runOwned(() => {
          return fixture.connectors.requestManualGrant(
            actor,
            "manual-mcp",
            "api-token",
            { apiKey: firstManualSecret },
            { statuses: [200] },
          );
        }),
        fixture.api.configureRunnerGroup(),
        runOwned(() => {
          return fixture.api.grantProEntitlement(actor, {
            onExternalStateReady: (restoreWebhook) => {
              restoreSetupWebhook = restoreWebhook;
            },
          });
        }),
        runOwned(() => {
          return fixture.api.createPersonalModelProvider(actor, {
            type: "claude-code-oauth-token",
            secret: "bdd-personal-claude-token",
          });
        }),
      ]);
      restoreSetupWebhook = undefined;

      const publicConnectionId = publicResponse.body.connectionId;
      if (firstManualResponse.status !== 200) {
        throw new Error("Expected initial manual MCP connection");
      }
      const firstManualId = firstManualResponse.body.connectionId;

      const run = await runOwned(() => {
        return fixture.sendChatRun(actor, {
          prompt: "Inspect authorized MCP tools",
          model: "claude-fable-5-1",
        });
      });

      const secondManualId = await runOwned(async () => {
        const added = await fixture.connectors.requestManualGrant(
          actor,
          "manual-mcp",
          "api-token",
          { apiKey: secondManualSecret },
          { statuses: [200] },
        );
        if (added.status !== 200) {
          throw new Error("Expected replacement manual MCP connection");
        }
        await fixture.connectors.setDefaultBuiltinConnectorAccount(
          actor,
          "manual-mcp",
          added.body.connectionId,
        );
        return added.body.connectionId;
      });

      const { execution } = await runOwned(async () => {
        const claimed = await fixture.runExecution(run.runId);
        owner.rememberExecution(run.runId, claimed.execution.sandboxToken);
        return claimed;
      });

      expect(execution.firewalls).toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "builtin",
            name: "public-mcp",
            sourceId: publicConnectionId,
          }),
          expect.objectContaining({
            kind: "builtin",
            name: "manual-mcp",
            sourceId: firstManualId,
          }),
        ]),
      );

      const serializedExecution = JSON.stringify(execution);
      expect(serializedExecution).not.toContain(firstManualSecret);
      expect(serializedExecution).not.toContain(secondManualSecret);
      expect(execution.environment).not.toHaveProperty("MCP_API_KEY");
      expect(execution.secretConnectorMap ?? {}).not.toHaveProperty(
        "MCP_API_KEY",
      );
      expect(execution.secretConnectorMetadataMap ?? {}).not.toHaveProperty(
        "MCP_API_KEY",
      );

      const mountedSkillNames =
        execution.startupInputs.contentBundles.skills.map((skill) => {
          return skill.name;
        });
      expect(mountedSkillNames).not.toContain("public-mcp");
      expect(mountedSkillNames).not.toContain("manual-mcp");

      expect(execution.appendSystemPrompt).toContain("- `public-mcp`");
      expect(execution.appendSystemPrompt).toContain("- `manual-mcp`");
      expect(execution.networkPolicies?.["manual-mcp"]).toMatchObject({
        unknownPolicy: "allow",
      });

      const mcpClient = setupApp({ context, routes: mcpConnectorsRoutes })(
        mcpConnectorsContract,
      );
      const firewallHeaders = {
        authorization: `Bearer ${execution.firewallToken}`,
      };
      const matchedManualMcp = {
        name: "manual-mcp",
        apiId: "api-0",
        connectorSlug: "manual-mcp" as const,
        sourceId: firstManualId,
        routingVariables: {},
      };
      const authHeaders = {
        Authorization: `Bearer ${secretTemplate("MCP_API_KEY")}`,
      };

      const [discovery, initialAuth, unrelatedMappingAuth] = await Promise.all([
        runOwned(() => {
          return accept(
            mcpClient.list({
              headers: {
                authorization: `Bearer ${okouTokenFromExecution(execution)}`,
              },
            }),
            [200],
          );
        }),
        runOwned(() => {
          return firewall.requestFirewallAuth(
            firewallHeaders,
            {
              authHeaders,
              matchedFirewall: matchedManualMcp,
            },
            [200],
          );
        }),
        runOwned(() => {
          return firewall.requestFirewallAuth(
            firewallHeaders,
            {
              authHeaders,
              matchedFirewall: matchedManualMcp,
              secretConnectorMap: { MCP_API_KEY: "openai" },
              secretConnectorMetadataMap: {
                MCP_API_KEY: {
                  sourceType: "connector",
                  sourceId: secondManualId,
                },
              },
            },
            [200],
          );
        }),
      ]);

      expect(discovery.status).toBe(200);
      expect(discovery.body.connectors).toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({
            slug: "public-mcp",
            connectionId: publicConnectionId,
            runtimeAvailable: true,
          }),
          expect.objectContaining({
            slug: "manual-mcp",
            connectionId: secondManualId,
            runtimeAvailable: true,
          }),
        ]),
      );

      expect(initialAuth.status).toBe(200);
      if (!("headers" in initialAuth.body)) {
        throw new Error("Expected firewall auth headers");
      }
      expect(initialAuth.body.headers).toStrictEqual({
        Authorization: `Bearer ${firstManualSecret}`,
      });
      expect(initialAuth.body.expiresAt).toBe(
        Math.floor(fixedClockMs / 1000) + 30,
      );

      expect(unrelatedMappingAuth.status).toBe(200);
      if (!("headers" in unrelatedMappingAuth.body)) {
        throw new Error("Expected unrelated firewall auth headers");
      }
      expect(unrelatedMappingAuth.body.headers).toStrictEqual({
        Authorization: `Bearer ${firstManualSecret}`,
      });

      await runOwned(() => {
        return fixture.connectors.deleteBuiltinConnectorAccount(
          actor,
          "manual-mcp",
          firstManualId,
        );
      });

      const deletedAuth = await runOwned(() => {
        return firewall.requestFirewallAuth(
          firewallHeaders,
          {
            authHeaders,
            matchedFirewall: matchedManualMcp,
          },
          [424],
        );
      });
      expect(deletedAuth.status).toBe(424);
      if (!("error" in deletedAuth.body)) {
        throw new Error("Expected CONNECTOR_NOT_CONFIGURED error");
      }
      expect(deletedAuth.body.error.code).toBe("CONNECTOR_NOT_CONFIGURED");
    },
  );
});
