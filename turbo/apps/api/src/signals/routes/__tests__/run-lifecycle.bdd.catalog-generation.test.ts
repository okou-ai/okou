import nativePiFixtures from "../../../../../../packages/api-contracts/src/contracts/__tests__/fixtures/pi-native.json";
import { createHash, createHmac, randomUUID } from "node:crypto";

import { CLIENT_VERSION_HEADER } from "@okouai/api-contracts/contracts/client-headers";
import {
  readPrimaryBuiltInRouteFixture,
  updateRestrictedPlanAccessFixture,
} from "../../../test-fixtures/model-route-capabilities";
import {
  builtinConnectorAutomaticContract,
  builtinConnectorNoAuthGrantContract,
} from "@okouai/api-contracts/contracts/connectors";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { connectorCheckContract } from "@okouai/api-contracts/contracts/connector-check";
import {
  getModelProviderFirewall,
  type ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  CONNECTOR_RUNTIME_SYNC_RUN_TERMINAL_ERROR_CODE,
  DEFAULT_PROFILE,
  agentRunConnectorDiagnosticRegistrationPayloadSchema,
  type ConnectorRuntimeSyncResult,
  type ExecutionContext,
  type Job as RunnerJob,
  type PiModelConfig,
} from "@okouai/api-contracts/contracts/runners";
import { testCronCleanupSandboxesStateContract } from "@okouai/api-contracts/contracts/test-cron-cleanup-sandboxes-state";
import type { CreateCustomConnectorBody } from "@okouai/api-contracts/contracts/custom-connectors";
import type {
  KnownRunFailureReason,
  RunFailureReasonToken,
} from "@okouai/api-contracts/contracts/run-failure-reasons";
import { testCustomConnectorSkillVersionAssociationContract } from "@okouai/api-contracts/contracts/test-custom-connector-skill-version-association";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  DISABLED_PAID_TOOLS_ENV_VAR,
  ENABLE_FRAMEWORK_WEB_SEARCH_ENV_VAR,
} from "@okouai/api-contracts/contracts/paid-tools";
import { SEED_SKILLS } from "@okouai/core/seed-skills";
import {
  getCustomConnectorSkillStorageName,
  getCustomSkillStorageName,
} from "@okouai/core/storage-names";
import {
  UNKNOWN_PERMISSION_GRANT,
  type ExecutionFirewallEntry,
  type FirewallApi,
} from "@okouai/connectors/firewall-types";
import { AUTOMATIC_MCP_RUNTIME_BEARER_TEMPLATE } from "@okouai/connectors/connector-catalog/artifacts/mcp-auth";
import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { v5 as uuidv5 } from "uuid";

