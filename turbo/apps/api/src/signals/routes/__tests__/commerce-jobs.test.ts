import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import {
  billingAutoRechargeContract,
  billingStatusContract,
} from "@okouai/api-contracts/contracts/billing";
import {
  commerceContract,
  type CommerceJob,
} from "@okouai/api-contracts/contracts/commerce";
import { cronReconcileCommerceJobsContract } from "@okouai/api-contracts/contracts/cron";
import { usageRecordContract } from "@okouai/api-contracts/contracts/usage-record";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { createDeferredPromise } from "../../utils";
import { billingAutoRechargeRoutes } from "../billing-auto-recharge";
import { billingStatusRoutes } from "../billing-status";
import { commerceRoutes } from "../commerce";
import { cronReconcileCommerceJobRoutes } from "../cron-reconcile-commerce-jobs";
import { usageRecordRoutes } from "../usage-record";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createPublicUnfundedProFixture } from "./helpers/public-unfunded-pro-fixture";
import { createRouteMocks } from "./helpers/route-test";
import { postCreditPurchaseInvoicePaid } from "./helpers/stripe-billing-webhook";

const context = testContext();
const BASE = "https://api.dataforseo.com/v3/merchant/amazon";
const ROUTES = Object.freeze([
  ...commerceRoutes,
  ...billingAutoRechargeRoutes,
  ...cronReconcileCommerceJobRoutes,
  ...billingStatusRoutes,
  ...usageRecordRoutes,
]);

function client() {
  return setupApp({ context, routes: ROUTES });
}
function authenticate(user: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    user.userId,
    user.orgId,
    user.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}
async function fundedActor() {
  const user = createBddApi(context).user();
  await createRunsApi(context).grantProEntitlement(user);
  return user;
}
function configureProvider() {
  mockEnv("OKOU_SEO_DATAFORSEO_LOGIN", "commerce-jobs-test-login");
  mockEnv("OKOU_SEO_DATAFORSEO_PASSWORD", "commerce-jobs-test-password");
}
function providerResponse(
  id: string,
  status: number,
  cost: number,
  result: unknown,
) {
  return {
    version: "0.1.20261001",
    status_code: 20_000,
    status_message: "Ok.",
    cost,
    tasks_count: 1,
    tasks_error: 0,
    tasks: [
      {
        id,
        status_code: status,
        status_message: status === 20_000 ? "Ok." : "Task in queue.",
        cost,
        result_count: result === null ? 0 : 1,
        result,
      },
    ],
  };
}
async function getJob(user: ApiTestUser, id: string) {
  return (
    await accept(
      client()(commerceContract).getJob({
        headers: authenticate(user),
        params: { id },
      }),
      [200],
    )
  ).body;
}
async function completeJob(user: ApiTestUser, job: CommerceJob) {
  let current = job;
  // Poll only the production API: each request advances at most one stage.
  for (
    let attempt = 0;
    attempt < 3 && current.status === "running";
    attempt++
  ) {
    current = await getJob(user, current.id);
  }
  expect(current.status).toBe("completed");
  if (current.result === null) {
    throw new Error("Expected completed Commerce result");
  }
  return { job: current, result: current.result };
}
async function credits(user: ApiTestUser) {
  return (
    await accept(
      client()(billingStatusContract).get({ headers: authenticate(user) }),
      [200],
    )
  ).body.credits;
}
async function personalUsage(user: ApiTestUser) {
  return (
    await accept(
      client()(usageRecordContract).get({
        headers: authenticate(user),
        query: { scope: "mine", range: "24h", tz: "UTC" },
      }),
      [200],
    )
  ).body;
}

