import { HttpResponse, http } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";

import {
  scrapeContract,
  type ScrapeRequest,
} from "@okouai/api-contracts/contracts/scrape";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";

import { mockEnv } from "../../../lib/env";
import { createAppWithRoutes } from "../../../app-factory-core";
import { server } from "../../../mocks/server";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { accept, testContext } from "../../../__tests__/test-context";
import {
  createUsagePricingFixture,
  seedOrgMetadata,
  type UsagePricingFixture,
} from "../../../test-fixtures/system-config-seeds";
import { createDeferredPromise } from "../../utils";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { now } from "../../../lib/time";
import type { RouteEntry } from "../../route-entry";
import { billingStatusRoutes } from "../billing-status";
import { scrapeRoutes } from "../scrape";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";
import { seedBuiltInDefaultModelKey } from "./helpers/runtime-state";

const context = testContext();
const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";

const scrapeTestRoutes: readonly RouteEntry[] = [
  ...billingStatusRoutes,
  ...scrapeRoutes,
];

interface AuthHeaders {
  readonly authorization?: string;
}

interface RawScrapeRequestOptions {
  readonly authHeaders?: AuthHeaders;
  readonly instanceSignal?: AbortSignal;
  readonly requestSignal?: AbortSignal;
  readonly usagePricingResolution?: UsagePricingFixture["resolution"];
}

class ClerkApiResponseTestError extends Error {
  static readonly kind = "ClerkAPIResponseError";
  readonly code = "api_response_error";

  constructor(readonly status: number) {
    super("Clerk request failed for user_sensitive and org_sensitive");
  }
}

function authHeaders(actor: ApiTestUser | null): AuthHeaders {
  return actor ? { authorization: "Bearer clerk-session" } : {};
}

function authenticate(actor: ApiTestUser | null): AuthHeaders {
  if (!actor) {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    return {};
  }

  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return authHeaders(actor);
}

function client(usagePricingResolution?: UsagePricingFixture["resolution"]) {
  return setupAppWithRoutes({
    context,
    routes: scrapeTestRoutes,
    usagePricingResolution,
  });
}

async function rawScrapeRequest(
  actor: ApiTestUser | null,
  body: ScrapeRequest,
  options: RawScrapeRequestOptions = {},
): Promise<Response> {
  const app = createAppWithRoutes({
    signal: options.instanceSignal ?? context.signal,
    routes: scrapeTestRoutes,
    usagePricingResolution: options.usagePricingResolution,
  });
  const request = new Request("http://api.test/api/scrape", {
    method: "POST",
    headers: {
      ...(options.authHeaders ?? authenticate(actor)),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    ...(options.requestSignal ? { signal: options.requestSignal } : {}),
  });
  return await app.request(request);
}

async function bootstrapOnboarding(actor: ApiTestUser): Promise<void> {
  const completed = await createBddApi(context).completeOnboarding(actor);
  expect(completed.status).toBe(200);
}

async function setActorCredits(
  actor: ApiTestUser,
  credits: number,
): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Scrape test actor must belong to an organization");
  }
  await seedOrgMetadata({ orgId: actor.orgId, tier: "pro", credits });
}

async function fundActor(actor: ApiTestUser): Promise<void> {
  await bootstrapOnboarding(actor);
  await setActorCredits(actor, 1000);
}

