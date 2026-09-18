import { randomUUID } from "node:crypto";

import { connectorNoAuthGrantContract } from "@okouai/api-contracts/contracts/connectors";
import { mcpConnectorsContract } from "@okouai/api-contracts/contracts/mcp-connectors";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { connectorsRoutes } from "../connectors";
import { mcpConnectorsRoutes } from "../mcp-connectors";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  manualHttpCustomConnectorCreateBody,
} from "./helpers/api-bdd-connectors";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);
const runs = createRunsApi(context);
const firewall = createFirewallApi(context);
const mocks = createRouteMocks(context);
const packageUrl = "https://static.okou.io/okou-cli/latest/package.tgz";

async function runActor() {
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const runnerGroup = runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  await runs.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "Builtin MCP Agent",
  });
  mockEnv("CLI_PKG_URL", packageUrl);
  return { actor, agentId: agent.agentId, runnerGroup };
}

async function connectPublic(actor: ApiTestUser, agentId: string) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  const response = await accept(
    setupApp({ context, routes: connectorsRoutes })(
      connectorNoAuthGrantContract,
    ).connect({
      headers: { authorization: "Bearer clerk-session" },
      params: { connectorSlug: "public-mcp" },
      body: {
        authMethod: "none",
        agentId,
        authorizeAgent: true,
        account: { intent: "add" },
      },
    }),
    [200],
  );
  return response.body.id;
}

