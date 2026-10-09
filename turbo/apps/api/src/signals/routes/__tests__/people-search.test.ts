import { randomUUID } from "node:crypto";

import {
  peopleSearchContract,
  type PeopleSearchRequest,
} from "@okouai/api-contracts/contracts/people-search";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { HttpResponse, http, type JsonBodyType } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { env, mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import {
  createUsagePricingFixture,
  type UsagePricingFixture,
  type UsagePricingKey,
  type UsagePricingRow,
} from "../../../test-fixtures/system-config-seeds";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { now } from "../../../lib/time";
import { settleIncludingAbort } from "../../utils";
import { flushWaitUntilForTest } from "../../context/wait-until";
import type { RouteEntry } from "../../route-entry";
import { billingStatusRoutes } from "../billing-status";
import { peopleSearchRoutes } from "../people-search";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createFixtureOperationOwner } from "./helpers/fixture-operation-owner";
import { createPublicUnfundedProFixture } from "./helpers/public-unfunded-pro-fixture";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const PERPLEXITY_AGENT_URL = "https://api.perplexity.ai/v1/agent";
const MAX_PROVIDER_RESPONSE_BYTES = 512 * 1024;

const peopleSearchTestRoutes: readonly RouteEntry[] = [
  ...billingStatusRoutes,
  ...peopleSearchRoutes,
];

interface AuthHeaders {
  readonly authorization?: string;
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
    routes: peopleSearchTestRoutes,
    usagePricingResolution,
  });
}

async function bootstrapOnboarding(actor: ApiTestUser): Promise<void> {
  const completed = await createBddApi(context).completeOnboarding(actor);
  expect(completed.status).toBe(200);
}

interface FundedPeopleSearchActor {
  readonly actor: ApiTestUser;
  readonly orgId: string;
  readonly customerId: string;
  readonly subscriptionId: string;
  readonly invoiceId: string;
  readonly storageBucket: string;
  readonly kmsKeyId: string | undefined;
}

async function cleanupFundedPeopleSearchActor(
  owned: FundedPeopleSearchActor,
  beforeOrganizationCleanup?: () => Promise<void>,
): Promise<void> {
  mockEnv("R2_USER_STORAGES_BUCKET_NAME", owned.storageBucket);
  mockEnv("SECRETS_KMS_KEY_ID", owned.kmsKeyId);
  context.mocks.s3.send.mockResolvedValue({
    Contents: [],
    IsTruncated: false,
  });
  context.mocks.ably.publish.mockResolvedValue(undefined);
  await flushWaitUntilForTest();

  const beforeCleanup = await settleIncludingAbort(
    beforeOrganizationCleanup?.() ?? Promise.resolve(),
  );
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
    items: { data: [{ price: { id: "price_bdd_pro" } }] },
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
  // immutable billing receipts under this fixture's unique IDs.
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
  if (!beforeCleanup.ok) {
    throw beforeCleanup.error;
  }
}

