import { createPublicUsageWallet } from "./helpers/public-usage-wallet";
import { randomUUID } from "node:crypto";

import { HttpResponse, http } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";

import {
  WEB_SEARCH_MAX_SNIPPET_CHARS,
  WEB_SEARCH_MAX_TITLE_CHARS,
  webSearchContract,
  type WebSearchRequest,
} from "@okouai/api-contracts/contracts/web-search";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { usageRecordContract } from "@okouai/api-contracts/contracts/usage-record";
import { testUsageSettlementContract } from "@okouai/api-contracts/contracts/test-usage-settlement";

import { createAppWithRoutes } from "../../../app-factory-core";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import {
  createUsagePricingFixture,
  seedOrgMetadata,
  type UsagePricingFixture,
  type UsagePricingKey,
} from "../../../test-fixtures/system-config-seeds";
import { env, mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { now, nowDate } from "../../../lib/time";
import type { RouteEntry } from "../../route-entry";
import { createDeferredPromise } from "../../utils";
import { billingStatusRoutes } from "../billing-status";
import { webSearchRoutes } from "../web-search";
import { testUsageSettlementRoutes } from "../test-usage-settlement";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { postUsageAllowanceInvoicePaid } from "./helpers/stripe-billing-webhook";
import { createRouteMocks } from "./helpers/route-test";
import { createFixtureOperationOwner } from "./helpers/fixture-operation-owner";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { ClerkTransportTestError } from "./helpers/clerk-transport-error";
import { usageRecordRoutes } from "../usage-record";

const context = testContext();
const PERPLEXITY_SEARCH_URL = "https://api.perplexity.ai/search";
const MAX_PROVIDER_RESPONSE_BYTES = 512 * 1024;

const webSearchTestRoutes: readonly RouteEntry[] = [
  ...billingStatusRoutes,
  ...webSearchRoutes,
];

interface AuthHeaders {
  readonly authorization?: string;
}

interface RawRequestOptions {
  readonly authHeaders?: AuthHeaders;
  readonly instanceSignal?: AbortSignal;
  readonly requestSignal?: AbortSignal;
  readonly usagePricingResolution?: UsagePricingFixture["resolution"];
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
    routes: webSearchTestRoutes,
    usagePricingResolution,
  });
}

async function rawWebSearchRequest(
  actor: ApiTestUser | null,
  body: unknown,
  options: RawRequestOptions = {},
): Promise<Response> {
  const app = createAppWithRoutes({
    signal: options.instanceSignal ?? context.signal,
    routes: webSearchTestRoutes,
    usagePricingResolution: options.usagePricingResolution,
  });
  const request = new Request("http://api.test/api/web-search", {
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
    throw new Error("Web Search test actor must belong to an organization");
  }
  await seedOrgMetadata({ orgId: actor.orgId, tier: "pro", credits });
}

async function fundActor(actor: ApiTestUser): Promise<void> {
  await bootstrapOnboarding(actor);
  await setActorCredits(actor, 1000);
}

interface FundedWebSearchActor {
  readonly actor: ApiTestUser;
  readonly orgId: string;
  readonly customerId: string;
  readonly subscriptionId: string;
  readonly invoiceId: string;
  readonly storageBucket: string;
}

async function cleanupFundedWebSearchActor(
  owned: FundedWebSearchActor,
): Promise<void> {
  mockEnv("R2_USER_STORAGES_BUCKET_NAME", owned.storageBucket);
  context.mocks.s3.send.mockResolvedValue({
    Contents: [],
    IsTruncated: false,
  });
  context.mocks.ably.publish.mockResolvedValue(undefined);
  await flushWaitUntilForTest();

  const webhooks = createWebhookCallbackApi(context);
  webhooks.configureStripeBillingEnv();
  context.mocks.stripe.subscriptions.list.mockResolvedValue({
    data: [],
    has_more: false,
  });
  context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
    id: owned.subscriptionId,
    status: "active",
    metadata: {},
  });
  context.mocks.stripe.subscriptions.update.mockResolvedValue({
    id: owned.subscriptionId,
  });
  context.mocks.stripe.subscriptions.cancel.mockResolvedValue({
    id: owned.subscriptionId,
    status: "canceled",
  });
  // This one-time credit invoice has no subscription invoice to refund.
  context.mocks.stripe.invoices.list.mockResolvedValue({
    data: [],
    has_more: false,
  });
  webhooks.configureClerkWebhookSecret();
  webhooks.verifyNextClerkWebhook({
    type: "organization.deleted",
    data: { id: owned.orgId },
  });
  await webhooks.requestClerkWebhook("{}", {}, [200]);
  await flushWaitUntilForTest();

  // Public deletion removes the wallet and active work. Production retains
  // immutable billing and usage history under this fixture's unique IDs.
  await expect(credits(owned.actor)).resolves.toBe(0);
  expect(
    (
      await createRunReadsApi(context).requestListLogs(
        owned.actor,
        { limit: 50 },
        [200],
      )
    ).body.data,
  ).toStrictEqual([]);
}

