import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { financeContract } from "@okouai/api-contracts/contracts/finance";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { now } from "../../../lib/time";
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
const APIDOJO_BASE_URL = "https://apidojo-yahoo-finance-v1.p.rapidapi.com";

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
  mockEnv("OKOU_FINANCE_APIDOJO_TOKEN", "test-rapidapi-token");
}

describe("okou finance routes", () => {
  it("rejects agent tokens without finance:read capability", async () => {
    const actor = createBddApi(context).user();
    if (!actor.orgId) {
      throw new Error("Finance test actor must belong to an organization");
    }
    const completed = await createBddApi(context).completeOnboarding(actor);
    expect(completed.status).toBe(200);
    const seconds = Math.floor(now() / 1000);
    const token = signSandboxJwtForTests({
      scope: "okou",
      userId: actor.userId,
      orgId: actor.orgId,
      runId: "run_finance_missing_capability",
      capabilities: [],
      iat: seconds,
      exp: seconds + 60,
    });

    const response = await accept(
      client()(financeContract).quote({
        headers: { authorization: `Bearer ${token}` },
        body: { symbol: "AAPL" },
      }),
      [403],
    );

    expectApiError(response.body);
    expect(response.body.error.message).toBe(
      "Missing required capability: finance:read",
    );
  });

  it("maps all operations to APIDojo and charges one credit each", async () => {
    const actor = createBddApi(context).user();
    await fundActor(actor);
    configureProvider();
    const beforeCredits = await credits(actor);
    const observed: string[] = [];
    server.use(
      http.get(`${APIDOJO_BASE_URL}/auto-complete`, ({ request }) => {
        const url = new URL(request.url);
        observed.push(`search:${url.searchParams.toString()}`);
        expect(request.headers.get("x-rapidapi-key")).toBe(
          "test-rapidapi-token",
        );
        expect(request.headers.get("x-rapidapi-host")).toBe(
          "apidojo-yahoo-finance-v1.p.rapidapi.com",
        );
        return HttpResponse.json({ quotes: [{ symbol: "0700.HK" }] });
      }),
      http.get(`${APIDOJO_BASE_URL}/stock/v3/get-profile`, ({ request }) => {
        observed.push(
          `profile:${new URL(request.url).searchParams.toString()}`,
        );
        return HttpResponse.json({ assetProfile: { industry: "Technology" } });
      }),
      http.get(`${APIDOJO_BASE_URL}/market/v2/get-quotes`, ({ request }) => {
        observed.push(`quote:${new URL(request.url).searchParams.toString()}`);
        return HttpResponse.json({
          quoteResponse: { result: [{ symbol: "AAPL" }] },
        });
      }),
      http.get(`${APIDOJO_BASE_URL}/stock/v3/get-chart`, ({ request }) => {
        observed.push(`chart:${new URL(request.url).searchParams.toString()}`);
        return HttpResponse.json({
          chart: { result: [{ timestamp: [1, 2] }] },
        });
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

    expect(search.body).toMatchObject({
      operation: "search",
      provider: "apidojo",
      creditsCharged: 1,
      result: { quotes: [{ symbol: "0700.HK" }] },
    });
    expect(profile.body.operation).toBe("profile");
    expect(quote.body.operation).toBe("quote");
    expect(chart.body).toMatchObject({
      operation: "chart",
      result: { chart: { result: [{ timestamp: [1, 2] }] } },
    });
    expect(observed).toStrictEqual([
      "search:q=Tencent&region=US",
      "profile:symbol=AAPL&region=US",
      "quote:symbols=AAPL&region=US",
      "chart:symbol=AAPL&range=5y&interval=1wk",
    ]);
    expect(beforeCredits - (await credits(actor))).toBe(4);
  });

  it("does not charge credits when APIDojo fails", async () => {
    const actor = createBddApi(context).user();
    await fundActor(actor);
    configureProvider();
    const beforeCredits = await credits(actor);
    server.use(
      http.get(`${APIDOJO_BASE_URL}/market/v2/get-quotes`, () => {
        return HttpResponse.json(
          { message: "upstream unavailable" },
          { status: 503 },
        );
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
    expect(response.body.error.code).toBe("APIDOJO_ERROR");
    await expect(credits(actor)).resolves.toBe(beforeCredits);
  });

  it("returns not configured without calling APIDojo", async () => {
    const actor = createBddApi(context).user();
    let providerRequests = 0;
    mockEnv("OKOU_FINANCE_APIDOJO_TOKEN", undefined);
    server.use(
      http.get(`${APIDOJO_BASE_URL}/stock/v3/get-profile`, () => {
        providerRequests += 1;
        return HttpResponse.json({});
      }),
    );

    const response = await accept(
      client()(financeContract).profile({
        headers: authenticate(actor),
        body: { symbol: "AAPL" },
      }),
      [503],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("NOT_CONFIGURED");
    expect(providerRequests).toBe(0);
  });
});
