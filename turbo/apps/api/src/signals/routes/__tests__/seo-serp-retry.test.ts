import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { seoContract } from "@okouai/api-contracts/contracts/seo";
import { HttpResponse, http } from "msw";
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
const GOOGLE_SERP_URL =
  "https://api.dataforseo.com/v3/serp/google/organic/live/advanced";
const GOOGLE_NEWS_SERP_URL =
  "https://api.dataforseo.com/v3/serp/google/news/live/advanced";

async function setupSerpTest() {
  const actor = createBddApi(context).user();
  if (!actor.orgId) {
    throw new Error("SERP test actor must belong to an organization");
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

function serpRequest(engine: "google" | "google_news", query: string) {
  return {
    query,
    provider: "dataforseo" as const,
    engine,
    location: "United States",
    languageCode: "en",
    device: "desktop" as const,
    limit: 10,
  };
}

function serpResponse(taskId: string, cost: number, result: unknown) {
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
        result_count: 1,
        result,
      },
    ],
  };
}

function searchEngineErrorResponse(taskId: string, cost: number) {
  const response = serpResponse(taskId, cost, null);
  return {
    ...response,
    tasks: response.tasks.map((task) => {
      return {
        ...task,
        status_code: 40_101,
        status_message: "Internal SE Server Error.",
        result_count: 0,
      };
    }),
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

describe("SEO SERP provider retries", () => {
  it.each([
    {
      engine: "google",
      query: "technical seo",
      url: GOOGLE_SERP_URL,
    },
    {
      engine: "google_news",
      query: "ai news",
      url: GOOGLE_NEWS_SERP_URL,
    },
  ] as const)(
    "recovers from a $engine 40101 task and charges only the successful result",
    async ({ engine, query, url }) => {
      const { client, headers, credits } = await setupSerpTest();
      const beforeCredits = await credits();
      const failedBody = searchEngineErrorResponse("failed-task", 0.002);
      const successfulBody = serpResponse("successful-task", 0.002, [
        { keyword: query },
      ]);
      const providerRequests: unknown[] = [];
      server.use(
        http.post(url, async ({ request }) => {
          providerRequests.push(await request.json());
          return HttpResponse.json(
            providerRequests.length === 1 ? failedBody : successfulBody,
          );
        }),
      );

      const response = await accept(
        client.serp({
          headers,
          body: serpRequest(engine, query),
        }),
        [200],
      );

      expect(response.body).toStrictEqual({
        operation: "serp",
        provider: "dataforseo",
        billingCategory: "provider_cost_usd_micros",
        billingQuantity: 2000,
        providerCostUsd: 0.002,
        creditsCharged: 3,
        result: successfulBody,
      });
      expect(providerRequests).toHaveLength(2);
      expect(providerRequests[1]).toStrictEqual(providerRequests[0]);
      expect(beforeCredits - (await credits())).toBe(3);
    },
  );

  it("stops after two 40101 tasks with recoverable guidance and no charge", async () => {
    const { client, headers, credits } = await setupSerpTest();
    const beforeCredits = await credits();
    let providerRequests = 0;
    server.use(
      http.post(GOOGLE_SERP_URL, () => {
        providerRequests += 1;
        return HttpResponse.json(
          searchEngineErrorResponse(`failed-task-${providerRequests}`, 0.002),
        );
      }),
    );

    const response = await accept(
      client.serp({
        headers,
        body: serpRequest("google", "technical seo"),
      }),
      [502],
    );

    expect(response.body.error).toStrictEqual({
      code: "SEO_SEARCH_ENGINE_UNAVAILABLE",
      message:
        "The search engine temporarily failed to return results. Please try again later.",
    });
    expect(providerRequests).toBe(2);
    await expect(credits()).resolves.toBe(beforeCredits);
  });

  it.each([
    {
      firstResponse: "40101",
      expectedCode: "DATAFORSEO_EMPTY_TASKS",
    },
    {
      firstResponse: "empty",
      expectedCode: "SEO_SEARCH_ENGINE_UNAVAILABLE",
    },
  ] as const)(
    "shares the two-attempt budget when $firstResponse is returned first",
    async ({ firstResponse, expectedCode }) => {
      const { client, headers, credits } = await setupSerpTest();
      const beforeCredits = await credits();
      let providerRequests = 0;
      server.use(
        http.post(GOOGLE_SERP_URL, () => {
          providerRequests += 1;
          const returnSearchEngineError =
            (firstResponse === "40101" && providerRequests === 1) ||
            (firstResponse === "empty" && providerRequests === 2);
          return HttpResponse.json(
            returnSearchEngineError
              ? searchEngineErrorResponse(
                  `failed-task-${providerRequests}`,
                  0.002,
                )
              : emptyTasksResponse(),
          );
        }),
      );

      const response = await accept(
        client.serp({
          headers,
          body: serpRequest("google", "technical seo"),
        }),
        [502],
      );

      expect(response.body.error.code).toBe(expectedCode);
      expect(providerRequests).toBe(2);
      await expect(credits()).resolves.toBe(beforeCredits);
    },
  );

  it("does not retry 40101 when the provider marks the task envelope as failed", async () => {
    const { client, headers, credits } = await setupSerpTest();
    const beforeCredits = await credits();
    let providerRequests = 0;
    server.use(
      http.post(GOOGLE_SERP_URL, () => {
        providerRequests += 1;
        return HttpResponse.json({
          ...searchEngineErrorResponse("failed-task", 0.002),
          tasks_error: 1,
        });
      }),
    );

    const response = await accept(
      client.serp({
        headers,
        body: serpRequest("google", "technical seo"),
      }),
      [502],
    );

    expect(response.body.error.code).toBe("SEO_SEARCH_ENGINE_UNAVAILABLE");
    expect(providerRequests).toBe(1);
    await expect(credits()).resolves.toBe(beforeCredits);
  });
});
