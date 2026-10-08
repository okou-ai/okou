import { HttpResponse, http } from "msw";
import { server } from "../../../mocks/server";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { mcpConnectorsContract } from "@okouai/api-contracts/contracts/mcp-connectors";
import { connectorAccountRoutes } from "../connector-accounts";
import { mcpConnectorsRoutes } from "../mcp-connectors";
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
import { cronConnectorCatalogRoutes } from "../cron-connector-catalog";
import { builtinConnectorsRoutes } from "../connectors";
import { createRouteMocks } from "./helpers/route-test";
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

async function admittedMcpRun() {
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
  return { actor, connection, run, runs, client, headers };
}

describe("immutable connector catalog publication", () => {
  it("publishes the supplied catalog and keeps repeated publication idempotent", async () => {
    const first = release("2099-01-01.first", "First lifecycle catalog");
    serve(first);
    const response = await accept(sync(), [200]);
    expect(response.body).toStrictEqual({
      outcome: "accepted",
      failureCode: null,
    });
    await directory(first);
    const repeated = await accept(sync(), [200]);
    expect(repeated.body).toStrictEqual({
      outcome: "unchanged",
      failureCode: null,
    });
    const next = release("2099-01-01.next", "Next lifecycle catalog");
    serve(next);
    const changed = await accept(sync(), [200]);
    expect(changed.body).toStrictEqual({
      outcome: "accepted",
      failureCode: null,
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
      expect(response.body.failureCode).toBeNull();
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
    const { actor, connection, run, runs, client, headers } =
      await admittedMcpRun();
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

describe("current-publication account readers", () => {
  const mocks = routeMocks;
  const routes = Object.freeze([
    ...connectorAccountRoutes,
    ...builtinConnectorsRoutes,
  ]);

  function authHeaders() {
    return { authorization: "Bearer clerk-session" };
  }

  function accountClient() {
    return setupApp({ context, routes })(connectorAccountsContract);
  }

  describe("connector account lifecycle routes", () => {
    it("reviews requested scopes for one exact account across default changes", async () => {
      const actor = createBddApi(context).user();
      const currentScopes = ["repo", "project", "workflow"] as const;
      const connectors = createConnectorBddApi(context);
      const catalog = createPublicConnectorCatalog(context, {
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
      const otherActor = createBddApi(context).user();
      mocks.clerk.session(otherActor.userId, otherActor.orgId);
      await accept(
        accountClient().scopeDiff({
          headers: authHeaders(),
          params: { connectionId: currentId },
          query: { connectorSlug: "github" },
        }),
        [404],
      );

      mocks.clerk.session(actor.userId, actor.orgId);
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
    });

    it("treats a removed built-in catalog target as absent", async () => {
      const actor = createBddApi(context).user();
      const connectors = createConnectorBddApi(context);
      const catalog = createPublicConnectorCatalog(context, {
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
    });
  });
});
