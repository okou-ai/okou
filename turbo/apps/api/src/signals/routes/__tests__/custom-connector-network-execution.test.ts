import { randomUUID } from "node:crypto";
import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import type { CustomConnectorNetworkIntent } from "@okouai/api-contracts/validators/custom-connector-network";
import type { CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connectors";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { cloudflareAccessRoutes } from "../cloudflare-access";
import { createBddApi } from "./helpers/api-bdd";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createFirewallApi } from "./helpers/api-bdd-firewall";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createPublicFirewallFixture } from "./helpers/public-firewall-fixture";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);
const runs = createRunsApi(context);
const firewall = createFirewallApi(context);
const mocks = createRouteMocks(context);
const headers = { authorization: "Bearer clerk-session" } as const;
const configs = () => {
  return setupApp({ context, routes: cloudflareAccessRoutes })(
    cloudflareAccessContract,
  );
};

interface SelectedConnector {
  readonly connector: CustomConnectorResponse;
  readonly bound: boolean;
  readonly sourceId: string;
  readonly secret: string;
  readonly url: string;
}

async function expectInitialConnector(
  execution: Awaited<ReturnType<typeof runs.executionInput>>,
  selected: SelectedConnector,
  boundIntent: CustomConnectorNetworkIntent,
) {
  const { connector, bound, sourceId, secret, url } = selected;
  const sandboxHeaders = { authorization: `Bearer ${execution.sandboxToken}` };
  const entry = execution.firewalls?.find((candidate) => {
    return (
      candidate.kind === "inline" &&
      candidate.customConnectorId === connector.id
    );
  });
  if (!entry || entry.kind !== "inline") {
    throw new Error("Expected the initial inline custom firewall");
  }
  const api = entry.firewall.apis[0];
  if (!api?.id) {
    throw new Error("Expected an initial custom API identity");
  }
  const intent = bound ? boundIntent : { kind: "direct" as const };
  expect(api.networkIntent).toStrictEqual(intent);
  expect(execution.connectorRuntimeTargets).toContainEqual({
    kind: "custom",
    customConnectorId: connector.id,
    sourceId,
    baseUrlVars: {},
  });
  const authBody = {
    encryptedSecrets:
      execution.encryptedSecrets || firewall.encryptedSecretsBody({}),
    secretConnectorMap: execution.secretConnectorMap ?? undefined,
    secretConnectorMetadataMap:
      execution.secretConnectorMetadataMap ?? undefined,
    authHeaders: api.auth.headers ?? {},
    matchedFirewall: {
      name: entry.firewall.name,
      apiId: api.id,
      customConnectorId: connector.id,
      sourceId,
      routingVariables: {},
    },
  };
  const auth = await firewall.requestFirewallAuth(
    sandboxHeaders,
    { ...authBody, networkIntent: api.networkIntent },
    [200],
  );
  expect(auth.body).toMatchObject({
    headers: { Authorization: `Bearer ${secret}` },
  });
  if (bound) {
    for (const wrongIntent of [
      undefined,
      { kind: "direct" },
      {
        kind: "cloudflare_access",
        configId: randomUUID(),
        generation: 1,
      },
    ] satisfies (CustomConnectorNetworkIntent | undefined)[]) {
      const denied = await firewall.requestFirewallAuth(
        sandboxHeaders,
        {
          ...authBody,
          networkIntent: wrongIntent,
        },
        [424],
      );
      expect(denied.body).toMatchObject({
        error: { code: "CONNECTOR_NOT_CONFIGURED" },
      });
    }
    const networkBody = {
      encryptedSecrets: authBody.encryptedSecrets,
      authHeaders: {},
      matchedFirewall: authBody.matchedFirewall,
      networkAdmission: true as const,
      networkRequest: { method: "GET", url, intent },
    };
    const admitted = await firewall.requestFirewallAuth(
      sandboxHeaders,
      networkBody,
      [200],
    );
    expect(admitted.body).toMatchObject({
      headers: {},
      networkAdmission: {
        ...intent,
        headers: {
          "CF-Access-Client-Id": "network-id",
          "CF-Access-Client-Secret": "network-secret",
        },
      },
    });
    return networkBody;
  }
}