async function fundActorWithSubscription(
  actor: ApiTestUser,
  {
    deleteCliUser = false,
    beforeOrganizationCleanup,
  }: {
    readonly deleteCliUser?: boolean;
    readonly beforeOrganizationCleanup?: () => Promise<void>;
  } = {},
) {
  if (!actor.orgId) {
    throw new Error("People Search test actor must belong to an organization");
  }
  const suffix = randomUUID();
  const owned = {
    actor,
    orgId: actor.orgId,
    customerId: `cus_people_search_${suffix}`,
    subscriptionId: `sub_people_search_${suffix}`,
    invoiceId: `in_people_search_${suffix}`,
    storageBucket: env("R2_USER_STORAGES_BUCKET_NAME"),
    kmsKeyId: env("SECRETS_KMS_KEY_ID"),
  };
  const cleanups: (() => Promise<void>)[] = [];
  let cliToken: string | undefined;
  const owner = createFixtureOperationOwner(async () => {
    const cleanupResult = await settleIncludingAbort(
      cleanupFundedPeopleSearchActor(owned, beforeOrganizationCleanup),
    );

    if (deleteCliUser) {
      // This unique user owns every bound token, including a lost issue response.
      const webhooks = createWebhookCallbackApi(context);
      webhooks.configureClerkWebhookSecret();
      webhooks.verifyNextClerkWebhook({
        type: "user.deleted",
        data: { id: actor.userId },
      });
      await webhooks.requestClerkWebhook("{}", {}, [200]);
      await flushWaitUntilForTest();
      if (cliToken) {
        // Keep positive Clerk membership: only actual bearer revocation yields 401.
        context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue(
          {
            data: [
              {
                id: `membership_${actor.userId}`,
                role: "org:admin",
                organization: {
                  id: owned.orgId,
                  slug: owned.orgId,
                  name: "People Search fixture",
                },
                publicUserData: { userId: actor.userId },
              },
            ],
          },
        );
        authenticate(actor);
        await accept(
          client()(peopleSearchContract).search({
            headers: { authorization: `Bearer ${cliToken}` },
            body: defaultRequest(),
          }),
          [401],
        );
        await flushWaitUntilForTest();
      }
      // Unapproved anonymous challenges retain their public 900-second expiry.
    }

    for (const cleanup of cleanups) {
      await cleanup();
    }
    if (!cleanupResult.ok) {
      throw cleanupResult.error;
    }
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
        id: `evt_people_search_created_${suffix}`,
        type: "customer.subscription.created",
        created: Math.floor(now() / 1000),
        data: { object: subscription },
      },
      [200],
    );
    await webhooks.postStripeEvent(
      {
        id: `evt_people_search_updated_${suffix}`,
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
        id: `evt_people_search_paid_${suffix}`,
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
  return {
    ...owner,
    registerCleanup(cleanup: () => Promise<void>) {
      cleanups.push(cleanup);
    },
    registerCliToken(token: string) {
      cliToken = token;
    },
  };
}

function peopleSearchPricingKey(): UsagePricingKey {
  return {
    kind: "people-search",
    provider: "perplexity",
    category: "request",
  };
}

function peopleSearchPricing(): UsagePricingRow {
  return {
    ...peopleSearchPricingKey(),
    unitPrice: 20,
    unitSize: 1,
  };
}

async function createPricingFixture(
  configured: readonly UsagePricingRow[],
  missing: readonly UsagePricingKey[] = [],
  registerCleanup?: (cleanup: () => Promise<void>) => void,
): Promise<UsagePricingFixture> {
  if (!registerCleanup) {
    const fixture = await createUsagePricingFixture({ configured, missing });
    onTestFinished(fixture.cleanup);
    return fixture;
  }
  return await createUsagePricingFixture({
    configured,
    missing,
    registerCleanup,
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
  mockEnv("OKOU_WEB_SEARCH_PERPLEXITY_TOKEN", "test-people-search-token");
}

function defaultRequest(
  overrides: Partial<PeopleSearchRequest> = {},
): PeopleSearchRequest {
  return {
    query: "platform engineering leaders at Notion",
    limit: 5,
    ...overrides,
  };
}

function providerResult(
  overrides: Partial<{
    readonly id: number;
    readonly url: string;
    readonly title: string;
  }> = {},
) {
  return {
    id: 1,
    url: "https://example.com/profile",
    title: "Example professional profile",
    snippet: "Public professional context.",
    source: "web",
    ...overrides,
  };
}

function structuredProfile(
  overrides: Partial<{
    readonly name: string;
    readonly title: string | null;
    readonly company: string | null;
    readonly location: string | null;
    readonly summary: string | null;
    readonly sourceIds: readonly number[];
  }> = {},
) {
  return {
    name: "Jordan Lee",
    title: "VP of Platform",
    company: "Example",
    location: "San Francisco",
    summary: "Leads public platform engineering work.",
    sourceIds: [1],
    ...overrides,
  };
}

function providerResponse(args?: {
  readonly profiles?: readonly ReturnType<typeof structuredProfile>[];
  readonly results?: readonly ReturnType<typeof providerResult>[];
  readonly invocation?: number;
  readonly extraOutput?: readonly unknown[];
}) {
  return {
    id: "agent-response-id",
    status: "completed",
    output: [
      ...(args?.extraOutput ?? []),
      {
        type: "people_search_results",
        queries: ["platform engineering leaders at Notion"],
        results: args?.results ?? [providerResult()],
      },
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: JSON.stringify({
              profiles: args?.profiles ?? [structuredProfile()],
            }),
          },
        ],
      },
    ],
    usage: {
      tool_calls_details: {
        search_people: { invocation: args?.invocation ?? 1 },
      },
    },
  };
}

async function successfulRequest(
  actor: ApiTestUser,
  pricing: UsagePricingFixture,
  body: PeopleSearchRequest = defaultRequest(),
) {
  return await accept(
    client(pricing.resolution)(peopleSearchContract).search({
      headers: authenticate(actor),
      body,
    }),
    [200],
  );
}

describe("okou people-search route", () => {
  it("rejects agent tokens without people-search capability", async () => {
    const actor = createBddApi(context).user();
    if (!actor.orgId) {
      throw new Error("People Search test actor must have an organization");
    }
    await bootstrapOnboarding(actor);
    const seconds = Math.floor(now() / 1000);
    const token = signSandboxJwtForTests({
      scope: "okou",
      userId: actor.userId,
      orgId: actor.orgId,
      runId: "run_missing_people_search_capability",
      capabilities: [],
      iat: seconds,
      exp: seconds + 60,
    });

    const response = await accept(
      client()(peopleSearchContract).search({
        headers: { authorization: `Bearer ${token}` },
        body: defaultRequest(),
      }),
      [403],
    );

    expectApiError(response.body);
    expect(response.body.error.message).toBe(
      "Missing required capability: people-search:read",
    );
  });

  it("sends one bounded tool request and returns provider-backed profiles", async () => {
    const actor = createBddApi(context).user();
    let requestBody: unknown;
    let authorization: string | null = null;
    configureProvider();
    const pricing = await createPricingFixture([peopleSearchPricing()]);
    const owner = await fundActorWithSubscription(actor);
    await owner.run(async () => {
      const beforeCredits = await credits(actor);
      server.use(
        http.post(PERPLEXITY_AGENT_URL, async ({ request }) => {
          requestBody = await request.json();
          authorization = request.headers.get("authorization");
          return HttpResponse.json(
            providerResponse({
              profiles: [
                structuredProfile({
                  name: "Jordan\u001b Lee",
                  summary: "Leads platform work.\nPublic data.",
                  sourceIds: [1, 3],
                }),
                structuredProfile({
                  name: "Jordan\u001b Lee",
                  summary: "Alternate extraction from the same source.",
                  sourceIds: [3, 1],
                }),
              ],
              results: [
                providerResult({
                  title: "Example\u0007 leadership",
                }),
                providerResult({
                  id: 2,
                  url: "file:///unreferenced",
                }),
                providerResult({
                  id: 3,
                  title: "Duplicate provider result",
                }),
              ],
              extraOutput: [
                { type: "future_provider_item", detail: "ignored" },
              ],
            }),
          );
        }),
      );

      const response = await successfulRequest(
        actor,
        pricing,
        defaultRequest({ limit: 3 }),
      );
      const afterCredits = await credits(actor);

      expect(requestBody).toMatchObject({
        model: "openai/gpt-5-mini",
        reasoning: { effort: "low" },
        tools: [
          {
            type: "people_search",
          },
        ],
        max_steps: 2,
        max_output_tokens: 4000,
        store: false,
        input: "platform engineering leaders at Notion",
        instructions: expect.stringContaining(
          "do not return email addresses, phone numbers, home addresses, or other personal contact details",
        ),
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "PeopleSearchProfiles",
            schema: {
              properties: {
                profiles: {
                  maxItems: 20,
                  items: {
                    properties: {
                      sourceIds: {
                        type: "array",
                        minItems: 1,
                        maxItems: 5,
                        items: { type: "integer", minimum: 1 },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });
      expect(requestBody).toHaveProperty(
        "instructions",
        expect.stringContaining(
          "Use only distinct positive integer result IDs from people_search_results in sourceIds.",
        ),
      );
      expect(requestBody).not.toHaveProperty(
        "response_format.json_schema.schema.properties.profiles.items.properties.sourceIds.uniqueItems",
      );
      expect(authorization).toBe("Bearer test-people-search-token");
      expect(response.body).toStrictEqual({
        query: "platform engineering leaders at Notion",
        limit: 3,
        provider: "perplexity",
        billingCategory: "request",
        billingQuantity: 1,
        creditsCharged: 20,
        profiles: [
          {
            name: "Jordan  Lee",
            title: "VP of Platform",
            company: "Example",
            location: "San Francisco",
            summary: "Leads platform work. Public data.",
            sources: [
              {
                title: "Example  leadership",
                url: "https://example.com/profile",
              },
            ],
          },
        ],
      });
      expect(beforeCredits - afterCredits).toBe(20);
    });
  });

  it("accepts a CLI token", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await createPricingFixture([peopleSearchPricing()]);
    const owner = await fundActorWithSubscription(actor, {
      deleteCliUser: true,
    });
    await owner.run(async () => {
      const { token } = await createRunsApi(context).createCliToken(actor);
      owner.registerCliToken(token);
      server.use(
        http.post(PERPLEXITY_AGENT_URL, () => {
          return HttpResponse.json(providerResponse());
        }),
      );

      const response = await accept(
        client(pricing.resolution)(peopleSearchContract).search({
          headers: { authorization: `Bearer ${token}` },
          body: defaultRequest(),
        }),
        [200],
      );

      expect(response.body.profiles[0]?.name).toBe("Jordan Lee");
      expect(response.body.creditsCharged).toBe(20);
    });
  });

  it("deduplicates by validated source identity before enforcing the response budget", async () => {
    const actor = createBddApi(context).user();
    const sourceIds = [1, 2, 3, 4, 5];
    const profiles = Array.from({ length: 7 }, (_, index) => {
      return structuredProfile({
        name: "n".repeat(256),
        title: index === 0 ? "t".repeat(512) : `alternate ${String(index)}`,
        company: "c".repeat(256),
        location: "l".repeat(256),
        summary: "s".repeat(1000),
        sourceIds,
      });
    });
    const results = sourceIds.map((id) => {
      return providerResult({
        id,
        title: "r".repeat(512),
        url: `https://example.com/${"u".repeat(900)}?id=${String(id)}`,
      });
    });
    configureProvider();
    const pricing = await createPricingFixture([peopleSearchPricing()]);
    const owner = await fundActorWithSubscription(actor);
    await owner.run(async () => {
      server.use(
        http.post(PERPLEXITY_AGENT_URL, () => {
          return HttpResponse.json(providerResponse({ profiles, results }));
        }),
      );

      const response = await successfulRequest(
        actor,
        pricing,
        defaultRequest({ limit: 7 }),
      );

      expect(response.body.profiles).toHaveLength(1);
      expect(response.body.profiles[0]?.title).toBe("t".repeat(512));
      expect(response.body.profiles[0]?.sources).toHaveLength(5);
    });
  });

  it("returns twenty profiles at the supported maximum", async () => {
    const actor = createBddApi(context).user();
    const profiles = Array.from({ length: 20 }, (_, index) => {
      return structuredProfile({
        name: `Professional ${String(index + 1)}`,
        summary: `Public professional profile ${String(index + 1)}.`,
      });
    });
    configureProvider();
    const pricing = await createPricingFixture([peopleSearchPricing()]);
    const owner = await fundActorWithSubscription(actor);
    await owner.run(async () => {
      server.use(
        http.post(PERPLEXITY_AGENT_URL, () => {
          return HttpResponse.json(providerResponse({ profiles }));
        }),
      );

      const response = await successfulRequest(
        actor,
        pricing,
        defaultRequest({ limit: 20 }),
      );

      expect(response.body.profiles).toHaveLength(20);
      expect(response.body.profiles.at(0)?.name).toBe("Professional 1");
      expect(response.body.profiles.at(-1)?.name).toBe("Professional 20");
    });
  });

  it("bills a valid search with no matching profiles", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await createPricingFixture([peopleSearchPricing()]);
    const owner = await fundActorWithSubscription(actor);
    await owner.run(async () => {
      const beforeCredits = await credits(actor);
      server.use(
        http.post(PERPLEXITY_AGENT_URL, () => {
          return HttpResponse.json(providerResponse({ profiles: [] }));
        }),
      );

      const response = await successfulRequest(actor, pricing);
      const afterCredits = await credits(actor);

      expect(response.body.profiles).toStrictEqual([]);
      expect(response.body.creditsCharged).toBe(20);
      expect(beforeCredits - afterCredits).toBe(20);
    });
  });

  it("rejects invalid provider/model output without billing", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await createPricingFixture([peopleSearchPricing()]);
    const owner = await fundActorWithSubscription(actor);
    await owner.run(async () => {
      const valid = providerResponse();
      const invalidBodies: readonly JsonBodyType[] = [
        { ...valid, status: "incomplete" },
        { ...valid, output: valid.output.slice(1) },
        {
          ...valid,
          output: [...valid.output, valid.output[0]],
        },
        {
          ...valid,
          output: [
            valid.output[0],
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "not-json" }],
            },
          ],
        },
        providerResponse({
          profiles: [structuredProfile({ sourceIds: [999] })],
        }),
        providerResponse({
          profiles: [structuredProfile({ sourceIds: [1, 1] })],
        }),
        providerResponse({
          results: [providerResult(), providerResult()],
        }),
        providerResponse({
          results: [providerResult({ url: "javascript:alert(1)" })],
        }),
        providerResponse({
          results: [
            providerResult({ url: "https://user:secret@example.com/profile" }),
          ],
        }),
        providerResponse({ invocation: 2 }),
        providerResponse({
          profiles: [
            structuredProfile({ name: "One" }),
            structuredProfile({ name: "Two" }),
          ],
        }),
      ];

      for (const body of invalidBodies) {
        const beforeCredits = await credits(actor);
        server.use(
          http.post(PERPLEXITY_AGENT_URL, () => {
            return HttpResponse.json(body);
          }),
        );
        const response = await accept(
          client(pricing.resolution)(peopleSearchContract).search({
            headers: authenticate(actor),
            body: defaultRequest({ limit: 1 }),
          }),
          [502],
        );
        const afterCredits = await credits(actor);
        expectApiError(response.body);
        expect(response.body.error.code).toBe("PERPLEXITY_INVALID_RESPONSE");
        expect(afterCredits).toBe(beforeCredits);
      }
    });
  });

  it("fails before provider work when configuration or pricing is absent", async () => {
    const actor = createBddApi(context).user();
    const pricing = await createPricingFixture([], [peopleSearchPricingKey()]);
    const owner = await fundActorWithSubscription(actor);
    await owner.run(async () => {
      let providerRequests = 0;
      server.use(
        http.post(PERPLEXITY_AGENT_URL, () => {
          providerRequests += 1;
          return HttpResponse.json(providerResponse());
        }),
      );
      mockEnv("OKOU_WEB_SEARCH_PERPLEXITY_TOKEN", undefined);
      const noCredential = await accept(
        client(pricing.resolution)(peopleSearchContract).search({
          headers: authenticate(actor),
          body: defaultRequest(),
        }),
        [503],
      );
      expectApiError(noCredential.body);
      expect(noCredential.body.error.code).toBe("NOT_CONFIGURED");

      configureProvider();
      const noPrice = await accept(
        client(pricing.resolution)(peopleSearchContract).search({
          headers: authenticate(actor),
          body: defaultRequest(),
        }),
        [503],
      );
      expectApiError(noPrice.body);
      expect(noPrice.body.error.code).toBe("PRICING_NOT_CONFIGURED");
      expect(providerRequests).toBe(0);
    });
  });

  it("rejects insufficient credits before provider work", async () => {
    const actor = createBddApi(context).user();
    let providerRequests = 0;
    configureProvider();
    const pricing = await createPricingFixture([peopleSearchPricing()]);
    const owner = createPublicUnfundedProFixture(context, actor);
    await owner.initialize();
    await owner.run(async () => {
      server.use(
        http.post(PERPLEXITY_AGENT_URL, () => {
          providerRequests += 1;
          return HttpResponse.json(providerResponse());
        }),
      );

      const response = await accept(
        client(pricing.resolution)(peopleSearchContract).search({
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

  it("maps provider failures without billing", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await createPricingFixture([peopleSearchPricing()]);
    const owner = await fundActorWithSubscription(actor);
    await owner.run(async () => {
      const beforeCredits = await credits(actor);
      server.use(
        http.post(PERPLEXITY_AGENT_URL, () => {
          return HttpResponse.json({ message: "slow down" }, { status: 429 });
        }),
      );
      const rateLimited = await accept(
        client(pricing.resolution)(peopleSearchContract).search({
          headers: authenticate(actor),
          body: defaultRequest(),
        }),
        [502],
      );
      expectApiError(rateLimited.body);
      expect(rateLimited.body.error.code).toBe("PERPLEXITY_RATE_LIMITED");

      server.use(
        http.post(PERPLEXITY_AGENT_URL, () => {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new DOMException("timed out", "TimeoutError"));
            },
          });
          return new HttpResponse(stream);
        }),
      );
      const timedOut = await accept(
        client(pricing.resolution)(peopleSearchContract).search({
          headers: authenticate(actor),
          body: defaultRequest(),
        }),
        [502],
      );
      expectApiError(timedOut.body);
      expect(timedOut.body.error.code).toBe("PEOPLE_SEARCH_TIMEOUT");

      server.use(
        http.post(PERPLEXITY_AGENT_URL, () => {
          return HttpResponse.text("{}", {
            headers: {
              "content-length": String(MAX_PROVIDER_RESPONSE_BYTES + 1),
            },
          });
        }),
      );
      const oversized = await accept(
        client(pricing.resolution)(peopleSearchContract).search({
          headers: authenticate(actor),
          body: defaultRequest(),
        }),
        [502],
      );
      const afterCredits = await credits(actor);
      expectApiError(oversized.body);
      expect(oversized.body.error.code).toBe("PEOPLE_SEARCH_OUTPUT_TOO_LARGE");
      expect(afterCredits).toBe(beforeCredits);
    });
  });

  it("maps and bounds nested provider errors without billing", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await createPricingFixture([peopleSearchPricing()]);
    const owner = await fundActorWithSubscription(actor);
    await owner.run(async () => {
      const beforeCredits = await credits(actor);
      server.use(
        http.post(PERPLEXITY_AGENT_URL, () => {
          return HttpResponse.json(
            {
              error: {
                message: `\u001b]52;c;clipboard\u0007${"x".repeat(5000)}`,
              },
            },
            { status: 400 },
          );
        }),
      );

      const response = await accept(
        client(pricing.resolution)(peopleSearchContract).search({
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
  });
});
