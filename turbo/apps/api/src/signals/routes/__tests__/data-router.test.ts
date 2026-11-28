import { randomUUID } from "node:crypto";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import {
  dataRouterHistoryContract,
  runDataRouterRequestContract,
} from "@okouai/api-contracts/contracts/data-router";
import { DATA_ROUTER_PROTOCOL_VERSION } from "@okouai/api-contracts/contracts/data-router-tools";
import { beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { billingStatusRoutes } from "../billing-status";
import { dataRouterHistoryRoutes } from "../data-router-history";
import { webhooksAgentDataRequestRoutes } from "../webhooks-agent-data-request";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const runs = createRunsApi(context);
const firewall = createFirewallApi(context);
const webhooks = createWebhookCallbackApi(context);
const ROUTER = "https://data-router.test/mcp";

beforeEach(() => {
  mockEnv("ENV", "development");
  mockEnv("SECRETS_ENCRYPTION_KEY", "a".repeat(64));
  mockEnv("OKOU_DATA_ROUTER_URL", ROUTER);
  mockEnv("OKOU_DATA_TOKEN", "router-test-service-token");
  bdd.acceptStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
});

async function createRun(actor = bdd.user()) {
  await runs.grantProEntitlement(actor);
  await runs.ensurePersonalSubscriptionModel(actor);

  const runnerGroup = await runs.configureRunnerGroup();
  const run = await runs.createThreadRun(actor, {
    prompt: "Read data",
  });
  await runs.heartbeatRunner(runnerGroup);
  const execution = await runs.executionInput(run.runId);
  return {
    actor,
    runId: run.runId,
    execution,
    headers: { authorization: `Bearer ${execution.sandboxToken}` },
  };
}

function auth(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}

async function credits(actor: ApiTestUser) {
  const result = await accept(
    setupApp({ context, routes: billingStatusRoutes })(
      billingStatusContract,
    ).get({ headers: auth(actor) }),
    [200],
  );
  return result.body.credits;
}

function register(
  run: Awaited<ReturnType<typeof createRun>>,
  requestId: string,
) {
  return setupApp({ context, routes: webhooksAgentDataRequestRoutes })(
    runDataRouterRequestContract,
  ).register({ headers: run.headers, body: { runId: run.runId, requestId } });
}

async function finish(run: Awaited<ReturnType<typeof createRun>>) {
  await webhooks.requestAgentComplete(
    { runId: run.runId, exitCode: 1, error: "Test finished" },
    run.headers,
    [200],
  );
  await flushWaitUntilForTest();
}

describe("Data Router accounting when a run ends", () => {
  it("resolves the service token only at auth and totals reported request credits once", async () => {
    const run = await createRun();
    expect(run.execution.platformEnvironment.OKOU_DATA_ROUTER_URL).toBe(ROUTER);
    expect(run.execution.firewalls).toContainEqual(
      expect.objectContaining({
        kind: "inline",
        firewall: expect.objectContaining({
          name: "data-router",
          placeholders: {
            OKOU_DATA_TOKEN: "OkouConnectore6d27185288fb0be86fa",
          },
        }),
      }),
    );
    expect(
      JSON.stringify([
        run.execution.environment,
        run.execution.platformEnvironment,
      ]),
    ).not.toContain("router-test-service-token");
    expect(JSON.stringify(run.execution)).not.toContain(
      "router-test-service-token",
    );
    const authHeaders = {
      Authorization: `Bearer ${secretTemplate("OKOU_DATA_TOKEN")}`,
    };
    const resolved = await firewall.requestFirewallAuth(
      { authorization: `Bearer ${run.execution.firewallToken}` },
      { authHeaders, firewallBillable: true },
      [200],
    );
    expect(resolved.body).toMatchObject({
      headers: { Authorization: "Bearer router-test-service-token" },
      resolvedSecrets: ["OKOU_DATA_TOKEN"],
      expiresAt: expect.any(Number),
    });
    const personalSource = Object.values(
      run.execution.secretConnectorMetadataMap ?? {},
    ).find((source) => {
      return source.sourceType === "model-provider";
    });
    if (!personalSource?.metadataKey) {
      throw new Error("Expected the dispatched personal model source");
    }
    for (const secretConnectorMap of [
      { OKOU_DATA_TOKEN: personalSource.metadataKey },
      undefined,
    ]) {
      const mapped = await firewall.requestFirewallAuth(
        { authorization: `Bearer ${run.execution.firewallToken}` },
        {
          authHeaders,
          secretConnectorMap,
          secretConnectorMetadataMap: { OKOU_DATA_TOKEN: personalSource },
        },
        [424],
      );
      expect(mapped.body).toMatchObject({
        error: { code: "CONNECTOR_NOT_CONFIGURED" },
      });
    }
    const requestId = randomUUID();
    const secondRequestId = randomUUID();
    await accept(register(run, requestId), [200]);
    await accept(register(run, secondRequestId), [200]);
    const before = await credits(run.actor);
    server.use(
      http.post(ROUTER, async ({ request }) => {
        expect(request.headers.get("Authorization")).toBe(
          "Bearer router-test-service-token",
        );
        // A stateless 2026-07-28 request that accepts only a JSON response.
        expect(request.headers.get("Accept")).toBe("application/json");
        expect(request.headers.get("MCP-Protocol-Version")).toBe(
          DATA_ROUTER_PROTOCOL_VERSION,
        );
        expect(request.headers.get("Mcp-Method")).toBe("tools/call");
        expect(request.headers.get("Mcp-Name")).toBe("billing_get");
        const body = await request.json();
        expect(body).toMatchObject({
          method: "tools/call",
          params: {
            name: "billing_get",
            _meta: {
              "io.modelcontextprotocol/protocolVersion":
                DATA_ROUTER_PROTOCOL_VERSION,
            },
          },
        });
        return HttpResponse.json({
          jsonrpc: "2.0",
          id: "test",
          result: {
            structuredContent: {
              records: [
                { requestId, credits: 3 },
                { requestId: secondRequestId, credits: 4 },
              ],
            },
          },
        });
      }),
    );
    await finish(run);
    await expect(credits(run.actor)).resolves.toBe(before - 7);
    await firewall.requestFirewallAuth(
      { authorization: `Bearer ${run.execution.firewallToken}` },
      { authHeaders, firewallBillable: true },
      [403],
    );
    await finish(run);
    await expect(credits(run.actor)).resolves.toBe(before - 7);
  });

  it("dispatches a healthy Run without Data Router configuration and refuses its auth", async () => {
    mockEnv("OKOU_DATA_TOKEN", undefined);
    const run = await createRun();
    expect(run.execution.billableFirewalls).not.toContain("data-router");
    const unavailable = await firewall.requestFirewallAuth(
      { authorization: `Bearer ${run.execution.firewallToken}` },
      {
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("OKOU_DATA_TOKEN")}`,
        },
      },
      [424],
    );
    expect(unavailable.body).toMatchObject({
      error: { code: "CONNECTOR_NOT_CONFIGURED" },
    });
    await expect(runs.readRun(run.actor, run.runId)).resolves.toMatchObject({
      status: "running",
    });
    await finish(run);
  });

  it("settles captured usage after a completed Run", async () => {
    const run = await createRun();
    const requestId = randomUUID();
    await accept(register(run, requestId), [200]);
    const before = await credits(run.actor);
    const lookupEntered = createDeferredPromise<void>(context.signal);
    const releaseLookup = createDeferredPromise<void>(context.signal);
    server.use(
      http.post(ROUTER, async () => {
        lookupEntered.resolve(undefined);
        await releaseLookup.promise;
        return HttpResponse.json({
          jsonrpc: "2.0",
          id: "deleted-run",
          result: {
            structuredContent: { records: [{ requestId, credits: 4 }] },
          },
        });
      }),
    );
    const completion = webhooks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: 1,
        error: "Completed before usage settlement",
      },
      run.headers,
      [200],
    );
    await lookupEntered.promise;
    releaseLookup.resolve(undefined);
    await completion;
    await flushWaitUntilForTest();
    await expect(credits(run.actor)).resolves.toBe(before - 4);
  });

  it("settles reported usage once across cancellation and completion callbacks", async () => {
    const run = await createRun();
    const requestId = randomUUID();
    await accept(register(run, requestId), [200]);
    const before = await credits(run.actor);
    server.use(
      http.post(ROUTER, () => {
        return HttpResponse.json({
          jsonrpc: "2.0",
          id: "cancel",
          result: {
            structuredContent: { records: [{ requestId, credits: 3 }] },
          },
        });
      }),
    );
    await runs.requestCancelRun(run.actor, run.runId, [200]);
    await flushWaitUntilForTest();
    await expect(credits(run.actor)).resolves.toBe(before - 3);
    await runs.requestCancelRun(run.actor, run.runId, [200]);
    await finish(run);
    await expect(credits(run.actor)).resolves.toBe(before - 3);
  });

  it("scopes session and agent request history to the user's organization and rejects another Run token", async () => {
    const own = await createRun();
    const other = await createRun(bdd.user({ orgId: own.actor.orgId }));
    const otherOrg = await createRun(bdd.user({ userId: own.actor.userId }));
    const ownId = randomUUID();
    const otherId = randomUUID();
    const otherOrgId = randomUUID();
    await accept(register(own, ownId), [200]);
    await accept(register(other, otherId), [200]);
    await accept(register(otherOrg, otherOrgId), [200]);
    await accept(
      setupApp({ context, routes: webhooksAgentDataRequestRoutes })(
        runDataRouterRequestContract,
      ).register({
        headers: other.headers,
        body: { runId: own.runId, requestId: randomUUID() },
      }),
      [401],
    );
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [
        { role: own.actor.orgRole, organization: { id: own.actor.orgId } },
        {
          role: otherOrg.actor.orgRole,
          organization: { id: otherOrg.actor.orgId },
        },
      ],
      totalCount: 2,
    });
    for (const headers of [
      auth(own.actor),
      {
        authorization: `Bearer ${own.execution.platformEnvironment.OKOU_TOKEN}`,
      },
    ]) {
      const history = await accept(
        setupApp({ context, routes: dataRouterHistoryRoutes })(
          dataRouterHistoryContract,
        ).list({ headers }),
        [200],
      );
      expect(history.body.requestIds).toStrictEqual([ownId]);
    }
  });
});