async function createAdmittedScrapeRun(actor: ApiTestUser): Promise<string> {
  await seedBuiltInDefaultModelKey(context);
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  bdd.acceptAgentStorageWrites();
  runs.configureRunnerGroup();
  await bootstrapOnboarding(actor);
  await setActorCredits(actor, 1);
  const agent = await bdd.createAgent(actor, {
    displayName: "Admitted scrape agent",
    visibility: "private",
  });
  const run = await runs.createRun(actor, {
    agentId: agent.agentId,
    prompt: "Scrape after credit exhaustion",
    modelProvider: "built-in",
  });
  return run.runId;
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

function allowExampleDotCom(): void {
  context.mocks.dns.lookupOverrides.set("example.com", [
    { address: "93.184.216.34", family: 4 },
  ]);
}

function configureProvider(): void {
  mockEnv("OKOU_SCRAPE_FIRECRAWL_TOKEN", "test-firecrawl-token");
}

async function createScrapePricingFixture(): Promise<UsagePricingFixture> {
  const fixture = await createUsagePricingFixture({
    configured: [
      {
        kind: "scrape",
        provider: "firecrawl",
        category: "standard.markdown",
        unitPrice: 4,
        unitSize: 1,
      },
      {
        kind: "scrape",
        provider: "firecrawl",
        category: "standard.links",
        unitPrice: 4,
        unitSize: 1,
      },
      {
        kind: "scrape",
        provider: "firecrawl",
        category: "enhanced.markdown",
        unitPrice: 20,
        unitSize: 1,
      },
      {
        kind: "scrape",
        provider: "firecrawl",
        category: "enhanced.links",
        unitPrice: 20,
        unitSize: 1,
      },
    ],
  });
  onTestFinished(async () => {
    await fixture.cleanup();
  });
  return fixture;
}

describe("okou scrape route", () => {
  it("rejects agent tokens without scrape:read capability", async () => {
    const actor = createBddApi(context).user();
    if (!actor.orgId) {
      throw new Error("Scrape test actor must belong to an organization");
    }
    await bootstrapOnboarding(actor);
    const seconds = Math.floor(now() / 1000);
    const token = signSandboxJwtForTests({
      scope: "okou",
      userId: actor.userId,
      orgId: actor.orgId,
      runId: "run_scrape_missing_capability",
      capabilities: [],
      iat: seconds,
      exp: seconds + 60,
    });

    const response = await accept(
      client()(scrapeContract).scrape({
        headers: { authorization: `Bearer ${token}` },
        body: {
          url: "https://example.com/page",
          format: "markdown",
          mode: "standard",
        },
      }),
      [403],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(response.body.error.message).toBe(
      "Missing required capability: scrape:read",
    );
  });

  it("retries a transient Clerk membership failure before scraping with a CLI PAT", async () => {
    const actor = createBddApi(context).user();
    const { token } =
      await createAuthOrgAgentsBddApi(context).createCliToken(actor);
    let firecrawlRequests = 0;
    allowExampleDotCom();
    configureProvider();
    const pricing = await createScrapePricingFixture();
    await fundActor(actor);
    mockClerkMembership(context, actor, "org:admin");
    context.mocks.clerk.users.getOrganizationMembershipList.mockRejectedValueOnce(
      new ClerkApiResponseTestError(521),
    );
    context.mocks.signalTimers.delay.mockResolvedValue(undefined);
    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, () => {
        firecrawlRequests += 1;
        return HttpResponse.json({
          success: true,
          data: {
            markdown: "# Example page",
            metadata: { sourceURL: "https://example.com/page" },
          },
        });
      }),
    );

    const response = await rawScrapeRequest(
      null,
      {
        url: "https://example.com/page",
        format: "markdown",
        mode: "standard",
      },
      {
        authHeaders: { authorization: `Bearer ${token}` },
        usagePricingResolution: pricing.resolution,
      },
    );

    expect(response.status).toBe(200);
    expect(
      context.mocks.clerk.users.getOrganizationMembershipList,
    ).toHaveBeenCalledTimes(2);
    expect(context.mocks.signalTimers.delay).toHaveBeenCalledOnce();
    expect(firecrawlRequests).toBe(1);
  });

  it("returns a sanitized 503 when Clerk membership reads remain unavailable", async () => {
    const actor = createBddApi(context).user();
    const { token } =
      await createAuthOrgAgentsBddApi(context).createCliToken(actor);
    let firecrawlRequests = 0;
    allowExampleDotCom();
    configureProvider();
    const pricing = await createScrapePricingFixture();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    context.mocks.clerk.users.getOrganizationMembershipList.mockRejectedValue(
      new ClerkApiResponseTestError(521),
    );
    context.mocks.signalTimers.delay.mockResolvedValue(undefined);
    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, () => {
        firecrawlRequests += 1;
        return HttpResponse.json({ success: true, data: {} });
      }),
    );

    const response = await rawScrapeRequest(
      null,
      {
        url: "https://example.com/page",
        format: "markdown",
        mode: "standard",
      },
      {
        authHeaders: { authorization: `Bearer ${token}` },
        usagePricingResolution: pricing.resolution,
      },
    );
    const afterCredits = await credits(actor);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Authentication provider is temporarily unavailable",
        code: "PROVIDER_UNAVAILABLE",
      },
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(
      context.mocks.clerk.users.getOrganizationMembershipList,
    ).toHaveBeenCalledTimes(3);
    expect(context.mocks.signalTimers.delay).toHaveBeenCalledTimes(2);
    expect(firecrawlRequests).toBe(0);
    expect(afterCredits).toBe(beforeCredits);
    expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
  });

  it("stops Clerk membership retries when the API instance is aborted", async () => {
    const actor = createBddApi(context).user();
    const { token } =
      await createAuthOrgAgentsBddApi(context).createCliToken(actor);
    const controller = new AbortController();
    const retryStarted = createDeferredPromise<void>(context.signal);
    const abortError = new Error("client disconnected during Clerk retry");
    abortError.name = "AbortError";
    await fundActor(actor);
    context.mocks.clerk.users.getOrganizationMembershipList.mockRejectedValue(
      new ClerkApiResponseTestError(521),
    );
    context.mocks.signalTimers.delay.mockImplementation((_ms, options) => {
      retryStarted.resolve(undefined);
      const signal = options?.signal;
      if (!signal) {
        throw new Error("Expected Clerk retry delay to receive a signal");
      }
      return createDeferredPromise<void>(signal).promise;
    });

    const responsePromise = rawScrapeRequest(
      null,
      {
        url: "https://example.com/page",
        format: "markdown",
        mode: "standard",
      },
      {
        authHeaders: { authorization: `Bearer ${token}` },
        instanceSignal: controller.signal,
      },
    );
    await retryStarted.promise;
    controller.abort(abortError);
    const response = await responsePromise;

    expect(response.status).toBe(500);
    expect(
      context.mocks.clerk.users.getOrganizationMembershipList,
    ).toHaveBeenCalledOnce();
  });

  it("keeps successful Clerk membership misses on the unauthorized path", async () => {
    const actor = createBddApi(context).user();
    const { token } =
      await createAuthOrgAgentsBddApi(context).createCliToken(actor);
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [],
    });

    const response = await rawScrapeRequest(
      null,
      {
        url: "https://example.com/page",
        format: "markdown",
        mode: "standard",
      },
      { authHeaders: { authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(401);
    expect(context.mocks.signalTimers.delay).not.toHaveBeenCalled();
  });

  it("does not retry direct Clerk session failures", async () => {
    context.mocks.clerk.authenticateRequest.mockRejectedValue(
      new ClerkApiResponseTestError(521),
    );

    const response = await rawScrapeRequest(
      null,
      {
        url: "https://example.com/page",
        format: "markdown",
        mode: "standard",
      },
      { authHeaders: { authorization: "Bearer clerk-session" } },
    );

    expect(response.status).toBe(500);
    expect(context.mocks.signalTimers.delay).not.toHaveBeenCalled();
    expect(context.mocks.sentry.captureException).toHaveBeenCalledOnce();
  });

  it("rejects scrape requests when the provider is not configured", async () => {
    const actor = createBddApi(context).user();
    allowExampleDotCom();
    mockEnv("OKOU_SCRAPE_FIRECRAWL_TOKEN", undefined);

    const response = await accept(
      client()(scrapeContract).scrape({
        headers: authenticate(actor),
        body: {
          url: "https://example.com/page",
          format: "markdown",
          mode: "standard",
        },
      }),
      [503],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("NOT_CONFIGURED");
  });

  it("blocks private targets before calling Firecrawl", async () => {
    const actor = createBddApi(context).user();
    let firecrawlRequests = 0;
    configureProvider();
    context.mocks.dns.lookupOverrides.set("private.example.test", [
      { address: "10.0.0.5", family: 4 },
    ]);
    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, () => {
        firecrawlRequests += 1;
        return HttpResponse.json({ success: true, data: {} });
      }),
    );

    for (const url of [
      "http://127.0.0.1:3000/admin",
      "http://localhost/admin",
      "https://private.example.test/admin",
    ]) {
      const response = await accept(
        client()(scrapeContract).scrape({
          headers: authenticate(actor),
          body: {
            url,
            format: "markdown",
            mode: "standard",
          },
        }),
        [400],
      );

      expectApiError(response.body);
      expect(response.body.error.code).toBe("INVALID_SCRAPE_TARGET");
    }
    expect(firecrawlRequests).toBe(0);
  });

  it("blocks special-use IPv4 literal targets before calling Firecrawl", async () => {
    const actor = createBddApi(context).user();
    let firecrawlRequests = 0;
    configureProvider();
    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, () => {
        firecrawlRequests += 1;
        return HttpResponse.json({ success: true, data: {} });
      }),
    );

    for (const url of [
      "http://192.0.2.10/page",
      "http://198.51.100.10/page",
      "http://203.0.113.10/page",
      "http://224.0.0.1/page",
      "http://240.0.0.1/page",
    ]) {
      const response = await accept(
        client()(scrapeContract).scrape({
          headers: authenticate(actor),
          body: {
            url,
            format: "markdown",
            mode: "standard",
          },
        }),
        [400],
      );

      expectApiError(response.body);
      expect(response.body.error.code).toBe("INVALID_SCRAPE_TARGET");
    }
    expect(firecrawlRequests).toBe(0);
  });

  it("blocks non-public IPv6 literal targets before calling Firecrawl", async () => {
    const actor = createBddApi(context).user();
    let firecrawlRequests = 0;
    configureProvider();
    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, () => {
        firecrawlRequests += 1;
        return HttpResponse.json({ success: true, data: {} });
      }),
    );

    for (const url of [
      "http://[::1]:3000/admin",
      "http://[::]/admin",
      "http://[::ffff:192.168.1.1]/admin",
      "http://[64:ff9b::c0a8:101]/admin",
      "http://[100:0:0:1::1]/admin",
      "http://[3fff::1]/admin",
      "http://[5f00::1]/admin",
      "http://[4000::1]/admin",
    ]) {
      const response = await accept(
        client()(scrapeContract).scrape({
          headers: authenticate(actor),
          body: {
            url,
            format: "markdown",
            mode: "standard",
          },
        }),
        [400],
      );

      expectApiError(response.body);
      expect(response.body.error.code).toBe("INVALID_SCRAPE_TARGET");
    }
    expect(firecrawlRequests).toBe(0);
  });

  it("blocks target URLs with embedded credentials before calling Firecrawl", async () => {
    const actor = createBddApi(context).user();
    let firecrawlRequests = 0;
    allowExampleDotCom();
    configureProvider();
    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, () => {
        firecrawlRequests += 1;
        return HttpResponse.json({ success: true, data: {} });
      }),
    );

    const response = await accept(
      client()(scrapeContract).scrape({
        headers: authenticate(actor),
        body: {
          url: "https://user:password@example.com/page",
          format: "markdown",
          mode: "standard",
        },
      }),
      [400],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("INVALID_SCRAPE_TARGET");
    expect(response.body.error.message).toBe(
      "Scrape URL must not include credentials",
    );
    expect(firecrawlRequests).toBe(0);
  });

  it("returns insufficient credits before calling Firecrawl", async () => {
    const actor = createBddApi(context).user();
    let firecrawlRequests = 0;
    allowExampleDotCom();
    configureProvider();
    const pricing = await createScrapePricingFixture();
    await bootstrapOnboarding(actor);
    await setActorCredits(actor, 0);
    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, () => {
        firecrawlRequests += 1;
        return HttpResponse.json({ success: true, data: {} });
      }),
    );

    const response = await accept(
      client(pricing.resolution)(scrapeContract).scrape({
        headers: authenticate(actor),
        body: {
          url: "https://example.com/page",
          format: "markdown",
          mode: "standard",
        },
      }),
      [402],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("INSUFFICIENT_CREDITS");
    expect(firecrawlRequests).toBe(0);
  });

  it("continues an admitted run after credits are exhausted", async () => {
    const actor = createBddApi(context).user();
    allowExampleDotCom();
    configureProvider();
    const pricing = await createScrapePricingFixture();
    const runId = await createAdmittedScrapeRun(actor);
    await setActorCredits(actor, 0);
    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, () => {
        return HttpResponse.json({
          success: true,
          data: {
            markdown: "# Admitted run",
            metadata: { sourceURL: "https://example.com/page" },
          },
        });
      }),
    );
    const token = createRunsApi(context).okouTokenForRunWithCapabilities(
      actor,
      runId,
      ["scrape:read"],
    );

    const response = await accept(
      client(pricing.resolution)(scrapeContract).scrape({
        headers: { authorization: `Bearer ${token}` },
        body: {
          url: "https://example.com/page",
          format: "markdown",
          mode: "standard",
        },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      creditsCharged: 4,
      result: { markdown: "# Admitted run" },
    });
    await expect(credits(actor)).resolves.toBe(-4);
  });

  it("does not let admitted runs bypass plan suspension", async () => {
    const actor = createBddApi(context).user();
    allowExampleDotCom();
    configureProvider();
    const pricing = await createScrapePricingFixture();
    const runId = await createAdmittedScrapeRun(actor);
    if (!actor.orgId) {
      throw new Error("Scrape test actor must belong to an organization");
    }
    await seedOrgMetadata({
      orgId: actor.orgId,
      tier: "pro-suspend",
      credits: 0,
    });
    let firecrawlRequests = 0;
    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, () => {
        firecrawlRequests += 1;
        return HttpResponse.json({ success: true, data: {} });
      }),
    );
    const token = createRunsApi(context).okouTokenForRunWithCapabilities(
      actor,
      runId,
      ["scrape:read"],
    );

    const response = await accept(
      client(pricing.resolution)(scrapeContract).scrape({
        headers: { authorization: `Bearer ${token}` },
        body: {
          url: "https://example.com/page",
          format: "markdown",
          mode: "standard",
        },
      }),
      [402],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("INSUFFICIENT_CREDITS");
    expect(firecrawlRequests).toBe(0);
  });

  it("scrapes markdown through standard Firecrawl proxy and records usage", async () => {
    const actor = createBddApi(context).user();
    let requestBody: unknown;
    allowExampleDotCom();
    configureProvider();
    const pricing = await createScrapePricingFixture();
    await fundActor(actor);
    const beforeCredits = await credits(actor);

    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, async ({ request }) => {
        requestBody = await request.json();
        return HttpResponse.json({
          success: true,
          data: {
            markdown: "# Example page",
            metadata: {
              sourceURL: "https://example.com/page",
            },
          },
        });
      }),
    );

    const response = await accept(
      client(pricing.resolution)(scrapeContract).scrape({
        headers: authenticate(actor),
        body: {
          url: "https://example.com/page",
          format: "markdown",
          mode: "standard",
        },
      }),
      [200],
    );
    const afterCredits = await credits(actor);

    expect(requestBody).toStrictEqual({
      url: "https://example.com/page",
      formats: ["markdown"],
      parsers: [],
      proxy: "basic",
      skipTlsVerification: false,
      maxAge: 0,
      storeInCache: false,
      timeout: 25_000,
    });
    expect(response.body).toMatchObject({
      requestedUrl: "https://example.com/page",
      finalUrl: "https://example.com/page",
      format: "markdown",
      mode: "standard",
      provider: "firecrawl",
      creditsCharged: 4,
      billingCategory: "standard.markdown",
      billingQuantity: 1,
      result: {
        markdown: "# Example page",
      },
    });
    expect(beforeCredits - afterCredits).toBe(4);
  });

  it("records usage when the request aborts after Firecrawl succeeds", async () => {
    const actor = createBddApi(context).user();
    const controller = new AbortController();
    const abortError = new Error("client disconnected after provider success");
    abortError.name = "AbortError";
    allowExampleDotCom();
    configureProvider();
    const pricing = await createScrapePricingFixture();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    let providerCompleted = false;
    context.mocks.dns.lookupOverrides.set("final.example.test", () => {
      controller.abort(abortError);
      return [{ address: "93.184.216.35", family: 4 }];
    });

    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, () => {
        providerCompleted = true;
        return HttpResponse.json({
          success: true,
          data: {
            markdown: "# Example page",
            metadata: {
              url: "https://final.example.test/page",
            },
          },
        });
      }),
    );

    const response = await rawScrapeRequest(
      actor,
      {
        url: "https://example.com/page",
        format: "markdown",
        mode: "standard",
      },
      {
        requestSignal: controller.signal,
        usagePricingResolution: pricing.resolution,
      },
    );
    const afterCredits = await credits(actor);

    expect(response.status).toBe(200);
    expect(providerCompleted).toBeTruthy();
    expect(beforeCredits - afterCredits).toBe(4);
  });

  it("does not start Firecrawl when the request aborts before provider launch", async () => {
    const actor = createBddApi(context).user();
    const controller = new AbortController();
    const abortError = new Error("client disconnected before provider launch");
    abortError.name = "AbortError";
    let firecrawlRequests = 0;
    configureProvider();
    const pricing = await createScrapePricingFixture();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    context.mocks.dns.lookupOverrides.set("example.com", () => {
      controller.abort(abortError);
      return [{ address: "93.184.216.34", family: 4 }];
    });
    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, () => {
        firecrawlRequests += 1;
        return HttpResponse.json({
          success: true,
          data: {
            markdown: "# Example page",
            metadata: { url: "https://example.com/page" },
          },
        });
      }),
    );

    const response = await rawScrapeRequest(
      actor,
      {
        url: "https://example.com/page",
        format: "markdown",
        mode: "standard",
      },
      {
        requestSignal: controller.signal,
        usagePricingResolution: pricing.resolution,
      },
    );
    const afterCredits = await credits(actor);

    expect(response.status).toBe(500);
    expect(firecrawlRequests).toBe(0);
    expect(afterCredits).toBe(beforeCredits);
  });

  it("cancels Firecrawl when the request aborts while it is in flight", async () => {
    const actor = createBddApi(context).user();
    const controller = new AbortController();
    const abortError = new Error("client disconnected during provider work");
    abortError.name = "AbortError";
    const providerStarted = createDeferredPromise<void>(context.signal);
    const providerResponse = createDeferredPromise<void>(context.signal);
    let providerSignalAborted = false;
    allowExampleDotCom();
    configureProvider();
    const pricing = await createScrapePricingFixture();
    await fundActor(actor);
    const beforeCredits = await credits(actor);

    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, async ({ request }) => {
        providerStarted.resolve(undefined);
        controller.abort(abortError);
        providerSignalAborted = request.signal.aborted;
        await providerResponse.promise;
        return HttpResponse.json({
          success: true,
          data: {
            markdown: "# Example page",
            metadata: {
              url: "https://example.com/page",
            },
          },
        });
      }),
    );

    const responsePromise = rawScrapeRequest(
      actor,
      {
        url: "https://example.com/page",
        format: "markdown",
        mode: "standard",
      },
      {
        requestSignal: controller.signal,
        usagePricingResolution: pricing.resolution,
      },
    );
    await providerStarted.promise;
    providerResponse.resolve(undefined);
    const response = await responsePromise;
    const afterCredits = await credits(actor);

    expect(response.status).toBe(500);
    expect(providerSignalAborted).toBeTruthy();
    expect(afterCredits).toBe(beforeCredits);
  });

  it("stops in-flight Firecrawl work when the instance lifecycle aborts", async () => {
    const actor = createBddApi(context).user();
    const controller = new AbortController();
    const abortError = new Error("function instance terminated");
    abortError.name = "AbortError";
    let providerSignalAborted = false;
    allowExampleDotCom();
    configureProvider();
    const pricing = await createScrapePricingFixture();
    await fundActor(actor);
    const beforeCredits = await credits(actor);

    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, ({ request }) => {
        controller.abort(abortError);
        providerSignalAborted = request.signal.aborted;
        return HttpResponse.json({
          success: true,
          data: {
            markdown: "# Example page",
            metadata: { url: "https://example.com/page" },
          },
        });
      }),
    );

    const response = await rawScrapeRequest(
      actor,
      {
        url: "https://example.com/page",
        format: "markdown",
        mode: "standard",
      },
      {
        instanceSignal: controller.signal,
        usagePricingResolution: pricing.resolution,
      },
    );
    const afterCredits = await credits(actor);

    expect(response.status).toBe(500);
    expect(providerSignalAborted).toBeTruthy();
    expect(afterCredits).toBe(beforeCredits);
  });

  it("records both concurrent same-org scrape requests", async () => {
    const actor = createBddApi(context).user();
    let firecrawlRequests = 0;
    allowExampleDotCom();
    configureProvider();
    const pricing = await createScrapePricingFixture();
    await fundActor(actor);
    const beforeCredits = await credits(actor);

    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, async ({ request }) => {
        firecrawlRequests += 1;
        const body = (await request.json()) as { readonly url?: string };
        return HttpResponse.json({
          success: true,
          data: {
            markdown: `# ${body.url ?? "unknown"}`,
            metadata: {
              sourceURL: body.url ?? "https://example.com/page",
            },
          },
        });
      }),
    );

    const scrapeClient = client(pricing.resolution);
    const [first, second] = await Promise.all([
      accept(
        scrapeClient(scrapeContract).scrape({
          headers: authenticate(actor),
          body: {
            url: "https://example.com/one",
            format: "markdown",
            mode: "standard",
          },
        }),
        [200],
      ),
      accept(
        scrapeClient(scrapeContract).scrape({
          headers: authenticate(actor),
          body: {
            url: "https://example.com/two",
            format: "markdown",
            mode: "standard",
          },
        }),
        [200],
      ),
    ]);
    const afterCredits = await credits(actor);

    expect(first.body.creditsCharged).toBe(4);
    expect(second.body.creditsCharged).toBe(4);
    expect(firecrawlRequests).toBe(2);
    expect(beforeCredits - afterCredits).toBe(8);
  });

  it("does not return successful content when usage processing records a billing error", async () => {
    const actor = createBddApi(context).user();
    allowExampleDotCom();
    configureProvider();
    const pricing = await createScrapePricingFixture();
    await fundActor(actor);
    const beforeCredits = await credits(actor);

    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, async () => {
        await pricing.cleanup();
        return HttpResponse.json({
          success: true,
          data: {
            markdown: "# Example page",
            metadata: {
              sourceURL: "https://example.com/page",
            },
          },
        });
      }),
    );

    const response = await rawScrapeRequest(
      actor,
      {
        url: "https://example.com/page",
        format: "markdown",
        mode: "standard",
      },
      { usagePricingResolution: pricing.resolution },
    );
    const afterCredits = await credits(actor);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Internal server error",
    });
    expect(afterCredits).toBe(beforeCredits);
  });

  it("scrapes public IPv6 literal targets without DNS lookup", async () => {
    const actor = createBddApi(context).user();
    let requestBody: unknown;
    configureProvider();
    const pricing = await createScrapePricingFixture();
    await fundActor(actor);
    const beforeCredits = await credits(actor);

    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, async ({ request }) => {
        requestBody = await request.json();
        return HttpResponse.json({
          success: true,
          data: {
            markdown: "# IPv6 page",
          },
        });
      }),
    );

    const response = await accept(
      client(pricing.resolution)(scrapeContract).scrape({
        headers: authenticate(actor),
        body: {
          url: "https://[2606:4700:4700::1111]/page",
          format: "markdown",
          mode: "standard",
        },
      }),
      [200],
    );
    const afterCredits = await credits(actor);

    expect(requestBody).toMatchObject({
      url: "https://[2606:4700:4700::1111]/page",
      formats: ["markdown"],
      proxy: "basic",
    });
    expect(response.body.result).toStrictEqual({ markdown: "# IPv6 page" });
    expect(beforeCredits - afterCredits).toBe(4);
  });

  it("scrapes links through enhanced Firecrawl proxy and records usage", async () => {
    const actor = createBddApi(context).user();
    let requestBody: unknown;
    let authorization: string | null = null;
    allowExampleDotCom();
    configureProvider();
    const pricing = await createScrapePricingFixture();
    await fundActor(actor);
    const beforeCredits = await credits(actor);

    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, async ({ request }) => {
        requestBody = await request.json();
        authorization = request.headers.get("authorization");
        return HttpResponse.json({
          success: true,
          data: {
            links: ["https://example.com/a", "https://example.com/b"],
            metadata: {
              title: "Example page",
              sourceURL: "https://example.com/page",
              url: "https://example.com/final",
              statusCode: 200,
            },
          },
        });
      }),
    );

    const response = await accept(
      client(pricing.resolution)(scrapeContract).scrape({
        headers: authenticate(actor),
        body: {
          url: "https://example.com/page",
          format: "links",
          mode: "enhanced",
        },
      }),
      [200],
    );
    const afterCredits = await credits(actor);

    expect(requestBody).toStrictEqual({
      url: "https://example.com/page",
      formats: ["links"],
      parsers: [],
      proxy: "enhanced",
      skipTlsVerification: false,
      maxAge: 0,
      storeInCache: false,
      timeout: 25_000,
    });
    expect(authorization).toBe("Bearer test-firecrawl-token");
    expect(response.body).toMatchObject({
      requestedUrl: "https://example.com/page",
      finalUrl: "https://example.com/final",
      format: "links",
      mode: "enhanced",
      provider: "firecrawl",
      creditsCharged: 20,
      billingCategory: "enhanced.links",
      billingQuantity: 1,
      result: {
        links: ["https://example.com/a", "https://example.com/b"],
      },
      metadata: {
        title: "Example page",
        statusCode: 200,
      },
    });
    expect(beforeCredits - afterCredits).toBe(20);
  });

  it("rejects unsafe final URLs when the source URL is public", async () => {
    const actor = createBddApi(context).user();
    allowExampleDotCom();
    configureProvider();
    const pricing = await createScrapePricingFixture();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, () => {
        return HttpResponse.json({
          success: true,
          data: {
            markdown: "# Internal redirect",
            metadata: {
              sourceURL: "https://example.com/page",
              url: "http://127.0.0.1/secret",
            },
          },
        });
      }),
    );

    const response = await accept(
      client(pricing.resolution)(scrapeContract).scrape({
        headers: authenticate(actor),
        body: {
          url: "https://example.com/page",
          format: "markdown",
          mode: "standard",
        },
      }),
      [502],
    );
    const afterCredits = await credits(actor);

    expectApiError(response.body);
    expect(response.body.error.code).toBe("UNSAFE_FINAL_URL");
    expect(afterCredits).toBe(beforeCredits);
  });

  it("returns Firecrawl success false errors without recording usage", async () => {
    const actor = createBddApi(context).user();
    allowExampleDotCom();
    configureProvider();
    const pricing = await createScrapePricingFixture();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, () => {
        return HttpResponse.json({
          success: false,
          error: "Firecrawl rejected this scrape",
        });
      }),
    );

    const response = await accept(
      client(pricing.resolution)(scrapeContract).scrape({
        headers: authenticate(actor),
        body: {
          url: "https://example.com/page",
          format: "markdown",
          mode: "standard",
        },
      }),
      [502],
    );
    const afterCredits = await credits(actor);

    expectApiError(response.body);
    expect(response.body.error.code).toBe("FIRECRAWL_ERROR");
    expect(response.body.error.message).toBe("Firecrawl rejected this scrape");
    expect(afterCredits).toBe(beforeCredits);
  });

  it("bounds provider error messages without recording usage", async () => {
    const actor = createBddApi(context).user();
    allowExampleDotCom();
    configureProvider();
    const pricing = await createScrapePricingFixture();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, () => {
        return HttpResponse.json({
          success: false,
          error: "x".repeat(5000),
        });
      }),
    );

    const response = await accept(
      client(pricing.resolution)(scrapeContract).scrape({
        headers: authenticate(actor),
        body: {
          url: "https://example.com/page",
          format: "markdown",
          mode: "standard",
        },
      }),
      [502],
    );
    const afterCredits = await credits(actor);

    expectApiError(response.body);
    expect(response.body.error.code).toBe("FIRECRAWL_ERROR");
    expect(response.body.error.message).toHaveLength(4096);
    expect(response.body.error.message.endsWith("...")).toBeTruthy();
    expect(afterCredits).toBe(beforeCredits);
  });

  it("rejects provider data without an explicit success marker", async () => {
    const actor = createBddApi(context).user();
    allowExampleDotCom();
    configureProvider();
    const pricing = await createScrapePricingFixture();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, () => {
        return HttpResponse.json({
          status: 400,
          body: {
            error: {
              message: "Provider controlled error",
              code: "PROVIDER_CONTROLLED",
            },
          },
          data: {
            markdown: "# Provider controlled content",
          },
        });
      }),
    );

    const response = await accept(
      client(pricing.resolution)(scrapeContract).scrape({
        headers: authenticate(actor),
        body: {
          url: "https://example.com/page",
          format: "markdown",
          mode: "standard",
        },
      }),
      [502],
    );
    const afterCredits = await credits(actor);

    expectApiError(response.body);
    expect(response.body.error.code).toBe("FIRECRAWL_ERROR");
    expect(response.body.error.message).toBe(
      "Firecrawl response did not include scrape data",
    );
    expect(afterCredits).toBe(beforeCredits);
  });

  it("rejects oversized Firecrawl responses without recording usage", async () => {
    const actor = createBddApi(context).user();
    allowExampleDotCom();
    configureProvider();
    const pricing = await createScrapePricingFixture();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.post(FIRECRAWL_SCRAPE_URL, () => {
        return HttpResponse.text("x".repeat(4 * 1024 * 1024 + 1));
      }),
    );

    const response = await accept(
      client(pricing.resolution)(scrapeContract).scrape({
        headers: authenticate(actor),
        body: {
          url: "https://example.com/page",
          format: "markdown",
          mode: "standard",
        },
      }),
      [502],
    );
    const afterCredits = await credits(actor);

    expectApiError(response.body);
    expect(response.body.error.code).toBe("SCRAPE_OUTPUT_TOO_LARGE");
    expect(afterCredits).toBe(beforeCredits);
  });
});