async function fundActorWithSubscription(actor: ApiTestUser): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Web Search test actor must belong to an organization");
  }
  const suffix = randomUUID();
  const owned = {
    actor,
    orgId: actor.orgId,
    customerId: `cus_web_search_${suffix}`,
    subscriptionId: `sub_web_search_${suffix}`,
    invoiceId: `in_web_search_${suffix}`,
    storageBucket: env("R2_USER_STORAGES_BUCKET_NAME"),
  };
  const owner = createFixtureOperationOwner(async () => {
    await cleanupFundedWebSearchActor(owned);
  });
  await owner.run(async () => {
    await bootstrapOnboarding(actor);
    await expect(credits(actor)).resolves.toBe(0);

    const webhooks = createWebhookCallbackApi(context);
    webhooks.configureStripeBillingEnv();
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: owned.customerId,
      metadata: { orgId: owned.orgId },
    });
    const subscription = {
      id: owned.subscriptionId,
      customer: owned.customerId,
      status: "active",
      metadata: {},
      cancel_at_period_end: false,
      cancel_at: null,
      schedule: null,
      trial_end: null,
      items: { data: [{ price: { id: "price_bdd_pro" } }] },
    };
    await webhooks.postStripeEvent(
      {
        id: `evt_web_search_created_${suffix}`,
        type: "customer.subscription.created",
        created: Math.floor(now() / 1000),
        data: { object: subscription },
      },
      [200],
    );
    await webhooks.postStripeEvent(
      {
        id: `evt_web_search_updated_${suffix}`,
        type: "customer.subscription.updated",
        created: Math.floor(now() / 1000),
        data: { object: subscription },
      },
      [200],
    );
    const subscribed = await accept(
      client()(billingStatusContract).get({
        headers: authenticate(actor),
      }),
      [200],
    );
    expect(subscribed.body).toMatchObject({
      tier: "pro",
      status: "active",
      credits: 0,
    });

    await webhooks.postStripeEvent(
      {
        id: `evt_web_search_paid_${suffix}`,
        type: "invoice.paid",
        created: Math.floor(now() / 1000),
        data: {
          object: {
            id: owned.invoiceId,
            customer: owned.customerId,
            amount_paid: 100,
            metadata: {
              type: "auto_recharge",
              orgId: owned.orgId,
              creditsAmount: "1000",
            },
            parent: null,
            lines: { has_more: false, data: [] },
          },
        },
      },
      [200],
    );
    await flushWaitUntilForTest();
    const funded = await accept(
      client()(billingStatusContract).get({
        headers: authenticate(actor),
      }),
      [200],
    );
    expect(funded.body).toMatchObject({
      tier: "pro",
      status: "active",
      credits: 1000,
    });
  });
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
  mockEnv("OKOU_WEB_SEARCH_PERPLEXITY_TOKEN", "test-perplexity-token");
}

function webSearchPricingKey(): UsagePricingKey {
  return {
    kind: "web-search",
    provider: "perplexity",
    category: "request",
  };
}

async function setupConfiguredWebSearchPricing(
  registerCleanup: (cleanup: () => Promise<void>) => void = onTestFinished,
): Promise<UsagePricingFixture> {
  const fixture = await createUsagePricingFixture({
    registerCleanup,
    configured: [
      {
        ...webSearchPricingKey(),
        unitPrice: 5,
        unitSize: 1,
      },
    ],
  });
  return fixture;
}

async function setupMissingWebSearchPricing(): Promise<UsagePricingFixture> {
  const fixture = await createUsagePricingFixture({
    missing: [webSearchPricingKey()],
  });
  onTestFinished(async () => {
    await fixture.cleanup();
  });
  return fixture;
}

function defaultRequest(
  overrides: Partial<WebSearchRequest> = {},
): WebSearchRequest {
  return {
    query: "latest AI regulation",
    limit: 5,
    ...overrides,
  };
}

function providerResponse() {
  return {
    id: "search-request-id",
    server_time: "2026-07-14T10:00:00Z",
    results: [
      {
        title: "AI regulation update",
        url: "https://example.com/update",
        snippet: "A relevant public-web excerpt.",
        date: "2026-07-13",
        last_updated: "2026-07-14",
      },
    ],
  };
}