describe("Commerce async jobs", () => {
  it("submits once, replays the request ID and settles saved submission cost once after polling", async () => {
    const user = await fundedActor();
    configureProvider();
    const beforeCredits = await credits(user);
    const beforeUsage = await personalUsage(user);
    const requestId = randomUUID();
    const providerId = randomUUID();
    const submissions: unknown[] = [];
    const polls: string[] = [];
    const pendingStatuses = [20_100, 40_601, 40_602];
    const first = { type: "amazon_serp", title: "Coffee Maker" };
    const second = { type: "amazon_paid", title: "Sponsored Coffee Maker" };
    const source = providerResponse(providerId, 20_000, 0, [
      {
        type: "products",
        items: [
          { type: "related_searches", items: ["coffee mugs"] },
          {
            type: "editorial_recommendations",
            items: [{ type: "amazon_serp", title: "Nested recommendation" }],
          },
          first,
          second,
          { type: "amazon_serp", title: "Beyond requested limit" },
        ],
      },
    ]);
    server.use(
      http.post(`${BASE}/products/task_post`, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          `Basic ${Buffer.from("commerce-jobs-test-login:commerce-jobs-test-password").toString("base64")}`,
        );
        submissions.push(await request.json());
        return HttpResponse.json(
          providerResponse(providerId, 20_100, 0.0024, null),
        );
      }),
      http.get(
        `${BASE}/products/task_get/advanced/${providerId}`,
        ({ request }) => {
          polls.push(request.url);
          const pending = pendingStatuses.shift();
          return HttpResponse.json(
            pending === undefined
              ? source
              : providerResponse(providerId, pending, 0, null),
          );
        },
      ),
    );
    const body = { query: "coffee maker", limit: 2, async: true, requestId };
    const created = await accept(
      client()(commerceContract).search({ headers: authenticate(user), body }),
      [202],
    );
    expect(created.body).toMatchObject({
      id: requestId,
      status: "running",
      operation: "search",
      provider: "dataforseo",
      marketplace: "amazon.com",
      result: null,
      error: null,
    });
    expect(submissions).toStrictEqual([
      [
        {
          keyword: "coffee maker",
          se_domain: "amazon.com",
          location_code: 2840,
          language_code: "en_US",
          depth: 2,
          max_crawl_pages: 1,
          priority: 2,
          tag: created.body.id,
        },
      ],
    ]);
    expect(polls).toStrictEqual([]);
    const replay = await accept(
      client()(commerceContract).search({ headers: authenticate(user), body }),
      [202],
    );
    expect(replay.body).toStrictEqual(created.body);
    await accept(
      client()(commerceContract).search({
        headers: authenticate(user),
        body: { ...body, query: "different product" },
      }),
      [409],
    );
    for (const [index] of [20_100, 40_601, 40_602].entries()) {
      const pending = await getJob(user, created.body.id);
      expect(pending).toMatchObject({
        id: requestId,
        status: "running",
        result: null,
        error: null,
      });
      expect(polls).toHaveLength(index + 1);
    }
    await expect(credits(user)).resolves.toBe(beforeCredits);
    const checkpoint = await getJob(user, created.body.id);
    expect(checkpoint.status).toBe("running");
    await expect(credits(user)).resolves.toBe(beforeCredits);
    const completed = await completeJob(user, checkpoint);
    expect(completed.result).toMatchObject({
      operation: "search",
      provider: "dataforseo",
      marketplace: "amazon.com",
      billingCategory: "provider_cost_usd_micros",
      billingQuantity: 2400,
      providerCostUsd: 0.0024,
      result: { items: [first, second], source },
    });
    expect(completed.result.result.items).toStrictEqual([first, second]);
    const charged = completed.result.creditsCharged;
    expect(charged).toBeGreaterThan(0);
    if (charged === null) {
      throw new Error("Expected settled Commerce usage");
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(getJob(user, requestId)).resolves.toStrictEqual(
        completed.job,
      );
    }
    const completedReplay = await accept(
      client()(commerceContract).search({ headers: authenticate(user), body }),
      [202],
    );
    expect(completedReplay.body).toStrictEqual(completed.job);
    expect(submissions).toHaveLength(1);
    expect(polls).toHaveLength(4);
    await expect(credits(user)).resolves.toBe(beforeCredits - charged);
    const usage = await personalUsage(user);
    expect(usage.totalCredits).toBe(beforeUsage.totalCredits + charged);
    expect(
      usage.rows.flatMap((row) => {
        return row.breakdown.flatMap((kind) => {
          return kind.providers;
        });
      }),
    ).toContainEqual(
      expect.objectContaining({
        provider: "dataforseo",
        credits: charged,
        usageKinds: expect.arrayContaining([
          expect.objectContaining({ kind: "commerce", credits: charged }),
        ]),
      }),
    );
  });

  it("includes accepted task liability when admitting a distinct paid submission before settlement", async () => {
    const user = createBddApi(context).user();
    const fixture = createPublicUnfundedProFixture(context, user);
    await fixture.initialize();
    await fixture.run(async () => {
      if (!user.orgId) {
        throw new Error("Expected funded Commerce organization");
      }
      // A one-cent public purchase grants 10 credits. At the configured
      // Commerce price, $0.003 admission costs 4 credits, while the deliberately
      // larger accepted $0.01 fee costs 13: no impractical provider charge.
      await postCreditPurchaseInvoicePaid(context.signal, {
        orgId: user.orgId,
        credits: 10,
      });
      configureProvider();
      const beforeCredits = await credits(user);
      expect(beforeCredits).toBe(10);
      const providerId = randomUUID();
      const submissions: unknown[] = [];
      server.use(
        http.post(`${BASE}/products/task_post`, async ({ request }) => {
          submissions.push(await request.json());
          return HttpResponse.json(
            providerResponse(providerId, 20_100, 0.01, null),
          );
        }),
        http.get(`${BASE}/products/task_get/advanced/${providerId}`, () => {
          return HttpResponse.json(
            providerResponse(providerId, 20_000, 0, [
              {
                type: "products",
                items: [{ type: "amazon_serp", title: "Coffee Maker" }],
              },
            ]),
          );
        }),
      );
      const created = await accept(
        client()(commerceContract).search({
          headers: authenticate(user),
          body: { query: "coffee maker", async: true, requestId: randomUUID() },
        }),
        [202],
      );
      expect(created.body.status).toBe("running");
      const nextBody = {
        query: "coffee grinder",
        async: true,
        requestId: randomUUID(),
      };
      // Neither submission nor checkpointing reserves or debits public credits.
      // Both outstanding stages must nevertheless block a new paid POST.
      for (const stage of ["accepted", "checkpointed"]) {
        if (stage === "checkpointed") {
          const checkpoint = await getJob(user, created.body.id);
          expect(checkpoint).toMatchObject({
            id: created.body.id,
            status: "running",
            result: null,
          });
        }
        await expect(credits(user)).resolves.toBe(beforeCredits);
        const denied = await accept(
          client()(commerceContract).search({
            headers: authenticate(user),
            body: nextBody,
          }),
          [402],
        );
        expect(denied.body.error.code).toBe("INSUFFICIENT_CREDITS");
        const legacyDenied = await accept(
          client()(commerceContract).search({
            headers: authenticate(user),
            body: { query: "coffee grinder" },
          }),
          [402],
        );
        expect(legacyDenied.body.error.code).toBe("INSUFFICIENT_CREDITS");
        expect(submissions).toHaveLength(1);
      }
      const completed = await completeJob(user, created.body);
      const charged = completed.result.creditsCharged;
      expect(charged).toBeGreaterThan(beforeCredits);
      if (charged === null) {
        throw new Error("Expected settled Commerce liability");
      }
      await expect(credits(user)).resolves.toBe(beforeCredits - charged);
      await expect(getJob(user, created.body.id)).resolves.toStrictEqual(
        completed.job,
      );
      await expect(credits(user)).resolves.toBe(beforeCredits - charged);
      expect(submissions).toHaveLength(1);
    });
  });

  it("recovers the same job after a transient provider GET failure and bills once", async () => {
    const user = await fundedActor();
    configureProvider();
    const beforeCredits = await credits(user);
    const beforeUsage = await personalUsage(user);
    const providerId = randomUUID();
    let submissions = 0;
    let polls = 0;
    const product = { type: "amazon_serp", title: "Coffee Maker" };
    server.use(
      http.post(`${BASE}/products/task_post`, () => {
        submissions++;
        return HttpResponse.json(
          providerResponse(providerId, 20_100, 0.0024, null),
        );
      }),
      http.get(`${BASE}/products/task_get/advanced/${providerId}`, () => {
        polls++;
        return polls === 1
          ? new HttpResponse(null, { status: 503 })
          : HttpResponse.json(
              providerResponse(providerId, 20_000, 0, [
                { type: "products", items: [product] },
              ]),
            );
      }),
    );
    const created = await accept(
      client()(commerceContract).search({
        headers: authenticate(user),
        body: { query: "coffee maker", async: true },
      }),
      [202],
    );
    await expect(getJob(user, created.body.id)).resolves.toStrictEqual(
      created.body,
    );
    expect(polls).toBe(1);
    await expect(credits(user)).resolves.toBe(beforeCredits);
    const completed = await completeJob(user, created.body);
    expect(completed.job.id).toBe(created.body.id);
    expect(completed.result.result.items).toStrictEqual([product]);
    const charged = completed.result.creditsCharged;
    expect(charged).toBeGreaterThan(0);
    if (charged === null) {
      throw new Error("Expected recovered Commerce billing receipt");
    }
    await expect(credits(user)).resolves.toBe(beforeCredits - charged);
    expect((await personalUsage(user)).totalCredits).toBe(
      beforeUsage.totalCredits + charged,
    );
    await expect(getJob(user, created.body.id)).resolves.toStrictEqual(
      completed.job,
    );
    await expect(credits(user)).resolves.toBe(beforeCredits - charged);
    expect((await personalUsage(user)).totalCredits).toBe(
      beforeUsage.totalCredits + charged,
    );
    expect(submissions).toBe(1);
    expect(polls).toBe(2);
  });

  it("completes and settles through independent cron requests without user polling", async () => {
    const user = createBddApi(context).user();
    await createRunsApi(context).grantProEntitlement(user, { isolatePg: true });
    configureProvider();
    mockEnv("CRON_SECRET", "commerce-jobs-cron-secret");
    const beforeCredits = await credits(user);
    const providerId = randomUUID();
    const product = { type: "amazon_serp", title: "Coffee Maker" };
    const source = providerResponse(providerId, 20_000, 0, [
      { type: "products", items: [product] },
    ]);
    let polls = 0;
    server.use(
      http.post(`${BASE}/products/task_post`, () => {
        return HttpResponse.json(
          providerResponse(providerId, 20_100, 0.0024, null),
        );
      }),
      http.get(`${BASE}/products/task_get/advanced/${providerId}`, () => {
        polls++;
        return HttpResponse.json(source);
      }),
    );
    const created = await accept(
      client()(commerceContract).search({
        headers: authenticate(user),
        body: { query: "coffee maker", async: true },
      }),
      [202],
    );
    expect(created.body.status).toBe("running");
    const cron = client()(cronReconcileCommerceJobsContract);
    await accept(cron.reconcile({ headers: {} }), [401]);
    await accept(
      cron.reconcile({ headers: { authorization: "Bearer wrong-secret" } }),
      [401],
    );
    expect(polls).toBe(0);
    await expect(credits(user)).resolves.toBe(beforeCredits);
    const headers = { authorization: "Bearer commerce-jobs-cron-secret" };
    // The first operator request checkpoints the provider result; the second
    // settles it. No user GET may advance either stage before these assertions.
    const checkpoint = await accept(cron.reconcile({ headers }), [200]);
    expect(checkpoint.body).toMatchObject({ success: true });
    expect(checkpoint.body.processed).toBeGreaterThan(0);
    await expect(credits(user)).resolves.toBe(beforeCredits);
    const settlement = await accept(cron.reconcile({ headers }), [200]);
    expect(settlement.body).toMatchObject({ success: true });
    expect(settlement.body.processed).toBeGreaterThan(0);
    const settledCredits = await credits(user);
    expect(settledCredits).toBeLessThan(beforeCredits);
    const completed = await getJob(user, created.body.id);
    expect(completed).toMatchObject({
      status: "completed",
      error: null,
      result: {
        billingQuantity: 2400,
        providerCostUsd: 0.0024,
        creditsCharged: beforeCredits - settledCredits,
        result: { items: [product], source },
      },
    });
    await expect(credits(user)).resolves.toBe(settledCredits);
  });

  it("settles a zero-cost provider result without a usage debit", async () => {
    const user = await fundedActor();
    configureProvider();
    const beforeCredits = await credits(user);
    const beforeUsage = await personalUsage(user);
    const providerId = randomUUID();
    server.use(
      http.post(`${BASE}/products/task_post`, () => {
        return HttpResponse.json(providerResponse(providerId, 20_100, 0, null));
      }),
      http.get(`${BASE}/products/task_get/advanced/${providerId}`, () => {
        return HttpResponse.json(
          providerResponse(providerId, 20_000, 0, [
            {
              type: "products",
              items: [{ type: "amazon_serp", title: "Coffee Maker" }],
            },
          ]),
        );
      }),
    );
    const created = await accept(
      client()(commerceContract).search({
        headers: authenticate(user),
        body: { query: "coffee maker", async: true },
      }),
      [202],
    );
    const completed = await completeJob(user, created.body);
    expect(completed.result).toMatchObject({
      billingQuantity: 0,
      creditsCharged: 0,
    });
    await expect(getJob(user, created.body.id)).resolves.toStrictEqual(
      completed.job,
    );
    await expect(credits(user)).resolves.toBe(beforeCredits);
    expect((await personalUsage(user)).totalCredits).toBe(
      beforeUsage.totalCredits,
    );
  });

  it("settles once when user GET overlaps the global recovery cron", async () => {
    const user = createBddApi(context).user();
    await createRunsApi(context).grantProEntitlement(user, { isolatePg: true });
    configureProvider();
    mockEnv("CRON_SECRET", "commerce-jobs-cron-secret");
    const beforeCredits = await credits(user);
    const providerId = randomUUID();
    server.use(
      http.post(`${BASE}/products/task_post`, () => {
        return HttpResponse.json(
          providerResponse(providerId, 20_100, 0.0024, null),
        );
      }),
      http.get(`${BASE}/products/task_get/advanced/${providerId}`, () => {
        return HttpResponse.json(
          providerResponse(providerId, 20_000, 0, [
            {
              type: "products",
              items: [{ type: "amazon_serp", title: "Coffee Maker" }],
            },
          ]),
        );
      }),
    );
    const created = await accept(
      client()(commerceContract).search({
        headers: authenticate(user),
        body: { query: "coffee maker", async: true },
      }),
      [202],
    );
    const checkpoint = await getJob(user, created.body.id);
    expect(checkpoint.status).toBe("running");
    await Promise.all([
      getJob(user, created.body.id),
      accept(
        client()(cronReconcileCommerceJobsContract).reconcile({
          headers: { authorization: "Bearer commerce-jobs-cron-secret" },
        }),
        [200],
      ),
    ]);
    const completed = await getJob(user, created.body.id);
    expect(completed.status).toBe("completed");
    const charged = completed.result?.creditsCharged;
    expect(charged).toBeGreaterThan(0);
    if (charged === null || charged === undefined) {
      throw new Error("Expected one Commerce charge");
    }
    await expect(credits(user)).resolves.toBe(beforeCredits - charged);
    expect((await personalUsage(user)).totalCredits).toBe(charged);
  });

  it("bills the accepted submission fee when provider results have expired", async () => {
    const user = await fundedActor();
    configureProvider();
    const beforeCredits = await credits(user);
    const providerId = randomUUID();
    const source = providerResponse(providerId, 40_403, 0, null);
    source.tasks_error = 1;
    source.tasks = source.tasks.map((task) => {
      return { ...task, status_message: "Results expired." };
    });
    server.use(
      http.post(`${BASE}/products/task_post`, () => {
        return HttpResponse.json(
          providerResponse(providerId, 20_100, 0.0024, null),
        );
      }),
      http.get(`${BASE}/products/task_get/advanced/${providerId}`, () => {
        return HttpResponse.json(source);
      }),
    );
    const created = await accept(
      client()(commerceContract).search({
        headers: authenticate(user),
        body: { query: "coffee maker", async: true },
      }),
      [202],
    );
    const checkpoint = await getJob(user, created.body.id);
    expect(checkpoint.status).toBe("running");
    await expect(credits(user)).resolves.toBe(beforeCredits);
    const failed = await getJob(user, created.body.id);
    expect(failed).toMatchObject({
      status: "failed",
      error: {
        code: "COMMERCE_TASK_ERROR",
        message: expect.any(String),
      },
      result: {
        billingQuantity: 2400,
        providerCostUsd: 0.0024,
        result: { items: [], source },
      },
    });
    const charged = failed.result?.creditsCharged;
    expect(charged).toBeGreaterThan(0);
    if (charged === null || charged === undefined) {
      throw new Error("Expected failed Commerce job billing receipt");
    }
    await expect(credits(user)).resolves.toBe(beforeCredits - charged);
    await expect(getJob(user, created.body.id)).resolves.toStrictEqual(failed);
    await expect(credits(user)).resolves.toBe(beforeCredits - charged);
  });

  it("publishes its durable receipt before postcommit recharge fails", async () => {
    const user = createBddApi(context).user();
    await createRunsApi(context).grantProEntitlement(user);
    configureProvider();
    const beforeCredits = await credits(user);
    const beforeUsage = await personalUsage(user);
    await accept(
      client()(billingAutoRechargeContract).update({
        headers: authenticate(user),
        body: {
          enabled: true,
          threshold: beforeCredits - 1,
          amount: beforeCredits + 5000,
        },
      }),
      [200],
    );
    const providerId = randomUUID();
    const requestId = randomUUID();
    let submissions = 0;
    server.use(
      http.post(`${BASE}/products/task_post`, () => {
        submissions++;
        return HttpResponse.json(
          providerResponse(providerId, 20_100, 0.0024, null),
        );
      }),
      http.get(`${BASE}/products/task_get/advanced/${providerId}`, () => {
        return HttpResponse.json(
          providerResponse(providerId, 20_000, 0, [
            {
              type: "products",
              items: [{ type: "amazon_serp", title: "Coffee Maker" }],
            },
          ]),
        );
      }),
    );
    const body = { query: "coffee maker", async: true, requestId };
    const created = await accept(
      client()(commerceContract).search({
        headers: authenticate(user),
        body,
      }),
      [202],
    );
    const checkpoint = await getJob(user, created.body.id);
    expect(checkpoint.status).toBe("running");
    const started = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    context.mocks.stripe.customers.retrieve.mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
      throw new Error("Stripe temporarily unavailable after settlement");
    });
    const settling = getJob(user, created.body.id);
    onTestFinished(async () => {
      if (!release.settled()) {
        release.resolve();
      }
      await Promise.allSettled([settling]);
    });
    await started.promise;
    // Replay is a read-only path: unlike GET it cannot repair an unpublished
    // receipt. It must see completion while the original request is held.
    const observed = await accept(
      client()(commerceContract).search({
        headers: authenticate(user),
        body,
      }),
      [202],
    );
    expect(observed.body.status).toBe("completed");
    const completed = await getJob(user, created.body.id);
    expect(completed).toStrictEqual(observed.body);
    expect(completed.status).toBe("completed");
    const charged = completed.result?.creditsCharged;
    expect(charged).toBeGreaterThan(0);
    if (charged === null || charged === undefined) {
      throw new Error("Expected durable Commerce financial receipt");
    }
    await expect(credits(user)).resolves.toBe(beforeCredits - charged);
    expect((await personalUsage(user)).totalCredits).toBe(
      beforeUsage.totalCredits + charged,
    );
    release.resolve();
    await expect(settling).resolves.toStrictEqual(completed);
    const replay = await accept(
      client()(commerceContract).search({
        headers: authenticate(user),
        body,
      }),
      [202],
    );
    expect(replay.body).toStrictEqual(completed);
    await expect(getJob(user, created.body.id)).resolves.toStrictEqual(
      completed,
    );
    await expect(credits(user)).resolves.toBe(beforeCredits - charged);
    expect(submissions).toBe(1);
  });

  it("settles once when repeated user GET requests overlap", async () => {
    const user = await fundedActor();
    configureProvider();
    const beforeCredits = await credits(user);
    const beforeUsage = await personalUsage(user);
    const providerId = randomUUID();
    server.use(
      http.post(`${BASE}/products/task_post`, () => {
        return HttpResponse.json(
          providerResponse(providerId, 20_100, 0.0024, null),
        );
      }),
      http.get(`${BASE}/products/task_get/advanced/${providerId}`, () => {
        return HttpResponse.json(
          providerResponse(providerId, 20_000, 0, [
            {
              type: "products",
              items: [{ type: "amazon_serp", title: "Coffee Maker" }],
            },
          ]),
        );
      }),
    );
    const created = await accept(
      client()(commerceContract).search({
        headers: authenticate(user),
        body: { query: "coffee maker", async: true },
      }),
      [202],
    );
    const checkpoint = await getJob(user, created.body.id);
    expect(checkpoint.status).toBe("running");
    await expect(credits(user)).resolves.toBe(beforeCredits);
    const settled = await Promise.all([
      getJob(user, created.body.id),
      getJob(user, created.body.id),
      getJob(user, created.body.id),
    ]);
    const completed = settled[0];
    expect(completed).toMatchObject({ status: "completed", error: null });
    for (const job of settled) {
      expect(job).toStrictEqual(completed);
    }
    const charged = completed?.result?.creditsCharged;
    expect(charged).toBeGreaterThan(0);
    if (charged === null || charged === undefined) {
      throw new Error("Expected settled Commerce job billing receipt");
    }
    await expect(credits(user)).resolves.toBe(beforeCredits - charged);
    expect((await personalUsage(user)).totalCredits).toBe(
      beforeUsage.totalCredits + charged,
    );
    await expect(getJob(user, created.body.id)).resolves.toStrictEqual(
      completed,
    );
    await expect(credits(user)).resolves.toBe(beforeCredits - charged);
  });

  it("inspects a UK product and hides its job from another user or organization", async () => {
    const user = await fundedActor();
    const colleague = createBddApi(context).user({ orgId: user.orgId });
    const outsider = createBddApi(context).user();
    configureProvider();
    const providerId = randomUUID();
    const submissions: unknown[] = [];
    const polls: string[] = [];
    const product = {
      type: "amazon_product_info",
      data_asin: "B085RFFC9Q",
      title: "Coffee Maker",
      se_domain: "amazon.co.uk",
    };
    const source = providerResponse(providerId, 20_000, 0, [
      { type: "asin", items: [{ type: "related_searches" }, product] },
    ]);
    server.use(
      http.post(`${BASE}/asin/task_post`, async ({ request }) => {
        submissions.push(await request.json());
        return HttpResponse.json(
          providerResponse(providerId, 20_100, 0.0024, null),
        );
      }),
      http.get(
        `${BASE}/asin/task_get/advanced/${providerId}`,
        ({ request }) => {
          polls.push(request.url);
          return HttpResponse.json(source);
        },
      ),
    );
    const created = await accept(
      client()(commerceContract).inspect({
        headers: authenticate(user),
        body: {
          target:
            "https://www.amazon.co.uk/Coffee-Maker/dp/B085RFFC9Q?tag=ignored",
          async: true,
        },
      }),
      [202],
    );
    expect(created.body.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(created.body).toMatchObject({
      operation: "inspect",
      provider: "dataforseo",
      marketplace: "amazon.co.uk",
      result: null,
      error: null,
    });
    expect(submissions).toStrictEqual([
      [
        {
          asin: "B085RFFC9Q",
          se_domain: "amazon.co.uk",
          location_code: 2826,
          language_code: "en_GB",
          priority: 2,
          tag: created.body.id,
        },
      ],
    ]);
    const missing = await accept(
      client()(commerceContract).getJob({
        headers: authenticate(user),
        params: { id: randomUUID() },
      }),
      [404],
    );
    for (const other of [colleague, outsider]) {
      const forbidden = await accept(
        client()(commerceContract).getJob({
          headers: authenticate(other),
          params: { id: created.body.id },
        }),
        [404],
      );
      expect(forbidden.body).toStrictEqual(missing.body);
    }
    expect(polls).toStrictEqual([]);
    const checkpoint = await getJob(user, created.body.id);
    expect(checkpoint.status).toBe("running");
    const completed = await completeJob(user, checkpoint);
    expect(completed.result).toMatchObject({
      operation: "inspect",
      marketplace: "amazon.co.uk",
      billingQuantity: 2400,
      providerCostUsd: 0.0024,
      result: { items: [product], source },
    });
    expect(completed.result.result.items).toStrictEqual([product]);
    await expect(getJob(user, created.body.id)).resolves.toStrictEqual(
      completed.job,
    );
    expect(polls).toHaveLength(1);
    expect(submissions).toHaveLength(1);
  });

  it("persists an uncertain submission as a failed job without resubmitting on replay or GET", async () => {
    const user = await fundedActor();
    configureProvider();
    const beforeCredits = await credits(user);
    const beforeUsage = await personalUsage(user);
    const requestId = randomUUID();
    const submissions: unknown[] = [];
    server.use(
      http.post(`${BASE}/products/task_post`, async ({ request }) => {
        submissions.push(await request.json());
        return HttpResponse.error();
      }),
    );
    const body = { query: "coffee maker", async: true, requestId };
    const created = await accept(
      client()(commerceContract).search({ headers: authenticate(user), body }),
      [202],
    );
    expect(created.body).toMatchObject({
      id: requestId,
      status: "failed",
      operation: "search",
      provider: "dataforseo",
      marketplace: "amazon.com",
      result: null,
      error: {
        code: "COMMERCE_SUBMISSION_UNCERTAIN",
        message: expect.any(String),
      },
    });
    expect(submissions).toStrictEqual([
      [expect.objectContaining({ tag: requestId, priority: 2 })],
    ]);
    const replay = await accept(
      client()(commerceContract).search({ headers: authenticate(user), body }),
      [202],
    );
    expect(replay.body).toStrictEqual(created.body);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(getJob(user, requestId)).resolves.toStrictEqual(
        created.body,
      );
    }
    expect(submissions).toHaveLength(1);
    await expect(credits(user)).resolves.toBe(beforeCredits);
    expect((await personalUsage(user)).totalCredits).toBe(
      beforeUsage.totalCredits,
    );
  });

  it("rejects generic scrape URLs, mismatched marketplaces and unbounded search input before provider access", async () => {
    const user = createBddApi(context).user();
    configureProvider();
    let calls = 0;
    server.use(
      http.post(`${BASE}/:operation/task_post`, () => {
        calls += 1;
        return HttpResponse.json(
          providerResponse(randomUUID(), 20_100, 0, null),
        );
      }),
    );
    const commerce = client()(commerceContract);
    for (const target of [
      "https://example.com/dp/B085RFFC9Q",
      "https://www.amazon.com/s?k=coffee",
      "https://amazon.com.evil.test/dp/B085RFFC9Q",
    ]) {
      await accept(
        commerce.inspect({ headers: authenticate(user), body: { target } }),
        [400],
      );
    }
    await accept(
      commerce.inspect({
        headers: authenticate(user),
        body: {
          target: "https://amazon.co.uk/dp/B085RFFC9Q",
          marketplace: "amazon.com",
        },
      }),
      [400],
    );
    await accept(
      commerce.search({
        headers: authenticate(user),
        body: { query: "https://amazon.com/dp/B085RFFC9Q" },
      }),
      [400],
    );
    await accept(
      commerce.search({
        headers: authenticate(user),
        body: { query: "coffee", limit: 49 },
      }),
      [400],
    );
    expect(calls).toBe(0);
  });

  it("normalizes a bare ASIN and applies an explicit marketplace", async () => {
    const user = await fundedActor();
    configureProvider();
    const providerId = randomUUID();
    const submissions: unknown[] = [];
    server.use(
      http.post(`${BASE}/asin/task_post`, async ({ request }) => {
        submissions.push(await request.json());
        return HttpResponse.json(providerResponse(providerId, 20_100, 0, null));
      }),
    );
    const created = await accept(
      client()(commerceContract).inspect({
        headers: authenticate(user),
        body: { target: "b085rffc9q", marketplace: "amazon.de" },
      }),
      [202],
    );
    expect(created.body).toMatchObject({
      operation: "inspect",
      marketplace: "amazon.de",
    });
    expect(submissions).toStrictEqual([
      [
        {
          asin: "B085RFFC9Q",
          se_domain: "amazon.de",
          location_code: 2276,
          language_code: "de_DE",
          priority: 2,
          tag: created.body.id,
        },
      ],
    ]);
  });

  it("completes a billable empty search when DataForSEO reports no results", async () => {
    const user = await fundedActor();
    configureProvider();
    const providerId = randomUUID();
    const empty = providerResponse(providerId, 40_102, 0, null);
    empty.tasks_error = 1;
    server.use(
      http.post(`${BASE}/products/task_post`, () => {
        return HttpResponse.json(
          providerResponse(providerId, 20_100, 0.0024, null),
        );
      }),
      http.get(`${BASE}/products/task_get/advanced/${providerId}`, () => {
        return HttpResponse.json(empty);
      }),
    );
    const created = await accept(
      client()(commerceContract).search({
        headers: authenticate(user),
        body: { query: "no matching product" },
      }),
      [202],
    );
    const completed = await completeJob(user, created.body);
    expect(completed.result.result.items).toStrictEqual([]);
    expect(completed.result.billingQuantity).toBe(2400);
    expect(completed.result.creditsCharged).toBeGreaterThan(0);
  });
});