describe("builtin MCP Run admission", () => {
  it("pins the admitted accounts and keeps MCP credentials behind firewall auth", async () => {
    const { actor, agentId, runnerGroup } = await runActor();
    const publicAccountId = await connectPublic(actor, agentId);
    await connectors.connectManualGrant(
      actor,
      "manual-mcp",
      "api-token",
      { apiKey: "admitted-mcp-token" },
      agentId,
    );
    const [admittedAccount] = await connectors.listBuiltinConnectorAccounts(
      actor,
      "manual-mcp",
    );
    if (!admittedAccount) {
      throw new Error("Expected the admitted manual MCP account");
    }
    const run = await runs.createRun(actor, {
      agentId,
      prompt: "Use the admitted builtin MCP tools",
      modelProvider: "anthropic-api-key",
    });

    await connectors.connectManualGrant(
      actor,
      "manual-mcp",
      "api-token",
      { apiKey: "new-default-mcp-token" },
      agentId,
    );
    const replacementAccount = (
      await connectors.listBuiltinConnectorAccounts(actor, "manual-mcp")
    ).find((account) => {
      return account.id !== admittedAccount.id;
    });
    if (!replacementAccount) {
      throw new Error("Expected the replacement default account");
    }
    await connectors.setDefaultBuiltinConnectorAccount(
      actor,
      "manual-mcp",
      replacementAccount.id,
    );
    await runs.heartbeatRunner(runnerGroup);
    const claim = await runs.claimRunnerJob(run.runId);
    expect(claim.platformEnvironment.CLI_PKG_URL).toBe(packageUrl);
    expect(claim.environment).not.toHaveProperty("MCP_API_KEY");
    expect(claim.platformEnvironment).not.toHaveProperty("MCP_API_KEY");
    expect(claim.secretConnectorMap ?? {}).not.toHaveProperty("MCP_API_KEY");
    expect(claim.secretConnectorMetadataMap ?? {}).not.toHaveProperty(
      "MCP_API_KEY",
    );
    expect(claim.secretValues).not.toContain("admitted-mcp-token");
    expect(claim.secretValues).not.toContain("new-default-mcp-token");
    expect(claim.firewalls).toStrictEqual(
      expect.arrayContaining([
        { kind: "builtin", name: "public-mcp", sourceId: publicAccountId },
        { kind: "builtin", name: "manual-mcp", sourceId: admittedAccount.id },
      ]),
    );
    expect(claim.networkPolicies?.["manual-mcp"]).toStrictEqual({
      allow: [],
      deny: [],
      ask: [],
      unknownPolicy: "allow",
    });
    expect(claim.appendSystemPrompt).toContain("# MCP Connectors");
    expect(claim.appendSystemPrompt).toContain("`manual-mcp`");
    expect(claim.appendSystemPrompt).toContain("`public-mcp`");
    const mountPaths =
      claim.storageManifest?.storageMounts.map((mount) => {
        return mount.mountPath;
      }) ?? [];
    expect(
      mountPaths.some((path) => {
        return path.endsWith("/manual-mcp") || path.endsWith("/public-mcp");
      }),
    ).toBeFalsy();
    const token = claim.platformEnvironment.OKOU_TOKEN;
    if (!token || !claim.encryptedSecrets) {
      throw new Error("Expected the admitted Run authentication context");
    }
    const discovery = await accept(
      setupApp({ context, routes: mcpConnectorsRoutes })(
        mcpConnectorsContract,
      ).list({
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );
    expect(discovery.body.connectors).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: { kind: "builtin", connectorSlug: "manual-mcp" },
          connectionId: admittedAccount.id,
          connected: true,
        }),
        expect.objectContaining({
          target: { kind: "builtin", connectorSlug: "public-mcp" },
          connectionId: publicAccountId,
          connected: true,
        }),
      ]),
    );
    const authBody = {
      encryptedSecrets: claim.encryptedSecrets,
      authHeaders: { Authorization: `Bearer ${secretTemplate("MCP_API_KEY")}` },
      secretConnectorMap: claim.secretConnectorMap ?? undefined,
      secretConnectorMetadataMap: claim.secretConnectorMetadataMap ?? undefined,
      matchedFirewall: {
        name: "manual-mcp",
        apiId: "manual-mcp:0",
        connectorSlug: "manual-mcp",
        sourceId: admittedAccount.id,
        routingVariables: {},
      },
    };
    const authorizationTime = now();
    mockNow(authorizationTime);
    const auth = await firewall.requestFirewallAuth(
      { authorization: `Bearer ${claim.sandboxToken}` },
      authBody,
      [200],
    );
    expect(auth.body).toMatchObject({
      headers: { Authorization: "Bearer admitted-mcp-token" },
      expiresAt: Math.floor(authorizationTime / 1000) + 30,
    });

    const collidingAliasAuth = await firewall.requestFirewallAuth(
      { authorization: `Bearer ${claim.sandboxToken}` },
      {
        ...authBody,
        encryptedSecrets: firewall.encryptedSecretsBody({
          MCP_API_KEY: "caller-owned-alias-value",
        }),
        secretConnectorMap: { MCP_API_KEY: "github" },
        secretConnectorMetadataMap: {},
      },
      [200],
    );
    expect(collidingAliasAuth.body).toMatchObject({
      headers: { Authorization: "Bearer admitted-mcp-token" },
    });

    await connectors.deleteBuiltinConnectorAccount(
      actor,
      "manual-mcp",
      admittedAccount.id,
    );
    const missingAccountAuth = await firewall.requestFirewallAuth(
      { authorization: `Bearer ${claim.sandboxToken}` },
      authBody,
      [424],
    );
    expect(missingAccountAuth.body).toMatchObject({
      error: { code: "CONNECTOR_NOT_CONFIGURED" },
    });
    await runs.requestCancelRun(actor, run.runId, [200]);
  });

  it("does not let an HTTP custom connector reuse MCP transport permissions", async () => {
    const actor = bdd.user();
    const response = await connectors.requestCreateCustomConnector(
      actor,
      {
        ...manualHttpCustomConnectorCreateBody({
          displayName: `HTTP permission boundary ${randomUUID()}`,
          prefixTemplates: ["https://manual-mcp.example.test/server"],
        }),
        permissionBundleRef: "builtin:manual-mcp@1",
      },
      [400],
    );
    expect(response.status).toBe(400);
  });
});