describe("okou web-search route", () => {
  it("settles concurrent searches without rejecting changes to member credits", async () => {
    mockEnv("ENV", "development");
    const actor = createBddApi(context).user();
    if (!actor.orgId) {
      throw new Error("Search actor needs an organization");
    }
    const orgId = actor.orgId;
    configureProvider();
    const pricing = await setupConfiguredWebSearchPricing();
    await fundActor(actor);
    const settlement = () => {
      return setupApp({ context, routes: testUsageSettlementRoutes })(
        testUsageSettlementContract,
      );
    };
    await accept(
      settlement().createGrant({
        body: {
          org_id: orgId,
          user_id: actor.userId,
          grant_type: "purchased",
          idempotency_key: randomUUID(),
          amount: 5,
          expires_at: "2099-01-01T00:00:00.000Z",
        },
      }),
      [200],
    );
    onTestFinished(async () => {
      await accept(settlement().cleanup({ body: { org_id: orgId } }), [200]);
    });
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, () => {
        return HttpResponse.json(providerResponse());
      }),
    );
    const headers = authenticate(actor);
    const search = client(pricing.resolution)(webSearchContract);
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => {
        return accept(
          search.search({ headers, body: defaultRequest() }),
          [200],
        );
      }),
    );
    expect(
      responses.map((response) => {
        return response.body.creditsCharged;
      }),
    ).toStrictEqual([5, 5, 5, 5, 5, 5]);
    const state = await accept(
      settlement().state({ body: { org_id: orgId } }),
      [200],
    );
    expect(state.body.grants).toHaveLength(1);
    const remaining = state.body.grants[0]?.remaining_amount;
    expect(remaining).toBeDefined();
    if (remaining === undefined) {
      throw new Error("Expected member credit grant");
    }
    expect(remaining).toBeLessThanOrEqual(0);
    // Whichever requests prepared the grant split before it was exhausted,
    // accepted overdraft and shared-wallet debits must conserve the same charge.
    expect(state.body.org_credits + remaining).toBe(975);
  });

  it.each([
    ["transport", [new ClerkTransportTestError()]],
    [
      "transport then 5xx",
      [new ClerkTransportTestError(), new ClerkTransportTestError(521)],
    ],
    [
      "5xx then transport",
      [new ClerkTransportTestError(521), new ClerkTransportTestError()],
    ],
  ])(
    "recovers a %s Clerk read before searching and charging once",
    async (_name, failures) => {
      const actor = createBddApi(context).user();
      const { token } =
        await createAuthOrgAgentsBddApi(context).createCliToken(actor);
      configureProvider();
      const pricing = await setupConfiguredWebSearchPricing();
      await fundActor(actor);
      const beforeCredits = await credits(actor);
      mockClerkMembership(context, actor, "org:admin");
      const membershipRead =
        context.mocks.clerk.users.getOrganizationMembershipList;
      for (const failure of failures) {
        membershipRead.mockRejectedValueOnce(failure);
      }
      context.mocks.signalTimers.delay.mockResolvedValue(undefined);
      let providerRequests = 0;
      server.use(
        http.post(PERPLEXITY_SEARCH_URL, () => {
          providerRequests += 1;
          return HttpResponse.json(providerResponse());
        }),
      );

      const response = await rawWebSearchRequest(null, defaultRequest(), {
        authHeaders: { authorization: `Bearer ${token}` },
        usagePricingResolution: pricing.resolution,
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        creditsCharged: 5,
      });
      expect(providerRequests).toBe(1);
      expect(beforeCredits - (await credits(actor))).toBe(5);
      expect(membershipRead).toHaveBeenCalledTimes(failures.length + 1);
      expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["transport", new ClerkTransportTestError()],
    ["5xx then transport", new ClerkTransportTestError(521)],
  ])(
    "returns 503 after a bounded %s Clerk failure without searching or charging",
    async (_name, firstFailure) => {
      const actor = createBddApi(context).user();
      const { token } =
        await createAuthOrgAgentsBddApi(context).createCliToken(actor);
      configureProvider();
      const pricing = await setupConfiguredWebSearchPricing();
      await fundActor(actor);
      const beforeCredits = await credits(actor);
      const membershipRead =
        context.mocks.clerk.users.getOrganizationMembershipList;
      membershipRead
        .mockRejectedValueOnce(firstFailure)
        .mockRejectedValue(new ClerkTransportTestError());
      context.mocks.signalTimers.delay.mockResolvedValue(undefined);
      let providerRequests = 0;
      server.use(
        http.post(PERPLEXITY_SEARCH_URL, () => {
          providerRequests += 1;
          return HttpResponse.json(providerResponse());
        }),
      );

      const response = await rawWebSearchRequest(null, defaultRequest(), {
        authHeaders: { authorization: `Bearer ${token}` },
        usagePricingResolution: pricing.resolution,
      });

      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      await expect(response.json()).resolves.toStrictEqual({
        error: {
          message: "Authentication provider is temporarily unavailable",
          code: "PROVIDER_UNAVAILABLE",
        },
      });
      expect(membershipRead).toHaveBeenCalledTimes(3);
      expect(providerRequests).toBe(0);
      await expect(credits(actor)).resolves.toBe(beforeCredits);
      expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();

      // Unavailability does not revoke the same PAT or mark its identity missing.
      mockClerkMembership(context, actor, "org:admin");
      const recovered = await rawWebSearchRequest(null, defaultRequest(), {
        authHeaders: { authorization: `Bearer ${token}` },
        usagePricingResolution: pricing.resolution,
      });
      expect(recovered.status).toBe(200);
    },
  );

  it.each([
    [
      "SDK parsing failure",
      new ClerkTransportTestError(undefined, [
        { code: "unexpected_error", message: "Unexpected token in JSON" },
      ]),
    ],
    [
      "unknown SDK code",
      new ClerkTransportTestError(undefined, [
        { code: "unknown_error", message: "fetch failed" },
      ]),
    ],
    [
      "multiple SDK errors",
      new ClerkTransportTestError(undefined, [
        { code: "unexpected_error", message: "fetch failed" },
        { code: "unknown_error", message: "other failure" },
      ]),
    ],
    ["malformed SDK errors", new ClerkTransportTestError(undefined, null)],
    ["null status", new ClerkTransportTestError(null)],
    ["malformed status", new ClerkTransportTestError("503")],
    ["non-Clerk failure", new Error("fetch failed")],
    ["forbidden response", new ClerkTransportTestError(403)],
    ["rate limit", new ClerkTransportTestError(429)],
  ])(
    "does not turn %s into a retryable transport error",
    async (_name, failure) => {
      const actor = createBddApi(context).user();
      const { token } =
        await createAuthOrgAgentsBddApi(context).createCliToken(actor);
      const membershipRead =
        context.mocks.clerk.users.getOrganizationMembershipList;
      membershipRead.mockRejectedValue(failure);
      context.mocks.signalTimers.delay.mockResolvedValue(undefined);

      const response = await rawWebSearchRequest(null, defaultRequest(), {
        authHeaders: { authorization: `Bearer ${token}` },
      });

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toStrictEqual({
        error: "Internal server error",
      });
      expect(membershipRead).toHaveBeenCalledOnce();
      expect(context.mocks.sentry.captureException).toHaveBeenCalledWith(
        failure,
      );
    },
  );

  it("stops transport recovery when the API instance is cancelled", async () => {
    const actor = createBddApi(context).user();
    const { token } =
      await createAuthOrgAgentsBddApi(context).createCliToken(actor);
    const controller = new AbortController();
    const retryStarted = createDeferredPromise<void>(context.signal);
    const membershipRead =
      context.mocks.clerk.users.getOrganizationMembershipList;
    membershipRead.mockRejectedValue(new ClerkTransportTestError());
    context.mocks.signalTimers.delay.mockImplementation((_ms, options) => {
      const signal = options?.signal;
      if (!signal) {
        throw new Error("Expected the Clerk retry signal");
      }
      retryStarted.resolve();
      return createDeferredPromise<void>(signal).promise;
    });

    const pending = rawWebSearchRequest(null, defaultRequest(), {
      authHeaders: { authorization: `Bearer ${token}` },
      instanceSignal: controller.signal,
    });
    await retryStarted.promise;
    controller.abort(new DOMException("Search cancelled", "AbortError"));
    const response = await pending;

    expect(response.status).toBe(500);
    expect(membershipRead).toHaveBeenCalledOnce();
  });

  it("rejects agent tokens without web-search:read capability", async () => {
    const actor = createBddApi(context).user();
    if (!actor.orgId) {
      throw new Error("Web Search test actor must belong to an organization");
    }
    await bootstrapOnboarding(actor);
    const seconds = Math.floor(now() / 1000);
    const token = signSandboxJwtForTests({
      scope: "okou",
      userId: actor.userId,
      orgId: actor.orgId,
      runId: "run_web_search_missing_capability",
      capabilities: [],
      iat: seconds,
      exp: seconds + 60,
    });

    const response = await accept(
      client()(webSearchContract).search({
        headers: { authorization: `Bearer ${token}` },
        body: defaultRequest(),
      }),
      [403],
    );

    expectApiError(response.body);
    expect(response.body.error.message).toBe(
      "Missing required capability: web-search:read",
    );
  });

  it("accepts agent tokens and attributes usage to their run", async () => {
    const actor = createBddApi(context).user();
    const fixture = createPublicUsageWallet(context, actor, { credits: 1000 });
    await fixture.run(async () => {
      await fixture.initialize();
      if (!actor.orgId) {
        throw new Error("Web Search test actor must belong to an organization");
      }
      const bdd = createBddApi(context);
      const api = createRunsApi(context);
      bdd.acceptAgentStorageWrites();
      api.acceptStorageDownloads();
      api.acceptTelemetryIngest();
      const pricing = await setupConfiguredWebSearchPricing(
        fixture.registerCleanup,
      );
      configureProvider();
      api.configureRunnerGroup();
      await api.ensureOrgModelProvider(actor);
      const agent = await createBddApi(context).createAgent(actor, {
        displayName: "Tool usage agent",
        description: "Calls a paid tool from its run.",
        visibility: "private",
      });
      const run = await api.createThreadRun(actor, {
        agentId: agent.agentId,
        prompt: "Find current public information",
      });
      fixture.registerRun(run.runId);
      const token = api.okouTokenForRunWithCapabilities(actor, run.runId, [
        "web-search:read",
      ]);
      server.use(
        http.post(PERPLEXITY_SEARCH_URL, () => {
          return HttpResponse.json(providerResponse());
        }),
      );
      context.mocks.ably.publish.mockClear();

      const response = await accept(
        client(pricing.resolution)(webSearchContract).search({
          headers: { authorization: `Bearer ${token}` },
          body: defaultRequest(),
        }),
        [200],
      );
      context.mocks.clerk.users.getUserList.mockResolvedValue({
        data: [
          {
            id: actor.userId,
            primaryEmailAddressId: `email_${actor.userId}`,
            emailAddresses: [
              {
                id: `email_${actor.userId}`,
                emailAddress: `${actor.userId}@example.com`,
              },
            ],
          },
        ],
      });
      const usage = await accept(
        setupApp({ context, routes: usageRecordRoutes })(
          usageRecordContract,
        ).get({
          headers: authenticate(actor),
          query: {
            page: 1,
            pageSize: 20,
            scope: "mine",
            range: "24h",
            tz: "UTC",
          },
        }),
        [200],
      );

      expect(response.body.creditsCharged).toBe(5);
      expect(usage.body.rows).toStrictEqual([
        expect.objectContaining({
          title: null,
          threadId: run.threadId,
          credits: 5,
        }),
      ]);
      expect(context.mocks.ably.publish).not.toHaveBeenCalledWith(
        "billing:changed",
        null,
      );
    });
  });

  it("rejects invalid filters before calling Perplexity", async () => {
    const actor = createBddApi(context).user();
    let providerRequests = 0;
    configureProvider();
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, () => {
        providerRequests += 1;
        return HttpResponse.json(providerResponse());
      }),
    );

    const response = await rawWebSearchRequest(actor, {
      query: "latest AI regulation",
      limit: 11,
      domains: ["https://example.com"],
    });

    expect(response.status).toBe(400);
    expect(providerRequests).toBe(0);
  });

  it("rejects requests when the provider is not configured", async () => {
    const actor = createBddApi(context).user();
    mockEnv("OKOU_WEB_SEARCH_PERPLEXITY_TOKEN", undefined);

    const response = await accept(
      client()(webSearchContract).search({
        headers: authenticate(actor),
        body: defaultRequest(),
      }),
      [503],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("NOT_CONFIGURED");
  });

  it("returns missing pricing before calling Perplexity", async () => {
    const actor = createBddApi(context).user();
    let providerRequests = 0;
    configureProvider();
    await fundActorWithSubscription(actor);
    const pricing = await setupMissingWebSearchPricing();
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, () => {
        providerRequests += 1;
        return HttpResponse.json(providerResponse());
      }),
    );

    const response = await accept(
      client(pricing.resolution)(webSearchContract).search({
        headers: authenticate(actor),
        body: defaultRequest(),
      }),
      [503],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("PRICING_NOT_CONFIGURED");
    expect(providerRequests).toBe(0);
  });

  it("returns insufficient credits before calling Perplexity", async () => {
    const actor = createBddApi(context).user();
    const fixture = createPublicUsageWallet(context, actor, { credits: 0 });
    await fixture.run(async () => {
      await fixture.initialize();
      let providerRequests = 0;
      configureProvider();
      const pricing = await setupConfiguredWebSearchPricing(
        fixture.registerCleanup,
      );
      server.use(
        http.post(PERPLEXITY_SEARCH_URL, () => {
          providerRequests += 1;
          return HttpResponse.json(providerResponse());
        }),
      );

      const response = await accept(
        client(pricing.resolution)(webSearchContract).search({
          headers: authenticate(actor),
          body: defaultRequest(),
        }),
        [402],
      );

      expectApiError(response.body);
      expect(response.body.error.code).toBe("INSUFFICIENT_CREDITS");
      expect(providerRequests).toBe(0);
    });
  });

  it("uses allowance for runless searches under shared debt", async () => {
    const actor = createBddApi(context).user();
    const fixture = createPublicUsageWallet(context, actor, { credits: -10 });
    await fixture.run(async () => {
      await fixture.initialize();
      if (!actor.orgId) {
        throw new Error("Web Search test actor must belong to an organization");
      }
      let providerRequests = 0;
      configureProvider();
      const pricing = await setupConfiguredWebSearchPricing(
        fixture.registerCleanup,
      );
      const effectiveAt = nowDate();
      await postUsageAllowanceInvoicePaid(context.signal, {
        orgId: actor.orgId,
        userId: actor.userId,
        customerId: fixture.customerId,
        subscriptionId: `sub_web_search_allowance_${randomUUID()}`,
        effectiveAt,
        expiresAt: new Date(effectiveAt.getTime() + 365 * 24 * 60 * 60 * 1000),
        shortWindowSeconds: 5 * 60 * 60,
        shortWindowUnits: 10,
        weeklyWindowSeconds: 7 * 24 * 60 * 60,
        weeklyWindowUnits: 10,
      });
      server.use(
        http.post(PERPLEXITY_SEARCH_URL, () => {
          providerRequests += 1;
          return HttpResponse.json(providerResponse());
        }),
      );

      const response = await accept(
        client(pricing.resolution)(webSearchContract).search({
          headers: authenticate(actor),
          body: defaultRequest(),
        }),
        [200],
      );
      const status = await accept(
        client()(billingStatusContract).get({
          headers: authenticate(actor),
        }),
        [200],
      );

      expect(response.body.creditsCharged).toBe(0);
      expect(providerRequests).toBe(1);
      expect(status.body.credits).toBe(-10);
      expect(
        Object.fromEntries(
          status.body.usageAllowance?.windows.map((window) => {
            return [window.kind, window.consumedUnits];
          }) ?? [],
        ),
      ).toStrictEqual({ short: 5, weekly: 5 });
    });
  });

  it("rejects runless searches when allowance cannot cover the exact price under shared debt", async () => {
    const actor = createBddApi(context).user();
    const fixture = createPublicUsageWallet(context, actor, { credits: -10 });
    await fixture.run(async () => {
      await fixture.initialize();
      if (!actor.orgId) {
        throw new Error("Web Search test actor must belong to an organization");
      }
      let providerRequests = 0;
      configureProvider();
      const pricing = await setupConfiguredWebSearchPricing(
        fixture.registerCleanup,
      );
      const effectiveAt = nowDate();
      await postUsageAllowanceInvoicePaid(context.signal, {
        orgId: actor.orgId,
        userId: actor.userId,
        customerId: fixture.customerId,
        subscriptionId: `sub_web_search_partial_allowance_${randomUUID()}`,
        effectiveAt,
        expiresAt: new Date(effectiveAt.getTime() + 365 * 24 * 60 * 60 * 1000),
        shortWindowSeconds: 5 * 60 * 60,
        shortWindowUnits: 4,
        weeklyWindowSeconds: 7 * 24 * 60 * 60,
        weeklyWindowUnits: 4,
      });
      server.use(
        http.post(PERPLEXITY_SEARCH_URL, () => {
          providerRequests += 1;
          return HttpResponse.json(providerResponse());
        }),
      );

      const response = await accept(
        client(pricing.resolution)(webSearchContract).search({
          headers: authenticate(actor),
          body: defaultRequest(),
        }),
        [402],
      );

      expectApiError(response.body);
      expect(response.body.error.code).toBe("INSUFFICIENT_CREDITS");
      expect(providerRequests).toBe(0);
    });
  });

  it("translates filtered searches and records successful usage", async () => {
    const actor = createBddApi(context).user();
    let requestBody: unknown;
    let authorization: string | null = null;
    configureProvider();
    const pricing = await setupConfiguredWebSearchPricing();
    await fundActorWithSubscription(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, async ({ request }) => {
        requestBody = await request.json();
        authorization = request.headers.get("authorization");
        return HttpResponse.json(providerResponse());
      }),
    );

    const response = await accept(
      client(pricing.resolution)(webSearchContract).search({
        headers: authenticate(actor),
        body: defaultRequest({
          limit: 3,
          recency: "week",
          domains: ["example.com", "docs.example.com"],
        }),
      }),
      [200],
    );
    const afterCredits = await credits(actor);

    expect(requestBody).toStrictEqual({
      query: "latest AI regulation",
      max_results: 3,
      max_tokens: 6000,
      max_tokens_per_page: 1200,
      search_recency_filter: "week",
      search_domain_filter: ["example.com", "docs.example.com"],
    });
    expect(authorization).toBe("Bearer test-perplexity-token");
    expect(response.body).toStrictEqual({
      query: "latest AI regulation",
      limit: 3,
      recency: "week",
      domains: ["example.com", "docs.example.com"],
      provider: "perplexity",
      billingCategory: "request",
      billingQuantity: 1,
      creditsCharged: 5,
      results: [
        {
          rank: 1,
          title: "AI regulation update",
          url: "https://example.com/update",
          snippet: "A relevant public-web excerpt.",
          publishedDate: "2026-07-13",
          lastUpdatedDate: "2026-07-14",
        },
      ],
    });
    expect(beforeCredits - afterCredits).toBe(5);
  });

  it("bills valid empty results", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredWebSearchPricing();
    await fundActorWithSubscription(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, () => {
        return HttpResponse.json({ id: "empty", results: [] });
      }),
    );

    const response = await accept(
      client(pricing.resolution)(webSearchContract).search({
        headers: authenticate(actor),
        body: defaultRequest(),
      }),
      [200],
    );
    const afterCredits = await credits(actor);

    expect(response.body.results).toStrictEqual([]);
    expect(response.body.creditsCharged).toBe(5);
    expect(beforeCredits - afterCredits).toBe(5);
  });

  it("truncates valid text under field and total output bounds", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredWebSearchPricing();
    await fundActorWithSubscription(actor);
    const longTitle = `${"t".repeat(WEB_SEARCH_MAX_TITLE_CHARS - 1)}😀`;
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, () => {
        return HttpResponse.json({
          results: Array.from({ length: 5 }, (_, index) => {
            return {
              title: index === 0 ? longTitle : `Result ${index + 1}`,
              url: `https://example.com/${index}`,
              snippet: "s".repeat(WEB_SEARCH_MAX_SNIPPET_CHARS + 100),
            };
          }),
        });
      }),
    );

    const response = await accept(
      client(pricing.resolution)(webSearchContract).search({
        headers: authenticate(actor),
        body: defaultRequest(),
      }),
      [200],
    );

    expect(response.body.results[0]?.title).toHaveLength(
      WEB_SEARCH_MAX_TITLE_CHARS - 1,
    );
    expect(
      response.body.results.slice(0, 4).every((result) => {
        return result.snippet.length === WEB_SEARCH_MAX_SNIPPET_CHARS;
      }),
    ).toBeTruthy();
    expect(response.body.results[4]?.snippet).toBe("");
    expect(
      response.body.results.reduce((total, result) => {
        return total + result.snippet.length;
      }, 0),
    ).toBe(32_000);
  });

  it("neutralizes provider control characters in returned text", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredWebSearchPricing();
    await fundActorWithSubscription(actor);
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, () => {
        return HttpResponse.json({
          results: [
            {
              title: "Result\u001b]52;c;clipboard\u0007 title",
              url: "https://example.com/result",
              snippet: "first line\rsecond line\u009b31m",
              date: "2026-07-14\nforged",
            },
          ],
        });
      }),
    );

    const response = await accept(
      client(pricing.resolution)(webSearchContract).search({
        headers: authenticate(actor),
        body: defaultRequest(),
      }),
      [200],
    );

    expect(response.body.results).toStrictEqual([
      {
        rank: 1,
        title: "Result ]52;c;clipboard  title",
        url: "https://example.com/result",
        snippet: "first line second line 31m",
        publishedDate: "2026-07-14 forged",
      },
    ]);
  });

  it.each([
    ["invalid JSON", "not-json", "PERPLEXITY_INVALID_RESPONSE"],
    [
      "missing results",
      JSON.stringify({ id: "missing" }),
      "PERPLEXITY_INVALID_RESPONSE",
    ],
    [
      "invalid URL",
      JSON.stringify({
        results: [{ title: "Bad", url: "file:///secret", snippet: "bad" }],
      }),
      "PERPLEXITY_INVALID_RESPONSE",
    ],
    [
      "URL containing a control character",
      JSON.stringify({
        results: [
          {
            title: "Bad",
            url: "https://exam\nple.com",
            snippet: "bad",
          },
        ],
      }),
      "PERPLEXITY_INVALID_RESPONSE",
    ],
    [
      "URL exceeding the bound after normalization",
      JSON.stringify({
        results: [
          {
            title: "Bad",
            url: `https://example.com/${"界".repeat(700)}`,
            snippet: "bad",
          },
        ],
      }),
      "PERPLEXITY_INVALID_RESPONSE",
    ],
  ])("rejects %s without recording usage", async (_name, body, code) => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredWebSearchPricing();
    await fundActorWithSubscription(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, () => {
        return HttpResponse.text(body);
      }),
    );

    const response = await accept(
      client(pricing.resolution)(webSearchContract).search({
        headers: authenticate(actor),
        body: defaultRequest(),
      }),
      [502],
    );
    const afterCredits = await credits(actor);

    expectApiError(response.body);
    expect(response.body.error.code).toBe(code);
    expect(afterCredits).toBe(beforeCredits);
  });

  it("maps and bounds provider errors without recording usage", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredWebSearchPricing();
    await fundActorWithSubscription(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, () => {
        return HttpResponse.json(
          { message: `\u001b]52;c;clipboard\u0007${"x".repeat(5000)}` },
          { status: 500 },
        );
      }),
    );

    const response = await accept(
      client(pricing.resolution)(webSearchContract).search({
        headers: authenticate(actor),
        body: defaultRequest(),
      }),
      [502],
    );
    const afterCredits = await credits(actor);

    expectApiError(response.body);
    expect(response.body.error.code).toBe("PERPLEXITY_ERROR");
    expect(response.body.error.message).toHaveLength(4096);
    expect(response.body.error.message.endsWith("...")).toBeTruthy();
    expect(response.body.error.message).not.toContain("\u001b");
    expect(response.body.error.message).not.toContain("\u0007");
    expect(afterCredits).toBe(beforeCredits);
  });

  it("maps provider rate limiting without recording usage", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredWebSearchPricing();
    await fundActorWithSubscription(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, () => {
        return HttpResponse.json({ message: "slow down" }, { status: 429 });
      }),
    );

    const response = await accept(
      client(pricing.resolution)(webSearchContract).search({
        headers: authenticate(actor),
        body: defaultRequest(),
      }),
      [502],
    );
    const afterCredits = await credits(actor);

    expectApiError(response.body);
    expect(response.body.error.code).toBe("PERPLEXITY_RATE_LIMITED");
    expect(afterCredits).toBe(beforeCredits);
  });

  it("maps provider transport timeouts without recording usage", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredWebSearchPricing();
    await fundActorWithSubscription(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new DOMException("timed out", "TimeoutError"));
          },
        });
        return new HttpResponse(stream);
      }),
    );

    const response = await accept(
      client(pricing.resolution)(webSearchContract).search({
        headers: authenticate(actor),
        body: defaultRequest(),
      }),
      [502],
    );
    const afterCredits = await credits(actor);

    expectApiError(response.body);
    expect(response.body.error.code).toBe("WEB_SEARCH_TIMEOUT");
    expect(afterCredits).toBe(beforeCredits);
  });

  it("rejects an empty successful provider body without recording usage", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredWebSearchPricing();
    await fundActorWithSubscription(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, () => {
        return new HttpResponse(null, { status: 200 });
      }),
    );

    const response = await accept(
      client(pricing.resolution)(webSearchContract).search({
        headers: authenticate(actor),
        body: defaultRequest(),
      }),
      [502],
    );
    const afterCredits = await credits(actor);

    expectApiError(response.body);
    expect(response.body.error.code).toBe("PERPLEXITY_INVALID_RESPONSE");
    expect(afterCredits).toBe(beforeCredits);
  });

  it("rejects declared oversized responses before reading or billing", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredWebSearchPricing();
    await fundActorWithSubscription(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, () => {
        return HttpResponse.text(JSON.stringify(providerResponse()), {
          headers: {
            "content-length": String(MAX_PROVIDER_RESPONSE_BYTES + 1),
          },
        });
      }),
    );

    const response = await accept(
      client(pricing.resolution)(webSearchContract).search({
        headers: authenticate(actor),
        body: defaultRequest(),
      }),
      [502],
    );
    const afterCredits = await credits(actor);

    expectApiError(response.body);
    expect(response.body.error.code).toBe("WEB_SEARCH_OUTPUT_TOO_LARGE");
    expect(afterCredits).toBe(beforeCredits);
  });

  it("rejects streamed oversized responses with dishonest lengths", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredWebSearchPricing();
    await fundActorWithSubscription(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                "x".repeat(MAX_PROVIDER_RESPONSE_BYTES + 1),
              ),
            );
          },
        });
        return new HttpResponse(stream, {
          headers: { "content-length": "1" },
        });
      }),
    );

    const response = await accept(
      client(pricing.resolution)(webSearchContract).search({
        headers: authenticate(actor),
        body: defaultRequest(),
      }),
      [502],
    );
    const afterCredits = await credits(actor);

    expectApiError(response.body);
    expect(response.body.error.code).toBe("WEB_SEARCH_OUTPUT_TOO_LARGE");
    expect(afterCredits).toBe(beforeCredits);
  });

  it("accepts a streamed response without a declared length and bills it", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredWebSearchPricing();
    await fundActorWithSubscription(actor);
    const beforeCredits = await credits(actor);
    const payload = JSON.stringify(providerResponse());
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(payload));
            controller.close();
          },
        });
        return new HttpResponse(stream);
      }),
    );

    const response = await accept(
      client(pricing.resolution)(webSearchContract).search({
        headers: authenticate(actor),
        body: defaultRequest(),
      }),
      [200],
    );
    const afterCredits = await credits(actor);

    expect(response.body.results).toHaveLength(1);
    expect(beforeCredits - afterCredits).toBe(5);
  });

  it("accepts an exact-size streamed response and bills it", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredWebSearchPricing();
    await fundActorWithSubscription(actor);
    const beforeCredits = await credits(actor);
    const json = JSON.stringify({ results: [] });
    const payload = `${json}${" ".repeat(MAX_PROVIDER_RESPONSE_BYTES - json.length)}`;
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, () => {
        const midpoint = Math.floor(payload.length / 2);
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode(payload.slice(0, midpoint)));
            controller.enqueue(encoder.encode(payload.slice(midpoint)));
            controller.close();
          },
        });
        return new HttpResponse(stream, {
          headers: {
            "content-length": String(MAX_PROVIDER_RESPONSE_BYTES),
          },
        });
      }),
    );

    const response = await accept(
      client(pricing.resolution)(webSearchContract).search({
        headers: authenticate(actor),
        body: defaultRequest(),
      }),
      [200],
    );
    const afterCredits = await credits(actor);

    expect(response.body.results).toStrictEqual([]);
    expect(beforeCredits - afterCredits).toBe(5);
  });

  it("does not record usage when the client aborts during provider work", async () => {
    const actor = createBddApi(context).user();
    const controller = new AbortController();
    const abortError = new Error("client disconnected during provider work");
    abortError.name = "AbortError";
    const providerStarted = createDeferredPromise<void>(context.signal);
    const providerRelease = createDeferredPromise<void>(context.signal);
    let providerSignalAborted = false;
    configureProvider();
    const pricing = await setupConfiguredWebSearchPricing();
    await fundActorWithSubscription(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, async ({ request }) => {
        providerStarted.resolve(undefined);
        controller.abort(abortError);
        providerSignalAborted = request.signal.aborted;
        await providerRelease.promise;
        return HttpResponse.json(providerResponse());
      }),
    );

    const responsePromise = rawWebSearchRequest(actor, defaultRequest(), {
      requestSignal: controller.signal,
      usagePricingResolution: pricing.resolution,
    });
    await providerStarted.promise;
    providerRelease.resolve(undefined);
    const response = await responsePromise;
    const afterCredits = await credits(actor);

    expect(response.status).toBe(500);
    expect(providerSignalAborted).toBeTruthy();
    expect(afterCredits).toBe(beforeCredits);
  });

  it("records usage when the client disconnects after provider success", async () => {
    const actor = createBddApi(context).user();
    const controller = new AbortController();
    const abortError = new Error("client disconnected after provider success");
    abortError.name = "AbortError";
    configureProvider();
    const pricing = await setupConfiguredWebSearchPricing();
    await fundActorWithSubscription(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, () => {
        const payload = new TextEncoder().encode(
          JSON.stringify(providerResponse()),
        );
        let payloadSent = false;
        const stream = new ReadableStream<Uint8Array>({
          pull(streamController) {
            if (!payloadSent) {
              payloadSent = true;
              streamController.enqueue(payload);
              return;
            }
            streamController.close();
            setImmediate(() => {
              controller.abort(abortError);
            });
          },
        });
        return new HttpResponse(stream);
      }),
    );

    const response = await rawWebSearchRequest(actor, defaultRequest(), {
      requestSignal: controller.signal,
      usagePricingResolution: pricing.resolution,
    });
    const afterCredits = await credits(actor);

    expect(response.status).toBe(200);
    expect(controller.signal.aborted).toBeTruthy();
    expect(beforeCredits - afterCredits).toBe(5);
  });

  it("records both concurrent successful searches", async () => {
    const actor = createBddApi(context).user();
    let providerRequests = 0;
    configureProvider();
    const pricing = await setupConfiguredWebSearchPricing();
    await fundActorWithSubscription(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, () => {
        providerRequests += 1;
        return HttpResponse.json(providerResponse());
      }),
    );
    const searchClient = client(pricing.resolution);

    const [first, second] = await Promise.all([
      accept(
        searchClient(webSearchContract).search({
          headers: authenticate(actor),
          body: defaultRequest({ query: "first query" }),
        }),
        [200],
      ),
      accept(
        searchClient(webSearchContract).search({
          headers: authenticate(actor),
          body: defaultRequest({ query: "second query" }),
        }),
        [200],
      ),
    ]);
    const afterCredits = await credits(actor);

    expect(first.body.creditsCharged).toBe(5);
    expect(second.body.creditsCharged).toBe(5);
    expect(providerRequests).toBe(2);
    expect(beforeCredits - afterCredits).toBe(10);
  });

  it("returns provider results when usage processing fails", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredWebSearchPricing();
    await fundActorWithSubscription(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.post(PERPLEXITY_SEARCH_URL, async () => {
        await pricing.cleanup();
        return HttpResponse.json(providerResponse());
      }),
    );

    const response = await rawWebSearchRequest(actor, defaultRequest(), {
      usagePricingResolution: pricing.resolution,
    });
    const afterCredits = await credits(actor);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      creditsCharged: null,
      results: [expect.objectContaining({ url: "https://example.com/update" })],
    });
    expect(afterCredits).toBe(beforeCredits);
  });
});
