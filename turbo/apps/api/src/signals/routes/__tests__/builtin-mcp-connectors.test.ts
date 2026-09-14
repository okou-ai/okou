import { randomUUID } from "node:crypto";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { connectorNoAuthGrantContract } from "@okouai/api-contracts/contracts/connectors";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { mcpConnectorsContract } from "@okouai/api-contracts/contracts/mcp-connectors";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { connectorCatalogRoutes } from "../connector-catalog";
import { connectorsRoutes } from "../connectors";
import { connectorAccountRoutes } from "../connector-accounts";
import { mcpConnectorsRoutes } from "../mcp-connectors";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { createRouteMocks } from "./helpers/route-test";
import { parseHttpOnlyCatalogList } from "./helpers/http-only-catalog-client";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);
const runs = createRunsApi(context);
const firewall = createFirewallApi(context);
const mocks = createRouteMocks(context);
const sessionHeaders = { authorization: "Bearer clerk-session" } as const;

function client() {
  return setupApp({ context, routes: mcpConnectorsRoutes })(
    mcpConnectorsContract,
  );
}

function authenticate(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return sessionHeaders;
}

async function prepare() {
  const actor = bdd.user({ orgRole: "org:admin" });
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const runnerGroup = runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  await runs.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "Builtin MCP Agent",
  });
  await connectors.updateFeatureSwitches(actor, {
    [FeatureSwitchKey.BuiltinConnectorMcp]: true,
  });
  return { actor, agent, runnerGroup };
}

async function start(prepared: Awaited<ReturnType<typeof prepare>>) {
  const run = await runs.createRun(prepared.actor, {
    agentId: prepared.agent.agentId,
    prompt: "Use MCP tools",
    modelProvider: "anthropic-api-key",
  });
  await runs.heartbeatRunner(prepared.runnerGroup);
  const claim = await runs.claimRunnerJob(run.runId);
  const token = claim.platformEnvironment.OKOU_TOKEN;
  if (!token) {
    throw new Error("Expected a real run token");
  }
  return { run, claim, headers: { authorization: `Bearer ${token}` } };
}

function connectNone(actor: ApiTestUser, agentId?: string) {
  const api = setupApp({ context, routes: connectorsRoutes })(
    connectorNoAuthGrantContract,
  );
  return api.connect({
    headers: authenticate(actor),
    params: { connectorSlug: "test-no-auth-mcp" },
    body: {
      authMethod: "none",
      account: { intent: "add" },
      ...(agentId ? { agentId, authorizeAgent: true as const } : {}),
    },
  });
}

