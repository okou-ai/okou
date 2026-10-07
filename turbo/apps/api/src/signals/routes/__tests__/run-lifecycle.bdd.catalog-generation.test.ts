import {
  builtinConnectorAutomaticContract,
  builtinConnectorNoAuthGrantContract,
} from "@okouai/api-contracts/contracts/connectors";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { connectorCheckContract } from "@okouai/api-contracts/contracts/connector-check";
import type { ExecutionContext } from "@okouai/api-contracts/contracts/runners";
import type { ExecutionFirewallEntry } from "@okouai/connectors/firewall-types";
import { describe, expect, it } from "vitest";

import { mockEnv } from "../../../lib/env";
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
import { createRouteMocks } from "./helpers/route-test";

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
  it.each(["none", "oauth"] as const)(
    "admits the exact builtin Automatic %s account and injects auth outside the sandbox",
    async (resolution) => {
      const catalog = createPublicAutomaticCatalog(context, {
        isolatePg: true,
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
        const fw = createFirewallApi(context);
        const { actor, agentId, runnerGroup } = await catalog.prepareRuntime();
        const connectionId = await connectAutomaticRuntime({
          actor,
          agentId,
          ...catalog,
          issuer: provider.issuer,
        });
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
      });
    },
  );

  it.each(["none", "manual"] as const)(
    "keeps catalog auth when reconnecting builtin Automatic to %s",
    async (authMode) => {
      const catalog = createPublicAutomaticCatalog(context, {
        isolatePg: true,
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
      });
    },
  );
});
