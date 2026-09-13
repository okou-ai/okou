import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { seoContract } from "@okouai/api-contracts/contracts/seo";
import { http, HttpResponse } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { createUsagePricingFixture } from "../../../test-fixtures/system-config-seeds";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";
import { billingStatusRoutes } from "../billing-status";
import { seoRoutes } from "../seo";

const context = testContext();
const BACKLINKS_URL = "https://api.dataforseo.com/v3/backlinks/summary/live";
const BACKLINKS_REQUEST = Object.freeze({
  target: "example.com",
  includeSubdomains: true,
});

async function setupBacklinksTest() {
  const actor = createBddApi(context).user();
  if (!actor.orgId) {
    throw new Error("Backlinks test actor must belong to an organization");
  }
  await createRunsApi(context).grantProEntitlement({
    ...actor,
    orgId: actor.orgId,
  });
  const pricing = await createUsagePricingFixture({
    configured: [
      {
        kind: "seo",
        provider: "dataforseo",
        category: "provider_cost_usd_micros",
        unitPrice: 1250,
        unitSize: 1_000_000,
      },
    ],
  });
  onTestFinished(pricing.cleanup);
  mockEnv("OKOU_SEO_DATAFORSEO_LOGIN", "test-dataforseo-login");
  mockEnv("OKOU_SEO_DATAFORSEO_PASSWORD", "test-dataforseo-password");
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  const headers = { authorization: "Bearer clerk-session" };
  const app = setupApp({
    context,
    routes: [...seoRoutes, ...billingStatusRoutes],
    rethrowErrors: true,
    usagePricingResolution: pricing.resolution,
  });
  return {
    client: app(seoContract),
    headers,
    async credits() {
      const response = await accept(
        app(billingStatusContract).get({ headers }),
        [200],
      );
      return response.body.credits;
    },
  };
}

function backlinksResponse(taskId: string, cost: number) {
  return {
    status_code: 20_000,
    status_message: "Ok.",
    cost,
    tasks_count: 1,
    tasks_error: 0,
    tasks: [
      {
        id: taskId,
        status_code: 20_000,
        status_message: "Ok.",
        cost,
        data: { target: "example.com", include_subdomains: true },
        result_count: 1,
        result: [{ target: "example.com", backlinks: 100 }],
      },
    ],
  };
}

function emptyTasksResponse() {
  return {
    status_code: 20_000,
    status_message: "Ok.",
    cost: 0,
    tasks_count: 0,
    tasks_error: 0,
    tasks: [],
  };
}