import { env, mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now, nowDate } from "../../../lib/time";
import { mockAxiomSdkTelemetryFailure } from "../../../__tests__/mocks";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { verifyOkouToken } from "../../auth/tokens";
import {
  deleteUsagePricingRows,
  seedOrgMetadata,
  seedUsagePricingRows,
} from "../../../test-fixtures/system-config-seeds";
import {
  deleteOrgPlanEntitlementFixture,
  readOrgPlanEntitlementFixture,
  upsertOrgPlanEntitlementFixture,
} from "../../../test-fixtures/org-plan-entitlement";
import { createUniqueStaffOrgIdFixture } from "../../../test-fixtures/staff-org";
import {
  API_TEST_CONNECTOR_CATALOG,
  API_TEST_CONNECTOR_FIREWALL_CONFIGS,
  corruptApiTestConnectorCatalogActiveSnapshotPayload,
  corruptApiTestConnectorCatalogRuntimeProjectionDigest,
  invalidateApiTestConnectorCatalogCompatibility,
  installApiTestConnectorCatalog,
  replaceApiTestConnectorCatalogFilteredAuthMethods,
} from "../../../test-fixtures/connector-catalog";
import { readStorageS3PrefixFixture } from "../../../test-fixtures/storage";
import {
  readSessionHistoryBlobRefCountFixture,
  setRunModelProviderFixture,
} from "../../../test-fixtures/agent-runs";
import { timeoutRunWithoutCallbacksFixture } from "../../../test-fixtures/chat-events";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
  type ApiTestUserOptions,
} from "./helpers/api-bdd";
import { seedUserSecret, seedUserVariable } from "./helpers/user-config-state";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import {
  createConnectorBddApi,
  manualHttpCustomConnectorCreateBody,
  mockAutomaticMcpOAuthProvider,
  mockCustomConnectorOAuth2Provider,
  mockTestOAuthAuthCodeProvider,
} from "./helpers/api-bdd-connectors";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import {
  createRunsApi,
  expectCanonicalStorageManifest,
} from "./helpers/api-bdd-runs";
import { storageTextFile } from "./helpers/api-bdd-storage-files";
import { setPaidToolDisabled } from "./helpers/paid-tools";
import { createStoragesBddApi } from "./helpers/api-bdd-storages";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { postSubscriptionInvoicePaid } from "./helpers/stripe-billing-webhook";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import {
  configureNativeCliArtifact,
  createChatEventsFixture,
} from "./helpers/chat-events-fixture";
import { seedAgentRunCallback$ } from "./helpers/agent-run-callback";
import {
  deleteSlackIntegrationFixture$,
  seedSlackEnvironmentAgent$,
  seedSlackOrgInstallation$,
} from "./helpers/integrations-slack";
import {
  deleteCustomConnectorCredentialValues,
  setCustomConnectorCredentialStorageState,
} from "./helpers/connector-credential-storage-state";
import {
  clearRunApiStart,
  readRunFailureReasonFixture,
  seedBuiltInDefaultModelKey as seedBuiltInDefaultModelKeyState,
  seedBuiltInModelKey as seedBuiltInModelKeyState,
  setRunnerJobContextProfileAsPreviousApi,
  setRunnerJobPiContextAsVersionedWriter,
} from "./helpers/runtime-state";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import {
  setSecretKmsClientForTests,
  type SecretKmsClient,
  type SecretKmsDataKey,
  type SecretKmsGenerateDataKeyRequest,
} from "../../../lib/secret-kms-client";
import { testCustomConnectorSkillVersionAssociationRoutes } from "../test-custom-connector-skill-version-association";
import { testCronCleanupSandboxesStateRoutes } from "../test-cron-cleanup-sandboxes-state";
import { builtinConnectorsAutomaticRoutes } from "../connectors-automatic";
import { builtinConnectorsRoutes } from "../connectors";
import { connectorAccountRoutes } from "../connector-accounts";
import { connectorCheckRoutes } from "../connector-check";
import {
  automaticMcpCatalogFixture,
  buildAutomaticMcpCatalog,
} from "./helpers/connector-automatic-catalog";
import { createPublicAutomaticCatalog } from "./helpers/public-automatic-catalog";
import { createRouteMocks } from "./helpers/route-test";
import { SEEDED_SYSTEM_DEFAULT_MODEL } from "./helpers/seeded-system-default";

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

type McpCustomConnectorCreateBody = Extract<
  CreateCustomConnectorBody,
  { readonly kind: "mcp" }
>;

function manualMcpRuntimeConnectorBody(args: {
  readonly displayName: string;
  readonly endpoint: string;
  readonly skillMarkdown?: string;
  readonly slug?: string;
}): McpCustomConnectorCreateBody {
  return {
    kind: "mcp",
    displayName: args.displayName,
    endpoint: args.endpoint,
    transport: "streamable-http",
    fields: [
      {
        key: "secret",
        label: "API token",
        kind: "secret",
        required: true,
      },
    ],
    headerInjections: [
      {
        name: "Authorization",
        valueTemplate: "Bearer {{secrets.secret}}",
      },
    ],
    queryInjections: [],
    authMode: "manual",
    ...(args.skillMarkdown === undefined
      ? {}
      : { skillMarkdown: args.skillMarkdown }),
    ...(args.slug === undefined ? {} : { slug: args.slug }),
  };
}
const MCP_CONNECTOR_PROMPT_HEADING = "# MCP Connectors";
const MCP_CONNECTOR_PROMPT_INVENTORY_LIMIT = 20;

