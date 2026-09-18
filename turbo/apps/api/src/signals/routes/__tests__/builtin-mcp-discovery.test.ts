import { randomUUID } from "node:crypto";
import { mcpConnectorsContract } from "@okouai/api-contracts/contracts/mcp-connectors";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { mcpConnectorsRoutes } from "../mcp-connectors";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);
const runs = createRunsApi(context);

function client() {
  return setupApp({ context, routes: mcpConnectorsRoutes })(
    mcpConnectorsContract,
  );
}

function token(
  actor: ApiTestUser,
  runId: string,
  sources?: Readonly<Record<string, string>>,
) {
  if (!actor.orgId) {
    throw new Error("Expected an organization");
  }
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "okou",
    orgId: actor.orgId,
    userId: actor.userId,
    runId,
    capabilities: ["connector:read", "connector:write"],
    builtinConnectorSourceIds: sources,
    iat: seconds,
    exp: seconds + 3600,
  });
}

async function discovery(
  actor: ApiTestUser,
  runId: string,
  sources?: Readonly<Record<string, string>>,
) {
  mockClerkMembership(context, actor, "org:admin");
  return await accept(
    client().list({
      headers: { authorization: `Bearer ${token(actor, runId, sources)}` },
    }),
    [200],
  );
}

async function setupRun() {
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  await runs.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "Account discovery Agent",
  });
  const run = await runs.createDirectRun(actor, {
    agentId: agent.agentId,
    prompt: "Discover admitted accounts",
    modelProviderType: "anthropic-api-key",
    vars: { OKOU_AGENT_ID: agent.agentId },
    secrets: { OKOU_TOKEN: "discovery-test-token" },
  });
  return { actor, run };
}

describe("builtin MCP discovery authority", () => {
  it("rejects absent, foreign, mismatched and deleted account bindings without choosing a default", async () => {
    const { actor, run } = await setupRun();
    await connectors.connectManualGrant(actor, "manual-mcp", "api-token", {
      apiKey: "owned-default",
    });
    const [account] = await connectors.listBuiltinConnectorAccounts(
      actor,
      "manual-mcp",
    );
    if (!account) {
      throw new Error("Expected owned account");
    }
    const foreign = bdd.user();
    await connectors.connectManualGrant(foreign, "manual-mcp", "api-token", {
      apiKey: "foreign-secret",
    });
    const [foreignAccount] = await connectors.listBuiltinConnectorAccounts(
      foreign,
      "manual-mcp",
    );
    if (!foreignAccount) {
      throw new Error("Expected foreign account");
    }
    const unavailableSources: readonly (
      | Readonly<Record<string, string>>
      | undefined
    )[] = [
      undefined,
      { "manual-mcp": foreignAccount.id },
      { "public-mcp": account.id },
      { "manual-mcp": randomUUID() },
    ];
    for (const sources of unavailableSources) {
      expect(
        (await discovery(actor, run.runId, sources)).body.connectors,
      ).toStrictEqual([]);
    }
    expect(
      (await discovery(actor, randomUUID(), { "manual-mcp": account.id })).body
        .connectors,
    ).toStrictEqual([]);
    expect(
      (await discovery(actor, run.runId, { "manual-mcp": account.id })).body
        .connectors,
    ).toMatchObject([
      {
        target: { kind: "builtin", connectorSlug: "manual-mcp" },
        connectionId: account.id,
        connected: true,
      },
    ]);
    await connectors.deleteBuiltinConnectorAccount(
      actor,
      "manual-mcp",
      account.id,
    );
    expect(
      (await discovery(actor, run.runId, { "manual-mcp": account.id })).body
        .connectors,
    ).toStrictEqual([]);
  });

  it("returns reconnect guidance for the exact non-default account", async () => {
    const { actor, run } = await setupRun();
    mockEnv("APP_URL", "https://app.okou.ai");
    await connectors.connectManualGrant(actor, "manual-mcp", "api-token", {
      apiKey: "default-secret",
    });
    await connectors.connectManualGrant(actor, "manual-mcp", "api-token", {
      apiKey: "selected-secret",
    });
    const accounts = await connectors.listBuiltinConnectorAccounts(
      actor,
      "manual-mcp",
    );
    const selected = accounts.find((account) => {
      return !account.isDefault;
    });
    if (!selected) {
      throw new Error("Expected non-default account");
    }
    const headers = {
      authorization: `Bearer ${token(actor, run.runId, { "manual-mcp": selected.id })}`,
    };
    mockClerkMembership(context, actor, "org:admin");
    const body = {
      target: { kind: "builtin" as const, connectorSlug: "manual-mcp" },
      scopes: ["read"],
    };
    const result = await accept(
      client().reauthorizeOAuth({
        headers,
        body,
      }),
      [200],
    );
    expect(result.body).toStrictEqual({
      kind: "reconnect",
      connectionId: selected.id,
      authorizationUrl: `https://app.okou.ai/connectors/manual-mcp/reconnect/${selected.id}`,
    });
    await connectors.deleteBuiltinConnectorAccount(
      actor,
      "manual-mcp",
      selected.id,
    );
    await accept(
      client().reauthorizeOAuth({
        headers,
        body,
      }),
      [409],
    );
  });
});