describe("builtin MCP catalog and runs", () => {
  it("scopes collections before discovery limits and keeps omitted protocol HTTP-only", async () => {
    const actor = bdd.user({ orgRole: "org:admin" });
    await connectors.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.BuiltinConnectorMcp]: true,
    });
    const api = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const headers = authenticate(actor);
    const http = await accept(api.list({ headers }), [200]);
    expect(parseHttpOnlyCatalogList(http.body)).toStrictEqual(http.body);
    expect(http.body.connectors.length).toBeGreaterThan(3);
    expect(
      http.body.connectors.every((item) => {
        return item.protocol === undefined;
      }),
    ).toBeTruthy();
    const mcp = await accept(
      api.discovery({ headers, query: { protocol: "mcp" } }),
      [200],
    );
    expect(
      mcp.body.connectors
        .map((item) => {
          return item.slug;
        })
        .sort(),
    ).toStrictEqual(["test-headers-mcp", "test-no-auth-mcp", "test-query-mcp"]);
    expect(
      mcp.body.connectors.every((item) => {
        return (
          item.protocol === "mcp" && !item.permissionSummary.hasPermissions
        );
      }),
    ).toBeTruthy();
    expect(mcp.body.categoryConnectorCounts).toStrictEqual({
      "test-connectors": 3,
    });
    const all = await accept(
      api.list({ headers, query: { protocol: "all" } }),
      [200],
    );
    expect(all.body.connectors).toHaveLength(http.body.connectors.length + 3);
    const search = await accept(
      api.discovery({
        headers,
        query: { protocol: "mcp", keyword: "Public Tools" },
      }),
      [200],
    );
    expect(
      search.body.connectors.map((item) => {
        return item.slug;
      }),
    ).toStrictEqual(["test-no-auth-mcp"]);
    const status = await accept(
      api.status({ headers, query: { protocol: "mcp" } }),
      [200],
    );
    expect(status.body.connectors).toHaveLength(3);
  });

  it("gates new builtin MCP connections without disabling HTTP or using the custom switch", async () => {
    const actor = bdd.user({ orgRole: "org:admin" });
    await connectors.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.CustomConnectorMcp]: true,
      [FeatureSwitchKey.BuiltinConnectorMcp]: false,
    });
    await accept(connectNone(actor), [403]);
    await connectors.requestManualGrant(
      actor,
      "test-headers-mcp",
      "api-token",
      { token: "hidden" },
      { statuses: [403] },
    );
    const api = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const hidden = await accept(
      api.list({ headers: authenticate(actor), query: { protocol: "mcp" } }),
      [200],
    );
    expect(hidden.body.connectors).toStrictEqual([]);
    await connectors.connectManualGrant(actor, "openai", "api-token", {
      apiKey: "http-still-works",
    });
  });

  it("does not admit existing MCP accounts when its switch is disabled", async () => {
    const prepared = await prepare();
    await accept(connectNone(prepared.actor, prepared.agent.agentId), [200]);
    await connectors.connectManualGrant(
      prepared.actor,
      "gitlab",
      "api-token",
      {
        accessToken: "http-credential",
      },
      prepared.agent.agentId,
    );
    await connectors.updateFeatureSwitches(prepared.actor, {
      [FeatureSwitchKey.BuiltinConnectorMcp]: false,
    });
    const { run, claim, headers } = await start(prepared);
    expect(claim.firewalls).not.toContainEqual(
      expect.objectContaining({ name: "test-no-auth-mcp" }),
    );
    expect(claim.firewalls).toContainEqual(
      expect.objectContaining({ name: "gitlab" }),
    );
    expect(
      (await accept(client().list({ headers }), [200])).body.connectors,
    ).toStrictEqual([]);
    expect(claim.appendSystemPrompt).not.toContain("# MCP Connectors");
    await connectors.updateFeatureSwitches(prepared.actor, {
      [FeatureSwitchKey.BuiltinConnectorMcp]: true,
    });
    // Enabling discovery later cannot retroactively admit this run.
    expect(
      (await accept(client().list({ headers }), [200])).body.connectors,
    ).toStrictEqual([]);
    await runs.requestCancelRun(prepared.actor, run.runId, [200]);
  });

  it("requires an account and an Agent grant even when no auth is needed", async () => {
    const prepared = await prepare();
    const unconnected = await start(prepared);
    expect(
      (await accept(client().list({ headers: unconnected.headers }), [200]))
        .body.connectors,
    ).toStrictEqual([]);
    await runs.requestCancelRun(prepared.actor, unconnected.run.runId, [200]);
    const account = await accept(
      connectNone(prepared.actor, prepared.agent.agentId),
      [200],
    );
    const { run, claim, headers } = await start(prepared);
    expect(claim.appendSystemPrompt).toContain("# MCP Connectors");
    expect(claim.appendSystemPrompt).toContain("okou mcp list --json");
    expect(claim.appendSystemPrompt).toContain("`test-no-auth-mcp`");
    expect(claim.firewalls).toContainEqual({
      kind: "builtin",
      name: "test-no-auth-mcp",
      sourceId: account.body.id,
    });
    const response = await accept(client().list({ headers }), [200]);
    expect(response.body.connectors).toStrictEqual([
      {
        kind: "builtin",
        slug: "test-no-auth-mcp",
        displayName: "Public Tools",
        transport: "streamable-http",
        endpoint: "https://public-tools.example.test/mcp",
        connected: true,
      },
    ]);
    await accept(
      client().reauthorizeOAuth({
        headers,
        body: {
          target: { kind: "builtin", connectorSlug: "test-no-auth-mcp" },
          scopes: ["tools:read"],
        },
      }),
      [409],
    );
    const oldToken = runs.okouTokenForRunWithCapabilities(
      prepared.actor,
      run.runId,
      ["connector:read"],
    );
    expect(
      (
        await accept(
          client().list({ headers: { authorization: `Bearer ${oldToken}` } }),
          [200],
        )
      ).body.connectors,
    ).toStrictEqual([]);
    await runs.requestCancelRun(prepared.actor, run.runId, [200]);
    await runs.enableAgentConnectors(
      prepared.actor,
      prepared.agent.agentId,
      [],
    );
    const ungranted = await start(prepared);
    expect(
      (await accept(client().list({ headers: ungranted.headers }), [200])).body
        .connectors,
    ).toStrictEqual([]);
    await runs.requestCancelRun(prepared.actor, ungranted.run.runId, [200]);
  });

  it.each(["headers", "query"] as const)(
    "keeps manual %s auth outside sandbox and pins the run account",
    async (kind) => {
      const prepared = await prepare();
      const slug = `test-${kind}-mcp`;
      const first = await connectors.connectManualGrant(
        prepared.actor,
        slug,
        "api-token",
        { token: "admitted-credential" },
        prepared.agent.agentId,
      );
      const second = await connectors.connectManualGrant(
        prepared.actor,
        slug,
        "api-token",
        { token: "different-credential" },
        undefined,
        { intent: "add", displayName: "Other account" },
      );
      const { run, claim, headers } = await start(prepared);
      const alias = `TEST_MCP_${kind.toUpperCase()}_TOKEN`;
      expect(claim.environment).not.toHaveProperty(alias);
      expect(JSON.stringify(claim.environment)).not.toContain(
        "admitted-credential",
      );
      expect(claim.firewalls).toContainEqual({
        kind: "builtin",
        name: slug,
        sourceId: first.id,
      });
      const accounts = setupApp({ context, routes: connectorAccountRoutes })(
        connectorAccountsContract,
      );
      await accept(
        accounts.setDefault({
          headers: authenticate(prepared.actor),
          params: { connectionId: second.id },
          body: { target: { kind: "builtin", connectorSlug: slug } },
        }),
        [200],
      );
      const { secretConnectorMap, secretConnectorMetadataMap } = claim;
      if (!secretConnectorMap || !secretConnectorMetadataMap) {
        throw new Error("Expected exact firewall credential bindings");
      }
      const auth = await firewall.requestFirewallAuth(
        firewall.sandboxHeaders(prepared.actor, run.runId),
        {
          encryptedSecrets: firewall.encryptedSecretsBody({}),
          secretConnectorMap,
          secretConnectorMetadataMap,
          authHeaders:
            kind === "headers"
              ? { Authorization: `Bearer ${secretTemplate(alias)}` }
              : {},
          ...(kind === "query"
            ? { authQuery: { api_key: secretTemplate(alias) } }
            : {}),
          matchedFirewall: {
            name: slug,
            apiId: "mcp",
            connectorSlug: slug,
            sourceId: first.id,
            routingVariables: {},
          },
        },
        [200],
      );
      expect(JSON.stringify(auth.body)).toContain("admitted-credential");
      expect(JSON.stringify(auth.body)).not.toContain("different-credential");
      expect(
        (await accept(client().list({ headers }), [200])).body.connectors,
      ).toContainEqual(
        expect.objectContaining({ kind: "builtin", slug, connected: true }),
      );
      await accept(
        accounts.delete({
          headers: authenticate(prepared.actor),
          params: { connectionId: first.id },
          body: { target: { kind: "builtin", connectorSlug: slug } },
        }),
        [200],
      );
      expect(
        (await accept(client().list({ headers }), [200])).body.connectors,
      ).toStrictEqual([]);
      await runs.requestCancelRun(prepared.actor, run.runId, [200]);
    },
  );

  it.each(["missing", "wrong-slug"] as const)(
    "rejects %s and foreign exact accounts while retaining an independent valid descriptor",
    async (unavailable) => {
      const prepared = await prepare();
      const publicAccount = await accept(
        connectNone(prepared.actor, prepared.agent.agentId),
        [200],
      );
      const foreign = bdd.user();
      await connectors.updateFeatureSwitches(foreign, {
        [FeatureSwitchKey.BuiltinConnectorMcp]: true,
      });
      const foreignAccount = await connectors.connectManualGrant(
        foreign,
        "test-headers-mcp",
        "api-token",
        { token: "foreign" },
      );
      const { run } = await start(prepared);
      const seconds = Math.floor(now() / 1000);
      if (!prepared.actor.orgId) {
        throw new Error("Expected an organization-scoped actor");
      }
      const token = signSandboxJwtForTests({
        scope: "okou",
        orgId: prepared.actor.orgId,
        userId: prepared.actor.userId,
        runId: run.runId,
        capabilities: ["connector:read"],
        iat: seconds,
        exp: seconds + 3600,
        builtinMcpSourceIds: {
          "test-no-auth-mcp": publicAccount.body.id,
          "test-headers-mcp": foreignAccount.id,
          "test-query-mcp":
            unavailable === "missing" ? randomUUID() : publicAccount.body.id,
          openai: publicAccount.body.id,
        },
      });
      const result = await accept(
        client().list({ headers: { authorization: `Bearer ${token}` } }),
        [200],
      );
      expect(
        result.body.connectors.map((item) => {
          return item.slug;
        }),
      ).toStrictEqual(["test-no-auth-mcp"]);
      await runs.requestCancelRun(prepared.actor, run.runId, [200]);
    },
  );
});
