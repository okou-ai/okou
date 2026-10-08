import { builtinConnectorAutomaticContract } from "@okouai/api-contracts/contracts/connectors";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { connectorCheckContract } from "@okouai/api-contracts/contracts/connector-check";
import type { ExecutionContext } from "@okouai/api-contracts/contracts/runners";
import type { ExecutionFirewallEntry } from "@okouai/connectors/firewall-types";
import { describe, expect, it, onTestFinished } from "vitest";

import { mockEnv } from "../../../lib/env";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockAutomaticMcpOAuthProvider } from "./helpers/api-bdd-connectors";
import { createFirewallApi } from "./helpers/api-bdd-firewall";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { builtinConnectorsAutomaticRoutes } from "../connectors-automatic";
import { connectorAccountRoutes } from "../connector-accounts";
import { connectorCheckRoutes } from "../connector-check";
import { automaticMcpCatalogFixture } from "./helpers/connector-automatic-catalog";
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
      const catalog = automaticMcpCatalogFixture(resolution);
      const provider = mockAutomaticMcpOAuthProvider(context, {
        registration: "cimd",
        authentication: resolution,
        initialExpiresIn: 3600,
      });
      const api = createRunsApi(context);
      const fw = createFirewallApi(context);
      const bdd = createBddApi(context);
      const actor = bdd.user();
      bdd.acceptAgentStorageWrites();
      api.acceptStorageDownloads();
      api.acceptTelemetryIngest();
      const runnerGroup = api.configureRunnerGroup();
      await api.grantProEntitlement(actor);
      await api.ensurePersonalSubscriptionModel(actor);
      const { agentId } = await bdd.createAgent(actor, {
        displayName: "Automatic runtime agent",
        visibility: "private",
      });
      const connectionId = await connectAutomaticRuntime({
        actor,
        agentId,
        ...catalog,
        issuer: provider.issuer,
      });
      onTestFinished(async () => {
        createRouteMocks(context).clerk.session(
          actor.userId,
          actor.orgId,
          actor.orgRole,
        );
        await accept(
          setupApp({ context, routes: connectorAccountRoutes })(
            connectorAccountsContract,
          ).delete({
            headers: { authorization: "Bearer clerk-session" },
            params: { connectionId },
            body: { target: catalog.target },
          }),
          [200],
        );
      });
      const run = await api.createThreadRun(actor, {
        agentId,
        prompt: `use builtin Automatic ${resolution}`,
      });
      const runOwner: { sandboxToken?: string } = {};
      onTestFinished(async () => {
        const current = await api.readRun(actor, run.runId);
        const active =
          current.status === "pending" || current.status === "running";
        if (active) {
          await api.requestCancelRun(actor, run.runId, [200]);
        }
        if (
          runOwner.sandboxToken &&
          (active || current.status === "cancelled")
        ) {
          await createWebhookCallbackApi(context).requestAgentComplete(
            { runId: run.runId, exitCode: 1, error: "Run cancelled" },
            { authorization: `Bearer ${runOwner.sandboxToken}` },
            [200],
          );
        }
      });
      await api.heartbeatRunner(runnerGroup);
      const claim = await api.claimRunnerJob(run.runId);
      runOwner.sandboxToken = claim.sandboxToken;
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
      if (!claim.encryptedSecrets) {
        throw new Error(
          "Expected encrypted secrets from the authenticated Runner claim",
        );
      }
      const authBody = {
        encryptedSecrets: claim.encryptedSecrets,
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
    },
  );
});