test.each(["legacy Agent", "Chat account"] as const)(
  "%s startup preserves HTTP/MCP network bindings and unbound Direct intent",
  async (mode) => {
    useSecretKmsProbe();
    const fixture = createPublicFirewallFixture(context, {
      orgRole: "org:admin",
    });
    await fixture.run(async () => {
      const actor = fixture.actor;
      bdd.acceptAgentStorageWrites();
      runs.acceptStorageDownloads();
      runs.acceptTelemetryIngest();
      const runnerGroup = await runs.configureRunnerGroup();
      await fixture.fund();
      await runs.ensurePersonalSubscriptionModel(actor);
      await connectors.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.CustomConnectorCloudflareAccess]: true,
        [FeatureSwitchKey.ConnectorChatAccountAccess]: mode === "Chat account",
      });
      const { agentId } = await bdd.createAgent(actor, {
        displayName: "Bound connector execution",
      });
      mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
      const config = (
        await accept(
          configs().create({
            headers,
            query: { view: "scoped" },
            body: {
              id: randomUUID(),
              scope: "organization",
              name: "Execution network",
              credentials: {
                clientId: "network-id",
                clientSecret: "network-secret",
              },
            },
          }),
          [201],
        )
      ).body;
      const selected: SelectedConnector[] = [];
      for (const kind of ["http", "mcp"] as const) {
        for (const bound of [true, false]) {
          const url = `https://${randomUUID()}.example.test/`;
          const connector = await connectors.createCustomConnector(actor, {
            displayName: `${kind} ${bound ? "protected" : "direct"}`,
            authMode: "manual",
            fields: [
              { key: "secret", label: "Token", kind: "secret", required: true },
            ],
            headerInjections: [
              {
                name: "Authorization",
                valueTemplate: "Bearer {{secrets.secret}}",
              },
            ],
            queryInjections: [],
            ...(kind === "http"
              ? { kind, prefixTemplates: [url] }
              : { kind, endpoint: url, transport: "streamable-http" as const }),
            ...(bound
              ? {
                  networkBinding: {
                    type: "cloudflare_access" as const,
                    configId: config.id,
                  },
                }
              : {}),
          });
          fixture.registerCustomConnector(connector.id);
          const secret = `application-${connector.id}`;
          await connectors.setCustomConnectorSecret(
            actor,
            connector.id,
            secret,
          );
          const [account] = await connectors.listCustomConnectorAccounts(
            actor,
            connector.id,
          );
          if (!account) {
            throw new Error("Expected a publicly connected custom account");
          }
          selected.push({
            connector,
            bound,
            url,
            secret,
            sourceId: account.id,
          });
        }
      }
      if (mode === "legacy Agent") {
        await connectors.updateAgentCustomConnectors(
          actor,
          agentId,
          selected.map(({ connector }) => {
            return connector.id;
          }),
        );
      }
      const run = await runs.createThreadRun(actor, {
        agentId,
        model: "claude-fable-5-1",
        prompt: "Use my protected and direct HTTP/MCP accounts",
      });
      fixture.registerRun(run.runId);
      await runs.heartbeatRunner(runnerGroup);
      const execution = await runs.executionInput(run.runId);
      fixture.registerExecution(run.runId, execution.sandboxToken);
      const sandboxHeaders = {
        authorization: `Bearer ${execution.sandboxToken}`,
      };
      const networkRequests = [];
      for (const selectedConnector of selected) {
        const request = await expectInitialConnector(
          execution,
          selectedConnector,
          {
            kind: "cloudflare_access",
            configId: config.id,
            generation: config.generation,
          },
        );
        if (request) {
          networkRequests.push(request);
        }
      }

      mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
      const rotated = await accept(
        configs().update({
          headers,
          params: { configId: config.id },
          query: { view: "scoped" },
          body: {
            expectedRevision: config.revision,
            credentials: {
              clientId: "rotated-id",
              clientSecret: "rotated-secret",
            },
          },
        }),
        [200],
      );
      const targets = selected
        .filter(({ bound }) => {
          return bound;
        })
        .map(({ connector, sourceId }) => {
          return {
            kind: "custom" as const,
            customConnectorId: connector.id,
            sourceId,
            baseUrlVars: {},
          };
        });
      expect(rotated.body.generation).toBe(config.generation + 1);
      const synchronized = await runs.syncConnectorRuntime(run.runId, {
        targets,
      });
      expect(synchronized).toHaveLength(targets.length);
      for (const target of targets) {
        expect(synchronized).toContainEqual(
          expect.objectContaining({
            target: {
              kind: target.kind,
              customConnectorId: target.customConnectorId,
            },
            state: "available",
            firewall: expect.objectContaining({
              firewall: expect.objectContaining({
                apis: [
                  expect.objectContaining({
                    networkIntent: {
                      kind: "cloudflare_access",
                      configId: config.id,
                      generation: rotated.body.generation,
                    },
                  }),
                ],
              }),
            }),
          }),
        );
      }
      for (const networkBody of networkRequests) {
        const refreshed = await firewall.requestFirewallAuth(
          sandboxHeaders,
          networkBody,
          [200],
        );
        expect(refreshed.body).toMatchObject({
          networkAdmission: {
            kind: "cloudflare_access",
            configId: config.id,
            generation: rotated.body.generation,
            headers: {
              "CF-Access-Client-Id": "rotated-id",
              "CF-Access-Client-Secret": "rotated-secret",
            },
          },
        });
      }

      await runs.requestCancelRun(actor, run.runId, [200]);
      await createWebhookCallbackApi(context).requestAgentComplete(
        {
          runId: run.runId,
          exitCode: 1,
          error: "Finished network execution checks",
        },
        sandboxHeaders,
        [200],
      );
      await connectors.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.CustomConnectorCloudflareAccess]: false,
      });
      const disabled = await runs.createThreadRun(actor, {
        agentId,
        model: "claude-fable-5-1",
        prompt:
          "Keep bound connectors unavailable while network support is disabled",
      });
      fixture.registerRun(disabled.runId);
      await runs.heartbeatRunner(runnerGroup);
      const disabledExecution = await runs.executionInput(disabled.runId);
      fixture.registerExecution(disabled.runId, disabledExecution.sandboxToken);
      for (const { connector, bound } of selected) {
        const entry = disabledExecution.firewalls?.find((candidate) => {
          return (
            candidate.kind === "inline" &&
            candidate.customConnectorId === connector.id
          );
        });
        if (bound) {
          expect(entry).toBeUndefined();
          expect(disabledExecution.connectorRuntimeTargets).not.toContainEqual(
            expect.objectContaining({ customConnectorId: connector.id }),
          );
        } else {
          expect(entry).toMatchObject({ kind: "inline" });
          if (!entry || entry.kind !== "inline") {
            throw new Error(
              "Expected the unbound custom connector to remain available",
            );
          }
          expect(entry.firewall.apis[0]).not.toHaveProperty("networkIntent");
        }
      }
    });
  },
);
