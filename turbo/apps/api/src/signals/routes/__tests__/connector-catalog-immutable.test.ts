import { createPublicConnectorActor } from "./helpers/public-connector-actor";
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
import { createHash, randomUUID } from "node:crypto";
import { builtinConnectorsSearchContract } from "@okouai/api-contracts/contracts/connectors";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { onboardingSourcesContract } from "@okouai/api-contracts/contracts/onboarding";
import { connectorCatalogRoutes } from "../connector-catalog";
import { onboardingSourcesRoutes } from "../onboarding-sources";
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

import { describe, expect, it } from "vitest";
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
  it("follows permission metadata changes and removal across catalog publications", async () => {
    const client = catalogClient();
    const first = release(
      `2099-02-02.${randomUUID()}`,
      "First permission catalog",
      "notion",
    );
    serve(first);
    await accept(sync(), [200]);
    routeMocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const params = { connectorSlug: "notion" };
    const initial = await accept(
      client.permissions({ headers, params }),
      [200],
    );
    expect(initial.body.permissions.label).toBe("First permission catalog");

    const next = release(
      `2099-02-03.${randomUUID()}`,
      "Updated permission catalog",
      "notion",
    );
    serve(next);
    await accept(sync(), [200]);
    const updated = await accept(
      client.permissions({ headers, params }),
      [200],
    );
    expect(updated.body.permissions.label).toBe("Updated permission catalog");

    const removed = publication({
      ...next.artifact,
      catalogVersion: `2099-02-04.${randomUUID()}`,
      connectors: next.artifact.connectors.filter((connector) => {
        return connector.slug !== "notion";
      }),
    });
    serve(removed);
    await accept(sync(), [200]);
    const missing = await accept(
      client.permissions({ headers, params }),
      [404],
    );
    expect(missing.body.error.code).toBe("NOT_FOUND");
  });
  it("serves concurrent and subsequent catalog reads across publications", async () => {
    for (const label of ["Initial catalog", "Replacement catalog"]) {
      const candidate = release(`2099-02-01.${randomUUID()}`, label, "github");
      serve(candidate);
      expect((await sync()).body).toMatchObject({ outcome: "accepted" });
      routeMocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
      const client = catalogClient();
      const responses = await Promise.all(
        Array.from({ length: 3 }, () => {
          return accept(client.list({ headers }), [200]);
        }),
      );
      for (const response of responses) {
        expect(response.body.connectors).toContainEqual(
          expect.objectContaining({ slug: "github", label }),
        );
        expect(response.body).toStrictEqual(responses[0]?.body);
      }
      const subsequent = await accept(client.list({ headers }), [200]);
      expect(subsequent.body).toStrictEqual(responses[0]?.body);
      await directory(candidate);
      const oneClick = await accept(client.oneClick({ headers }), [200]);
      expect(oneClick.body.connectors.length).toBeGreaterThan(0);
    }
  });

  it("lists named onboarding sources from current entries", async () => {
    await publishedCatalog();
    const client = setupApp({ context, routes: onboardingSourcesRoutes })(
      onboardingSourcesContract,
    );
    const listed = await accept(client.list({ headers }), [200]);
    expect(listed.body.connectors.length).toBeGreaterThan(0);
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
      const currentScopes = ["repo", "project", "workflow"] as const;
      const connectors = createConnectorBddApi(context);
      const owner = createPublicConnectorActor(context, {
        optionalEnvironmentNames: [
          "GH_OAUTH_CLIENT_ID",
          "GH_OAUTH_CLIENT_SECRET",
        ],
        beforeWorkspaceCleanup: async (): Promise<void> => {
          const accounts = await connectors.listBuiltinConnectorAccounts(
            actor,
            "github",
          );
          for (const account of accounts) {
            await connectors.deleteBuiltinConnectorAccount(
              actor,
              "github",
              account.id,
            );
          }
        },
      });
      const { actor, run: own } = owner;
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
      const firstId = await own(() => {
        return connectAccount(1001);
      });
      const currentId = await own(() => {
        return connectAccount(1002);
      });
      await own(() => {
        return connectors.setDefaultBuiltinConnectorAccount(
          actor,
          "github",
          currentId,
        );
      });

      const plainList = await accept(
        accountClient().connections({
          headers: authHeaders(),
          query: { kind: "builtin", connectorSlug: "github", limit: 100 },
        }),
        [200],
      );
      expect(
        plainList.body.connections.every((account) => {
          return !("scopeMismatch" in account);
        }),
      ).toBeTruthy();
      expect(plainList.body.defaultConnection).toMatchObject({
        id: currentId,
        isDefault: true,
      });
      expect(plainList.body.defaultConnection).not.toHaveProperty(
        "scopeMismatch",
      );

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
          [firstId, false],
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
            search: firstId,
          },
        }),
        [200],
      );
      expect(filteredList.body.connections).toHaveLength(1);
      expect(filteredList.body.connections[0]?.id).toBe(firstId);
      expect(filteredList.body.defaultConnection).toMatchObject({
        id: currentId,
        isDefault: true,
        scopeMismatch: false,
      });

      const firstDiff = await accept(
        accountClient().scopeDiff({
          headers: authHeaders(),
          params: { connectionId: firstId },
          query: { connectorSlug: "github" },
        }),
        [200],
      );
      expect(firstDiff.body).toStrictEqual({
        addedScopes: [],
        removedScopes: [],
        currentScopes,
        storedScopes: currentScopes,
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
        own(() => {
          return accountClient().setDefault({
            headers: authHeaders(),
            params: { connectionId: firstId },
            body: { target: { kind: "builtin", connectorSlug: "github" } },
          });
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
        own(() => {
          return accountClient().delete({
            headers: authHeaders(),
            params: { connectionId: currentId },
            body: { target: { kind: "builtin", connectorSlug: "github" } },
          });
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
  });
});