function mcpConnectorPromptSection(prompt: string): string | undefined {
  const sectionStart = prompt.indexOf(MCP_CONNECTOR_PROMPT_HEADING);
  if (sectionStart === -1) {
    return undefined;
  }
  const nextSectionStart = prompt.indexOf(
    "\n\n# ",
    sectionStart + MCP_CONNECTOR_PROMPT_HEADING.length,
  );
  return prompt.slice(
    sectionStart,
    nextSectionStart === -1 ? undefined : nextSectionStart,
  );
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

/**
 * Chat-thread runs on the fixture's default Sonnet 5 route execute through Pi.
 * Scenarios that exercise the native Runner claim protocol for a chat thread
 * pin Fable, which model policy keeps on the claude-code Runner.
 */
const NATIVE_RUNNER_ROUTE = { model: "claude-fable-5-1" } as const;

async function entitledRunActor(
  userOptions: ApiTestUserOptions = {},
  route: { readonly model?: typeof NATIVE_RUNNER_ROUTE.model } = {},
): Promise<{
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
  readonly granted: {
    readonly customerId: string;
    readonly subscriptionId: string;
  };
}> {
  const bdd = createBddApi(context);
  const api = createRunsApi(context);
  const actor = bdd.user(userOptions);
  bdd.acceptAgentStorageWrites();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  const runnerGroup = api.configureRunnerGroup();
  const granted = await api.grantProEntitlement(actor);
  await api.ensureOrgModelProvider(actor, route);
  const agent = await bdd.createAgent(actor, {
    displayName: "BDD lifecycle agent",
    description: "Exercises the full run lifecycle.",
    visibility: "private",
  });
  return { actor, agentId: agent.agentId, runnerGroup, granted };
}

describe("RUN-02: custom connectors, grants, and network policies", () => {
  async function setupBoundedMcpAwareness() {
    const api = createRunsApi(context);
    const connectors = createConnectorBddApi(context);
    const fw = createFirewallApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const { actor, agentId, runnerGroup } = await entitledRunActor(
      {},
      NATIVE_RUNNER_ROUTE,
    );
    const admittedSlugs = Array.from(
      { length: MCP_CONNECTOR_PROMPT_INVENTORY_LIMIT + 1 },
      (_, index) => {
        return `_mcp-awareness-${String(index).padStart(2, "0")}`;
      },
    );
    const admittedConnectorIds: string[] = [];
    for (const slug of [...admittedSlugs].reverse()) {
      const connector = await connectors.createCustomConnector(
        actor,
        manualMcpRuntimeConnectorBody({
          displayName: `Remote display ${slug}`,
          endpoint: `https://${slug.slice(1)}.example.test/mcp`,
          slug,
        }),
      );
      await connectors.setCustomConnectorValues(actor, connector.id, [
        { key: "secret", kind: "secret", value: `credential-${slug}` },
      ]);
      admittedConnectorIds.push(connector.id);
    }
    const incompleteSlug = "_mcp-awareness-incomplete";
    const incomplete = await connectors.createCustomConnector(
      actor,
      manualMcpRuntimeConnectorBody({
        displayName: "Incomplete MCP connector",
        endpoint: "https://incomplete-mcp.example.test/mcp",
        slug: incompleteSlug,
      }),
    );
    const ungrantedSlug = "_mcp-awareness-ungranted";
    const ungranted = await connectors.createCustomConnector(
      actor,
      manualMcpRuntimeConnectorBody({
        displayName: "Ungranted MCP connector",
        endpoint: "https://ungranted-mcp.example.test/mcp",
        slug: ungrantedSlug,
      }),
    );
    await connectors.setCustomConnectorValues(actor, ungranted.id, [
      { key: "secret", kind: "secret", value: "ungranted-credential" },
    ]);
    await connectors.updateAgentCustomConnectors(actor, agentId, [
      ...admittedConnectorIds,
      incomplete.id,
    ]);
    return {
      api,
      fw,
      webhooks,
      actor,
      agentId,
      runnerGroup,
      admittedSlugs,
      incompleteSlug,
      ungrantedSlug,
    };
  }

  function expectBoundedMcpAwareness(
    prompt: string | null | undefined,
    fixture: Awaited<ReturnType<typeof setupBoundedMcpAwareness>>,
  ) {
    expect(prompt).toContain("# Agent Tools");
    const section = mcpConnectorPromptSection(prompt ?? "");
    if (!section) {
      throw new Error("Expected MCP awareness");
    }
    const expectedListedSlugs = [...fixture.admittedSlugs]
      .sort()
      .slice(0, MCP_CONNECTOR_PROMPT_INVENTORY_LIMIT);
    expect(
      section.split("\n").filter((line) => {
        return line.startsWith("- `");
      }),
    ).toStrictEqual(
      expectedListedSlugs.map((slug) => {
        return `- \`${slug}\``;
      }),
    );
    expect(section).not.toContain(
      fixture.admittedSlugs[MCP_CONNECTOR_PROMPT_INVENTORY_LIMIT],
    );
    expect(section).toContain(
      "1 additional admitted MCP connector was omitted from this prompt",
    );
    expect(section).not.toContain(fixture.incompleteSlug);
    expect(section).not.toContain(fixture.ungrantedSlug);
    expect(section).not.toContain("Remote display");
    expect(section).not.toContain("example.test");
    expect(section).not.toContain("credential-");
    return section;
  }

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
