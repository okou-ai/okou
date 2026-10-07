import { HttpResponse, http } from "msw";
import { server } from "../../../mocks/server";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { mcpConnectorsContract } from "@okouai/api-contracts/contracts/mcp-connectors";
import {
  customConnectorByIdContract,
  customConnectorsContract,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { connectorAccountRoutes } from "../connector-accounts";
import { mcpConnectorsRoutes } from "../mcp-connectors";
import { customConnectorsRoutes } from "../custom-connectors";
import { customConnectorsDeleteRoutes } from "../custom-connectors-delete";
import { customConnectorsValuesSetRoutes } from "../custom-connectors-values-set";
import { createBddApi } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockGitHubConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import {
  catalogWithAuthMethod,
  catalogWithManualConnector,
  createPublicConnectorCatalog,
} from "./helpers/public-connector-catalog";
import { createHash, randomUUID } from "node:crypto";
import {
  builtinConnectorsSearchContract,
  builtinConnectorManualGrantContract,
} from "@okouai/api-contracts/contracts/connectors";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { connectorOverviewContract } from "@okouai/api-contracts/contracts/connector-overview";
import {
  onboardingSourcesContract,
  onboardingWorkflowConnectorsContract,
} from "@okouai/api-contracts/contracts/onboarding";
import { connectorCatalogRoutes } from "../connector-catalog";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { getConnectorAuthProviderRegistrationCapabilities } from "@okouai/connectors/auth-providers";
import { featureSwitchesRoutes } from "../feature-switches";
import { connectorOverviewRoutes } from "../connector-overview";
import { onboardingSourcesRoutes } from "../onboarding-sources";
import { onboardingWorkflowConnectorsRoutes } from "../onboarding-workflow-connectors";
import { cronConnectorCatalogContract } from "@okouai/api-contracts/contracts/cron";
import {
  connectorCatalogArtifactSchema,
  CONNECTOR_CATALOG_ACTIVE_KEY,
  type ConnectorCatalogArtifact,
} from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import { API_TEST_CONNECTOR_CATALOG_ARTIFACT } from "../../../test-fixtures/connector-catalog-artifact";
import { getApiTestMocks } from "../../../__tests__/mocks";
import { setupApp } from "../../../__tests__/test-helpers";
import { accept, testContext } from "../../../__tests__/test-context";
import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { cronConnectorCatalogRoutes } from "../cron-connector-catalog";
import { builtinConnectorsRoutes } from "../connectors";
import { createRouteMocks, createFixtureTracker } from "./helpers/route-test";
import { API_TEST_CONNECTOR_CATALOG } from "../../../test-fixtures/connector-catalog";

import { describe, expect, it } from "vitest";
import { replaceRunnerJobWithLegacyConnectorBaselineFixture } from "../../../test-fixtures/legacy-runner-job-context";
import { createRunsApi } from "./helpers/api-bdd-runs";

const context = testContext();
const routeMocks = createRouteMocks(context);

function release(version: string, label: string, entrySlug?: string) {
  const artifact = connectorCatalogArtifactSchema.parse(
    structuredClone(API_TEST_CONNECTOR_CATALOG_ARTIFACT),
  );
  artifact.catalogVersion = version;
  const first =
    entrySlug === undefined
      ? artifact.connectors[0]
      : artifact.connectors.find((entry) => {
          return entry.slug === entrySlug;
        });
  if (!first) {
    throw new Error("Missing fixed catalog connector");
  }
  first.label = label;
  return publication(artifact);
}

function publication(artifact: ConnectorCatalogArtifact) {
  const raw = Buffer.from(JSON.stringify(artifact));
  const hash = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  const key = `connectors/v4/releases/${artifact.catalogVersion}/catalog.json`;
  const pointer = Buffer.from(
    JSON.stringify({
      catalogVersion: artifact.catalogVersion,
      catalogKey: key,
      catalogDigest: hash,
    }),
  );
  return { artifact, raw, hash, key, pointer };
}

function serve(candidate: ReturnType<typeof release>) {
  getApiTestMocks().s3.send.mockImplementation((command: unknown) => {
    const input = (command as { input: { Key?: string } }).input;
    const bytes =
      input.Key === CONNECTOR_CATALOG_ACTIVE_KEY
        ? candidate.pointer
        : input.Key === candidate.key
          ? candidate.raw
          : undefined;
    if (!bytes) {
      throw new Error("Uncontrolled lifecycle R2 key");
    }
    return Promise.resolve({
      ContentLength: bytes.length,
      Body: {
        async *[Symbol.asyncIterator]() {
          yield bytes;
        },
      },
    });
  });
}

async function directory(candidate: ReturnType<typeof release>) {
  routeMocks.clerk.session("catalog-lifecycle-user", "catalog-lifecycle-org");
  const first = candidate.artifact.connectors[0];
  if (!first) {
    throw new Error("Missing fixed catalog connector");
  }
  const response = await setupApp({ context, routes: builtinConnectorsRoutes })(
    builtinConnectorsSearchContract,
  ).search({
    headers: { authorization: "Bearer clerk-session" },
    query: { keyword: first.slug },
  });
  expect(response.status).toBe(200);
  if (response.status !== 200) {
    throw new Error("Catalog search failed");
  }
  expect(
    response.body.connectors.find((entry) => {
      return entry.slug === first.slug;
    })?.label,
  ).toBe(first.label);
}

async function sync() {
  const app = await setupApp({
    context,
    routes: cronConnectorCatalogRoutes,
    isolatePg: true,
  });
  return await app(cronConnectorCatalogContract).sync({
    headers: { authorization: "Bearer test-cron-secret" },
  });
}

describe("immutable connector catalog publication", () => {
  it("publishes the supplied digest and keeps repeated publication idempotent", async () => {
    const first = release("2099-01-01.first", "First lifecycle catalog");
    serve(first);
    const response = await accept(sync(), [200]);
    expect(response.body).toMatchObject({
      outcome: "accepted",
      active: { catalogDigest: first.hash },
    });
    await directory(first);
    const repeated = await accept(sync(), [200]);
    expect(repeated.body).toMatchObject({
      outcome: "unchanged",
      active: { catalogDigest: first.hash },
    });
    const next = release("2099-01-01.next", "Next lifecycle catalog");
    serve(next);
    const changed = await accept(sync(), [200]);
    expect(changed.body).toMatchObject({
      outcome: "accepted",
      active: { catalogDigest: next.hash },
    });
    await directory(next);
  });

  it("serves a complete catalog after concurrent publication requests", async () => {
    const released = release("2099-01-01.competitors", "Concurrent catalog");
    // Use public methods with no platform OAuth configuration or feature gate.
    const candidate = publication({
      ...released.artifact,
      connectors: released.artifact.connectors.filter((connector) => {
        return ["public-mcp", "manual-mcp", "openai"].includes(connector.slug);
      }),
    });
    serve(candidate);
    // Initialize the selected database before issuing competing requests.
    const app = await setupApp({
      context,
      routes: cronConnectorCatalogRoutes,
      isolatePg: true,
    });
    const client = app(cronConnectorCatalogContract);
    const responses = await Promise.all([
      accept(
        client.sync({ headers: { authorization: "Bearer test-cron-secret" } }),
        [200],
      ),
      accept(
        client.sync({ headers: { authorization: "Bearer test-cron-secret" } }),
        [200],
      ),
    ]);
    expect(
      responses.map((response) => {
        return response.body.outcome;
      }),
    ).toContain("accepted");
    for (const response of responses) {
      expect(["accepted", "unchanged"]).toContain(response.body.outcome);
      expect(response.body.active?.catalogDigest).toBe(candidate.hash);
    }
    routeMocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const listed = await accept(
      setupApp({ context, routes: connectorCatalogRoutes })(
        connectorCatalogContract,
      ).list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(
      listed.body.connectors
        .map((connector) => {
          return connector.slug;
        })
        .sort(),
    ).toStrictEqual(
      candidate.artifact.connectors
        .map((connector) => {
          return connector.slug;
        })
        .sort(),
    );
    await directory(candidate);
  });

  it("serves the current MCP descriptor to an admitted Run after publication changes", async () => {
    const first = release("2099-01-02.old", "Old MCP catalog", "manual-mcp");
    serve(first);
    await accept(sync(), [200]);
    const bdd = createBddApi(context);
    const connectors = createConnectorBddApi(context);
    const runs = createRunsApi(context);
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const runnerGroup = runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensurePersonalSubscriptionModel(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "Catalog MCP reader",
    });
    const connection = await connectors.connectManualGrant(
      actor,
      "manual-mcp",
      "api-token",
      { apiKey: "catalog-mcp-key" },
      agent.agentId,
    );
    await runs.enableAgentConnectors(actor, agent.agentId, ["manual-mcp"]);
    const run = await runs.createThreadRun(actor, {
      agentId: agent.agentId,
      prompt: "Discover the admitted MCP connection",
    });
    await runs.heartbeatRunner(runnerGroup);
    const claim = await runs.claimRunnerJob(run.runId);
    const token = claim.platformEnvironment.OKOU_TOKEN;
    if (!token) {
      throw new Error("Expected a claimed Run's Okou token");
    }
    const client = setupApp({ context, routes: mcpConnectorsRoutes })(
      mcpConnectorsContract,
    );
    const headers = { authorization: `Bearer ${token}` };
    const original = await accept(client.list({ headers }), [200]);
    expect(original.body.connectors).toContainEqual(
      expect.objectContaining({
        displayName: "Old MCP catalog",
        connectionId: connection.id,
      }),
    );
    const next = release("2099-01-02.new", "New MCP catalog", "manual-mcp");
    serve(next);
    await accept(sync(), [200]);
    const current = await accept(client.list({ headers }), [200]);
    expect(current.body.connectors).toContainEqual(
      expect.objectContaining({
        displayName: "New MCP catalog",
        connectionId: connection.id,
      }),
    );
    await runs.requestCancelRun(actor, run.runId, [200]);
  });
});

describe("slug-first current catalog business readers", () => {
  const headers = { authorization: "Bearer clerk-session" };
  function catalogClient() {
    return setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
  }
  async function publishedCatalog() {
    const candidate = release(
      `2099-02-01.${randomUUID()}`,
      "Slug-reader catalog",
    );
    serve(candidate);
    expect((await sync()).body).toMatchObject({ outcome: "accepted" });
    routeMocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    return candidate;
  }
  it("answers detail and permissions from current entries", async () => {
    await publishedCatalog();
    const detail = await accept(
      catalogClient().get({ headers, params: { connectorSlug: "openai" } }),
      [200],
    );
    expect(detail.body.connector.slug).toBe("openai");
    const permissions = await accept(
      catalogClient().permissions({
        headers,
        params: { connectorSlug: "notion" },
      }),
      [200],
    );
    expect(permissions.body.permissions.connectorSlug).toBe("notion");
  });
  it("reports an absent slug as unknown", async () => {
    await publishedCatalog();
    const result = await accept(
      catalogClient().get({
        headers,
        params: { connectorSlug: "missing-catalog-slug" },
      }),
      [404],
    );
    expect(result.body.error.code).toBe("NOT_FOUND");
  });
  it("serves complete lists, search and compatibility from published entries", async () => {
    const candidate = await publishedCatalog();
    const listed = await accept(catalogClient().list({ headers }), [200]);
    expect(listed.body.connectors).toContainEqual(
      expect.objectContaining({ slug: "github" }),
    );
    await directory(candidate);
    const oneClick = await accept(catalogClient().oneClick({ headers }), [200]);
    expect(oneClick.body.connectors.length).toBeGreaterThan(0);
  });

  it.each(["claude-code", "pi"] as const)(
    "claims an old %s execution context and v1 permission baseline",
    async (cliAgentType) => {
      const candidate = await publishedCatalog();
      const bdd = createBddApi(context);
      const runs = createRunsApi(context);
      const actor = bdd.user();
      bdd.acceptAgentStorageWrites();
      runs.acceptStorageDownloads();
      runs.acceptTelemetryIngest();
      const runnerGroup = runs.configureRunnerGroup();
      await runs.grantProEntitlement(actor);
      await runs.ensurePersonalSubscriptionModel(actor);
      const agent = await bdd.createAgent(actor, {
        displayName: "Legacy context compatibility",
      });
      const run = await runs.createThreadRun(actor, {
        agentId: agent.agentId,
        prompt: "Claim a queued context from an older API",
      });
      const storedContext =
        await replaceRunnerJobWithLegacyConnectorBaselineFixture({
          runId: run.runId,
          cliAgentType,
          catalogVersion: candidate.artifact.catalogVersion,
          catalogDigest: candidate.hash,
        });
      await runs.heartbeatRunner(runnerGroup);
      const claim = await runs.claimRunnerJob(run.runId);
      expect(claim.cliAgentType).toBe(cliAgentType);
      expect(claim.networkPolicies?.github).toStrictEqual({
        allow: [],
        deny: ["user:read"],
        ask: [],
        unknownPolicy: "deny",
      });
      if (cliAgentType === "pi") {
        expect(claim.piSessionId).toBe(storedContext.piSessionId);
        expect(claim.piLaunchConfig).toStrictEqual(
          storedContext.piLaunchConfig,
        );
      }
      await runs.requestCancelRun(actor, run.runId, [200]);
    },
  );

  it("lists named onboarding sources from current entries", async () => {
    await publishedCatalog();
    const client = setupApp({ context, routes: onboardingSourcesRoutes })(
      onboardingSourcesContract,
    );
    const listed = await accept(client.list({ headers }), [200]);
    expect(listed.body.connectors.length).toBeGreaterThan(0);
  });
  it("summarizes case-owned accounts using current methods and briefs", async () => {
    await publishedCatalog();
    const client = setupApp({
      context,
      routes: [...connectorOverviewRoutes, ...builtinConnectorsRoutes],
    });
    const account = await accept(
      client(builtinConnectorManualGrantContract).connect({
        headers,
        params: { connectorSlug: "gitlab" },
        body: {
          authMethod: "api-token",
          account: { intent: "add" },
          values: { accessToken: "gl-test-token", host: "gitlab.example.com" },
        },
      }),
      [200],
    );
    const overview = await accept(
      client(connectorOverviewContract).overview({ headers }),
      [200],
    );
    expect(overview.body.accountSummaries).toStrictEqual([
      expect.objectContaining({
        target: { kind: "builtin", connectorSlug: "gitlab" },
        accountCount: 1,
        defaultConnection: expect.objectContaining({
          id: account.body.id,
          connectionStatus: "connected",
        }),
      }),
    ]);
    expect(overview.body.builtinConnectors).toContainEqual(
      expect.objectContaining({ slug: "gitlab" }),
    );
  });
  it("lists named onboarding workflow connectors from current entries", async () => {
    await publishedCatalog();
    const client = setupApp({
      context,
      routes: onboardingWorkflowConnectorsRoutes,
    })(onboardingWorkflowConnectorsContract);
    const listed = await accept(client.list({ headers }), [200]);
    expect(listed.body.connectors.length).toBeGreaterThan(0);
  });
  it("a later slug request follows current publication without a retained version", async () => {
    const first = release("2099-02-02.first", "First OpenAI", "openai");
    serve(first);
    expect((await sync()).body).toMatchObject({ outcome: "accepted" });
    routeMocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    expect(
      (
        await accept(
          catalogClient().get({ headers, params: { connectorSlug: "openai" } }),
          [200],
        )
      ).body.connector.label,
    ).toBe("First OpenAI");
    const next = release("2099-02-02.next", "Next OpenAI", "openai");
    serve(next);
    expect((await sync()).body).toMatchObject({ outcome: "accepted" });
    expect(
      (
        await accept(
          catalogClient().get({ headers, params: { connectorSlug: "openai" } }),
          [200],
        )
      ).body.connector.label,
    ).toBe("Next OpenAI");
  });
});

describe("staff connector catalog diagnostics from current entries", () => {
  const headers = { authorization: "Bearer clerk-session" };

  async function staffSession() {
    routeMocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    await accept(
      setupApp({ context, routes: featureSwitchesRoutes })(
        featureSwitchesContract,
      ).update({
        headers,
        body: { switches: { [FeatureSwitchKey.OkouDebug]: true } },
      }),
      [200],
    );
  }

  async function diagnostics() {
    const response = await accept(
      setupApp({ context, routes: connectorCatalogRoutes })(
        connectorCatalogContract,
      ).diagnostics({ headers }),
      [200],
    );
    return response.body;
  }

  it("reports the pointer and on-demand compatibility", async () => {
    const candidate = release(`2099-03-01.${randomUUID()}`, "Diagnostics");
    serve(candidate);
    expect((await sync()).body).toMatchObject({ outcome: "accepted" });
    await staffSession();
    context.mocks.s3.send.mockClear();

    const requestedAt = now();
    const current = await diagnostics();
    expect(
      Date.parse(current.filtering.evaluatedAt ?? ""),
    ).toBeGreaterThanOrEqual(requestedAt);
    expect(current).toMatchObject({
      schemaVersion: 4,
      state: "current",
      active: { catalogDigest: candidate.hash },
      pointer: {
        schemaVersion: 4,
        hash: candidate.hash,
        entryCount: candidate.artifact.connectors.length,
      },
      filtering: {
        capabilityDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        stale: false,
      },
    });
    expect(current).not.toHaveProperty("lastAttempt");
    expect(current).not.toHaveProperty("lastSuccessAt");
    expect(current).not.toHaveProperty("rejectedCandidate");
    expect(current.active).not.toHaveProperty("activatedAt");

    // Unconfigure one provider used by the published entries: the next
    // request filters that method against the new capability, with no sync.
    const entryMethods = new Set(
      candidate.artifact.connectors.flatMap((entry) => {
        return entry.authMethods.map((method) => {
          return `${entry.slug}\0${method.id}`;
        });
      }),
    );
    const registration =
      getConnectorAuthProviderRegistrationCapabilities().find((capability) => {
        return (
          capability.requiredConfigurationNames.length > 0 &&
          entryMethods.has(
            `${capability.connectorSlug}\0${capability.authMethodId}`,
          )
        );
      });
    const configurationName = registration?.requiredConfigurationNames[0];
    if (!registration || !configurationName) {
      throw new Error("Missing configurable catalog auth method");
    }
    const filteredMethod = {
      connectorSlug: registration.connectorSlug,
      authMethodId: registration.authMethodId,
      reasons: ["missing-platform-configuration"],
    };
    expect(current.filtering.filteredAuthMethods).not.toContainEqual(
      filteredMethod,
    );
    mockOptionalEnv(configurationName, undefined);
    const unconfigured = await diagnostics();
    expect(unconfigured.filtering.capabilityDigest).not.toBe(
      current.filtering.capabilityDigest,
    );
    expect(unconfigured.filtering.stale).toBeFalsy();
    expect(unconfigured.filtering.filteredAuthMethods).toContainEqual(
      filteredMethod,
    );
    expect(unconfigured.pointer).toStrictEqual(current.pointer);
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });
});

describe("current-publication account readers", () => {
  const mocks = routeMocks;
  const routes = Object.freeze([
    ...connectorAccountRoutes,
    ...builtinConnectorsRoutes,
    ...customConnectorsRoutes,
    ...customConnectorsDeleteRoutes,
    ...customConnectorsValuesSetRoutes,
  ]);

  interface AccountCatalogFixture {
    readonly orgId: string;
    readonly userId: string;
  }

  function authHeaders() {
    return { authorization: "Bearer clerk-session" };
  }

  function accountClient() {
    return setupApp({ context, routes })(connectorAccountsContract);
  }

  function customConnectorClient() {
    return setupApp({ context, routes })(customConnectorsContract);
  }

  function customConnectorByIdClient() {
    return setupApp({ context, routes })(customConnectorByIdContract);
  }

  async function deleteBuiltinAccountPage(
    connectorSlug: "openai" | "github",
    connections: readonly { readonly id: string }[],
  ): Promise<void> {
    const accountsApi = accountClient();
    for (let offset = 0; offset < connections.length; offset += 4) {
      const deleted = await Promise.allSettled(
        connections.slice(offset, offset + 4).map(async (account) => {
          await accept(
            accountsApi.delete({
              headers: authHeaders(),
              params: { connectionId: account.id },
              body: { target: { kind: "builtin", connectorSlug } },
            }),
            [200, 404],
          );
        }),
      );
      for (const result of deleted) {
        if (result.status === "rejected") {
          throw result.reason;
        }
      }
    }
  }

  async function cleanupFixture(fixture: AccountCatalogFixture): Promise<void> {
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const accountsApi = accountClient();
    for (const connectorSlug of ["openai", "github"] as const) {
      let hasBuiltinAccounts = true;
      while (hasBuiltinAccounts) {
        const accounts = await accept(
          accountsApi.connections({
            headers: authHeaders(),
            query: { kind: "builtin", connectorSlug, limit: 100 },
          }),
          [200, 404],
        );
        hasBuiltinAccounts =
          accounts.status === 200 && accounts.body.connections.length > 0;
        if (accounts.status !== 200) {
          break;
        }
        await deleteBuiltinAccountPage(
          connectorSlug,
          accounts.body.connections,
        );
      }
    }
    const customConnectors = await accept(
      customConnectorClient().list({ headers: authHeaders() }),
      [200],
    );
    for (const definition of customConnectors.body.connectors) {
      const customAccounts = await accept(
        accountClient().connections({
          headers: authHeaders(),
          query: {
            kind: "custom",
            customConnectorId: definition.id,
            limit: 100,
          },
        }),
        [200, 404],
      );
      if (customAccounts.status === 200) {
        for (const account of customAccounts.body.connections) {
          await accept(
            accountClient().delete({
              headers: authHeaders(),
              params: { connectionId: account.id },
              body: {
                target: {
                  kind: "custom",
                  customConnectorId: definition.id,
                },
              },
            }),
            [200, 404],
          );
        }
      }
      await accept(
        customConnectorByIdClient().delete({
          headers: authHeaders(),
          params: { id: definition.id },
        }),
        [204, 404],
      );
    }
  }

  describe("connector account lifecycle routes", () => {
    const track = createFixtureTracker<AccountCatalogFixture>(cleanupFixture);

    async function seedFixture(
      overrides: Partial<AccountCatalogFixture> = {},
    ): Promise<AccountCatalogFixture> {
      const fixture = await track(
        Promise.resolve({
          orgId: overrides.orgId ?? `org_${randomUUID()}`,
          userId: overrides.userId ?? `user_${randomUUID()}`,
        }),
      );
      mocks.clerk.session(fixture.userId, fixture.orgId);
      return fixture;
    }

    it("reviews requested scopes for one exact account across default changes", async () => {
      const fixture = await seedFixture();
      const currentScopes = ["repo", "project", "workflow"] as const;
      const actor = createBddApi(context).user(fixture);
      const connectors = createConnectorBddApi(context);
      const catalog = createPublicConnectorCatalog(context, {
        cleanupOwnership: "caller",
        isolatePg: true,
      });
      const staleCatalog = catalogWithAuthMethod(
        { connectorSlug: "github", authMethodId: "oauth" },
        (method) => {
          if (method.grant.kind !== "auth-code") {
            throw new Error("Expected the GitHub authorization-code method");
          }
          return { ...method, grant: { ...method.grant, scopes: ["repo"] } };
        },
      );
      const accountIds: string[] = [];
      catalog.onCleanup(async () => {
        const accounts = await connectors.listBuiltinConnectorAccounts(
          actor,
          "github",
        );
        for (const account of accounts) {
          if (accountIds.includes(account.id)) {
            await connectors.deleteBuiltinConnectorAccount(
              actor,
              "github",
              account.id,
            );
          }
        }
      });
      const connectAccount = async (userId: number) => {
        mockGitHubConnectorOAuth({ userId, login: `scope-review-${userId}` });
        // Grants can be narrower than the selected catalog's requested scopes.
        server.use(
          http.post("https://github.com/login/oauth/access_token", () => {
            return HttpResponse.json({
              access_token: `scope-review-${userId}`,
              scope: "repo",
            });
          }),
        );
        const started = await connectors.startOauth(actor, "github", "oauth");
        const state = new URL(started.authorizationUrl).searchParams.get(
          "state",
        );
        if (!state) {
          throw new Error("Expected GitHub OAuth state");
        }
        await connectors.completeOauthCallback("github", {
          code: `scope-review-${userId}`,
          state,
        });
        const accounts = await connectors.listBuiltinConnectorAccounts(
          actor,
          "github",
        );
        const account = accounts.find((candidate) => {
          return candidate.externalId === String(userId);
        });
        if (!account) {
          throw new Error("Expected the exact GitHub provider identity");
        }
        accountIds.push(account.id);
        return account.id;
      };
      await catalog.publish(staleCatalog);
      const staleId = await connectAccount(1001);
      await catalog.publish(API_TEST_CONNECTOR_CATALOG);
      const currentId = await connectAccount(1002);
      await connectors.setDefaultBuiltinConnectorAccount(
        actor,
        "github",
        currentId,
      );

      const legacyList = await accept(
        accountClient().connections({
          headers: authHeaders(),
          query: { kind: "builtin", connectorSlug: "github", limit: 100 },
        }),
        [200],
      );
      expect(
        legacyList.body.connections.every((account) => {
          return !("scopeMismatch" in account);
        }),
      ).toBeTruthy();
      expect("defaultConnection" in legacyList.body).toBeFalsy();

      const enrichedList = await accept(
        accountClient().connections({
          headers: authHeaders(),
          query: {
            kind: "builtin",
            connectorSlug: "github",
            includeScopeMismatch: "true",
            limit: 100,
          },
        }),
        [200],
      );
      const mismatchById = new Map(
        enrichedList.body.connections.map((account) => {
          return [account.id, account.scopeMismatch] as const;
        }),
      );
      expect(mismatchById).toStrictEqual(
        new Map([
          [staleId, true],
          [currentId, false],
        ]),
      );
      expect(enrichedList.body.defaultConnection).toMatchObject({
        id: currentId,
        scopeMismatch: false,
      });

      const filteredList = await accept(
        accountClient().connections({
          headers: authHeaders(),
          query: {
            kind: "builtin",
            connectorSlug: "github",
            includeScopeMismatch: "true",
            limit: 100,
            search: staleId,
          },
        }),
        [200],
      );
      expect(filteredList.body.connections).toHaveLength(1);
      expect(filteredList.body.connections[0]?.id).toBe(staleId);
      expect("defaultConnection" in filteredList.body).toBeFalsy();

      const staleDiff = await accept(
        accountClient().scopeDiff({
          headers: authHeaders(),
          params: { connectionId: staleId },
          query: { connectorSlug: "github" },
        }),
        [200],
      );
      expect(staleDiff.body).toStrictEqual({
        addedScopes: ["project", "workflow"],
        removedScopes: [],
        currentScopes,
        storedScopes: ["repo"],
      });
      const currentDiff = await accept(
        accountClient().scopeDiff({
          headers: authHeaders(),
          params: { connectionId: currentId },
          query: { connectorSlug: "github" },
        }),
        [200],
      );
      expect(currentDiff.body).toStrictEqual({
        addedScopes: [],
        removedScopes: [],
        currentScopes,
        storedScopes: currentScopes,
      });

      await accept(
        accountClient().setDefault({
          headers: authHeaders(),
          params: { connectionId: staleId },
          body: { target: { kind: "builtin", connectorSlug: "github" } },
        }),
        [200],
      );
      const currentDiffAfterDefaultChange = await accept(
        accountClient().scopeDiff({
          headers: authHeaders(),
          params: { connectionId: currentId },
          query: { connectorSlug: "github" },
        }),
        [200],
      );
      expect(currentDiffAfterDefaultChange.body).toStrictEqual(
        currentDiff.body,
      );

      await accept(
        accountClient().scopeDiff({
          headers: authHeaders(),
          params: { connectionId: currentId },
          query: { connectorSlug: "openai" },
        }),
        [404],
      );
      await seedFixture();
      await accept(
        accountClient().scopeDiff({
          headers: authHeaders(),
          params: { connectionId: currentId },
          query: { connectorSlug: "github" },
        }),
        [404],
      );

      mocks.clerk.session(fixture.userId, fixture.orgId);
      await accept(
        accountClient().delete({
          headers: authHeaders(),
          params: { connectionId: currentId },
          body: { target: { kind: "builtin", connectorSlug: "github" } },
        }),
        [200],
      );
      await accept(
        accountClient().scopeDiff({
          headers: authHeaders(),
          params: { connectionId: currentId },
          query: { connectorSlug: "github" },
        }),
        [404],
      );
      await catalog.cleanup();
    });

    it("treats a removed built-in catalog target as absent", async () => {
      const fixture = await seedFixture();
      const actor = createBddApi(context).user(fixture);
      const connectors = createConnectorBddApi(context);
      const catalog = createPublicConnectorCatalog(context, {
        cleanupOwnership: "caller",
        isolatePg: true,
      });
      const available = catalogWithManualConnector({
        connectorSlug: "retired-connector",
        authMethodId: "api-token",
      });
      await catalog.publish(available);
      const account = await connectors.connectManualGrant(
        actor,
        "retired-connector",
        "api-token",
        {
          credential: "retired-connector-secret",
        },
      );
      const accountId = account.id;
      catalog.onCleanup(async () => {
        await catalog.publish(available);
        await connectors.deleteDefaultBuiltinConnectorAccount(
          actor,
          "retired-connector",
        );
      });
      await catalog.publish(API_TEST_CONNECTOR_CATALOG);

      const summary = await accept(
        accountClient().summaries({ headers: authHeaders() }),
        [200],
      );
      expect(summary.body.summaries).not.toContainEqual(
        expect.objectContaining({
          target: { kind: "builtin", connectorSlug: "retired-connector" },
        }),
      );
      await accept(
        accountClient().connections({
          headers: authHeaders(),
          query: {
            kind: "builtin",
            connectorSlug: "retired-connector",
            limit: 100,
          },
        }),
        [404],
      );
      await accept(
        accountClient().connection({
          headers: authHeaders(),
          params: { connectionId: accountId },
          query: {
            kind: "builtin",
            connectorSlug: "retired-connector",
          },
        }),
        [404],
      );
      await accept(
        accountClient().rename({
          headers: authHeaders(),
          params: { connectionId: accountId },
          body: {
            target: { kind: "builtin", connectorSlug: "retired-connector" },
            displayName: "Must remain absent",
          },
        }),
        [404],
      );
      await catalog.cleanup();
    });
  });
});
