import { randomUUID } from "node:crypto";
import { chatThreadConnectorSelectionContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  builtinConnectorAutomaticContract,
  builtinConnectorNoAuthGrantContract,
} from "@okouai/api-contracts/contracts/connectors";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { connectorCheckContract } from "@okouai/api-contracts/contracts/connector-check";
import {
  runnersConnectorRuntimeSyncContract,
  type ExecutionContext,
} from "@okouai/api-contracts/contracts/runners";
import type { ConnectorCatalogArtifact } from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import type { ExecutionFirewallEntry } from "@okouai/connectors/firewall-types";
import { describe, expect, it } from "vitest";

import { env, mockEnv } from "../../../lib/env";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { API_TEST_CONNECTOR_CATALOG } from "../../../test-fixtures/connector-catalog";
import type { ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockAutomaticMcpOAuthProvider,
} from "./helpers/api-bdd-connectors";
import { createFirewallApi } from "./helpers/api-bdd-firewall";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { builtinConnectorsAutomaticRoutes } from "../connectors-automatic";
import { builtinConnectorsRoutes } from "../connectors";
import { connectorAccountRoutes } from "../connector-accounts";
import { connectorCheckRoutes } from "../connector-check";
import { buildAutomaticMcpCatalog } from "./helpers/connector-automatic-catalog";
import { createPublicAutomaticCatalog } from "./helpers/public-automatic-catalog";
import {
  catalogWithAuthMethod,
  createPublicConnectorCatalog,
} from "./helpers/public-connector-catalog";
import {
  createChatEventsFixture,
  userMessages,
} from "./helpers/chat-events-fixture";
import {
  barrierQueryText,
  withDatabaseTransactionBarrierFixture,
} from "../../../test-fixtures/database-transaction-barrier";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatThreadRoutes } from "../chat-threads";
import { createRouteMocks } from "./helpers/route-test";
import { runnersRoutes } from "../runners";

/**
 * RUN-01..04 and CHAIN-RUN: successful run dispatch and lifecycle.
 *
 * The billing entitlement Given uses the public Stripe webhook contract
 * (invoice.paid for a mocked subscription) and verifies the grant through the
 * billing status API, so no DB fixtures are involved.
 */

const context = testContext();

async function connectAutomaticRuntime(args: {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly slug: string;
  readonly methodId: string;
  readonly issuer: string;
  readonly connectionId?: string;
}): Promise<string> {
  mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
  mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
  mockEnv("APP_URL", "https://app.okou.ai");
  createRouteMocks(context).clerk.session(
    args.actor.userId,
    args.actor.orgId,
    args.actor.orgRole,
  );
  const headers = { authorization: "Bearer clerk-session" };
  const client = setupApp({
    context,
    routes: builtinConnectorsAutomaticRoutes,
  })(builtinConnectorAutomaticContract);
  const started = await accept(
    client.start({
      headers,
      params: { connectorSlug: args.slug },
      body: {
        authMethod: args.methodId,
        agentId: args.agentId,
        authorizeAgent: true,
        account: args.connectionId
          ? { intent: "reconnect", connectionId: args.connectionId }
          : { intent: "add" },
      },
    }),
    [200],
  );
  if (started.body.result === "connected") {
    return started.body.connectedAccountId;
  }
  const state = new URL(started.body.authorizationUrl).searchParams.get(
    "state",
  );
  if (!state) {
    throw new Error("Expected builtin Automatic authorization state");
  }
  const completed = await accept(
    client.callback({
      query: {
        state,
        code: "runtime-code",
        iss: args.issuer,
        responseMode: "json",
      },
    }),
    [200],
  );
  expect(completed.body.status).toBe("success");
  const receipt = await accept(
    setupApp({ context, routes: connectorAccountRoutes })(
      connectorAccountsContract,
    ).oauthCompletion({
      headers,
      params: { attemptId: started.body.oauthAttemptId },
      query: { kind: "builtin", connectorSlug: args.slug },
    }),
    [200],
  );
  return receipt.body.connectionId;
}

function firewallEntryName(entry: ExecutionFirewallEntry): string {
  return entry.kind === "builtin" ? entry.name : entry.firewall.name;
}

function findFirewallEntry(
  entries: readonly ExecutionFirewallEntry[] | undefined,
  name: string,
): ExecutionFirewallEntry | undefined {
  return entries?.find((entry) => {
    return firewallEntryName(entry) === name;
  });
}

