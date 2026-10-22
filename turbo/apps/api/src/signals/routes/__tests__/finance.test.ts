import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { financeContract } from "@okouai/api-contracts/contracts/finance";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";
import { billingStatusRoutes } from "../billing-status";
import { financeRoutes } from "../finance";

const context = testContext();
const FINANCE_ROUTES = Object.freeze([
  ...billingStatusRoutes,
  ...financeRoutes,
]);
const MONID_BASE_URL = "https://api.monid.ai/v1";

function authenticate(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context, routes: FINANCE_ROUTES });
}

async function fundActor(actor: ApiTestUser): Promise<void> {
  await createRunsApi(context).grantProEntitlement(actor);
}

async function credits(actor: ApiTestUser): Promise<number> {
  const response = await accept(
    client()(billingStatusContract).get({
      headers: authenticate(actor),
    }),
    [200],
  );
  return response.body.credits;
}

function configureProvider(): void {
  mockEnv("OKOU_FINANCE_MONID_API_KEY", "test-monid-token");
}

function completedRun(endpoint: string, output: unknown) {
  return {
    runId: "finance-run-123",
    provider: "yahoo-finance",
    endpoint,
    status: "COMPLETED",
    providerResponse: { httpStatus: 200 },
    output,
  };
}

describe("okou finance routes", () => {
  it("maps all operations to Monid and charges configured request pricing", async () => {
    const actor = createBddApi(context).user();
    await fundActor(actor);
    configureProvider();
    const beforeCredits = await credits(actor);
    const observed: unknown[] = [];
    const outputs: Record<string, unknown> = {
      "/search_tickers": { tickers: [{ symbol: "0700.HK" }] },
      "/get_company_profile": { assetProfile: { industry: "Technology" } },
      "/get_quote": { quotes: [{ symbol: "AAPL", price: 200 }] },
      "/get_historical_data": { prices: [{ date: "2026-10-21", close: 200 }] },
    };
    server.use(
      http.post(`${MONID_BASE_URL}/run`, async ({ request }) => {
        const body = await request.json();
        observed.push(body);
        expect(request.headers.get("authorization")).toBe(
          "Bearer test-monid-token",
        );
        expect(body).toMatchObject({ provider: "yahoo-finance" });
        const endpoint =
          body && typeof body === "object" && "endpoint" in body
            ? String(body.endpoint)
            : "";
        expect(outputs).toHaveProperty(endpoint);
        return HttpResponse.json(completedRun(endpoint, outputs[endpoint]));
      }),
    );

    const search = await accept(
      client()(financeContract).search({
        headers: authenticate(actor),
        body: { query: "Tencent" },
      }),
      [200],
    );
    const profile = await accept(
      client()(financeContract).profile({
        headers: authenticate(actor),
        body: { symbol: "AAPL" },
      }),
      [200],
    );
    const quote = await accept(
      client()(financeContract).quote({
        headers: authenticate(actor),
        body: { symbol: "AAPL" },
      }),
      [200],
    );
    const chart = await accept(
      client()(financeContract).chart({
        headers: authenticate(actor),
        body: { symbol: "AAPL", range: "5y", interval: "1wk" },
      }),
      [200],
    );

    for (const [response, operation, endpoint] of [
      [search, "search", "/search_tickers"],
      [profile, "profile", "/get_company_profile"],
      [quote, "quote", "/get_quote"],
      [chart, "chart", "/get_historical_data"],
    ] as const) {
      expect(response.body).toStrictEqual({
        operation,
        provider: "monid/yahoo-finance",
        billingCategory: "provider_cost_usd_micros",
        billingQuantity: 50_000,
        creditsCharged: 63,
        result: outputs[endpoint],
      });
    }
    expect(observed).toStrictEqual([
      {
        provider: "yahoo-finance",
        endpoint: "/search_tickers",
        input: { queryParams: { query: "Tencent" } },
      },
      {
        provider: "yahoo-finance",
        endpoint: "/get_company_profile",
        input: { queryParams: { symbol: "AAPL" } },
      },
      {
        provider: "yahoo-finance",
        endpoint: "/get_quote",
        input: { queryParams: { symbols: "AAPL" } },
      },
      {
        provider: "yahoo-finance",
        endpoint: "/get_historical_data",
        input: {
          queryParams: { symbol: "AAPL", range: "5y", interval: "1wk" },
        },
      },
    ]);
    expect(beforeCredits - (await credits(actor))).toBe(252);
  });

  it("follows an accepted run to completion and charges once", async () => {
    const actor = createBddApi(context).user();
    await fundActor(actor);
    configureProvider();
    const beforeCredits = await credits(actor);
    const output = { quotes: [{ symbol: "000001.SS", price: 4000 }] };
    server.use(
      http.post(`${MONID_BASE_URL}/run`, () => {
        return HttpResponse.json(
          {
            runId: "finance-run-123",
            provider: "yahoo-finance",
            endpoint: "/get_quote",
            status: "RUNNING",
          },
          { status: 202 },
        );
      }),
      http.get(`${MONID_BASE_URL}/runs/finance-run-123`, ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer test-monid-token",
        );
        return HttpResponse.json(completedRun("/get_quote", output));
      }),
    );

    const response = await accept(
      client()(financeContract).quote({
        headers: authenticate(actor),
        body: { symbol: "000001.SS" },
      }),
      [200],
    );

    expect(response.body.result).toStrictEqual(output);
    expect(response.body.creditsCharged).toBe(63);
    expect(beforeCredits - (await credits(actor))).toBe(63);
  });

  it.each([
    {
      name: "provider HTTP failure",
      status: 502,
      body: { message: "upstream unavailable" },
    },
    {
      name: "blocked execution",
      status: 200,
      body: { ...completedRun("/get_quote", null), status: "BLOCKED" },
    },
    {
      name: "failed source behind a completed run",
      status: 200,
      body: {
        ...completedRun("/get_quote", null),
        providerResponse: { httpStatus: 500, error: "source unavailable" },
      },
    },
  ])("does not charge credits for $name", async ({ status, body }) => {
    const actor = createBddApi(context).user();
    await fundActor(actor);
    configureProvider();
    const beforeCredits = await credits(actor);
    server.use(
      http.post(`${MONID_BASE_URL}/run`, () => {
        return HttpResponse.json(body, { status });
      }),
    );

    const response = await accept(
      client()(financeContract).quote({
        headers: authenticate(actor),
        body: { symbol: "AAPL" },
      }),
      [502],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("MONID_ERROR");
    await expect(credits(actor)).resolves.toBe(beforeCredits);
  });

  it("reports an uncertain execution without replaying the paid request", async () => {
    const actor = createBddApi(context).user();
    await fundActor(actor);
    configureProvider();
    const beforeCredits = await credits(actor);
    let starts = 0;
    server.use(
      http.post(`${MONID_BASE_URL}/run`, () => {
        starts += 1;
        return HttpResponse.error();
      }),
    );

    const response = await accept(
      client()(financeContract).quote({
        headers: authenticate(actor),
        body: { symbol: "AAPL" },
      }),
      [502],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("MONID_EXECUTION_UNKNOWN");
    expect(response.body.error.message).toContain("Do not automatically retry");
    expect(starts).toBe(1);
    await expect(credits(actor)).resolves.toBe(beforeCredits);
  });

  it("returns not configured when the Monid key is missing", async () => {
    const actor = createBddApi(context).user();
    mockEnv("OKOU_FINANCE_MONID_API_KEY", undefined);

    const response = await accept(
      client()(financeContract).profile({
        headers: authenticate(actor),
        body: { symbol: "AAPL" },
      }),
      [503],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("NOT_CONFIGURED");
  });
});