describe("SEO backlinks provider retries", () => {
  it.each([500, 504])(
    "recovers from HTTP %i with an Ok envelope and charges only the successful result",
    async (httpStatus) => {
      const { client, headers, credits } = await setupBacklinksTest();
      const beforeCredits = await credits();
      const failedBody = backlinksResponse("failed-task", 0.012);
      const successfulBody = backlinksResponse("successful-task", 0.024);
      const providerRequests: unknown[] = [];
      server.use(
        http.post(BACKLINKS_URL, async ({ request }) => {
          providerRequests.push(await request.json());
          return providerRequests.length === 1
            ? HttpResponse.json(failedBody, { status: httpStatus })
            : HttpResponse.json(successfulBody);
        }),
      );

      const response = await accept(
        client.backlinksSummary({ headers, body: BACKLINKS_REQUEST }),
        [200],
      );

      expect(response.body).toStrictEqual({
        operation: "backlinks-summary",
        provider: "dataforseo",
        billingCategory: "provider_cost_usd_micros",
        billingQuantity: 24_000,
        providerCostUsd: 0.024,
        creditsCharged: 30,
        result: successfulBody,
      });
      expect(providerRequests).toStrictEqual([
        [{ target: "example.com", include_subdomains: true }],
        [{ target: "example.com", include_subdomains: true }],
      ]);
      expect(beforeCredits - (await credits())).toBe(30);
    },
  );

  it.each([500, 504])(
    "stops after two HTTP %i responses without charging credits",
    async (httpStatus) => {
      const { client, headers, credits } = await setupBacklinksTest();
      const beforeCredits = await credits();
      let providerRequests = 0;
      server.use(
        http.post(BACKLINKS_URL, () => {
          providerRequests += 1;
          return HttpResponse.json(backlinksResponse("failed-task", 0.024), {
            status: httpStatus,
          });
        }),
      );

      const response = await accept(
        client.backlinksSummary({ headers, body: BACKLINKS_REQUEST }),
        [502],
      );

      expect(response.body.error.code).toBe("DATAFORSEO_UPSTREAM_ERROR");
      expect(providerRequests).toBe(2);
      await expect(credits()).resolves.toBe(beforeCredits);
    },
  );

  it.each([
    {
      failure: "HTTP authentication failure",
      httpStatus: 401,
      body: { status_code: 40_100, status_message: "Not authorized." },
      status: 502,
      code: "DATAFORSEO_AUTH_ERROR",
    },
    {
      failure: "authentication failure inside HTTP 500",
      httpStatus: 500,
      body: { status_code: 40_100, status_message: "Not authorized." },
      status: 502,
      code: "DATAFORSEO_AUTH_ERROR",
    },
    {
      failure: "parameter failure inside HTTP 504",
      httpStatus: 504,
      body: { status_code: 40_501, status_message: "Invalid Field: 'target'." },
      status: 400,
      code: "DATAFORSEO_INVALID_REQUEST",
    },
    {
      failure: "task authentication failure inside HTTP 500",
      httpStatus: 500,
      body: {
        ...backlinksResponse("auth-task", 0),
        tasks_error: 1,
        tasks: [
          { status_code: 40_100, status_message: "Not authorized.", cost: 0 },
        ],
      },
      status: 502,
      code: "DATAFORSEO_UPSTREAM_ERROR",
    },
  ])("does not retry $failure", async ({ httpStatus, body, status, code }) => {
    const { client, headers, credits } = await setupBacklinksTest();
    const beforeCredits = await credits();
    let providerRequests = 0;
    server.use(
      http.post(BACKLINKS_URL, () => {
        providerRequests += 1;
        return HttpResponse.json(body, { status: httpStatus });
      }),
    );

    const response = await accept(
      client.backlinksSummary({ headers, body: BACKLINKS_REQUEST }),
      [400, 502],
    );

    expect(response.status).toBe(status);
    expect(response.body.error.code).toBe(code);
    expect(providerRequests).toBe(1);
    await expect(credits()).resolves.toBe(beforeCredits);
  });

  it.each([
    { firstEmpty: true, code: "DATAFORSEO_UPSTREAM_ERROR" },
    { firstEmpty: false, code: "DATAFORSEO_EMPTY_TASKS" },
  ])(
    "shares the two-attempt budget with empty task responses (empty first: $firstEmpty)",
    async ({ firstEmpty, code }) => {
      const { client, headers, credits } = await setupBacklinksTest();
      const beforeCredits = await credits();
      let providerRequests = 0;
      server.use(
        http.post(BACKLINKS_URL, () => {
          providerRequests += 1;
          const isEmpty = firstEmpty
            ? providerRequests === 1
            : providerRequests === 2;
          return isEmpty
            ? HttpResponse.json(emptyTasksResponse())
            : HttpResponse.json(backlinksResponse("failed-task", 0), {
                status: 500,
              });
        }),
      );

      const response = await accept(
        client.backlinksSummary({ headers, body: BACKLINKS_REQUEST }),
        [502],
      );

      expect(response.body.error.code).toBe(code);
      expect(providerRequests).toBe(2);
      await expect(credits()).resolves.toBe(beforeCredits);
    },
  );

  it("retries HTTP 500 without a JSON body", async () => {
    const { client, headers, credits } = await setupBacklinksTest();
    const beforeCredits = await credits();
    let providerRequests = 0;
    server.use(
      http.post(BACKLINKS_URL, () => {
        providerRequests += 1;
        return providerRequests === 1
          ? new HttpResponse("Internal Server Error", { status: 500 })
          : HttpResponse.json(backlinksResponse("successful-task", 0));
      }),
    );

    const response = await accept(
      client.backlinksSummary({ headers, body: BACKLINKS_REQUEST }),
      [200],
    );

    expect(response.body.creditsCharged).toBe(0);
    expect(providerRequests).toBe(2);
    await expect(credits()).resolves.toBe(beforeCredits);
  });

  it("cancels an in-flight retry without charging credits", async () => {
    const { client, headers, credits } = await setupBacklinksTest();
    const beforeCredits = await credits();
    const controller = new AbortController();
    const abortError = new DOMException("Client disconnected", "AbortError");
    onTestFinished(() => {
      controller.abort(abortError);
    });
    let providerRequests = 0;
    let providerSignalAborted = false;
    server.use(
      http.post(BACKLINKS_URL, ({ request }) => {
        providerRequests += 1;
        if (providerRequests === 2) {
          controller.abort(abortError);
          providerSignalAborted = request.signal.aborted;
        }
        return HttpResponse.json(backlinksResponse("failed-task", 0.024), {
          status: 500,
        });
      }),
    );

    await expect(
      client.backlinksSummary({
        headers,
        body: BACKLINKS_REQUEST,
        fetchOptions: {
          signal: AbortSignal.any([controller.signal, context.signal]),
        },
      }),
    ).rejects.toBe(abortError);

    expect(providerRequests).toBe(2);
    expect(providerSignalAborted).toBeTruthy();
    await expect(credits()).resolves.toBe(beforeCredits);
  });

  it("keeps HTTP failure handling for SERP without retrying it", async () => {
    const { client, headers, credits } = await setupBacklinksTest();
    const beforeCredits = await credits();
    let providerRequests = 0;
    server.use(
      http.post(
        "https://api.dataforseo.com/v3/serp/google/organic/live/advanced",
        () => {
          providerRequests += 1;
          return HttpResponse.json(
            { status_code: 20_000, status_message: "Ok." },
            { status: 500 },
          );
        },
      ),
    );

    const response = await accept(
      client.serp({
        headers,
        body: {
          query: "technical seo",
          provider: "dataforseo",
          engine: "google",
          location: "United States",
          languageCode: "en",
          device: "desktop",
          limit: 10,
        },
      }),
      [502],
    );

    expect(response.body.error.code).toBe("DATAFORSEO_UPSTREAM_ERROR");
    expect(providerRequests).toBe(1);
    await expect(credits()).resolves.toBe(beforeCredits);
  });
});