function builtinFirewallEntry(
  entries: readonly ExecutionFirewallEntry[] | undefined,
  name: string,
): Extract<ExecutionFirewallEntry, { readonly kind: "builtin" }> {
  const entry = findFirewallEntry(entries, name);
  if (!entry || entry.kind !== "builtin") {
    throw new Error(`Expected builtin firewall entry: ${name}`);
  }
  return entry;
}

function builtinConnectorRuntimeRegistration(
  context: ExecutionContext,
  connectorSlug: string,
): Extract<
  ExecutionContext["connectorRuntimeTargets"][number],
  { readonly kind: "builtin" }
> {
  const registration = context.connectorRuntimeTargets.find((target) => {
    return target.kind === "builtin" && target.connectorSlug === connectorSlug;
  });
  if (!registration || registration.kind !== "builtin") {
    throw new Error("Expected a built-in connector runtime registration");
  }
  return registration;
}

describe("RUN-02: custom connectors, grants, and network policies", () => {
  it("retains captured immutable credentials then omits a genuinely removed builtin on the next bootstrap", async () => {
    const catalog = createPublicConnectorCatalog(context);
    // OpenAI is deliberately credential-only in this fixture (firewall:none).
    // Give the independent retained Runtime a real public executable descriptor.
    const initialCatalog: ConnectorCatalogArtifact = {
      ...API_TEST_CONNECTOR_CATALOG,
      connectors: API_TEST_CONNECTOR_CATALOG.connectors.map((entry) => {
        return entry.slug !== "runtime"
          ? entry
          : {
              ...entry,
              firewall: {
                kind: "generated",
                billable: false,
                categories: null,
                defaultAllowed: ["read"],
                defaultUnknownPolicy: "deny",
                config: {
                  description: "Owned public Runtime read boundary",
                  placeholders: { RUNTIME_API_KEY: "fixture-runtime-key" },
                  apis: [
                    {
                      base: "https://runtime.fixture.invalid",
                      auth: {
                        headers: {
                          Authorization: [
                            "Bearer $",
                            "{{ secrets.RUNTIME_API_KEY }}",
                          ].join(""),
                        },
                      },
                      permissions: [{ name: "read", rules: ["GET /status"] }],
                    },
                  ],
                },
              },
            };
      }),
    };
    const firstGeneration = await catalog.publish(initialCatalog);
    const fixture = createChatEventsFixture(context);
    const { actor, agentId, runnerGroup } =
      await fixture.entitledNativeChatActor();
    fixture.chatCallbacks.failIfChatCallbackRouteIsFetched();
    const connection = await fixture.connectors.connectManualGrant(
      actor,
      "openai",
      "api-token",
      { apiKey: "terminal-openai-owned" },
      agentId,
    );
    const other = await fixture.connectors.connectManualGrant(
      actor,
      "runtime",
      "api-token",
      { apiKey: "terminal-runtime-owned" },
      agentId,
    );
    const ownAcceptedRun = (accepted: {
      readonly runId: string | null;
      readonly threadId: string;
      readonly clientEventId: string;
    }) => {
      const owned: {
        runId: string | null;
        sandboxHeaders: { readonly authorization: string } | undefined;
        cleaned: boolean;
      } = { runId: accepted.runId, sandboxHeaders: undefined, cleaned: false };
      const discover = async () => {
        if (!owned.runId) {
          owned.runId =
            userMessages(
              (await fixture.chat.listThreadEvents(actor, accepted.threadId))
                .events,
            ).find((message) => {
              return message.revokesEventId === accepted.clientEventId;
            })?.runId ?? null;
        }
        return owned.runId;
      };
      // Register before publication/prepare/claim assertions can reject. An
      // accepted send with no ID yet is discovered through its exact public event.
      catalog.onCleanup(async () => {
        if (owned.cleaned) {
          return;
        }
        await flushWaitUntilForTest();
        const id = await discover();
        if (id) {
          const run = await fixture.api.readRun(actor, id);
          if (
            run.status === "pending" ||
            run.status === "queued" ||
            run.status === "running"
          ) {
            await fixture.cancelChatRun(actor, id, owned.sandboxHeaders);
          } else if (run.status === "cancelled" && owned.sandboxHeaders) {
            await fixture.failChatRun(
              id,
              owned.sandboxHeaders,
              "Run cancelled",
            );
          }
        }
        await flushWaitUntilForTest();
        owned.cleaned = true;
      });
      return { owned, discover };
    };
    const clientEventId = randomUUID();
    let firstOwner: ReturnType<typeof ownAcceptedRun> | undefined;
    const sent = await withDatabaseTransactionBarrierFixture(
      {
        select: (queryArgs) => {
          const text = barrierQueryText(queryArgs);
          return (
            text.includes('from "connector_catalog"') &&
            text.includes('"connector_catalog_entries"') &&
            text.includes('"catalog_header"') &&
            text.includes('"payload"')
          );
        },
        stopAt: (_queryArgs, selecting) => {
          return selecting;
        },
        pauseAfter: true,
        work: async (barrier) => {
          const sending = fixture.chat
            .requestSendEvent(
              actor,
              {
                agentId,
                prompt: "use captured immutable catalog",
                clientEventId,
              },
              [201],
            )
            .then((response) => {
              if (response.status === 201) {
                firstOwner = ownAcceptedRun({
                  ...response.body,
                  clientEventId,
                });
              }
              return response;
            });
          expect((await barrier.entered).rowCount).toBeGreaterThan(0);
          const response = await sending;
          if (response.status !== 201) {
            throw new Error("Expected direct send acceptance");
          }
          // Real activation, not the retired legacy installer. Capture completed
          // before this winning CAS; old immutable entry rows remain addressable.
          const replacement = await catalog.publish({
            ...initialCatalog,
            connectors: initialCatalog.connectors.filter((entry) => {
              return entry.slug !== "openai";
            }),
          });
          expect(replacement.hash).not.toBe(firstGeneration.hash);
          barrier.release();
          await flushWaitUntilForTest();
          return response;
        },
      },
      context.signal,
    );
    if (!firstOwner) {
      throw new Error("Missing accepted Run owner");
    }
    const runId = await firstOwner.discover();
    if (!runId) {
      throw new Error("Missing captured generation Run");
    }
    const first = await fixture.claimChatRun(runnerGroup, runId);
    firstOwner.owned.sandboxHeaders = first.sandboxHeaders;
    expect(first.claim.environment?.OPENAI_TOKEN).toBe("terminal-openai-owned");
    expect(first.claim.secretValues).toContain("terminal-openai-owned");
    expect(first.claim.secretConnectorMap?.OPENAI_TOKEN).toBe("openai");
    expect(first.claim.secretConnectorMetadataMap?.OPENAI_TOKEN).toStrictEqual({
      sourceType: "connector",
      sourceId: connection.id,
    });
    // Captured credential facts are not executable authorization. OpenAI's
    // original descriptor has no firewall; current B additionally removes it.
    expect(first.claim.firewalls).not.toContainEqual(
      expect.objectContaining({ kind: "builtin", name: "openai" }),
    );
    expect(first.claim.firewalls).toContainEqual(
      expect.objectContaining({
        kind: "builtin",
        name: "runtime",
        sourceId: other.id,
      }),
    );
    expect(first.claim.billableFirewalls ?? []).not.toContain("openai");
    expect(first.claim.networkPolicies ?? {}).not.toHaveProperty("openai");
    expect(first.claim).not.toHaveProperty("connectorPermissionBaseline");
    expect(first.claim).not.toHaveProperty("secretValueEnvironmentKeys");
    expect(first.claim.connectorRuntimeTargets).toStrictEqual([
      { kind: "builtin", connectorSlug: "runtime", sourceId: other.id },
    ]);
    expect(
      first.claim.secretConnectorMetadataMap?.RUNTIME_API_KEY,
    ).toStrictEqual({
      sourceType: "connector",
      sourceId: other.id,
    });
    expect(
      first.claim.secretConnectorMetadataMap?.OPENAI_TOKEN?.sourceId,
    ).not.toBe(other.id);
    const currentRuntime = await accept(
      setupApp({ context, routes: runnersRoutes })(
        runnersConnectorRuntimeSyncContract,
      ).sync({
        headers: {
          authorization: `Bearer vm0_official_${env("OFFICIAL_RUNNER_SECRET")}`,
        },
        params: { runId },
        body: {
          targets: [
            {
              kind: "builtin",
              connectorSlug: "openai",
              sourceId: connection.id,
            },
            { kind: "builtin", connectorSlug: "runtime", sourceId: other.id },
          ],
        },
      }),
      [200],
    );
    expect(currentRuntime.body.results).toStrictEqual([
      {
        target: { kind: "builtin", connectorSlug: "openai" },
        state: "absent",
        reason: "connector-unavailable",
      },
      {
        target: { kind: "builtin", connectorSlug: "runtime" },
        state: "available",
        networkPolicy: {
          allow: ["read"],
          deny: [],
          ask: [],
          unknownPolicy: "deny",
        },
      },
    ]);
    await fixture.cancelChatRun(actor, runId, first.sandboxHeaders);
    firstOwner.owned.cleaned = true;
    const nextClientEventId = randomUUID();
    const next = await fixture.chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: sent.body.threadId,
        prompt: "use actual replacement generation",
        clientEventId: nextClientEventId,
      },
      [201],
    );
    if (next.status !== 201) {
      throw new Error("Expected next-generation send acceptance");
    }
    const nextOwner = ownAcceptedRun({
      ...next.body,
      clientEventId: nextClientEventId,
    });
    await flushWaitUntilForTest();
    const nextRunId = await nextOwner.discover();
    if (!nextRunId) {
      throw new Error("Missing next generation Run");
    }
    const claimed = await fixture.claimChatRun(runnerGroup, nextRunId);
    nextOwner.owned.sandboxHeaders = claimed.sandboxHeaders;
    expect(claimed.claim.environment).not.toHaveProperty("OPENAI_TOKEN");
    expect(claimed.claim.secretConnectorMap ?? {}).not.toHaveProperty(
      "OPENAI_TOKEN",
    );
    expect(claimed.claim.secretConnectorMetadataMap ?? {}).not.toHaveProperty(
      "OPENAI_TOKEN",
    );
    expect(
      claimed.claim.firewalls?.some((entry) => {
        return entry.kind === "builtin" && entry.name === "openai";
      }),
    ).toBeFalsy();
    expect(claimed.claim.billableFirewalls ?? []).not.toContain("openai");
    expect(claimed.claim.networkPolicies ?? {}).not.toHaveProperty("openai");
    expect(claimed.claim).not.toHaveProperty("connectorPermissionBaseline");
    expect(claimed.claim.environment?.RUNTIME_API_KEY).toBe(
      "fixture-runtime-key",
    );
    expect(
      claimed.claim.secretConnectorMetadataMap?.RUNTIME_API_KEY,
    ).toStrictEqual({
      sourceType: "connector",
      sourceId: other.id,
    });
    expect(claimed.claim.connectorRuntimeTargets).toContainEqual({
      kind: "builtin",
      connectorSlug: "runtime",
      sourceId: other.id,
    });
    await fixture.cancelChatRun(actor, nextRunId, claimed.sandboxHeaders);
    nextOwner.owned.cleaned = true;
    const selectionClient = setupApp({ context, routes: chatThreadRoutes })(
      chatThreadConnectorSelectionContract,
    );
    const selections = await accept(
      selectionClient.get({
        headers: fixture.sessionHeaders(actor),
        params: { id: sent.body.threadId },
      }),
      [200],
    );
    expect(
      selections.body.selections.some((entry) => {
        return (
          entry.target.kind === "builtin" &&
          entry.target.connectorSlug === "openai"
        );
      }),
    ).toBeFalsy();
    await accept(
      selectionClient.update({
        headers: fixture.sessionHeaders(actor),
        params: { id: sent.body.threadId },
        body: {
          connectionId: connection.id,
          target: { kind: "builtin", connectorSlug: "openai" },
        },
      }),
      [400],
    );
    await accept(
      fixture.chatThreadsClient().create({
        headers: fixture.sessionHeaders(actor),
        body: {
          agentId,
          model: "claude-fable-5-1",
          connectorSelections: [
            {
              connectionId: connection.id,
              target: { kind: "builtin", connectorSlug: "openai" },
            },
          ],
        },
      }),
      [400],
    );
  });
  it("omits genuinely compatibility-filtered auth from immutable scoped claims", async () => {
    const catalog = createPublicAutomaticCatalog(context);
    await catalog.run(async () => {
      await catalog.publish();
      const api = createRunsApi(context);
      const fw = createFirewallApi(context);
      const { actor, agentId, runnerGroup } = await catalog.prepareRuntime();
      await fw.seedTestConnector(actor, {
        connectorSlug: "x",
        authMethod: "oauth",
        accessToken: "generation-x-access",
        refreshToken: "generation-x-refresh",
      });
      await api.enableAgentConnectors(actor, agentId, ["x"]);
      const warm = await api.createThreadRun(actor, {
        agentId,
        prompt: "warm executable X method",
      });
      catalog.registerRun(warm.runId);
      await api.heartbeatRunner(runnerGroup);
      const warmClaim = await api.claimRunnerJob(warm.runId);
      catalog.registerClaim(warm.runId, warmClaim.sandboxToken);
      expect(warmClaim.environment).toHaveProperty(
        "X_TOKEN",
        "fixture-x-token",
      );
      const ownedAccount = (
        await createConnectorBddApi(context).listBuiltinConnectorAccounts(
          actor,
          "x",
        )
      ).find((account) => {
        return account.isDefault;
      });
      if (!ownedAccount) {
        throw new Error("Missing owned generation X account");
      }
      expect(warmClaim.secretConnectorMap?.X_TOKEN).toBe("x");
      expect(warmClaim.secretConnectorMetadataMap?.X_TOKEN).toMatchObject({
        sourceType: "connector",
        sourceId: ownedAccount.id,
      });
      expect(findFirewallEntry(warmClaim.firewalls, "x")).toMatchObject({
        name: "x",
        sourceId: ownedAccount.id,
      });
      await api.requestCancelRun(actor, warm.runId, [200]);

      // Same real account, method ID, storage version and authorization. Only
      // the published client contract changes, so the real capability evaluator
      // rejects it instead of consuming a hand-written legacy filter row.
      const filtered = catalogWithAuthMethod(
        { connectorSlug: "x", authMethodId: "oauth" },
        (method) => {
          return {
            ...method,
            client: {
              clientRegistration: "static",
              clientType: "public",
              clientId: "unregistered-test-client",
            },
          };
        },
      );
      const x = filtered.connectors.find((connector) => {
        return connector.slug === "x";
      });
      if (!x) {
        throw new Error("Missing filtered X generation");
      }
      const next = buildAutomaticMcpCatalog({
        slug: catalog.slug,
        methodId: catalog.methodId,
      }).catalog;
      await catalog.publish({
        ...next,
        connectors: next.connectors.map((connector) => {
          return connector.slug === "x" ? x : connector;
        }),
      });
      const run = await api.createThreadRun(actor, {
        agentId,
        prompt: "omit actual filtered X method",
      });
      catalog.registerRun(run.runId);
      await api.heartbeatRunner(runnerGroup);
      const claim = await api.claimRunnerJob(run.runId);
      catalog.registerClaim(run.runId, claim.sandboxToken);
      expect(claim.environment ?? {}).not.toHaveProperty("X_TOKEN");
      expect(claim.secretConnectorMap ?? {}).not.toHaveProperty("X_TOKEN");
      expect(findFirewallEntry(claim.firewalls, "x")).toBeUndefined();
      expect(claim.billableFirewalls).not.toContain("x");
      expect(claim.networkPolicies ?? {}).not.toHaveProperty("x");
      expect(claim).not.toHaveProperty("connectorPermissionBaseline");
      expect(JSON.stringify(claim)).not.toContain("generation-x-access");
      expect(JSON.stringify(claim)).not.toContain("generation-x-refresh");
      await api.requestCancelRun(actor, run.runId, [200]);
    });
  });
  it.each(["none", "oauth"] as const)(
    "admits the exact builtin Automatic %s account and injects auth outside the sandbox",
    async (resolution) => {
      const catalog = createPublicAutomaticCatalog(context, {
        firewallAuth: resolution,
      });
      await catalog.run(async () => {
        await catalog.publish();
        const provider = mockAutomaticMcpOAuthProvider(context, {
          registration: "cimd",
          authentication: resolution,
          initialExpiresIn: 3600,
        });
        const api = createRunsApi(context);
        const connectors = createConnectorBddApi(context);
        const fw = createFirewallApi(context);
        const { actor, agentId, runnerGroup } = await catalog.prepareRuntime();
        const connectionId = await connectAutomaticRuntime({
          actor,
          agentId,
          ...catalog,
          issuer: provider.issuer,
        });
        catalog.registerAccount(connectionId);
        if (resolution === "none") {
          await catalog.publish(
            buildAutomaticMcpCatalog({
              slug: catalog.slug,
              methodId: catalog.methodId,
              storageVersion: 2,
              firewallAuth: resolution,
            }).catalog,
          );
        }
        const run = await api.createThreadRun(actor, {
          agentId,
          prompt: `use builtin Automatic ${resolution}`,
        });
        catalog.registerRun(run.runId);
        await api.heartbeatRunner(runnerGroup);
        const claim = await api.claimRunnerJob(run.runId);
        catalog.registerClaim(run.runId, claim.sandboxToken);
        const target = builtinConnectorRuntimeRegistration(claim, catalog.slug);
        expect(target.sourceId).toBe(connectionId);
        const firewall = builtinFirewallEntry(claim.firewalls, catalog.slug);
        expect(firewall).toMatchObject({
          kind: "builtin",
          name: catalog.slug,
          sourceId: connectionId,
        });
        expect(JSON.stringify(claim)).not.toContain(
          "automatic-initial-access-token",
        );
        expect(JSON.stringify(claim)).not.toContain("automatic-refresh-token");
        expect(claim.environment).not.toHaveProperty("AUTOMATIC_ACCESS_TOKEN");
        expect(claim.appendSystemPrompt).toContain(`\`${catalog.slug}\``);
        const checkClient = setupApp({ context, routes: connectorCheckRoutes })(
          connectorCheckContract,
        );
        const checkBody = {
          mode: "url" as const,
          method: "POST",
          url: catalog.endpoint,
          connectorSlug: catalog.slug,
        };
        const checkHeaders = {
          authorization: `Bearer ${claim.platformEnvironment.OKOU_TOKEN}`,
        };
        for (const headers of [
          { authorization: "Bearer clerk-session" },
          checkHeaders,
        ]) {
          const check = await accept(
            checkClient.check({ headers, body: checkBody }),
            [200],
          );
          expect(check.body).toMatchObject({
            outcome: "resolved",
            connector: {
              credentialResolution:
                resolution === "oauth" ? "network-boundary" : "none",
            },
          });
        }
        const authBody = {
          encryptedSecrets:
            claim.encryptedSecrets ?? fw.encryptedSecretsBody({}),
          authHeaders: catalog.firewallAuthHeaders,
          matchedFirewall: {
            name: catalog.slug,
            apiId: `${catalog.slug}:0`,
            base: catalog.endpoint,
            connectorSlug: catalog.slug,
            sourceId: connectionId,
            routingVariables: {},
          },
        };
        const resolved = await fw.requestFirewallAuth(
          { authorization: `Bearer ${claim.sandboxToken}` },
          authBody,
          [200],
        );
        expect(resolved.body).toMatchObject({
          headers:
            resolution === "oauth"
              ? { Authorization: "Bearer automatic-initial-access-token" }
              : {},
        });

        if (resolution === "oauth") {
          mockAutomaticMcpOAuthProvider(context, {
            registration: "none",
            authentication: "none",
          });
          await expect(
            connectAutomaticRuntime({
              actor,
              agentId,
              ...catalog,
              issuer: provider.issuer,
              connectionId,
            }),
          ).resolves.toBe(connectionId);
          const [updated] = await api.syncConnectorRuntime(run.runId, {
            targets: [target],
          });
          expect(updated).toMatchObject({
            target: { kind: "builtin", connectorSlug: catalog.slug },
            state: "available",
          });
          expect(updated).not.toHaveProperty("firewall");
          const mismatched = await fw.requestFirewallAuth(
            { authorization: `Bearer ${claim.sandboxToken}` },
            authBody,
            [424],
          );
          expect(mismatched.body).toMatchObject({
            error: { code: "CONNECTOR_NOT_CONFIGURED" },
          });
          const check = await accept(
            checkClient.check({ headers: checkHeaders, body: checkBody }),
            [200],
          );
          expect(check.body).toMatchObject({
            outcome: "resolved",
            connector: { credentialResolution: "network-boundary" },
          });
        }
        await api.requestCancelRun(actor, run.runId, [200]);
        catalog.registerAccountDeletion(connectionId);
        await connectors.deleteBuiltinConnectorAccount(
          actor,
          catalog.slug,
          connectionId,
        );
      });
    },
  );

  it.each(["none", "manual"] as const)(
    "keeps catalog auth when reconnecting builtin Automatic to %s",
    async (authMode) => {
      const catalog = createPublicAutomaticCatalog(context, {
        slug: "manual-mcp",
        additionalNoAuthMethodId: "public-connect",
      });
      await catalog.run(async () => {
        await catalog.publish();
        const provider = mockAutomaticMcpOAuthProvider(context, {
          registration: "cimd",
          initialExpiresIn: 3600,
        });
        const api = createRunsApi(context);
        const connectors = createConnectorBddApi(context);
        const fw = createFirewallApi(context);
        const { actor, agentId, runnerGroup } = await catalog.prepareRuntime();
        const connectionId = await connectAutomaticRuntime({
          actor,
          agentId,
          ...catalog,
          issuer: provider.issuer,
        });
        catalog.registerAccount(connectionId);
        const run = await api.createThreadRun(actor, {
          agentId,
          prompt: "change the connected builtin MCP authentication method",
        });
        catalog.registerRun(run.runId);
        await api.heartbeatRunner(runnerGroup);
        const claim = await api.claimRunnerJob(run.runId);
        catalog.registerClaim(run.runId, claim.sandboxToken);
        const target = builtinConnectorRuntimeRegistration(claim, catalog.slug);
        expect(
          builtinFirewallEntry(claim.firewalls, catalog.slug),
        ).toMatchObject({
          kind: "builtin",
          name: catalog.slug,
          sourceId: connectionId,
        });
        if (authMode === "none") {
          const client = setupApp({ context, routes: builtinConnectorsRoutes })(
            builtinConnectorNoAuthGrantContract,
          );
          await accept(
            client.connect({
              headers: { authorization: "Bearer clerk-session" },
              params: { connectorSlug: catalog.slug },
              body: {
                authMethod: "public-connect",
                account: { intent: "reconnect", connectionId },
              },
            }),
            [200],
          );
        } else {
          await catalog.publish(API_TEST_CONNECTOR_CATALOG);
          await connectors.connectManualGrant(
            actor,
            catalog.slug,
            "api-token",
            {
              apiKey: "reconnected-manual-token",
            },
            agentId,
            { intent: "reconnect", connectionId },
          );
        }
        const [updated] = await api.syncConnectorRuntime(run.runId, {
          targets: [target],
        });
        expect(updated).toMatchObject({
          state: "available",
        });
        expect(updated).not.toHaveProperty("firewall");
        const endpoint =
          authMode === "none"
            ? catalog.endpoint
            : "https://manual-mcp.example.test/server";
        const checkClient = setupApp({ context, routes: connectorCheckRoutes })(
          connectorCheckContract,
        );
        const check = await accept(
          checkClient.check({
            headers: {
              authorization: `Bearer ${claim.platformEnvironment.OKOU_TOKEN}`,
            },
            body: {
              mode: "url",
              method: "POST",
              url: endpoint,
              connectorSlug: catalog.slug,
            },
          }),
          [200],
        );
        expect(check.body).toMatchObject({
          outcome: "resolved",
          connector: {
            credentialResolution: "network-boundary",
          },
        });
        const authHeaders =
          authMode === "none"
            ? catalog.firewallAuthHeaders
            : {
                Authorization: `Bearer \${{ secrets.MCP_API_KEY }}`,
              };
        const auth = await fw.requestFirewallAuth(
          {
            authorization: `Bearer ${claim.sandboxToken}`,
          },
          {
            encryptedSecrets:
              claim.encryptedSecrets ?? fw.encryptedSecretsBody({}),
            authHeaders,
            matchedFirewall: {
              name: catalog.slug,
              apiId: `${catalog.slug}:0`,
              base: endpoint,
              connectorSlug: catalog.slug,
              sourceId: connectionId,
              routingVariables: {},
            },
          },
          authMode === "none" ? [424] : [200],
        );
        expect(auth.body).toMatchObject(
          authMode === "none"
            ? { error: { code: "CONNECTOR_NOT_CONFIGURED" } }
            : { headers: { Authorization: "Bearer reconnected-manual-token" } },
        );
        await api.requestCancelRun(actor, run.runId, [200]);
        catalog.registerAccountDeletion(connectionId);
        await connectors.deleteBuiltinConnectorAccount(
          actor,
          catalog.slug,
          connectionId,
        );
      });
    },
  );
});
