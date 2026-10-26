import { randomUUID } from "node:crypto";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import {
  dataRouterHistoryContract,
  dataRouterRequestContract,
} from "@okouai/api-contracts/contracts/data-router";
import { beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { billingStatusRoutes } from "../billing-status";
import { DATA_ROUTES } from "../../route-groups/data";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);
const ROUTER = "https://data-router.test/mcp";

beforeEach(() => {
  mockEnv("ENV", "development");
  mockEnv("SECRETS_ENCRYPTION_KEY", "a".repeat(64));
  mockEnv("OKOU_DATA_ROUTER_URL", ROUTER);
  mockEnv("OKOU_DATA_TOKEN", "router-test-service-token");
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
});

async function createRun(actor = bdd.user()) {
  await runs.grantProEntitlement(actor);
  await runs.ensurePersonalSubscriptionModel(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "Router accounting",
    visibility: "private",
  });
  const runnerGroup = runs.configureRunnerGroup();
  const run = await runs.createThreadRun(actor, {
    agentId: agent.agentId,
    prompt: "Read data",
  });
  await runs.heartbeatRunner(runnerGroup);
  const claim = await runs.claimRunnerJob(run.runId);
  return {
    actor,
    runId: run.runId,
    threadId: run.threadId,
    claim,
    headers: { authorization: `Bearer ${claim.sandboxToken}` },
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
  return setupApp({ context, routes: DATA_ROUTES })(
    dataRouterRequestContract,
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

describe("Data Router completion accounting", () => {
  it("charges returned credits once at completion and keeps the service token out of the sandbox environment", async () => {
    const run = await createRun();
    expect(run.claim.platformEnvironment.OKOU_DATA_ROUTER_URL).toBe(ROUTER);
    expect(
      JSON.stringify([run.claim.environment, run.claim.platformEnvironment]),
    ).not.toContain("router-test-service-token");
    const requestId = randomUUID();
    const unfinished = randomUUID();
    await accept(register(run, requestId), [200]);
    await accept(register(run, unfinished), [200]);
    const before = await credits(run.actor);
    let lookups = 0;
    server.use(
      http.post(ROUTER, async ({ request }) => {
        expect(request.headers.get("Authorization")).toBe(
          "Bearer router-test-service-token",
        );
        const body = await request.json();
        expect(body).toMatchObject({
          method: "tools/call",
          params: { name: "billing_get" },
        });
        lookups += 1;
        return HttpResponse.json({
          jsonrpc: "2.0",
          id: "test",
          result: {
            structuredContent: { records: [{ requestId, credits: 7 }] },
          },
        });
      }),
    );
    await finish(run);
    await expect(credits(run.actor)).resolves.toBe(before - 7);
    await finish(run);
    expect(lookups).toBe(1);
    await expect(credits(run.actor)).resolves.toBe(before - 7);
  });

  it("does not retry a failed completion lookup", async () => {
    const run = await createRun();
    await accept(register(run, randomUUID()), [200]);
    const before = await credits(run.actor);
    let lookups = 0;
    server.use(
      http.post(ROUTER, () => {
        lookups += 1;
        return new HttpResponse(null, { status: 503 });
      }),
    );
    await finish(run);
    await finish(run);
    expect(lookups).toBe(1);
    await expect(credits(run.actor)).resolves.toBe(before);
  });

  it("does not charge again when another completion redrives an undelivered chat callback", async () => {
    const run = await createRun();
    const requestId = randomUUID();
    await accept(register(run, requestId), [200]);
    const before = await credits(run.actor);
    const callbackEntered = createDeferredPromise<void>(context.signal);
    const releaseCallback = createDeferredPromise<void>(context.signal);
    let heldCallback = false;
    context.mocks.ably.publish.mockImplementation(async (topic: unknown) => {
      if (
        !heldCallback &&
        topic === `chatThreadMessageCreated:${run.threadId}`
      ) {
        heldCallback = true;
        callbackEntered.resolve(undefined);
        await releaseCallback.promise;
      }
    });
    let lookups = 0;
    server.use(
      http.post(ROUTER, () => {
        lookups += 1;
        return HttpResponse.json({
          jsonrpc: "2.0",
          id: "callback-redrive",
          result: {
            structuredContent: { records: [{ requestId, credits: 5 }] },
          },
        });
      }),
    );
    const first = webhooks.requestAgentComplete(
      { runId: run.runId, exitCode: 1, error: "Callback redrive" },
      run.headers,
      [200],
    );
    await callbackEntered.promise;
    // The first request has committed the terminal state; its callback is pending.
    await webhooks.requestAgentComplete(
      { runId: run.runId, exitCode: 1, error: "Callback redrive" },
      run.headers,
      [200],
    );
    releaseCallback.resolve(undefined);
    await first;
    await flushWaitUntilForTest();
    expect(lookups).toBe(1);
    await expect(credits(run.actor)).resolves.toBe(before - 5);
  });

  it("settles a fresh cancellation once without charging again on cancellation recovery", async () => {
    const run = await createRun();
    const requestId = randomUUID();
    await accept(register(run, requestId), [200]);
    const before = await credits(run.actor);
    let lookups = 0;
    server.use(
      http.post(ROUTER, () => {
        lookups += 1;
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
    expect(lookups).toBe(1);
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
      setupApp({ context, routes: DATA_ROUTES })(
        dataRouterRequestContract,
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
      { authorization: `Bearer ${own.claim.platformEnvironment.OKOU_TOKEN}` },
    ]) {
      const history = await accept(
        setupApp({ context, routes: DATA_ROUTES })(
          dataRouterHistoryContract,
        ).list({ headers }),
        [200],
      );
      expect(history.body.requestIds).toStrictEqual([ownId]);
    }
  });
});
