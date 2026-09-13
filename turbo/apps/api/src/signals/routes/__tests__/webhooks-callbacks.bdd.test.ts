import { readFileSync } from "node:fs";
import { oomEvidenceSchema } from "@okouai/api-contracts/contracts/oom-evidence";
import { createHash, randomInt, randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { LIMITED_FREE1_DEFAULT_RUN_MODEL } from "@okouai/api-contracts/contracts/model-providers";
import { RESUME_SESSION_HISTORY_MAX_BYTES } from "@okouai/api-contracts/contracts/runners";
import { MAX_FILE_SIZE_BYTES } from "@okouai/api-contracts/contracts/storages";
import type { CreateCustomConnectorBody } from "@okouai/api-contracts/contracts/custom-connectors";
import { HttpResponse, http } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";

import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { mockNow, now, nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { testContext } from "../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise, settle } from "../../utils";
import { expireAtomGrantFixture } from "../../../test-fixtures/org-metadata";
import {
  deleteOrgPlanEntitlementFixture,
  readOrgPlanEntitlementFixture,
} from "../../../test-fixtures/org-plan-entitlement";
import { seedUsagePricingRows } from "../../../test-fixtures/system-config-seeds";
import { readUsageAllowanceEntitlementFixture } from "../../../test-fixtures/usage-allowance";
import { holdUsageEventCompactionLockFixture } from "../../../test-fixtures/usage-event-compaction";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import {
  createConnectorBddApi,
  manualHttpCustomConnectorCreateBody,
  mockCustomConnectorOAuth2Provider,
  mockSlackConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createGithubBddApi, newGithubUserId } from "./helpers/api-bdd-github";
import {
  createRunsApi,
  expectCanonicalStorageManifest,
} from "./helpers/api-bdd-runs";
import { createStoragesBddApi } from "./helpers/api-bdd-storages";
import {
  transitionRunToTerminal,
  transitionRunToTimeout,
  type TestTerminalRunStatus,
} from "./helpers/api-bdd-run-timeout";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createUserConfigBddApi } from "./helpers/api-bdd-user-config";
import {
  generatedStripeCustomerId,
  generatedStripeSubscriptionId,
  postUsageAllowanceInvoicePaid,
} from "./helpers/stripe-billing-webhook";
import {
  insertUsageEvent$,
  materializeHourlyUsage$,
  readUsageStorageCounts$,
} from "./helpers/usage-state";
import {
  readCustomConnectorCredentialStorageParent,
  readThreadConnectorSelectionState,
  seedCustomThreadConnectorSelection,
} from "./helpers/connector-credential-storage-state";

const context = testContext();
const TERMINAL_RUN_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "timeout",
] as const satisfies readonly TestTerminalRunStatus[];
const api = createWebhookCallbackApi(context);
const store = createStore();
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_AGENT_AVATAR_URL =
  "https://static.vm0.io/public/default-agent-avatar-ceb298b79964.svg";

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Axiom reports how many events it accepted, and the API treats any other
// count as a partial ingest. The mock therefore sizes its response from the
// request without inspecting or asserting on the payload.
async function ingestedEventCount(request: Request): Promise<number> {
  const events: unknown = await request.json();
  return Array.isArray(events) ? events.length : 0;
}

function successfulAxiomIngestStatus(ingested: number) {
  return {
    ingested,
    failed: 0,
    processedBytes: 123,
  };
}

function collectorEvidence(stage: "initial" | "sample" | "cleanup") {
  const fixture: unknown = JSON.parse(
    readFileSync(
      new URL(
        "../../../../../../../crates/guest-control-server/tests/fixtures/oom-evidence-collector.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  if (!isUnknownRecord(fixture)) {
    throw new Error("Expected the production collector fixture");
  }
  return oomEvidenceSchema.parse(fixture[stage]);
}

async function createEventWebhookRun(prompt: string) {
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  await runs.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: `BDD Event Consumer ${randomUUID()}`,
    visibility: "private",
  });
  const run = await runs.createRun(actor, {
    agentId: agent.agentId,
    prompt,
    modelProvider: "anthropic-api-key",
  });
  return {
    actor,
    runId: run.runId,
    headers: {
      authorization: `Bearer ${runs.sandboxTokenForRun(actor, run.runId)}`,
    },
  };
}

function orgOf(actor: ApiTestUser): string {
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped actor");
  }
  return actor.orgId;
}

async function sandboxStorageWriteFixture(label: string) {
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const runnerGroup = runs.configureRunnerGroup();
  await runs.heartbeatRunner(runnerGroup);
  await runs.grantProEntitlement(actor);
  await runs.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: `BDD sandbox storage ${label}`,
    visibility: "private",
  });
  const run = await runs.createRun(actor, {
    agentId: agent.agentId,
    prompt: `write ${label} from the sandbox`,
    modelProvider: "anthropic-api-key",
  });
  const claim = await runs.claimRunnerJob(run.runId);
  const manifest = expectCanonicalStorageManifest(claim.storageManifest);
  const mount = manifest?.storageMounts.find((candidate) => {
    return candidate.writeback === true;
  });
  if (!mount) {
    throw new Error("Expected a canonical writeback mount");
  }
  return {
    actor,
    runId: run.runId,
    mount,
    headers: { authorization: `Bearer ${claim.sandboxToken}` },
  };
}

function oauthStateFromAuthorizationUrl(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected connector authorization URL to include state");
  }
  return state;
}

function customManualConnectorBodyForTeardown(
  scope: "org" | "user",
): CreateCustomConnectorBody {
  const slug = `_${scope}-teardown-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  return manualHttpCustomConnectorCreateBody({
    slug,
    displayName: `BDD ${scope === "org" ? "Org" : "User"} Teardown Custom`,
    prefixTemplates: [`https://${slug.slice(1)}.example.test/v1/`],
  });
}

function customOauthConnectorBodyForTeardown(
  scope: "org" | "user",
  provider: {
    readonly authorizationUrl: string;
    readonly tokenUrl: string;
  },
): CreateCustomConnectorBody {
  return {
    displayName: `BDD ${scope} Teardown OAuth ${randomUUID()}`,
    prefixTemplates: [
      `https://${scope}-teardown-oauth-${randomUUID()}.example.test/v1/`,
    ],
    fields: [],
    headerInjections: [
      {
        name: "Authorization",
        valueTemplate: "Bearer {{oauth.access_token}}",
      },
    ],
    queryInjections: [],
    authMode: "oauth",
    oauthConfig: {
      providerAdapter: "standard",
      clientId: `${scope}-teardown-client-id`,
      clientSecret: `${scope}-teardown-client-secret`,
      authorizationUrl: provider.authorizationUrl,
      tokenUrl: provider.tokenUrl,
      tokenEndpointAuthMethod: "client_secret_post",
      pkceMethod: "none",
      scopes: ["read"],
      authorizationParams: {},
    },
  };
}

function epochSeconds(offsetDays: number): number {
  return Math.floor(now() / 1000) + offsetDays * 86_400;
}

function isoOf(epoch: number): string {
  return new Date(epoch * 1000).toISOString();
}

function expectExpiresAboutThirtyDaysFromNow(value: unknown): void {
  expect(typeof value).toBe("string");
  if (typeof value !== "string") {
    throw new Error("Expected a string credit expiration");
  }

  const expiresInMs = Date.parse(value) - now();
  expect(expiresInMs).toBeGreaterThan(THIRTY_DAYS_MS - 60_000);
  expect(expiresInMs).toBeLessThanOrEqual(THIRTY_DAYS_MS + 5000);
}

function expectIsoTimestampBetween(
  value: string | null | undefined,
  before: Date,
  after: Date,
): void {
  expect(typeof value).toBe("string");
  if (typeof value !== "string") {
    throw new Error("Expected an ISO timestamp");
  }
  const timestamp = Date.parse(value);
  expect(timestamp).toBeGreaterThanOrEqual(before.getTime());
  expect(timestamp).toBeLessThanOrEqual(after.getTime() + 1000);
}

async function waitForExpectation(
  assertion: () => void | Promise<void>,
): Promise<void> {
  await expect
    .poll(async () => {
      const result = await settle(Promise.resolve().then(assertion));
      return result.ok;
    })
    .toBe(true);
}

async function completeOnboardingWithoutCredits(
  actor: ApiTestUser,
): Promise<void> {
  const completed = await createBddApi(context).completeOnboarding(actor);
  expect(completed.status).toBe(200);
}

function stripeEvent(args: {
  readonly type: string;
  readonly object: Record<string, unknown>;
  readonly previousAttributes?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    id: `evt_bdd_${randomUUID()}`,
    type: args.type,
    created: Math.floor(now() / 1000),
    data: {
      object: args.object,
      ...(args.previousAttributes === undefined
        ? {}
        : { previous_attributes: args.previousAttributes }),
    },
  };
}

function subscriptionLines(
  periodEndUnix: number,
  priceId = "price_bdd_pro",
): {
  readonly data: readonly {
    readonly price: { readonly id: string };
    readonly period: { readonly end: number };
    readonly parent: { readonly type: "subscription_item_details" };
  }[];
} {
  return {
    data: [
      {
        price: { id: priceId },
        period: { end: periodEndUnix },
        parent: { type: "subscription_item_details" },
      },
    ],
  };
}

function proSubscription(args: {
  readonly id: string;
  readonly customerId: string;
  readonly status?: string;
  readonly trialEnd?: number;
  readonly metadata?: Record<string, string>;
}): Record<string, unknown> {
  return {
    id: args.id,
    status: args.status ?? "active",
    customer: args.customerId,
    cancel_at: null,
    cancel_at_period_end: false,
    schedule: null,
    trial_end: args.trialEnd ?? null,
    metadata: args.metadata ?? {},
    items: { data: [{ price: { id: "price_bdd_pro" } }] },
  };
}

function concurrencySubscription(args: {
  readonly id: string;
  readonly customerId: string;
  readonly quantity: number;
  readonly periodEnd: number;
  readonly status?: string;
  readonly cancelAtPeriodEnd?: boolean;
}): Record<string, unknown> {
  return {
    id: args.id,
    status: args.status ?? "active",
    customer: args.customerId,
    cancel_at: null,
    cancel_at_period_end: args.cancelAtPeriodEnd ?? false,
    schedule: null,
    trial_end: null,
    metadata: { purpose: "concurrency_subscription" },
    items: {
      data: [
        {
          price: { id: "price_bdd_concurrency" },
          quantity: args.quantity,
          current_period_end: args.periodEnd,
        },
      ],
    },
  };
}

function commandInput(command: unknown): Record<string, unknown> {
  if (
    typeof command === "object" &&
    command !== null &&
    "input" in command &&
    typeof command.input === "object" &&
    command.input !== null
  ) {
    return command.input as Record<string, unknown>;
  }
  return {};
}

function acceptGithubGrantRevocations(): void {
  server.use(
    http.delete("https://api.github.com/applications/:clientId/grant", () => {
      return new HttpResponse(null, { status: 204 });
    }),
  );
}

function acceptTelegramDomainProbes(): void {
  server.use(
    http.head("https://oauth.telegram.org/auth", () => {
      return new HttpResponse(null, {
        status: 200,
        headers: { "content-length": "2001" },
      });
    }),
  );
}

async function registerTelegramBot(
  actor: ApiTestUser,
  defaultAgentId: string,
): Promise<string> {
  const integrations = createBddIntegrationApi(context);
  const telegramBotId = randomInt(1_000_000_000, 9_999_999_999);
  const botToken = `${telegramBotId}:bdd-token-${randomUUID().slice(0, 8)}`;
  acceptTelegramDomainProbes();
  context.mocks.telegram.getMe.mockResolvedValue({
    id: telegramBotId,
    username: `bdd_bot_${telegramBotId}`,
    can_read_all_group_messages: true,
  });
  await integrations.requestRegisterTelegramBot(
    actor,
    { botToken, defaultAgentId },
    [201],
  );
  return botToken;
}

describe("WHCB-01: third-party webhook verification boundaries", () => {
  it("reports unconfigured third-party webhooks through public responses", async () => {
    api.disableStripeWebhookSecret();
    const stripe = await api.requestStripeWebhook(
      "{}",
      { "stripe-signature": "sig_bdd" },
      [503],
    );
    expect(stripe.body).toStrictEqual({
      error: "Stripe billing is not configured",
    });

    api.disableGithubWebhookSecret();
    const githubBody = "{}";
    const github = await api.requestGithubWebhook(
      githubBody,
      api.signedGithubWebhookHeaders(githubBody, "ping"),
      [503],
    );
    expect(github.body).toStrictEqual({
      error: "GitHub App integration is not configured",
    });
  });

  it("rejects Stripe requests with missing or invalid signatures", async () => {
    api.configureStripeWebhookSecret();

    const missingSignature = await api.requestStripeWebhook("{}", {}, [401]);
    expect(missingSignature.body).toStrictEqual({
      error: "Missing stripe-signature header",
    });

    api.rejectNextStripeWebhookSignature();
    const invalidSignature = await api.requestStripeWebhook(
      "{}",
      { "stripe-signature": "bad-signature" },
      [401],
    );
    expect(invalidSignature.body).toStrictEqual({
      error: "Invalid webhook signature",
    });

    api.acceptNextStripeWebhookEvent({
      id: `evt_bdd_${randomUUID()}`,
      type: "charge.succeeded",
      data: { object: { id: `ch_bdd_${randomUUID()}` } },
    });
    const ignored = await api.requestStripeWebhook(
      "{}",
      { "stripe-signature": "valid-signature" },
      [200],
    );
    expect(ignored.body).toBe("OK");
  });

  it("accepts signed Stripe events that do not require existing billing state", async () => {
    api.configureStripeWebhookSecret();

    api.acceptNextStripeWebhookEvent({
      id: `evt_bdd_${randomUUID()}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_bdd_${randomUUID()}`,
          invoice: `in_bdd_${randomUUID()}`,
          subscription: null,
          customer: null,
          metadata: { purpose: "credit_purchase" },
        },
      },
    });
    const creditPurchaseCheckout = await api.requestStripeWebhook(
      "{}",
      { "stripe-signature": "valid-signature" },
      [200],
    );
    expect(creditPurchaseCheckout.body).toBe("OK");

    api.acceptNextStripeWebhookEvent({
      id: `evt_bdd_${randomUUID()}`,
      type: "checkout.session.async_payment_succeeded",
      data: {
        object: {
          id: `cs_bdd_${randomUUID()}`,
          invoice: null,
          subscription: null,
          customer: null,
          metadata: { purpose: "one_time_purchase" },
          payment_status: "unpaid",
        },
      },
    });
    const unpaidOneTimeCheckout = await api.requestStripeWebhook(
      "{}",
      { "stripe-signature": "valid-signature" },
      [200],
    );
    expect(unpaidOneTimeCheckout.body).toBe("OK");

    api.acceptNextStripeWebhookEvent({
      id: `evt_bdd_${randomUUID()}`,
      type: "invoice.paid",
      data: {
        object: {
          id: `in_bdd_${randomUUID()}`,
          customer: null,
          metadata: null,
          subtotal: null,
          lines: {
            has_more: false,
            data: [],
          },
          parent: null,
        },
      },
    });
    const invoiceWithoutSubscription = await api.requestStripeWebhook(
      "{}",
      { "stripe-signature": "valid-signature" },
      [200],
    );
    expect(invoiceWithoutSubscription.body).toBe("OK");

    api.acceptNextStripeWebhookEvent({
      id: `evt_bdd_${randomUUID()}`,
      type: "customer.subscription.created",
      data: {
        object: {
          id: `sub_bdd_${randomUUID()}`,
          customer: null,
          status: "active",
          metadata: null,
          cancel_at_period_end: false,
          items: { data: [] },
        },
      },
    });
    const subscriptionCreatedWithoutCustomer = await api.requestStripeWebhook(
      "{}",
      { "stripe-signature": "valid-signature" },
      [200],
    );
    expect(subscriptionCreatedWithoutCustomer.body).toBe("OK");

    api.acceptNextStripeWebhookEvent({
      id: `evt_bdd_${randomUUID()}`,
      type: "customer.subscription.updated",
      data: {
        object: {
          id: `sub_bdd_${randomUUID()}`,
          status: "active",
          metadata: null,
          cancel_at_period_end: false,
          items: { data: [] },
        },
        previous_attributes: { cancel_at_period_end: true },
      },
    });
    const subscriptionUpdatedWithoutOrg = await api.requestStripeWebhook(
      "{}",
      { "stripe-signature": "valid-signature" },
      [200],
    );
    expect(subscriptionUpdatedWithoutOrg.body).toBe("OK");

    api.acceptNextStripeWebhookEvent({
      id: `evt_bdd_${randomUUID()}`,
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: `sub_bdd_${randomUUID()}`,
          metadata: null,
        },
      },
    });
    const subscriptionDeletedWithoutOrg = await api.requestStripeWebhook(
      "{}",
      { "stripe-signature": "valid-signature" },
      [200],
    );
    expect(subscriptionDeletedWithoutOrg.body).toBe("OK");

    api.acceptNextStripeWebhookEvent({
      id: `evt_bdd_${randomUUID()}`,
      type: "subscription_schedule.released",
      created: Math.floor(now() / 1000),
      data: { object: { id: `sched_bdd_${randomUUID()}` } },
    });
    const releasedScheduleWithoutOrg = await api.requestStripeWebhook(
      "{}",
      { "stripe-signature": "valid-signature" },
      [200],
    );
    expect(releasedScheduleWithoutOrg.body).toBe("OK");

    api.acceptNextStripeWebhookEvent({
      id: `evt_bdd_${randomUUID()}`,
      type: "subscription_schedule.canceled",
      data: { object: { id: `sched_bdd_${randomUUID()}` } },
    });
    const canceledScheduleWithoutOrg = await api.requestStripeWebhook(
      "{}",
      { "stripe-signature": "valid-signature" },
      [200],
    );
    expect(canceledScheduleWithoutOrg.body).toBe("OK");
  });

  it("rejects Clerk requests when webhook verification is missing or invalid", async () => {
    api.configureClerkWebhookSecret();

    api.rejectNextClerkWebhookVerification();
    const missingVerification = await api.requestClerkWebhook("{}", {}, [401]);
    expect(missingVerification.body).toStrictEqual({
      error: "Invalid webhook signature",
    });

    api.rejectNextClerkWebhookVerification();
    const invalidVerification = await api.requestClerkWebhook(
      "{}",
      {
        "svix-id": "msg_bdd",
        "svix-timestamp": "1700000000",
        "svix-signature": "v1,bad",
      },
      [401],
    );
    expect(invalidVerification.body).toStrictEqual({
      error: "Invalid webhook signature",
    });
  });

  it("accepts verified Clerk events that do not require visible cleanup", async () => {
    api.configureClerkWebhookSecret();

    api.verifyNextClerkWebhook({
      type: "session.created",
      data: { id: "sess_bdd" },
    });
    const ignored = await api.requestClerkWebhook("{}", {}, [200]);
    expect(ignored.body).toBe("OK");

    api.verifyNextClerkWebhook({
      type: "organization.deleted",
      data: {},
    });
    const missingOrgId = await api.requestClerkWebhook("{}", {}, [200]);
    expect(missingOrgId.body).toBe("OK");

    api.verifyNextClerkWebhook({
      type: "user.deleted",
      data: {},
    });
    const missingUserId = await api.requestClerkWebhook("{}", {}, [200]);
    expect(missingUserId.body).toBe("OK");

    api.verifyNextClerkWebhook({
      type: "organizationMembership.deleted",
      data: { id: "mem_bdd" },
    });
    const membershipDeleted = await api.requestClerkWebhook("{}", {}, [200]);
    expect(membershipDeleted.body).toBe("OK");
  });

  it("bootstraps limited-free orgs after verified Clerk org creation events", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    api.configureClerkWebhookSecret();
    bdd.acceptAgentStorageWrites();

    const admin = bdd.user();
    api.verifyNextClerkWebhook({
      type: "organization.created",
      data: {
        id: orgOf(admin),
        created_by: admin.userId,
        created_at: now(),
      },
    });
    const created = await api.requestClerkWebhook("{}", {}, [200]);
    expect(created.body).toBe("OK");
    await flushWaitUntilForTest();

    const billing = await runs.readBillingStatus(admin);
    expect(billing).toMatchObject({
      credits: 1000,
      tier: "limited-free-1",
      onboardingPaymentPending: false,
    });
    await expect(
      readOrgPlanEntitlementFixture(orgOf(admin)),
    ).resolves.toMatchObject({
      orgId: orgOf(admin),
      planKey: "limited-free-1",
      planRank: 0,
      source: "org_metadata_bootstrap",
      status: "active",
      baseConcurrencyLimit: 1,
      canBuyConcurrency: false,
      autoRechargeAllowed: false,
      supportByok: false,
      restrictedBuiltInModels: true,
      videoGenerationAllowed: false,
      workflowWebhookAutomationAllowed: false,
      audioLifetimeLimit: 10,
      audioDailyRateLimit: 10,
      audioDailyDurationSeconds: 600,
      stripeSubscriptionId: null,
      stripePriceId: null,
      currentPeriodEnd: null,
      expiresAt: null,
    });
    const onboardingCreditGrant = billing.creditGrants.find((grant) => {
      return grant.source === "onboarding";
    });
    expect(onboardingCreditGrant).toMatchObject({
      amount: 1000,
      remaining: 1000,
    });
    expectExpiresAboutThirtyDaysFromNow(onboardingCreditGrant?.expiresAt);
    const limitedFreeProviders = await runs.listOrgModelProviders(admin);
    expect(
      limitedFreeProviders.find((provider) => {
        return provider.type === "built-in";
      })?.selectedModel,
    ).toBe(LIMITED_FREE1_DEFAULT_RUN_MODEL);

    api.verifyNextClerkWebhook({
      type: "organizationMembership.created",
      data: {
        id: "mem_bdd_created",
        organization: { id: orgOf(admin) },
        publicUserData: { userId: admin.userId },
        role: "org:admin",
      },
    });
    const duplicate = await api.requestClerkWebhook("{}", {}, [200]);
    expect(duplicate.body).toBe("OK");
    await flushWaitUntilForTest();

    const repeatedBilling = await runs.readBillingStatus(admin);
    expect(repeatedBilling).toMatchObject({
      credits: 1000,
      tier: "limited-free-1",
      onboardingPaymentPending: false,
    });

    const status = await bdd.readOnboardingStatus(admin);
    expect(status).toMatchObject({
      needsOnboarding: true,
      onboardingComplete: false,
      isAdmin: true,
      hasOrg: true,
      hasDefaultAgent: true,
      defaultAgentMetadata: {
        displayName: "Okou",
        sound: "professional",
        avatarUrl: DEFAULT_AGENT_AVATAR_URL,
      },
    });
    expect(status.defaultAgentId).toBeTruthy();

    const agents = await bdd.listAgents(admin);
    expect(
      agents.filter((agent) => {
        return agent.displayName === "Okou";
      }),
    ).toHaveLength(1);

    api.configureStripeBillingEnv();
    context.mocks.stripe.subscriptions.list.mockResolvedValue({ data: [] });
    context.mocks.ably.publish.mockClear();
    const grantExpiresAtUnix = epochSeconds(7);
    await api.postStripeEvent(
      stripeEvent({
        type: "invoice.paid",
        object: {
          id: `in_bdd_bootstrap_${randomUUID()}`,
          customer: `cus_bdd_bootstrap_${randomUUID()}`,
          metadata: {
            type: "atom_grant",
            purpose: "atom_grant",
            source: "atom_entitlement",
            orgId: orgOf(admin),
            tier: "team",
            duration: "7d",
            atomGrantExpiresAt: isoOf(grantExpiresAtUnix),
          },
          parent: null,
          lines: {
            has_more: false,
            data: [
              {
                id: `il_bdd_bootstrap_${randomUUID()}`,
                quantity: 1,
                price: { id: "price_bdd_atom_grant" },
                period: {
                  start: epochSeconds(0),
                  end: grantExpiresAtUnix,
                },
                parent: { type: "invoice_item_details" },
              },
            ],
          },
        },
      }),
      [200],
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "billing:changed",
      null,
    );
  });

  it("rejects GitHub requests with missing headers or invalid signatures", async () => {
    api.configureGithubWebhookSecret();

    const missingHeaders = await api.requestGithubWebhook("{}", {}, [401]);
    expect(missingHeaders.body).toStrictEqual({
      error: "Missing GitHub webhook headers",
    });

    const invalidSignature = await api.requestGithubWebhook(
      "{}",
      {
        "x-github-delivery": "delivery-bdd",
        "x-github-event": "ping",
        "x-hub-signature-256": "sha256=bad",
      },
      [401],
    );
    expect(invalidSignature.body).toStrictEqual({
      error: "Invalid signature",
    });

    const invalidJson = await api.requestGithubWebhook(
      "not-json",
      api.signedGithubWebhookHeaders("not-json", "ping"),
      [400],
    );
    expect(invalidJson.body).toStrictEqual({
      error: "Invalid JSON payload",
    });

    const pingBody = "{}";
    const ping = await api.requestGithubWebhook(
      pingBody,
      api.signedGithubWebhookHeaders(pingBody, "ping"),
      [200],
    );
    expect(ping.body).toStrictEqual({ message: "pong" });

    const ignoredBody = JSON.stringify({ action: "ignored" });
    const ignored = await api.requestGithubWebhook(
      ignoredBody,
      api.signedGithubWebhookHeaders(ignoredBody, "fork"),
      [200],
    );
    expect(ignored.body).toBe("OK");

    const invalidPullRequestBody = JSON.stringify({ action: "opened" });
    const invalidPullRequest = await api.requestGithubWebhook(
      invalidPullRequestBody,
      api.signedGithubWebhookHeaders(invalidPullRequestBody, "pull_request"),
      [400],
    );
    expect(invalidPullRequest.body).toStrictEqual({
      error: "Invalid payload structure",
    });

    const invalidIssueCommentBody = JSON.stringify({ action: "created" });
    const invalidIssueComment = await api.requestGithubWebhook(
      invalidIssueCommentBody,
      api.signedGithubWebhookHeaders(invalidIssueCommentBody, "issue_comment"),
      [400],
    );
    expect(invalidIssueComment.body).toStrictEqual({
      error: "Invalid payload structure",
    });

    const invalidInstallationBody = JSON.stringify({ action: "created" });
    const invalidInstallation = await api.requestGithubWebhook(
      invalidInstallationBody,
      api.signedGithubWebhookHeaders(invalidInstallationBody, "installation"),
      [400],
    );
    expect(invalidInstallation.body).toStrictEqual({
      error: "Invalid payload structure",
    });
  });

  it("accepts signed GitHub events that do not dispatch work", async () => {
    api.configureGithubWebhookSecret();
    const user = { id: 42, login: "bdd-user", type: "User" };
    const bot = { id: 43, login: "zero[bot]", type: "Bot" };
    const repository = { full_name: "vm0-ai/vm0" };
    const installation = { id: 12_345 };
    const issue = {
      number: 123,
      title: "BDD issue",
      body: "No bot mention here.",
      labels: [],
      user,
    };

    const synchronizedPullRequestBody = JSON.stringify({
      action: "synchronize",
      pull_request: {
        number: 123,
        title: "BDD pull request",
        html_url: "https://github.com/vm0-ai/vm0/pull/123",
        draft: false,
        merged: false,
        user,
        base: { ref: "main" },
        head: { ref: "feat/bdd", sha: "abc123" },
        labels: [],
      },
      repository,
      installation,
      sender: user,
    });
    const synchronizedPullRequest = await api.requestGithubWebhook(
      synchronizedPullRequestBody,
      api.signedGithubWebhookHeaders(
        synchronizedPullRequestBody,
        "pull_request",
      ),
      [200],
    );
    expect(synchronizedPullRequest.body).toBe("OK");

    const editedCommentBody = JSON.stringify({
      action: "edited",
      issue,
      comment: { id: 456, body: "@Nova please help", user },
      repository,
      installation,
      sender: user,
    });
    const editedComment = await api.requestGithubWebhook(
      editedCommentBody,
      api.signedGithubWebhookHeaders(editedCommentBody, "issue_comment"),
      [200],
    );
    expect(editedComment.body).toBe("OK");

    const botCommentBody = JSON.stringify({
      action: "created",
      issue,
      comment: { id: 457, body: "@Nova please help", user: bot },
      repository,
      installation,
      sender: bot,
    });
    const botComment = await api.requestGithubWebhook(
      botCommentBody,
      api.signedGithubWebhookHeaders(botCommentBody, "issue_comment"),
      [200],
    );
    expect(botComment.body).toBe("OK");

    const unmentionedCommentBody = JSON.stringify({
      action: "created",
      issue,
      comment: { id: 458, body: "plain follow-up", user },
      repository,
      installation,
      sender: user,
    });
    const unmentionedComment = await api.requestGithubWebhook(
      unmentionedCommentBody,
      api.signedGithubWebhookHeaders(unmentionedCommentBody, "issue_comment"),
      [200],
    );
    expect(unmentionedComment.body).toBe("OK");

    const mentionedCommentWithoutInstallBody = JSON.stringify({
      action: "created",
      issue,
      comment: { id: 459, body: "@Nova please help", user },
      repository,
      installation,
      sender: user,
    });
    const mentionedCommentWithoutInstall = await api.requestGithubWebhook(
      mentionedCommentWithoutInstallBody,
      api.signedGithubWebhookHeaders(
        mentionedCommentWithoutInstallBody,
        "issue_comment",
      ),
      [200],
    );
    expect(mentionedCommentWithoutInstall.body).toBe("OK");

    const ignoredInstallationBody = JSON.stringify({
      action: "suspend",
      installation: {
        id: 67_890,
        account: { id: 98_765, login: "vm0-ai", type: "Organization" },
      },
      sender: { id: 42, login: "bdd-user" },
    });
    const ignoredInstallation = await api.requestGithubWebhook(
      ignoredInstallationBody,
      api.signedGithubWebhookHeaders(ignoredInstallationBody, "installation"),
      [200],
    );
    expect(ignoredInstallation.body).toBe("OK");

    const createdInstallationBody = JSON.stringify({
      action: "created",
      installation: {
        id: 67_891,
        account: { id: 98_765, login: "vm0-ai", type: "Organization" },
      },
      sender: { id: 42, login: "bdd-user" },
    });
    const createdInstallation = await api.requestGithubWebhook(
      createdInstallationBody,
      api.signedGithubWebhookHeaders(createdInstallationBody, "installation"),
      [200],
    );
    expect(createdInstallation.body).toBe("OK");

    const deletedInstallationBody = JSON.stringify({
      action: "deleted",
      installation: {
        id: 67_892,
        account: { id: 98_765, login: "vm0-ai", type: "Organization" },
      },
      sender: { id: 42, login: "bdd-user" },
    });
    const deletedInstallation = await api.requestGithubWebhook(
      deletedInstallationBody,
      api.signedGithubWebhookHeaders(deletedInstallationBody, "installation"),
      [200],
    );
    expect(deletedInstallation.body).toBe("OK");
  });
});

describe("WHCB-02: built-in generation callback boundaries", () => {
  it("rejects invalid provider tokens before reading generation state", async () => {
    const generationId = randomUUID();

    const response = await api.requestFalGenerationWebhook({
      generationId,
      token: "invalid-token",
      body: "{}",
      statuses: [401],
    });

    expect(response.body).toStrictEqual({ error: "Invalid token" });
  });

  it("rejects malformed provider payloads after a valid token", async () => {
    const generationId = randomUUID();

    const response = await api.requestBytePlusGenerationWebhook({
      generationId,
      token: api.bytePlusGenerationWebhookToken(generationId),
      body: "not-json",
      statuses: [400],
    });

    expect(response.body).toStrictEqual({ error: "Invalid payload" });
  });

  it("accepts valid provider callbacks that do not have an active generation job", async () => {
    const falGenerationId = randomUUID();
    const falVisualKey = "visual-bdd";

    const falResponse = await api.requestFalGenerationWebhook({
      generationId: falGenerationId,
      visualKey: falVisualKey,
      token: api.falGenerationWebhookToken(falGenerationId, falVisualKey),
      body: {
        status: "COMPLETED",
        payload: { images: [] },
      },
      statuses: [200],
    });
    expect(falResponse.body).toBe("OK");

    const falDataResponse = await api.requestFalGenerationWebhook({
      generationId: falGenerationId,
      visualKey: falVisualKey,
      token: api.falGenerationWebhookToken(falGenerationId, falVisualKey),
      body: {
        status: "COMPLETED",
        data: [{ url: "https://assets.example.test/image.png" }],
      },
      statuses: [200],
    });
    expect(falDataResponse.body).toBe("OK");

    const falNestedResponse = await api.requestFalGenerationWebhook({
      generationId: falGenerationId,
      visualKey: falVisualKey,
      token: api.falGenerationWebhookToken(falGenerationId, falVisualKey),
      body: {
        status: "COMPLETED",
        response: { images: [] },
      },
      statuses: [200],
    });
    expect(falNestedResponse.body).toBe("OK");

    const bytePlusGenerationId = randomUUID();
    const queuedResponse = await api.requestBytePlusGenerationWebhook({
      generationId: bytePlusGenerationId,
      token: api.bytePlusGenerationWebhookToken(bytePlusGenerationId),
      body: { status: "queued" },
      statuses: [200],
    });
    expect(queuedResponse.body).toBe("OK");

    const runningResponse = await api.requestBytePlusGenerationWebhook({
      generationId: bytePlusGenerationId,
      token: api.bytePlusGenerationWebhookToken(bytePlusGenerationId),
      body: { status: "running" },
      statuses: [200],
    });
    expect(runningResponse.body).toBe("OK");

    const completedResponse = await api.requestBytePlusGenerationWebhook({
      generationId: bytePlusGenerationId,
      token: api.bytePlusGenerationWebhookToken(bytePlusGenerationId),
      body: { status: "succeeded", content: { video: [] } },
      statuses: [200],
    });
    expect(completedResponse.body).toBe("OK");
  });
});

describe("WHCB-03: email inbound webhook boundaries", () => {
  it("keeps missing, invalid, and signed non-run Resend events visible through the inbound API", async () => {
    const missingHeaders = await api.requestResendInboundWebhook(
      { type: "email.received" },
      {},
      [401],
    );
    expect(missingHeaders.body).toStrictEqual({
      error: "Missing signature headers",
    });

    api.configureResendWebhookSecret();
    const signedBody = { type: "email.opened" };
    const invalidSignature = await api.requestResendInboundWebhook(
      signedBody,
      {
        ...api.signedResendWebhookHeaders(signedBody),
        "svix-signature": "v1,bad-signature",
      },
      [401],
    );
    expect(invalidSignature.body).toStrictEqual({
      error: "Invalid signature",
    });

    const ignoredEvent = await api.requestResendInboundWebhook(
      signedBody,
      api.signedResendWebhookHeaders(signedBody),
      [200],
    );
    expect(ignoredEvent.body).toStrictEqual({ received: true });

    const bounceBody = {
      type: "email.bounced",
      data: {
        email_id: `email_bdd_bounce_${randomUUID()}`,
        to: [`bounce-${randomUUID()}@example.test`],
      },
    };
    const bounceResponse = await api.requestResendInboundWebhook(
      bounceBody,
      api.signedResendWebhookHeaders(bounceBody),
      [200],
    );
    expect(bounceResponse.body).toStrictEqual({ received: true });

    context.mocks.clerk.users.getUserList.mockResolvedValue({ data: [] });
    const complaintBody = {
      type: "email.complained",
      data: {
        email_id: `email_bdd_complaint_${randomUUID()}`,
        to: [`complaint-${randomUUID()}@example.test`],
      },
    };
    const complaintResponse = await api.requestResendInboundWebhook(
      complaintBody,
      api.signedResendWebhookHeaders(complaintBody),
      [200],
    );
    expect(complaintResponse.body).toStrictEqual({ received: true });

    const malformedReceived = {
      type: "email.received",
      data: { email_id: "email_bdd_missing_sender" },
    };
    const malformedResponse = await api.requestResendInboundWebhook(
      malformedReceived,
      api.signedResendWebhookHeaders(malformedReceived),
      [200],
    );
    expect(malformedResponse.body).toStrictEqual({ received: true });

    api.disableResendApiKey();
    const unrecognizedOrgAddress = {
      type: "email.received",
      data: {
        email_id: `email_bdd_unrecognized_${randomUUID()}`,
        to: [`bad+alias-${randomUUID()}@example.test`],
        from: "sender@example.test",
        subject: "Unrecognized org",
      },
    };
    const unrecognizedOrgResponse = await api.requestResendInboundWebhook(
      unrecognizedOrgAddress,
      api.signedResendWebhookHeaders(unrecognizedOrgAddress),
      [200],
    );
    expect(unrecognizedOrgResponse.body).toStrictEqual({ received: true });

    const invalidReplyAddress = {
      type: "email.received",
      data: {
        email_id: `email_bdd_reply_${randomUUID()}`,
        to: [`reply+bad-token-${randomUUID()}@example.test`],
        from: "sender@example.test",
        subject: "Invalid reply",
      },
    };
    const invalidReplyResponse = await api.requestResendInboundWebhook(
      invalidReplyAddress,
      api.signedResendWebhookHeaders(invalidReplyAddress),
      [200],
    );
    expect(invalidReplyResponse.body).toStrictEqual({ received: true });
  });
});

describe("WHCB-04: internal callback and event-consumer boundaries", () => {
  it("acknowledges DB projection while the Axiom trace stays best effort", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD Axiom Event Consumer Agent",
      visibility: "private",
    });
    const run = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "emit events to Axiom",
      modelProvider: "anthropic-api-key",
    });
    const headers = {
      authorization: `Bearer ${runs.sandboxTokenForRun(actor, run.runId)}`,
    };
    const body = {
      runId: run.runId,
      events: [
        { type: "assistant", sequenceNumber: 1, message: { content: [] } },
        { type: "tool_result", sequenceNumber: 2, result: "ok" },
      ],
    };
    let ingestRequests = 0;
    server.use(
      http.post(
        "https://api.axiom.co/v1/datasets/agent-run-events/ingest",
        () => {
          ingestRequests += 1;
          return HttpResponse.json(
            successfulAxiomIngestStatus(body.events.length),
          );
        },
      ),
    );

    const ingested = await api.requestAgentEvents(body, headers, [200]);
    expect(ingested.body).toStrictEqual({
      received: 2,
      firstSequence: 1,
      lastSequence: 2,
    });
    await flushWaitUntilForTest();
    expect(ingestRequests).toBe(1);
    mockOptionalEnv("AXIOM_TOKEN_SESSIONS", undefined);
    const unconfigured = await api.requestAgentEvents(body, headers, [200]);
    expect(unconfigured.body).toStrictEqual({
      received: 2,
      firstSequence: 1,
      lastSequence: 2,
    });
    await flushWaitUntilForTest();
    expect(ingestRequests).toBe(1);

    mockOptionalEnv("AXIOM_TOKEN_SESSIONS", "xaat-test-sessions");
    let failedRequestCount = 0;
    server.use(
      http.post(
        "https://api.axiom.co/v1/datasets/agent-run-events/ingest",
        () => {
          failedRequestCount += 1;
          return HttpResponse.text("unavailable", { status: 503 });
        },
      ),
    );
    const unavailable = await api.requestAgentEvents(body, headers, [200]);
    expect(unavailable.body).toStrictEqual({
      received: 2,
      firstSequence: 1,
      lastSequence: 2,
    });
    await flushWaitUntilForTest();
    expect(failedRequestCount).toBe(1);

    const redirectTarget =
      "https://api.axiom.co/v1/datasets/redirected-agent-run-events/ingest";
    let redirectTargetRequests = 0;
    server.use(
      http.post(
        "https://api.axiom.co/v1/datasets/agent-run-events/ingest",
        () => {
          return new HttpResponse(null, {
            headers: { location: redirectTarget },
            status: 307,
          });
        },
      ),
      http.post(redirectTarget, () => {
        redirectTargetRequests += 1;
        return HttpResponse.json(
          successfulAxiomIngestStatus(body.events.length),
        );
      }),
    );
    const redirected = await api.requestAgentEvents(body, headers, [200]);
    expect(redirected.body).toStrictEqual({
      received: 2,
      firstSequence: 1,
      lastSequence: 2,
    });
    await flushWaitUntilForTest();
    expect(redirectTargetRequests).toBe(0);
  });

  it("acknowledges an event batch when its required DB run is missing", async () => {
    const runId = randomUUID();
    const headers = api.sandboxWebhookHeaders({ runId });
    let requestCount = 0;
    server.use(
      http.post(
        "https://api.axiom.co/v1/datasets/agent-run-events/ingest",
        () => {
          requestCount += 1;
          return HttpResponse.json(successfulAxiomIngestStatus(1));
        },
      ),
    );
    const response = await api.requestAgentEvents(
      {
        runId,
        events: [{ type: "system", sequenceNumber: 0 }],
      },
      headers,
      [200],
    );
    expect(response.body).toStrictEqual({
      received: 1,
      firstSequence: 0,
      lastSequence: 0,
    });
    await flushWaitUntilForTest();
    expect(requestCount).toBe(0);
  });

  it("acknowledges the event batch before the Axiom sub-deadline elapses", async () => {
    const { runId, headers } = await createEventWebhookRun(
      "best-effort Axiom deadline",
    );
    const submittedPayloadValue = `private-timeout-value-${randomUUID()}`;
    const axiomToken = `xaat-timeout-${randomUUID()}`;
    mockOptionalEnv("AXIOM_TOKEN_SESSIONS", axiomToken);
    const startedAt = now();
    mockNow(startedAt);
    const ingestStarted = createDeferredPromise<void>(context.signal);
    const releaseIngest = createDeferredPromise<void>(context.signal);
    const axiomDeadline = new AbortController();
    context.mocks.abortSignal.timeout.mockImplementation((milliseconds) => {
      return milliseconds === 10_000 ? axiomDeadline.signal : undefined;
    });
    onTestFinished(() => {
      if (!releaseIngest.settled()) {
        releaseIngest.resolve(undefined);
      }
    });
    server.use(
      http.post(
        "https://api.axiom.co/v1/datasets/agent-run-events/ingest",
        async () => {
          ingestStarted.resolve(undefined);
          await releaseIngest.promise;
          return HttpResponse.json(successfulAxiomIngestStatus(1));
        },
      ),
    );
    const response = await api.requestAgentEvents(
      {
        runId,
        events: [
          {
            type: "result",
            sequenceNumber: 0,
            result: submittedPayloadValue,
          },
        ],
      },
      headers,
      [200],
    );
    expect(response.body).toStrictEqual({
      received: 1,
      firstSequence: 0,
      lastSequence: 0,
    });
    await ingestStarted.promise;
    mockNow(startedAt + 2345);
    axiomDeadline.abort(
      new DOMException("Axiom ingest deadline", "TimeoutError"),
    );

    releaseIngest.resolve(undefined);
    await flushWaitUntilForTest();
  });

  it("acknowledges events when the optional Axiom status is malformed", async () => {
    const { runId, headers } = await createEventWebhookRun(
      "malformed optional Axiom status",
    );
    server.use(
      http.post(
        "https://api.axiom.co/v1/datasets/agent-run-events/ingest",
        () => {
          return HttpResponse.json({ ingested: 0, failed: 1 });
        },
      ),
    );

    const response = await api.requestAgentEvents(
      {
        runId,
        events: [
          {
            type: "result",
            sequenceNumber: 0,
            result: "DB-backed callback output",
          },
        ],
      },
      headers,
      [200],
    );
    expect(response.body).toStrictEqual({
      received: 1,
      firstSequence: 0,
      lastSequence: 0,
    });
    await flushWaitUntilForTest();
  });
});

describe("WHCB-05: sandbox agent webhook boundaries", () => {
  it("rejects unbounded DNS attempt dimensions at the telemetry boundary", async () => {
    const runId = randomUUID();
    const headers = api.sandboxWebhookHeaders({ runId });
    for (const invalid of [
      { dns_readiness_attempt: 0 },
      { dns_readiness_attempt: 4 },
      { dns_readiness_guest_duration_ms: -1 },
      { dns_readiness_host_residual_ms: -1 },
      { dns_readiness_timing: "arbitrary-diagnostic" },
      { dns_readiness_final_attempt: "false" },
    ]) {
      const response = await api.requestAgentTelemetryUnchecked(
        {
          runId,
          sandboxOperations: [
            {
              ts: nowDate().toISOString(),
              action_type:
                "runner_fresh_sandbox_start_guest_dns_readiness_attempt",
              duration_ms: 1,
              success: true,
              ...invalid,
            },
          ],
        },
        headers,
        [400],
      );
      expectApiError(response.body);
      expect(response.body.error.code).toBe("BAD_REQUEST");
    }
  });

  it("returns 500 when telemetry ingest times out", async () => {
    const { runId, headers } = await createEventWebhookRun(
      "required Axiom telemetry deadline",
    );
    const submittedHost = `${randomUUID()}.timeout.example.test`;
    const axiomToken = `xaat-telemetry-timeout-${randomUUID()}`;
    mockOptionalEnv("AXIOM_TOKEN_TELEMETRY", axiomToken);
    const startedAt = now();
    mockNow(startedAt);
    const ingestStarted = createDeferredPromise<void>(context.signal);
    const releaseIngest = createDeferredPromise<void>(context.signal);
    const axiomDeadline = new AbortController();
    context.mocks.abortSignal.timeout.mockImplementation((milliseconds) => {
      return milliseconds === 10_000 ? axiomDeadline.signal : undefined;
    });
    onTestFinished(() => {
      if (!releaseIngest.settled()) {
        releaseIngest.resolve(undefined);
      }
    });
    server.use(
      http.post(
        "https://api.axiom.co/v1/datasets/sandbox-telemetry-network/ingest",
        async () => {
          ingestStarted.resolve(undefined);
          await releaseIngest.promise;
          return HttpResponse.json(successfulAxiomIngestStatus(1));
        },
      ),
    );

    const pendingResponse = api.requestAgentTelemetry(
      {
        runId,
        networkLogs: [
          { timestamp: nowDate().toISOString(), host: submittedHost },
        ],
      },
      headers,
      [500],
    );
    await ingestStarted.promise;
    mockNow(startedAt + 3456);
    axiomDeadline.abort(
      new DOMException("Axiom telemetry deadline", "TimeoutError"),
    );
    releaseIngest.resolve(undefined);

    const response = await pendingResponse;
    expect(response.status).toBe(500);
  });

  it("preserves parent cancellation at the telemetry request boundary", async () => {
    const { runId, headers } = await createEventWebhookRun(
      "parent-cancelled Axiom telemetry",
    );
    const ingestStarted = createDeferredPromise<void>(context.signal);
    const releaseIngest = createDeferredPromise<void>(context.signal);
    const parentController = new AbortController();
    onTestFinished(() => {
      if (!releaseIngest.settled()) {
        releaseIngest.resolve(undefined);
      }
    });
    server.use(
      http.post(
        "https://api.axiom.co/v1/datasets/sandbox-telemetry-network/ingest",
        async () => {
          ingestStarted.resolve(undefined);
          await releaseIngest.promise;
          return HttpResponse.json(successfulAxiomIngestStatus(1));
        },
      ),
    );

    const pendingResponse = api.requestAgentTelemetry(
      {
        runId,
        networkLogs: [
          {
            timestamp: nowDate().toISOString(),
            host: `${randomUUID()}.parent-abort.example.test`,
          },
        ],
      },
      headers,
      [500],
      parentController.signal,
    );
    await ingestStarted.promise;
    const parentAbort = new Error("Parent request cancelled");
    parentAbort.name = "AbortError";
    parentController.abort(parentAbort);
    releaseIngest.resolve(undefined);

    const response = await pendingResponse;
    expect(response.status).toBe(500);
    expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
  });

  it("ingests collector OOM evidence and fallback with the same identity and rejects cross-run or forged payloads", async () => {
    const { runId, headers } = await createEventWebhookRun(
      `OOM evidence ${randomUUID()}`,
    );
    const evidence = collectorEvidence("sample");
    let ingestRequests = 0;
    mockOptionalEnv("AXIOM_TOKEN_TELEMETRY", `xaat-oom-${randomUUID()}`);
    server.use(
      http.post(
        "https://api.axiom.co/v1/datasets/sandbox-telemetry-metrics/ingest",
        async ({ request }) => {
          ingestRequests += 1;
          // Axiom answers with the number of events it accepted, so the mock
          // has to size its response the same way. Nothing here inspects the
          // payload; the test asserts the HTTP result and the request count.
          return HttpResponse.json(
            successfulAxiomIngestStatus(await ingestedEventCount(request)),
          );
        },
      ),
    );
    const response = await api.requestAgentTelemetry(
      { runId, oomEvidence: evidence },
      headers,
      [200],
    );
    expect(response.body).toMatchObject({
      success: true,
      oomEvidenceVersion: 1,
    });
    const fallback = collectorEvidence("cleanup");
    const retried = await api.requestAgentTelemetry(
      { runId, oomEvidence: fallback },
      headers,
      [200],
    );
    expect(retried.body).toMatchObject({ oomEvidenceVersion: 1 });
    expect(fallback.incidents).toStrictEqual(evidence.incidents);
    await api.requestAgentTelemetry(
      { runId: randomUUID(), oomEvidence: evidence },
      headers,
      [401],
    );
    for (const altered of [
      { ...evidence, prompt: "must never enter telemetry" },
      {
        ...evidence,
        incidents: Array.from({ length: 5 }, () => {
          return evidence.incidents[0];
        }),
      },
      { ...evidence, operation_id: randomUUID() },
      {
        ...evidence,
        incidents: evidence.incidents.map((incident) => {
          return {
            ...incident,
            kernel_events: incident.kernel_events.map((event) => {
              return { ...event, source: "host" };
            }),
          };
        }),
      },
    ]) {
      await api.requestAgentTelemetryUnchecked(
        { runId, oomEvidence: altered },
        headers,
        [400],
      );
    }
    expect(ingestRequests).toBe(2);
  });

  it("does not acknowledge OOM evidence when the Axiom destination is unavailable", async () => {
    const { runId, headers } = await createEventWebhookRun(
      `OOM unavailable ${randomUUID()}`,
    );
    mockOptionalEnv("AXIOM_TOKEN_TELEMETRY", undefined);
    const response = await api.requestAgentTelemetry(
      { runId, oomEvidence: collectorEvidence("cleanup") },
      headers,
      [200],
    );
    expect(response.body).toStrictEqual({ success: true, id: runId });
  });

  it.each(["failed", "partial"])(
    "does not acknowledge collector OOM evidence after %s ingestion",
    async (result) => {
      const { runId, headers } = await createEventWebhookRun(
        `OOM ingestion ${randomUUID()}`,
      );
      mockOptionalEnv("AXIOM_TOKEN_TELEMETRY", `xaat-oom-${randomUUID()}`);
      server.use(
        http.post(
          "https://api.axiom.co/v1/datasets/sandbox-telemetry-metrics/ingest",
          () => {
            return result === "failed"
              ? new HttpResponse(null, { status: 500 })
              : HttpResponse.json({
                  ingested: 1,
                  failed: 1,
                  processedBytes: 123,
                });
          },
        ),
      );
      const response = await api.requestAgentTelemetry(
        { runId, oomEvidence: collectorEvidence("sample") },
        headers,
        [500],
      );
      expect(response.body).not.toHaveProperty("oomEvidenceVersion");
    },
  );

  it("ingests collector memory in ordinary mixed telemetry and degrades an unusable snapshot without dropping the batch", async () => {
    const { runId, headers } = await createEventWebhookRun(
      `collector mixed telemetry ${randomUUID()}`,
    );
    const ingestedDatasets = new Set<string>();
    mockOptionalEnv("AXIOM_TOKEN_TELEMETRY", `xaat-mixed-${randomUUID()}`);
    server.use(
      http.post(
        "https://api.axiom.co/v1/datasets/:dataset/ingest",
        async ({ request, params }) => {
          ingestedDatasets.add(String(params.dataset));
          return HttpResponse.json(
            successfulAxiomIngestStatus(await ingestedEventCount(request)),
          );
        },
      ),
    );
    const metrics = [
      collectorEvidence("initial"),
      collectorEvidence("sample"),
    ].map((memory) => {
      return {
        ts: memory.sampled_at,
        cpu: 1,
        mem_used: 4096,
        mem_total: 16_384,
        disk_used: 1024,
        disk_total: 8192,
        memory,
      };
    });
    const networkLogs = [
      {
        timestamp: nowDate().toISOString(),
        host: "telemetry-batch.example.test",
      },
    ];
    const body = {
      runId,
      systemLog: "synthetic system event",
      metrics,
      networkLogs,
      sandboxOperations: [
        {
          ts: nowDate().toISOString(),
          action_type: "cli",
          duration_ms: 10,
          success: true,
        },
      ],
    };
    const response = await api.requestAgentTelemetry(body, headers, [200]);
    expect(response.body).toStrictEqual({ success: true, id: runId });
    expect([...ingestedDatasets].sort()).toStrictEqual([
      "sandbox-telemetry-metrics",
      "sandbox-telemetry-network",
      "sandbox-telemetry-system",
    ]);
    await flushWaitUntilForTest();
    ingestedDatasets.clear();
    const malformed = structuredClone(body);
    const malformedMemory = malformed.metrics[0]?.memory;
    if (!malformedMemory) {
      throw new Error("Expected first periodic memory snapshot");
    }
    for (const group of malformedMemory.groups) {
      group.cgroup = group.cgroup.slice(1);
    }
    const degraded = await api.requestAgentTelemetry(malformed, headers, [200]);

    // An unusable periodic snapshot drops itself, never the unrelated system
    // logs, metrics, and sandbox operations batched in the same request.
    expect(degraded.body).toStrictEqual({ success: true, id: runId });
    expect([...ingestedDatasets].sort()).toStrictEqual([
      "sandbox-telemetry-metrics",
      "sandbox-telemetry-network",
      "sandbox-telemetry-system",
    ]);
    await flushWaitUntilForTest();
  });

  it("keeps dedicated OOM evidence strict so an unusable payload is never acknowledged", async () => {
    const { runId, headers } = await createEventWebhookRun(
      `collector strict evidence ${randomUUID()}`,
    );
    let ingestRequests = 0;
    mockOptionalEnv("AXIOM_TOKEN_TELEMETRY", `xaat-strict-${randomUUID()}`);
    server.use(
      http.post("https://api.axiom.co/v1/datasets/:dataset/ingest", () => {
        ingestRequests += 1;
        return HttpResponse.json(successfulAxiomIngestStatus(1));
      }),
    );
    const relativePaths = collectorEvidence("sample");
    for (const group of relativePaths.groups) {
      group.cgroup = group.cgroup.slice(1);
    }

    await api.requestAgentTelemetryUnchecked(
      {
        runId,
        systemLog: "batched with unusable evidence",
        oomEvidence: relativePaths,
      },
      headers,
      [400],
    );

    expect(ingestRequests).toBe(0);
  });

  it("rejects malformed, unauthenticated, mismatched, and missing-run sandbox reports", async () => {
    const runId = randomUUID();
    const mismatchedRunId = randomUUID();
    const headers = api.sandboxWebhookHeaders({ runId });
    const mismatchedHeaders = api.sandboxWebhookHeaders({
      runId,
      tokenRunId: mismatchedRunId,
    });

    const malformedHeartbeat = await api.requestAgentHeartbeatUnchecked(
      {},
      {},
      [400],
    );
    expectApiError(malformedHeartbeat.body);
    expect(malformedHeartbeat.body.error.code).toBe("BAD_REQUEST");

    const unauthenticatedHeartbeat = await api.requestAgentHeartbeat(
      { runId },
      {},
      [401],
    );
    expectApiError(unauthenticatedHeartbeat.body);
    expect(unauthenticatedHeartbeat.body.error.code).toBe("UNAUTHORIZED");

    const nonSandboxBearerHeartbeat = await api.requestAgentHeartbeat(
      { runId },
      { authorization: "Bearer not-a-sandbox-token" },
      [401],
    );
    expectApiError(nonSandboxBearerHeartbeat.body);
    expect(nonSandboxBearerHeartbeat.body.error.code).toBe("UNAUTHORIZED");

    const mismatchedTelemetry = await api.requestAgentTelemetry(
      {
        runId,
        systemLog: "runner booted",
        metrics: [
          {
            ts: nowDate().toISOString(),
            cpu: 1,
            mem_used: 2,
            mem_total: 4,
            disk_used: 8,
            disk_total: 16,
          },
        ],
      },
      mismatchedHeaders,
      [401],
    );
    expectApiError(mismatchedTelemetry.body);
    expect(mismatchedTelemetry.body.error.code).toBe("UNAUTHORIZED");

    const missingHeartbeatRun = await api.requestAgentHeartbeat(
      { runId },
      headers,
      [404],
    );
    expectApiError(missingHeartbeatRun.body);
    expect(missingHeartbeatRun.body.error.code).toBe("NOT_FOUND");

    const mismatchedUsageEvent = await api.requestAgentUsageEvent(
      {
        runId,
        events: [
          {
            idempotencyKey: randomUUID(),
            kind: "connector",
            provider: "github",
            category: "api_request",
            quantity: 1,
          },
        ],
      },
      mismatchedHeaders,
      [401],
    );
    expectApiError(mismatchedUsageEvent.body);
    expect(mismatchedUsageEvent.body.error.code).toBe("UNAUTHORIZED");

    const malformedTelemetryBody = await api.requestAgentTelemetryUnchecked(
      {},
      headers,
      [400],
    );
    expectApiError(malformedTelemetryBody.body);
    expect(malformedTelemetryBody.body.error.code).toBe("BAD_REQUEST");

    const malformedUsageEvent = await api.requestAgentUsageEventUnchecked(
      {
        runId,
        events: [],
      },
      headers,
      [400],
    );
    expectApiError(malformedUsageEvent.body);
    expect(malformedUsageEvent.body.error.code).toBe("BAD_REQUEST");

    const missingUsageRun = await api.requestAgentUsageEvent(
      {
        runId,
        events: [
          {
            idempotencyKey: randomUUID(),
            kind: "connector",
            provider: "github",
            category: "api_request",
            quantity: 1,
          },
        ],
      },
      headers,
      [404],
    );
    expectApiError(missingUsageRun.body);
    expect(missingUsageRun.body.error.code).toBe("NOT_FOUND");

    const malformedTelemetryBucket = await api.requestAgentTelemetryUnchecked(
      {
        runId,
        sandboxOperations: [
          {
            ts: nowDate().toISOString(),
            action_type: "session_history_download",
            duration_ms: 3,
            success: true,
            session_history_raw_size_bucket: "exact_123_bytes",
          },
        ],
      },
      headers,
      [400],
    );
    expectApiError(malformedTelemetryBucket.body);
    expect(malformedTelemetryBucket.body.error.code).toBe("BAD_REQUEST");

    for (const invalidRunnerDimension of [
      { runnerHostname: "x".repeat(256) },
      { runnerVersion: "x".repeat(129) },
    ]) {
      const malformedRunnerDimension = await api.requestAgentTelemetryUnchecked(
        {
          runId,
          ...invalidRunnerDimension,
        },
        headers,
        [400],
      );
      expectApiError(malformedRunnerDimension.body);
      expect(malformedRunnerDimension.body.error.code).toBe("BAD_REQUEST");
    }

    const malformedTelemetryProbe = await api.requestAgentTelemetryUnchecked(
      {
        runId,
        sandboxOperations: [
          {
            ts: nowDate().toISOString(),
            action_type: "session_history_download",
            duration_ms: 3,
            success: true,
            session_history_ref_seen_recently: "yes",
          },
        ],
      },
      headers,
      [400],
    );
    expectApiError(malformedTelemetryProbe.body);
    expect(malformedTelemetryProbe.body.error.code).toBe("BAD_REQUEST");

    const malformedTelemetryResponseState =
      await api.requestAgentTelemetryUnchecked(
        {
          runId,
          sandboxOperations: [
            {
              ts: nowDate().toISOString(),
              action_type: "session_history_download",
              duration_ms: 3,
              success: true,
              session_history_content_encoding_state: "brotli",
            },
          ],
        },
        headers,
        [400],
      );
    expectApiError(malformedTelemetryResponseState.body);
    expect(malformedTelemetryResponseState.body.error.code).toBe("BAD_REQUEST");

    const unknownTelemetryDownloadSource =
      await api.requestAgentTelemetryUnchecked(
        {
          runId,
          sandboxOperations: [
            {
              ts: nowDate().toISOString(),
              action_type: "session_history_download",
              duration_ms: 3,
              success: true,
              session_history_download_source: "regional_edge_cache",
            },
          ],
        },
        headers,
        [404],
      );
    expectApiError(unknownTelemetryDownloadSource.body);
    expect(unknownTelemetryDownloadSource.body.error.code).toBe("NOT_FOUND");

    const missingTelemetryRun = await api.requestAgentTelemetry(
      {
        runId,
        networkLogs: [
          {
            timestamp: nowDate().toISOString(),
            host: "example.test",
            port: 443,
            method: "GET",
            url: "https://example.test/status",
            status: 200,
            latency_ms: 12,
            request_size: 5,
            response_size: 8,
          },
        ],
        sandboxOperations: [
          {
            ts: nowDate().toISOString(),
            action_type: "checkpoint",
            duration_ms: 3,
            success: true,
          },
        ],
      },
      headers,
      [404],
    );
    expectApiError(missingTelemetryRun.body);
    expect(missingTelemetryRun.body.error.code).toBe("NOT_FOUND");
  });
});

describe("WHCB-06: sandbox agent artifact webhook boundaries", () => {
  it("handles malformed, mismatched, and missing-run sandbox artifact reports", async () => {
    const runId = randomUUID();
    const hash = "a".repeat(64);
    const headers = api.sandboxWebhookHeaders({ runId });
    const mismatchedHeaders = api.sandboxWebhookHeaders({
      runId,
      tokenRunId: randomUUID(),
    });

    const malformedEvents = await api.requestAgentEventsUnchecked(
      { runId, events: [] },
      headers,
      [400],
    );
    expectApiError(malformedEvents.body);
    expect(malformedEvents.body.error.code).toBe("BAD_REQUEST");

    const mismatchedEvents = await api.requestAgentEvents(
      {
        runId,
        events: [{ type: "system", sequenceNumber: 0 }],
      },
      mismatchedHeaders,
      [401],
    );
    expectApiError(mismatchedEvents.body);
    expect(mismatchedEvents.body.error.code).toBe("UNAUTHORIZED");

    const missingEventsRun = await api.requestAgentEvents(
      {
        runId,
        events: [{ type: "system", sequenceNumber: 0 }],
      },
      headers,
      [200],
    );
    expect(missingEventsRun.body).toStrictEqual({
      received: 1,
      firstSequence: 0,
      lastSequence: 0,
    });

    const malformedComplete = await api.requestAgentCompleteUnchecked(
      { runId },
      headers,
      [400],
    );
    expectApiError(malformedComplete.body);
    expect(malformedComplete.body.error.code).toBe("BAD_REQUEST");

    const incoherentReuseComplete = await api.requestAgentCompleteUnchecked(
      {
        runId,
        exitCode: 0,
        sandboxReuseResult: "reused",
        workspaceReuseResult: "cacheMiss",
      },
      headers,
      [400],
    );
    expectApiError(incoherentReuseComplete.body);
    expect(incoherentReuseComplete.body.error.code).toBe("BAD_REQUEST");

    const mismatchedComplete = await api.requestAgentComplete(
      { runId, exitCode: 0, lastEventSequence: 0 },
      mismatchedHeaders,
      [401],
    );
    expectApiError(mismatchedComplete.body);
    expect(mismatchedComplete.body.error.code).toBe("UNAUTHORIZED");

    const missingCompleteRun = await api.requestAgentComplete(
      {
        runId,
        exitCode: 0,
        lastEventSequence: 0,
        sandboxId: "sandbox-bdd",
        sandboxReuseResult: "poolMiss",
      },
      headers,
      [404],
    );
    expectApiError(missingCompleteRun.body);
    expect(missingCompleteRun.body.error.code).toBe("NOT_FOUND");

    const malformedCheckpoint = await api.requestAgentCheckpointUnchecked(
      {
        runId,
        cliAgentType: "claude-code",
        cliAgentSessionId: "session-bdd",
        cliAgentSessionHistoryHash: "not-a-sha",
      },
      headers,
      [400],
    );
    expectApiError(malformedCheckpoint.body);
    expect(malformedCheckpoint.body.error.code).toBe("BAD_REQUEST");

    const uppercaseCheckpointHash = await api.requestAgentCheckpointUnchecked(
      {
        runId,
        cliAgentType: "claude-code",
        cliAgentSessionId: "session-bdd",
        cliAgentSessionHistoryHash: "A".repeat(64),
      },
      headers,
      [400],
    );
    expectApiError(uppercaseCheckpointHash.body);
    expect(uppercaseCheckpointHash.body.error.code).toBe("BAD_REQUEST");

    const missingCheckpointRun = await api.requestAgentCheckpoint(
      {
        runId,
        cliAgentType: "claude-code",
        cliAgentSessionId: "session-bdd",
        cliAgentSessionHistoryHash: hash,
      },
      headers,
      [404],
    );
    expectApiError(missingCheckpointRun.body);
    expect(missingCheckpointRun.body.error.code).toBe("NOT_FOUND");

    const mismatchedCheckpoint = await api.requestAgentCheckpoint(
      {
        runId,
        cliAgentType: "claude-code",
        cliAgentSessionId: "session-bdd",
        cliAgentSessionHistoryHash: hash,
      },
      mismatchedHeaders,
      [401],
    );
    expectApiError(mismatchedCheckpoint.body);
    expect(mismatchedCheckpoint.body.error.code).toBe("UNAUTHORIZED");

    const mismatchedHistoryPrepare =
      await api.requestAgentCheckpointPrepareHistory(
        { runId, hash, rawSize: 128, encodedSize: 128 },
        mismatchedHeaders,
        [401],
      );
    expectApiError(mismatchedHistoryPrepare.body);
    expect(mismatchedHistoryPrepare.body.error.code).toBe("UNAUTHORIZED");

    const malformedHistoryPrepare =
      await api.requestAgentCheckpointPrepareHistoryUnchecked(
        { runId, hash, rawSize: 0, encodedSize: 0 },
        headers,
        [400],
      );
    expectApiError(malformedHistoryPrepare.body);
    expect(malformedHistoryPrepare.body.error.code).toBe("BAD_REQUEST");

    const uppercaseHistoryPrepare =
      await api.requestAgentCheckpointPrepareHistoryUnchecked(
        { runId, hash: "A".repeat(64), rawSize: 128, encodedSize: 128 },
        headers,
        [400],
      );
    expectApiError(uppercaseHistoryPrepare.body);
    expect(uppercaseHistoryPrepare.body.error.code).toBe("BAD_REQUEST");

    const oversizedHistoryPrepare =
      await api.requestAgentCheckpointPrepareHistoryUnchecked(
        {
          runId,
          hash,
          rawSize: RESUME_SESSION_HISTORY_MAX_BYTES + 1,
          encodedSize: 128,
        },
        headers,
        [400],
      );
    expectApiError(oversizedHistoryPrepare.body);
    expect(oversizedHistoryPrepare.body.error.code).toBe("BAD_REQUEST");

    const mismatchedStoragePrepare = await api.requestAgentStoragePrepare(
      {
        runId,
        storageId: randomUUID(),
        files: [{ path: "index.txt", hash, size: 5 }],
      },
      mismatchedHeaders,
      [401],
    );
    expectApiError(mismatchedStoragePrepare.body);
    expect(mismatchedStoragePrepare.body.error.code).toBe("UNAUTHORIZED");

    const malformedStoragePrepare =
      await api.requestAgentStoragePrepareUnchecked(
        {
          runId,
          storageId: "",
          files: [{ path: "index.txt", hash, size: 5 }],
        },
        headers,
        [400],
      );
    expectApiError(malformedStoragePrepare.body);
    expect(malformedStoragePrepare.body.error.code).toBe("BAD_REQUEST");

    const mismatchedStorageCommit = await api.requestAgentStorageCommit(
      {
        runId,
        storageId: randomUUID(),
        versionId: randomUUID(),
        files: [{ path: "index.txt", hash, size: 5 }],
      },
      mismatchedHeaders,
      [401],
    );
    expectApiError(mismatchedStorageCommit.body);
    expect(mismatchedStorageCommit.body.error.code).toBe("UNAUTHORIZED");

    const malformedStorageCommit = await api.requestAgentStorageCommitUnchecked(
      {
        runId,
        storageId: randomUUID(),
        versionId: "",
        files: [{ path: "index.txt", hash, size: 5 }],
      },
      headers,
      [400],
    );
    expectApiError(malformedStorageCommit.body);
    expect(malformedStorageCommit.body.error.code).toBe("BAD_REQUEST");
  });
});

describe("WHCB-09: sandbox storage writes and checkpoint history blobs land in the run organization", () => {
  it("prepares, commits, dedups, and bounds sandbox storage writes for the run org", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const storages = createStoragesBddApi(context);
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const runnerGroup = runs.configureRunnerGroup();
    await runs.heartbeatRunner(runnerGroup);
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD sandbox storage agent",
      visibility: "private",
    });
    const run = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "write artifacts from the sandbox",
      modelProvider: "anthropic-api-key",
    });
    const claim = await runs.claimRunnerJob(run.runId);
    const manifest = expectCanonicalStorageManifest(claim.storageManifest);
    const writebackMount = manifest?.storageMounts.find((mount) => {
      return mount.writeback === true;
    });
    if (!writebackMount) {
      throw new Error("Expected a canonical writeback mount");
    }
    const headers = {
      authorization: `Bearer ${claim.sandboxToken}`,
    };

    // Checkpoint history blobs: first prepare issues an upload URL, the
    // second sees the registered blob and skips the upload.
    const historyHash = createHash("sha256")
      .update(`bdd history blob ${run.runId}`)
      .digest("hex");
    const firstHistory = await api.requestAgentCheckpointPrepareHistory(
      { runId: run.runId, hash: historyHash, rawSize: 456, encodedSize: 456 },
      headers,
      [200],
    );
    if (firstHistory.status !== 200) {
      throw new Error("Expected the first history prepare to succeed");
    }
    expect(firstHistory.body.existing).toBeFalsy();
    expect(firstHistory.body.presignedUrl).toMatch(/^https/);

    const repeatedHistory = await api.requestAgentCheckpointPrepareHistory(
      { runId: run.runId, hash: historyHash, rawSize: 456, encodedSize: 456 },
      headers,
      [200],
    );
    if (repeatedHistory.status !== 200) {
      throw new Error("Expected the repeated history prepare to succeed");
    }
    expect(repeatedHistory.body).toStrictEqual({
      existing: true,
      encoding: "identity",
    });

    const ghostRunId = randomUUID();
    const missingHistoryRun = await api.requestAgentCheckpointPrepareHistory(
      { runId: ghostRunId, hash: historyHash, rawSize: 456, encodedSize: 456 },
      {
        authorization: `Bearer ${runs.sandboxTokenForRun(actor, ghostRunId)}`,
      },
      [404],
    );
    expectApiError(missingHistoryRun.body);
    expect(missingHistoryRun.body.error.message).toBe("Agent run not found");

    const unmountedStorage = await api.requestAgentStoragePrepare(
      {
        runId: run.runId,
        storageId: randomUUID(),
        files: [],
      },
      headers,
      [404],
    );
    expectApiError(unmountedStorage.body);
    expect(unmountedStorage.body.error.message).toBe(
      "Writeback storage not found",
    );

    // Canonical writes land under the run organization's Storage prefix.
    const storageName = writebackMount.name;
    const files = [
      {
        path: "index.html",
        hash: createHash("sha256")
          .update(`bdd artifact ${storageName}`)
          .digest("hex"),
        size: 2048,
      },
    ];
    const prepared = await api.requestAgentStoragePrepare(
      {
        runId: run.runId,
        storageId: writebackMount.storageId,
        parentVersionId: writebackMount.versionId,
        files,
      },
      headers,
      [200],
    );
    if (prepared.status !== 200) {
      throw new Error("Expected the sandbox storage prepare to succeed");
    }
    expect(prepared.body.existing).toBeFalsy();
    expect(prepared.body.uploads?.archive.key).toMatch(
      new RegExp(
        `^${orgOf(actor)}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/${prepared.body.versionId}/archive\\.tar\\.gz$`,
      ),
    );
    expect(prepared.body.uploads?.archive.presignedUrl).toMatch(/^https/);
    expect(prepared.body.uploads?.manifest.presignedUrl).toMatch(/^https/);

    const committed = await api.requestAgentStorageCommit(
      {
        runId: run.runId,
        storageId: writebackMount.storageId,
        versionId: prepared.body.versionId,
        parentVersionId: writebackMount.versionId,
        files,
        message: "bdd sandbox commit",
      },
      headers,
      [200],
    );
    if (committed.status !== 200) {
      throw new Error("Expected the sandbox storage commit to succeed");
    }
    expect(committed.body).toStrictEqual({
      success: true,
      versionId: prepared.body.versionId,
      storageName,
      size: 2048,
      fileCount: 1,
    });

    // Re-preparing identical content reuses the committed version without
    // new upload URLs.
    const reprepared = await api.requestAgentStoragePrepare(
      { runId: run.runId, storageId: writebackMount.storageId, files },
      headers,
      [200],
    );
    if (reprepared.status !== 200) {
      throw new Error("Expected the duplicate prepare to succeed");
    }
    expect(reprepared.body).toStrictEqual({
      versionId: prepared.body.versionId,
      existing: true,
    });

    const mismatchedCommit = await api.requestAgentStorageCommit(
      {
        runId: run.runId,
        storageId: writebackMount.storageId,
        versionId: "f".repeat(64),
        files,
      },
      headers,
      [400],
    );
    expectApiError(mismatchedCommit.body);
    expect(mismatchedCommit.body.error.message).toBe(
      "Version ID mismatch - files may have changed",
    );

    const oversized = await api.requestAgentStoragePrepare(
      {
        runId: run.runId,
        storageId: writebackMount.storageId,
        files: [
          {
            path: "a.bin",
            hash: "1".repeat(64),
            size: MAX_FILE_SIZE_BYTES,
          },
          { path: "b.bin", hash: "2".repeat(64), size: 1 },
        ],
      },
      headers,
      [413],
    );
    expectApiError(oversized.body);
    expect(oversized.body.error.code).toBe("PAYLOAD_TOO_LARGE");

    // The committed writeback is visible through fixture-only state reads.
    const listed = await storages.listStorages(actor, "user");
    expect(listed).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: storageName,
          size: 2048,
          fileCount: 1,
        }),
      ]),
    );
    const downloaded = await storages.downloadStorage(actor, {
      name: storageName,
      owner: "user",
    });
    expect(downloaded).toMatchObject({
      versionId: prepared.body.versionId,
      size: 2048,
      fileCount: 1,
    });

    await runs.requestCancelRun(actor, run.runId, [200]);
    const cancelled = await runs.readRun(actor, run.runId);
    expect(cancelled.status).toBe("cancelled");
  });
});

describe("WHCB-10: timeout closes sandbox storage write authority", () => {
  it.each(TERMINAL_RUN_STATUSES)(
    "rejects prepare before issuing upload URLs after %s",
    async (status) => {
      const fixture = await sandboxStorageWriteFixture("timeout prepare");
      const signedUrlCalls = context.mocks.s3.getSignedUrl.mock.calls.length;

      const terminal = await transitionRunToTerminal(
        context,
        fixture.runId,
        status,
      );
      expect(terminal.body.ok).toBeTruthy();

      const prepared = await api.requestAgentStoragePrepare(
        {
          runId: fixture.runId,
          storageId: fixture.mount.storageId,
          files: [
            {
              path: `${status}.txt`,
              hash: createHash("sha256").update(status).digest("hex"),
              size: 1,
            },
          ],
        },
        fixture.headers,
        [404],
      );
      expectApiError(prepared.body);
      expect(prepared.body.error.code).toBe("NOT_FOUND");
      expect(context.mocks.s3.getSignedUrl).toHaveBeenCalledTimes(
        signedUrlCalls,
      );
    },
  );

  it("keeps prepare-then-timeout commit completely write-free", async () => {
    const fixture = await sandboxStorageWriteFixture("timeout commit");
    const storages = createStoragesBddApi(context);
    const parentVersionId = fixture.mount.versionId;
    const files = [
      {
        path: "timeout.txt",
        hash: createHash("sha256")
          .update(`timeout ${fixture.runId}`)
          .digest("hex"),
        size: 2048,
      },
    ];
    const prepared = await api.requestAgentStoragePrepare(
      {
        runId: fixture.runId,
        storageId: fixture.mount.storageId,
        parentVersionId,
        files,
      },
      fixture.headers,
      [200],
    );
    if (prepared.status !== 200) {
      throw new Error("Expected storage prepare to succeed before timeout");
    }
    const before = await storages.inspectWriteback({
      storageId: fixture.mount.storageId,
      versionId: prepared.body.versionId,
      runId: fixture.runId,
      parentVersionId,
    });
    expect(before.version).toBeNull();
    expect(before.lineageCount).toBe(0);

    const timeout = await transitionRunToTimeout(context, fixture.runId);
    expect(timeout.body.ok).toBeTruthy();
    const s3Calls = context.mocks.s3.send.mock.calls.length;

    const committed = await api.requestAgentStorageCommit(
      {
        runId: fixture.runId,
        storageId: fixture.mount.storageId,
        versionId: prepared.body.versionId,
        parentVersionId,
        files,
        message: "must not commit after timeout",
      },
      fixture.headers,
      [404],
    );
    expectApiError(committed.body);
    expect(committed.body.error.code).toBe("NOT_FOUND");
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(s3Calls);
    await expect(
      storages.inspectWriteback({
        storageId: fixture.mount.storageId,
        versionId: prepared.body.versionId,
        runId: fixture.runId,
        parentVersionId,
      }),
    ).resolves.toStrictEqual(before);
  });

  it("acknowledges a proven committed retry after timeout without writes", async () => {
    const fixture = await sandboxStorageWriteFixture("timeout exact retry");
    const storages = createStoragesBddApi(context);
    const parentVersionId = fixture.mount.versionId;
    const files = [
      {
        path: "committed.txt",
        hash: createHash("sha256")
          .update(`committed ${fixture.runId}`)
          .digest("hex"),
        size: 4096,
      },
    ];
    const message = "committed before timeout";
    const prepared = await api.requestAgentStoragePrepare(
      {
        runId: fixture.runId,
        storageId: fixture.mount.storageId,
        parentVersionId,
        files,
      },
      fixture.headers,
      [200],
    );
    if (prepared.status !== 200) {
      throw new Error("Expected storage prepare to succeed before timeout");
    }
    await api.requestAgentStorageCommit(
      {
        runId: fixture.runId,
        storageId: fixture.mount.storageId,
        versionId: prepared.body.versionId,
        parentVersionId,
        files,
        message,
      },
      fixture.headers,
      [200],
    );
    const before = await storages.inspectWriteback({
      storageId: fixture.mount.storageId,
      versionId: prepared.body.versionId,
      runId: fixture.runId,
      parentVersionId,
    });
    expect(before.version).not.toBeNull();
    expect(before.lineageCount).toBe(1);

    const timeout = await transitionRunToTimeout(context, fixture.runId);
    expect(timeout.body.ok).toBeTruthy();

    const retried = await api.requestAgentStorageCommit(
      {
        runId: fixture.runId,
        storageId: fixture.mount.storageId,
        versionId: prepared.body.versionId,
        parentVersionId,
        files,
        message,
      },
      fixture.headers,
      [200],
    );
    if (retried.status !== 200) {
      throw new Error("Expected exact committed retry to succeed");
    }
    expect(retried.body).toMatchObject({
      success: true,
      versionId: prepared.body.versionId,
      size: 4096,
      fileCount: 1,
      deduplicated: true,
    });
    await expect(
      storages.inspectWriteback({
        storageId: fixture.mount.storageId,
        versionId: prepared.body.versionId,
        runId: fixture.runId,
        parentVersionId,
      }),
    ).resolves.toStrictEqual(before);
  });

  it("keeps a deduplicated head move provable after timeout", async () => {
    const fixture = await sandboxStorageWriteFixture(
      "timeout deduplicated retry",
    );
    const storages = createStoragesBddApi(context);
    const initialVersionId = fixture.mount.versionId;
    const restoredFiles = [
      {
        path: "restored.txt",
        hash: createHash("sha256")
          .update(`restored ${fixture.runId}`)
          .digest("hex"),
        size: 1024,
      },
    ];
    const restoredMessage = "restored before timeout";
    const restoredPrepare = await api.requestAgentStoragePrepare(
      {
        runId: fixture.runId,
        storageId: fixture.mount.storageId,
        parentVersionId: initialVersionId,
        files: restoredFiles,
      },
      fixture.headers,
      [200],
    );
    if (restoredPrepare.status !== 200) {
      throw new Error("Expected restored version prepare to succeed");
    }
    await api.requestAgentStorageCommit(
      {
        runId: fixture.runId,
        storageId: fixture.mount.storageId,
        versionId: restoredPrepare.body.versionId,
        parentVersionId: initialVersionId,
        files: restoredFiles,
        message: restoredMessage,
      },
      fixture.headers,
      [200],
    );

    const replacementFiles = [
      {
        path: "replacement.txt",
        hash: createHash("sha256")
          .update(`replacement ${fixture.runId}`)
          .digest("hex"),
        size: 4096,
      },
    ];
    const replacementPrepare = await api.requestAgentStoragePrepare(
      {
        runId: fixture.runId,
        storageId: fixture.mount.storageId,
        parentVersionId: restoredPrepare.body.versionId,
        files: replacementFiles,
      },
      fixture.headers,
      [200],
    );
    if (replacementPrepare.status !== 200) {
      throw new Error("Expected replacement version prepare to succeed");
    }
    await api.requestAgentStorageCommit(
      {
        runId: fixture.runId,
        storageId: fixture.mount.storageId,
        versionId: replacementPrepare.body.versionId,
        parentVersionId: restoredPrepare.body.versionId,
        files: replacementFiles,
        message: "replacement before restore",
      },
      fixture.headers,
      [200],
    );

    const restored = await api.requestAgentStorageCommit(
      {
        runId: fixture.runId,
        storageId: fixture.mount.storageId,
        versionId: restoredPrepare.body.versionId,
        parentVersionId: replacementPrepare.body.versionId,
        files: restoredFiles,
        message: restoredMessage,
      },
      fixture.headers,
      [200],
    );
    if (restored.status !== 200) {
      throw new Error("Expected deduplicated head move to succeed");
    }
    expect(restored.body).toMatchObject({
      success: true,
      versionId: restoredPrepare.body.versionId,
      size: 1024,
      fileCount: 1,
      deduplicated: true,
    });

    const before = await storages.inspectWriteback({
      storageId: fixture.mount.storageId,
      versionId: restoredPrepare.body.versionId,
      runId: fixture.runId,
      parentVersionId: replacementPrepare.body.versionId,
    });
    expect(before.storage).toMatchObject({
      headVersionId: restoredPrepare.body.versionId,
      size: 1024,
      fileCount: 1,
    });
    expect(before.lineageCount).toBe(1);

    const timeout = await transitionRunToTimeout(context, fixture.runId);
    expect(timeout.body.ok).toBeTruthy();
    const retried = await api.requestAgentStorageCommit(
      {
        runId: fixture.runId,
        storageId: fixture.mount.storageId,
        versionId: restoredPrepare.body.versionId,
        parentVersionId: replacementPrepare.body.versionId,
        files: restoredFiles,
        message: restoredMessage,
      },
      fixture.headers,
      [200],
    );
    if (retried.status !== 200) {
      throw new Error("Expected deduplicated exact retry to succeed");
    }
    expect(retried.body.deduplicated).toBeTruthy();
    await expect(
      storages.inspectWriteback({
        storageId: fixture.mount.storageId,
        versionId: restoredPrepare.body.versionId,
        runId: fixture.runId,
        parentVersionId: replacementPrepare.body.versionId,
      }),
    ).resolves.toStrictEqual(before);
  });
});

describe("WHCB-07: Stripe billing lifecycle webhooks", () => {
  it("uses each successful card payment as the customer default", async () => {
    api.configureStripeBillingEnv();
    const customerId = `cus_bdd_default_${randomUUID().slice(0, 8)}`;
    const cardPaymentMethodId = `pm_bdd_card_${randomUUID().slice(0, 8)}`;
    context.mocks.stripe.paymentMethods.retrieve.mockResolvedValueOnce({
      id: cardPaymentMethodId,
      type: "card",
      customer: customerId,
    });

    await api.postStripeEvent(
      stripeEvent({
        type: "payment_intent.succeeded",
        object: {
          id: `pi_bdd_card_${randomUUID().slice(0, 8)}`,
          customer: customerId,
          payment_method: cardPaymentMethodId,
          metadata: {},
        },
      }),
      [200],
    );

    expect(context.mocks.stripe.customers.update).toHaveBeenCalledWith(
      customerId,
      {
        invoice_settings: {
          default_payment_method: cardPaymentMethodId,
        },
      },
    );

    context.mocks.stripe.customers.update.mockClear();
    const bankPaymentMethodId = `pm_bdd_bank_${randomUUID().slice(0, 8)}`;
    context.mocks.stripe.paymentMethods.retrieve.mockResolvedValueOnce({
      id: bankPaymentMethodId,
      type: "us_bank_account",
      customer: customerId,
    });
    await api.postStripeEvent(
      stripeEvent({
        type: "payment_intent.succeeded",
        object: {
          id: `pi_bdd_bank_${randomUUID().slice(0, 8)}`,
          customer: customerId,
          payment_method: bankPaymentMethodId,
          metadata: {},
        },
      }),
      [200],
    );
    expect(context.mocks.stripe.customers.update).not.toHaveBeenCalled();
  });

  it("grants and renews Atom invoice-backed Team entitlements", async () => {
    const bdd = createBddApi(context);
    const billing = createBillingMediaApi(context);
    const runs = createRunsApi(context);
    const actor = bdd.user();
    const orgId = orgOf(actor);
    const grantExpiresAtUnix = epochSeconds(7);
    const renewedGrantExpiresAtUnix = epochSeconds(14);
    const suffix = randomUUID().slice(0, 8);
    api.configureStripeBillingEnv();
    context.mocks.stripe.subscriptions.list.mockResolvedValue({ data: [] });
    await completeOnboardingWithoutCredits(actor);

    await api.postStripeEvent(
      stripeEvent({
        type: "invoice.paid",
        object: {
          id: `in_bdd_atom_grant_${suffix}`,
          customer: `cus_bdd_atom_${suffix}`,
          metadata: {
            type: "atom_grant",
            purpose: "atom_grant",
            source: "atom_entitlement",
            orgId,
            tier: "team",
            duration: "7d",
            atomGrantExpiresAt: isoOf(grantExpiresAtUnix),
          },
          parent: null,
          lines: {
            has_more: false,
            data: [
              {
                id: `il_bdd_atom_grant_${suffix}`,
                quantity: 1,
                price: { id: "price_bdd_atom_grant" },
                period: {
                  start: epochSeconds(0),
                  end: grantExpiresAtUnix,
                },
                parent: { type: "invoice_item_details" },
              },
            ],
          },
        },
      }),
      [200],
    );

    const granted = await billing.readBillingStatus(actor);
    expect(granted.tier).toBe("team");
    expect(granted.credits).toBe(120_000);
    expect(granted.hasSubscription).toBeFalsy();
    expect(granted.currentPeriodEnd).toBe(isoOf(grantExpiresAtUnix));
    expect(granted.creditGrants).toStrictEqual([
      expect.objectContaining({
        amount: 120_000,
        expiresAt: isoOf(grantExpiresAtUnix),
        source: "subscription_renewal",
      }),
    ]);
    await expect(readOrgPlanEntitlementFixture(orgId)).resolves.toMatchObject({
      orgId,
      planKey: "team",
      planRank: 2,
      source: "stripe_atom_grant",
      status: "active",
      baseConcurrencyLimit: 10,
      canBuyConcurrency: true,
      autoRechargeAllowed: true,
      supportByok: true,
      restrictedBuiltInModels: false,
      videoGenerationAllowed: true,
      workflowWebhookAutomationAllowed: true,
      audioLifetimeLimit: null,
      audioDailyRateLimit: 500,
      audioDailyDurationSeconds: 30_000,
      stripeSubscriptionId: null,
      stripePriceId: "price_bdd_atom_grant",
      currentPeriodEnd: isoOf(grantExpiresAtUnix),
      expiresAt: isoOf(grantExpiresAtUnix),
    });

    await api.postStripeEvent(
      stripeEvent({
        type: "invoice.paid",
        object: {
          id: `in_bdd_atom_grant_renewed_${suffix}`,
          customer: `cus_bdd_atom_${suffix}`,
          metadata: {
            type: "atom_grant",
            purpose: "atom_grant",
            source: "atom_entitlement",
            orgId,
            tier: "team",
            duration: "7d",
            atomGrantExpiresAt: isoOf(renewedGrantExpiresAtUnix),
          },
          parent: null,
          lines: {
            has_more: false,
            data: [
              {
                id: `il_bdd_atom_grant_renewed_${suffix}`,
                quantity: 1,
                price: { id: "price_bdd_atom_grant" },
                period: {
                  start: grantExpiresAtUnix,
                  end: renewedGrantExpiresAtUnix,
                },
                parent: { type: "invoice_item_details" },
              },
            ],
          },
        },
      }),
      [200],
    );

    const renewed = await billing.readBillingStatus(actor);
    expect(renewed.tier).toBe("team");
    expect(renewed.credits).toBe(240_000);
    expect(renewed.hasSubscription).toBeFalsy();
    expect(renewed.currentPeriodEnd).toBe(isoOf(renewedGrantExpiresAtUnix));
    expect(renewed.creditGrants).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          amount: 120_000,
          expiresAt: isoOf(grantExpiresAtUnix),
          source: "subscription_renewal",
        }),
        expect.objectContaining({
          amount: 120_000,
          expiresAt: isoOf(renewedGrantExpiresAtUnix),
          source: "subscription_renewal",
        }),
      ]),
    );
    await expect(readOrgPlanEntitlementFixture(orgId)).resolves.toMatchObject({
      planKey: "team",
      currentPeriodStart: isoOf(grantExpiresAtUnix),
      currentPeriodEnd: isoOf(renewedGrantExpiresAtUnix),
      expiresAt: isoOf(renewedGrantExpiresAtUnix),
    });

    const expiredAt = new Date(now() - 1000);
    await expireAtomGrantFixture({ orgId, expiredAt });

    await runs.reconcileBillingOrganizations([orgId]);

    const downgraded = await billing.readBillingStatus(actor);
    expect(downgraded.tier).toBe("limited-free-1");
    expect(downgraded.credits).toBe(0);
    expect(downgraded.hasSubscription).toBeFalsy();
    expect(downgraded.creditGrants).toHaveLength(0);
    await expect(readOrgPlanEntitlementFixture(orgId)).resolves.toMatchObject({
      orgId,
      planKey: "limited-free-1",
      planRank: 0,
      source: "stripe_atom_grant",
      status: "active",
      stripeSubscriptionId: null,
      stripePriceId: null,
      currentPeriodEnd: null,
      expiresAt: null,
    });
  });

  it("upserts usage allowance entitlements from Atom subscription invoices", async () => {
    const bdd = createBddApi(context);
    const actor = bdd.user();
    const orgId = orgOf(actor);
    const suffix = randomUUID().slice(0, 8);
    const effectiveAtUnix = epochSeconds(0);
    const expiresAtUnix = epochSeconds(14);
    api.configureStripeBillingEnv();

    await api.postStripeEvent(
      stripeEvent({
        type: "invoice.paid",
        object: {
          id: `in_bdd_usage_allowance_${suffix}`,
          customer: `cus_bdd_allowance_${suffix}`,
          metadata: {
            type: "usage_allowance",
            purpose: "usage_allowance",
            source: "atom_usage_allowance",
            orgId,
            shortWindowSeconds: "3600",
            shortWindowUnits: "5000",
            weeklyWindowSeconds: "604800",
            weeklyWindowUnits: "50000",
          },
          parent: {
            subscription_details: {
              subscription: `sub_bdd_allowance_${suffix}`,
              metadata: {},
            },
          },
          lines: {
            has_more: false,
            data: [
              {
                id: `il_bdd_usage_allowance_${suffix}`,
                quantity: 1,
                price: { id: "price_bdd_atom_grant" },
                period: {
                  start: effectiveAtUnix,
                  end: expiresAtUnix,
                },
                parent: { type: "invoice_item_details" },
              },
            ],
          },
        },
      }),
      [200],
    );

    const entitlement = await readUsageAllowanceEntitlementFixture(orgId);
    expect(entitlement).toMatchObject({
      orgId,
      status: "active",
      shortWindowSeconds: 3600,
      shortWindowUnits: 5000,
      weeklyWindowSeconds: 604_800,
      weeklyWindowUnits: 50_000,
      effectiveAt: isoOf(effectiveAtUnix),
      expiresAt: isoOf(expiresAtUnix),
      stripeCustomerId: `cus_bdd_allowance_${suffix}`,
      stripeSubscriptionId: `sub_bdd_allowance_${suffix}`,
      stripeInvoiceId: `in_bdd_usage_allowance_${suffix}`,
    });

    const subscriptionPeriodEndUnix = epochSeconds(21);
    const cancelAtUnix = epochSeconds(60);
    await api.postStripeEvent(
      stripeEvent({
        type: "customer.subscription.updated",
        object: {
          id: `sub_bdd_allowance_${suffix}`,
          status: "active",
          cancel_at: cancelAtUnix,
          cancel_at_period_end: false,
          metadata: {
            type: "usage_allowance",
            purpose: "usage_allowance",
            orgId,
            shortWindowUnits: "9000",
            weeklyWindowUnits: "90000",
          },
          items: {
            data: [{ current_period_end: subscriptionPeriodEndUnix }],
          },
        },
      }),
      [200],
    );

    const canceledAtPeriod = await readUsageAllowanceEntitlementFixture(orgId);
    expect(canceledAtPeriod).toMatchObject({
      orgId,
      status: "active",
      shortWindowUnits: 9000,
      weeklyWindowUnits: 90_000,
      expiresAt: isoOf(subscriptionPeriodEndUnix),
      stripeSubscriptionId: `sub_bdd_allowance_${suffix}`,
    });

    const beforeCancel = nowDate();
    await api.postStripeEvent(
      stripeEvent({
        type: "customer.subscription.updated",
        object: {
          id: `sub_bdd_allowance_${suffix}`,
          status: "canceled",
          items: {
            data: [{ current_period_end: epochSeconds(30) }],
          },
        },
      }),
      [200],
    );
    const afterCancel = nowDate();

    const canceled = await readUsageAllowanceEntitlementFixture(orgId);
    expect(canceled).toMatchObject({
      orgId,
      status: "canceled",
      stripeSubscriptionId: `sub_bdd_allowance_${suffix}`,
    });
    expectIsoTimestampBetween(canceled?.expiresAt, beforeCancel, afterCancel);
  });

  it("ignores a canceled usage allowance invoice from an obsolete subscription", async () => {
    const bdd = createBddApi(context);
    const actor = bdd.user();
    const orgId = orgOf(actor);
    const suffix = randomUUID().slice(0, 8);
    const customerId = `cus_bdd_allowance_stale_${suffix}`;
    const currentSubscriptionId = `sub_bdd_allowance_current_${suffix}`;
    const staleSubscriptionId = `sub_bdd_allowance_stale_${suffix}`;
    const effectiveAtUnix = epochSeconds(-1);
    const expiresAtUnix = epochSeconds(30);

    await postUsageAllowanceInvoicePaid(context.signal, {
      orgId,
      userId: actor.userId,
      customerId,
      subscriptionId: currentSubscriptionId,
      effectiveAt: new Date(effectiveAtUnix * 1000),
      expiresAt: new Date(expiresAtUnix * 1000),
      shortWindowSeconds: 3600,
      shortWindowUnits: 5000,
      weeklyWindowSeconds: 604_800,
      weeklyWindowUnits: 50_000,
    });

    await api.postStripeEvent(
      stripeEvent({
        type: "invoice.paid",
        object: {
          id: `in_bdd_allowance_stale_${suffix}`,
          customer: customerId,
          metadata: {
            type: "usage_allowance",
            purpose: "usage_allowance",
            source: "atom_usage_allowance",
            orgId,
            allowanceStatus: "canceled",
            shortWindowSeconds: "3600",
            shortWindowUnits: "1000",
            weeklyWindowSeconds: "604800",
            weeklyWindowUnits: "10000",
          },
          parent: {
            subscription_details: {
              subscription: staleSubscriptionId,
              metadata: {},
            },
          },
          lines: {
            has_more: false,
            data: [
              {
                id: `il_bdd_allowance_stale_${suffix}`,
                quantity: 1,
                price: { id: `price_bdd_allowance_stale_${suffix}` },
                period: {
                  start: epochSeconds(-30),
                  end: epochSeconds(0),
                },
                parent: { type: "subscription_item_details" },
              },
            ],
          },
        },
      }),
      [200],
    );

    await expect(
      readUsageAllowanceEntitlementFixture(orgId),
    ).resolves.toMatchObject({
      status: "active",
      shortWindowUnits: 5000,
      weeklyWindowUnits: 50_000,
      expiresAt: isoOf(expiresAtUnix),
      stripeSubscriptionId: currentSubscriptionId,
    });
  });

  it("cancels usage allowance entitlements when their Stripe subscription is deleted", async () => {
    const bdd = createBddApi(context);
    const actor = bdd.user();
    const orgId = orgOf(actor);
    const suffix = randomUUID().slice(0, 8);
    const subscriptionId = `sub_bdd_allowance_delete_${suffix}`;
    api.configureStripeBillingEnv();

    await api.postStripeEvent(
      stripeEvent({
        type: "invoice.paid",
        object: {
          id: `in_bdd_usage_allowance_delete_${suffix}`,
          customer: `cus_bdd_allowance_delete_${suffix}`,
          metadata: {
            type: "usage_allowance",
            purpose: "usage_allowance",
            orgId,
            shortWindowSeconds: "3600",
            shortWindowUnits: "5000",
            weeklyWindowSeconds: "604800",
            weeklyWindowUnits: "50000",
          },
          parent: {
            subscription_details: {
              subscription: subscriptionId,
              metadata: {},
            },
          },
          lines: {
            has_more: false,
            data: [
              {
                id: `il_bdd_usage_allowance_delete_${suffix}`,
                quantity: 1,
                price: { id: "price_bdd_atom_grant" },
                period: {
                  start: epochSeconds(0),
                  end: epochSeconds(30),
                },
                parent: { type: "invoice_item_details" },
              },
            ],
          },
        },
      }),
      [200],
    );

    const beforeDelete = nowDate();
    await api.postStripeEvent(
      stripeEvent({
        type: "customer.subscription.deleted",
        object: { id: subscriptionId },
      }),
      [200],
    );
    const afterDelete = nowDate();

    const entitlement = await readUsageAllowanceEntitlementFixture(orgId);
    expect(entitlement).toMatchObject({
      orgId,
      status: "canceled",
      stripeSubscriptionId: subscriptionId,
    });
    expectIsoTimestampBetween(
      entitlement?.expiresAt,
      beforeDelete,
      afterDelete,
    );
  });

  it("expires Atom day-grant subscription credits at the Atom grant end", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const billing = createBillingMediaApi(context);
    const actor = bdd.user();
    const grantExpiresAtUnix = epochSeconds(7);

    await runs.grantProEntitlement(actor, {
      periodEndUnix: epochSeconds(30),
      cancelAtUnix: grantExpiresAtUnix,
      subscriptionMetadata: {
        source: "atom_entitlement",
        duration: "7d",
        atomGrantExpiresAt: isoOf(grantExpiresAtUnix),
      },
    });

    const status = await billing.readBillingStatus(actor);
    expect(status.tier).toBe("pro");
    expect(status.currentPeriodEnd).toBe(isoOf(grantExpiresAtUnix));
    expect(status.creditGrants).toStrictEqual([
      expect.objectContaining({
        amount: 20_000,
        expiresAt: isoOf(grantExpiresAtUnix),
        source: "subscription_renewal",
      }),
    ]);
  });

  it("keeps the normal credit window for a non-Atom early cancellation", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const billing = createBillingMediaApi(context);
    const actor = bdd.user();
    const cancelAtUnix = epochSeconds(7);
    const periodEndUnix = epochSeconds(30);
    const renewalExpiresAt = new Date(periodEndUnix * 1000);
    renewalExpiresAt.setMonth(renewalExpiresAt.getMonth() + 1);

    await runs.grantProEntitlement(actor, {
      periodEndUnix,
      cancelAtUnix,
    });

    const status = await billing.readBillingStatus(actor);
    expect(status.tier).toBe("pro");
    expect(status.currentPeriodEnd).toBe(isoOf(cancelAtUnix));
    expect(status.creditGrants).toStrictEqual([
      expect.objectContaining({
        amount: 20_000,
        expiresAt: renewalExpiresAt.toISOString(),
        source: "subscription_renewal",
      }),
    ]);
  });

  it("cancels replaced subscriptions and reads the Custom grant billing period", async () => {
    const bdd = createBddApi(context);
    const billing = createBillingMediaApi(context);
    const runs = createRunsApi(context);
    const actor = bdd.user();
    const orgId = orgOf(actor);
    const granted = await runs.grantProEntitlement(actor);
    const suffix = randomUUID().slice(0, 8);
    const grantStartsAtUnix = epochSeconds(0);
    const grantExpiresAtUnix = epochSeconds(7);

    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [
        {
          id: granted.subscriptionId,
          status: "active",
          metadata: { orgId: "org_wrong" },
          items: { data: [{ price: { id: "price_bdd_pro" } }] },
        },
      ],
    });
    context.mocks.stripe.subscriptions.cancel.mockResolvedValue({
      id: granted.subscriptionId,
    });

    await api.postStripeEvent(
      stripeEvent({
        type: "invoice.paid",
        object: {
          id: `in_bdd_atom_team_${suffix}`,
          customer: granted.customerId,
          metadata: {
            type: "atom_grant",
            purpose: "atom_grant",
            source: "atom_entitlement",
            orgId,
            tier: "team",
            duration: "7d",
            atomGrantExpiresAt: isoOf(grantExpiresAtUnix),
          },
          parent: null,
          lines: {
            has_more: false,
            data: [
              {
                id: `il_bdd_atom_team_${suffix}`,
                quantity: 1,
                price: { id: "price_bdd_atom_grant" },
                period: {
                  start: grantStartsAtUnix,
                  end: grantExpiresAtUnix,
                },
                parent: { type: "invoice_item_details" },
              },
            ],
          },
        },
      }),
      [200],
    );

    expect(context.mocks.stripe.subscriptions.cancel).toHaveBeenCalledWith(
      granted.subscriptionId,
      { invoice_now: false, prorate: false },
    );
    expect((await billing.readBillingStatus(actor)).tier).toBe("team");

    context.mocks.stripe.subscriptions.cancel.mockClear();
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [
        {
          id: "sub_bdd_team_replaced",
          status: "active",
          metadata: {},
          items: { data: [{ price: { id: "price_bdd_team" } }] },
        },
      ],
    });
    context.mocks.stripe.subscriptions.cancel.mockResolvedValue({
      id: "sub_bdd_team_replaced",
    });

    await api.postStripeEvent(
      stripeEvent({
        type: "invoice.paid",
        object: {
          id: `in_bdd_atom_custom_${suffix}`,
          customer: granted.customerId,
          metadata: {
            type: "atom_grant",
            purpose: "atom_grant",
            source: "atom_entitlement",
            orgId,
            tier: "custom",
            duration: "7d",
            atomGrantExpiresAt: isoOf(grantExpiresAtUnix),
          },
          parent: null,
          lines: {
            has_more: false,
            data: [
              {
                id: `il_bdd_atom_custom_${suffix}`,
                quantity: 1,
                price: { id: "price_bdd_atom_grant" },
                period: {
                  start: grantStartsAtUnix,
                  end: grantExpiresAtUnix,
                },
                parent: { type: "invoice_item_details" },
              },
            ],
          },
        },
      }),
      [200],
    );

    expect(context.mocks.stripe.subscriptions.cancel).toHaveBeenCalledWith(
      "sub_bdd_team_replaced",
      { invoice_now: false, prorate: false },
    );
    expect((await billing.readBillingStatus(actor)).tier).toBe("custom");
    expect((await billing.readUsageMembers(actor)).body.period).toStrictEqual({
      start: isoOf(grantStartsAtUnix),
      end: isoOf(grantExpiresAtUnix),
    });
  });

  it("reads the usage allowance subscription period for a forever Custom plan", async () => {
    const bdd = createBddApi(context);
    const billing = createBillingMediaApi(context);
    const actor = bdd.user();
    const orgId = orgOf(actor);
    const suffix = randomUUID().slice(0, 8);
    const customerId = `cus_bdd_custom_allowance_${suffix}`;
    const sharedSubscriptionId = `sub_bdd_custom_allowance_${suffix}`;
    const previousAllowanceSubscriptionId = `sub_bdd_custom_allowance_previous_${suffix}`;
    const customPriceId = `price_bdd_custom_main_${suffix}`;
    const allowancePriceId = `price_bdd_allowance_${suffix}`;
    const allowanceStartsAtUnix = epochSeconds(-1);
    const allowanceEndsAtUnix = epochSeconds(29);
    api.configureStripeBillingEnv();
    mockEnv("OKOU_PRICE_CUSTOM", customPriceId);
    context.mocks.stripe.subscriptions.list.mockResolvedValue({ data: [] });
    await completeOnboardingWithoutCredits(actor);

    await api.postStripeEvent(
      stripeEvent({
        type: "invoice.paid",
        object: {
          id: `in_bdd_atom_custom_forever_${suffix}`,
          customer: customerId,
          metadata: {
            type: "atom_grant",
            purpose: "atom_grant",
            source: "atom_entitlement",
            orgId,
            tier: "custom",
            duration: "forever",
          },
          parent: null,
          lines: {
            has_more: false,
            data: [
              {
                id: `il_bdd_atom_custom_forever_${suffix}`,
                quantity: 1,
                price: { id: "price_bdd_atom_grant" },
                period: {
                  start: epochSeconds(0),
                  end: epochSeconds(30),
                },
                parent: { type: "invoice_item_details" },
              },
            ],
          },
        },
      }),
      [200],
    );

    await postUsageAllowanceInvoicePaid(context.signal, {
      orgId,
      userId: actor.userId,
      customerId,
      subscriptionId: previousAllowanceSubscriptionId,
      effectiveAt: new Date(allowanceStartsAtUnix * 1000),
      expiresAt: new Date(allowanceEndsAtUnix * 1000),
      shortWindowSeconds: 5 * 60 * 60,
      shortWindowUnits: 625_000,
      weeklyWindowSeconds: 7 * 86_400,
      weeklyWindowUnits: 5_000_000,
    });
    mockEnv("OKOU_PRICE_CUSTOM", customPriceId);

    await api.postStripeEvent(
      stripeEvent({
        type: "customer.subscription.updated",
        object: {
          id: sharedSubscriptionId,
          customer: customerId,
          status: "active",
          cancel_at: null,
          cancel_at_period_end: false,
          schedule: null,
          metadata: {
            orgId,
            purpose: "custom_plan_subscription",
            tier: "custom",
            allowanceStatus: "active",
            allowancePriceId,
            allowanceCancelAt: isoOf(allowanceEndsAtUnix),
            shortWindowSeconds: String(5 * 60 * 60),
            shortWindowUnits: "625000",
            weeklyWindowSeconds: String(7 * 86_400),
            weeklyWindowUnits: "5000000",
          },
          items: {
            data: [
              {
                id: `si_custom_${suffix}`,
                price: { id: customPriceId },
                current_period_start: allowanceStartsAtUnix,
                current_period_end: allowanceEndsAtUnix,
              },
              {
                id: `si_allowance_${suffix}`,
                price: { id: allowancePriceId },
                current_period_start: allowanceStartsAtUnix,
                current_period_end: allowanceEndsAtUnix,
              },
            ],
          },
        },
      }),
      [200],
    );

    const status = await billing.readBillingStatus(actor);
    expect(status.tier).toBe("custom");
    expect(status.hasSubscription).toBeTruthy();
    await expect(readOrgPlanEntitlementFixture(orgId)).resolves.toMatchObject({
      planKey: "custom",
      stripeSubscriptionId: sharedSubscriptionId,
      stripePriceId: customPriceId,
    });
    expect((await billing.readUsageMembers(actor)).body.period).toStrictEqual({
      start: isoOf(allowanceStartsAtUnix),
      end: isoOf(allowanceEndsAtUnix),
    });

    const staleSubscriptionId = `sub_bdd_custom_allowance_stale_${suffix}`;
    await api.postStripeEvent(
      stripeEvent({
        type: "customer.subscription.updated",
        object: {
          id: staleSubscriptionId,
          customer: customerId,
          status: "active",
          cancel_at: null,
          cancel_at_period_end: false,
          schedule: null,
          metadata: {
            orgId,
            purpose: "usage_allowance",
            allowanceStatus: "active",
            allowancePriceId,
            shortWindowSeconds: String(5 * 60 * 60),
            shortWindowUnits: "1000",
            weeklyWindowSeconds: String(7 * 86_400),
            weeklyWindowUnits: "10000",
          },
          items: {
            data: [
              {
                id: `si_stale_allowance_${suffix}`,
                price: { id: allowancePriceId },
                current_period_start: allowanceStartsAtUnix,
                current_period_end: epochSeconds(60),
              },
            ],
          },
        },
      }),
      [200],
    );

    await expect(
      readUsageAllowanceEntitlementFixture(orgId),
    ).resolves.toMatchObject({
      status: "active",
      shortWindowUnits: 625_000,
      weeklyWindowUnits: 5_000_000,
      expiresAt: isoOf(allowanceEndsAtUnix),
      stripeSubscriptionId: sharedSubscriptionId,
    });
  });

  it("rejects lower Atom grants after a Custom grant without canceling subscriptions", async () => {
    const bdd = createBddApi(context);
    const billing = createBillingMediaApi(context);
    const runs = createRunsApi(context);
    const actor = bdd.user();
    const orgId = orgOf(actor);
    const suffix = randomUUID().slice(0, 8);
    const grantExpiresAtUnix = epochSeconds(30);
    api.configureStripeBillingEnv();
    await completeOnboardingWithoutCredits(actor);

    await api.postStripeEvent(
      stripeEvent({
        type: "invoice.paid",
        object: {
          id: `in_bdd_atom_custom_initial_${suffix}`,
          customer: `cus_bdd_atom_custom_${suffix}`,
          metadata: {
            type: "atom_grant",
            purpose: "atom_grant",
            source: "atom_entitlement",
            orgId,
            tier: "custom",
            duration: "30d",
            atomGrantExpiresAt: isoOf(grantExpiresAtUnix),
          },
          parent: null,
          lines: {
            has_more: false,
            data: [
              {
                id: `il_bdd_atom_custom_initial_${suffix}`,
                quantity: 1,
                price: { id: "price_bdd_atom_grant" },
                period: {
                  start: epochSeconds(0),
                  end: grantExpiresAtUnix,
                },
                parent: { type: "invoice_item_details" },
              },
            ],
          },
        },
      }),
      [200],
    );

    context.mocks.stripe.subscriptions.cancel.mockClear();
    await api.postStripeEvent(
      stripeEvent({
        type: "invoice.paid",
        object: {
          id: `in_bdd_atom_team_after_custom_${suffix}`,
          customer: `cus_bdd_atom_custom_${suffix}`,
          metadata: {
            type: "atom_grant",
            purpose: "atom_grant",
            source: "atom_entitlement",
            orgId,
            tier: "team",
            duration: "30d",
            atomGrantExpiresAt: isoOf(grantExpiresAtUnix),
          },
          parent: null,
          lines: {
            has_more: false,
            data: [
              {
                id: `il_bdd_atom_team_after_custom_${suffix}`,
                quantity: 1,
                price: { id: "price_bdd_atom_grant" },
                period: {
                  start: epochSeconds(0),
                  end: grantExpiresAtUnix,
                },
                parent: { type: "invoice_item_details" },
              },
            ],
          },
        },
      }),
      [200],
    );

    expect(context.mocks.stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect((await billing.readBillingStatus(actor)).tier).toBe("custom");

    const expiredAt = new Date(now() - 1000);
    await expireAtomGrantFixture({ orgId, expiredAt });
    await runs.reconcileBillingOrganizations([orgId]);

    const downgraded = await billing.readBillingStatus(actor);
    expect(downgraded.tier).toBe("limited-free-1");
    expect(downgraded.hasSubscription).toBeFalsy();
  });

  it("expires Atom redeem-code day-grant subscription credits at the grant end", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const billing = createBillingMediaApi(context);
    const actor = bdd.user();
    const grantExpiresAtUnix = epochSeconds(7);

    await runs.grantProEntitlement(actor, {
      periodEndUnix: epochSeconds(30),
      cancelAtUnix: grantExpiresAtUnix,
      subscriptionMetadata: {
        source: "atom_redeem_code",
        duration: "7d",
        atomGrantExpiresAt: isoOf(grantExpiresAtUnix),
      },
    });

    const status = await billing.readBillingStatus(actor);
    expect(status.tier).toBe("pro");
    expect(status.currentPeriodEnd).toBe(isoOf(grantExpiresAtUnix));
    expect(status.creditGrants).toStrictEqual([
      expect.objectContaining({
        amount: 20_000,
        expiresAt: isoOf(grantExpiresAtUnix),
        source: "subscription_renewal",
      }),
    ]);
  });

  it("uses the normal renewal credit window when an Atom day-grant cancel_at is cleared", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const billing = createBillingMediaApi(context);
    const actor = bdd.user();
    const grantExpiresAtUnix = epochSeconds(7);
    const periodEndUnix = epochSeconds(30);
    const renewalExpiresAt = new Date(periodEndUnix * 1000);
    renewalExpiresAt.setMonth(renewalExpiresAt.getMonth() + 1);

    await runs.grantProEntitlement(actor, {
      periodEndUnix,
      cancelAtUnix: null,
      subscriptionMetadata: {
        source: "atom_entitlement",
        duration: "7d",
        atomGrantExpiresAt: isoOf(grantExpiresAtUnix),
      },
    });

    const status = await billing.readBillingStatus(actor);
    expect(status.tier).toBe("pro");
    expect(status.currentPeriodEnd).toBe(isoOf(periodEndUnix));
    expect(status.creditGrants).toStrictEqual([
      expect.objectContaining({
        amount: 20_000,
        expiresAt: renewalExpiresAt.toISOString(),
        source: "subscription_renewal",
      }),
    ]);
  });

  it("replays and expires subscription invoice credits", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const billing = createBillingMediaApi(context);
    const actor = bdd.user();
    const granted = await runs.grantProEntitlement(actor);

    const baseline = await billing.readBillingStatus(actor);
    expect(baseline.tier).toBe("pro");
    expect(baseline.credits).toBe(20_000);
    expect(baseline.creditGrants).toHaveLength(1);

    // Redelivering the processed entitlement invoice grants nothing more.
    await api.postStripeEvent(
      stripeEvent({
        type: "invoice.paid",
        object: {
          id: granted.invoiceId,
          customer: granted.customerId,
          metadata: {},
          parent: {
            subscription_details: { subscription: granted.subscriptionId },
          },
          lines: subscriptionLines(epochSeconds(30)),
        },
      }),
      [200],
    );
    const afterReplay = await billing.readBillingStatus(actor);
    expect(afterReplay.credits).toBe(20_000);
    expect(afterReplay.creditGrants).toHaveLength(1);

    // An invoice whose subscription period already ended grants credits that
    // immediately count as expired-but-unsettled.
    const staleEpoch = epochSeconds(-60);
    const staleInvoiceId = `in_bdd_stale_${randomUUID().slice(0, 8)}`;
    const staleInvoice = {
      id: staleInvoiceId,
      customer: granted.customerId,
      metadata: {},
      parent: {
        subscription_details: { subscription: granted.subscriptionId },
      },
      lines: subscriptionLines(staleEpoch),
    };
    await api.postStripeEvent(
      stripeEvent({ type: "invoice.paid", object: staleInvoice }),
      [200],
    );
    const afterStale = await billing.readBillingStatus(actor);
    expect(afterStale.credits).toBe(20_000);
    expect(afterStale.creditGrants).toHaveLength(1);
    expect(afterStale.currentPeriodEnd).toBe(isoOf(staleEpoch));

    // The next renewal settles the expired grant before granting again.
    await api.postStripeEvent(
      stripeEvent({
        type: "invoice.paid",
        object: {
          id: `in_bdd_renewal_${randomUUID().slice(0, 8)}`,
          customer: granted.customerId,
          metadata: {},
          parent: {
            subscription_details: { subscription: granted.subscriptionId },
          },
          lines: subscriptionLines(epochSeconds(30)),
        },
      }),
      [200],
    );
    const afterRenewal = await billing.readBillingStatus(actor);
    expect(afterRenewal.credits).toBe(40_000);
    expect(afterRenewal.creditGrants).toHaveLength(2);

    // Concurrent duplicate deliveries of one invoice grant exactly once.
    const concurrentInvoice = {
      id: `in_bdd_concurrent_${randomUUID().slice(0, 8)}`,
      customer: granted.customerId,
      metadata: {},
      parent: {
        subscription_details: { subscription: granted.subscriptionId },
      },
      lines: subscriptionLines(epochSeconds(45)),
    };
    await Promise.all([
      api.postStripeEvent(
        stripeEvent({ type: "invoice.paid", object: concurrentInvoice }),
        [200],
      ),
      api.postStripeEvent(
        stripeEvent({ type: "invoice.paid", object: concurrentInvoice }),
        [200],
      ),
    ]);
    const afterConcurrent = await billing.readBillingStatus(actor);
    expect(afterConcurrent.credits).toBe(60_000);
    expect(afterConcurrent.creditGrants).toHaveLength(3);

    // A stale invoice redelivered after later renewals hits the existing
    // expires record and grants nothing.
    await api.postStripeEvent(
      stripeEvent({ type: "invoice.paid", object: staleInvoice }),
      [200],
    );
    expect((await billing.readBillingStatus(actor)).credits).toBe(60_000);

    // Invoices without a Plan line can belong to another item on the shared
    // subscription and must not renew Plan credits.
    await api.postStripeEvent(
      stripeEvent({
        type: "invoice.paid",
        object: {
          id: `in_bdd_broken_${randomUUID().slice(0, 8)}`,
          customer: granted.customerId,
          metadata: {},
          parent: {
            subscription_details: { subscription: granted.subscriptionId },
          },
          lines: {
            has_more: false,
            data: [],
          },
        },
      }),
      [200],
    );
    expect((await billing.readBillingStatus(actor)).credits).toBe(60_000);
  });

  it("atomically accumulates distinct auto-recharge invoices", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const billing = createBillingMediaApi(context);
    const actor = bdd.user();
    const orgId = orgOf(actor);
    const granted = await runs.grantProEntitlement(actor);

    expect((await billing.readBillingStatus(actor)).credits).toBe(20_000);

    // Concurrent auto-recharge invoices accumulate distinct grants while a
    // duplicate delivery still grants exactly once.
    const autoRechargeInvoiceA = {
      id: `in_bdd_auto_${randomUUID().slice(0, 8)}`,
      customer: granted.customerId,
      metadata: {
        type: "auto_recharge",
        orgId,
        creditsAmount: "5000",
      },
      parent: null,
    };
    const autoRechargeInvoiceB = {
      ...autoRechargeInvoiceA,
      id: `in_bdd_auto_${randomUUID().slice(0, 8)}`,
    };
    await Promise.all([
      api.postStripeEvent(
        stripeEvent({ type: "invoice.paid", object: autoRechargeInvoiceA }),
        [200],
      ),
      api.postStripeEvent(
        stripeEvent({ type: "invoice.paid", object: autoRechargeInvoiceA }),
        [200],
      ),
      api.postStripeEvent(
        stripeEvent({ type: "invoice.paid", object: autoRechargeInvoiceB }),
        [200],
      ),
    ]);
    const final = await billing.readBillingStatus(actor);
    expect(final.credits).toBe(30_000);
    const autoGrants = final.creditGrants.filter((grant) => {
      return grant.source === "auto_recharge";
    });
    expect(autoGrants).toHaveLength(2);
    for (const autoGrant of autoGrants) {
      expect(autoGrant.amount).toBe(5000);
      expect(autoGrant.remaining).toBe(5000);
      expect(
        new Date(autoGrant.expiresAt).getUTCFullYear(),
      ).toBeGreaterThanOrEqual(2999);
    }
  });

  it("grants, refreshes, and clamps trial credits from trial-period invoices", async () => {
    const bdd = createBddApi(context);
    const billing = createBillingMediaApi(context);
    const actor = bdd.user();
    const orgId = orgOf(actor);
    api.configureStripeBillingEnv();
    await completeOnboardingWithoutCredits(actor);

    const suffix = randomUUID().slice(0, 8);
    const customerId = `cus_bdd_trial_${suffix}`;
    const subscriptionId = `sub_bdd_trial_${suffix}`;
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      metadata: { orgId },
    });

    // The first trial invoice arrives before any binding: the customer is
    // bound from its metadata and trial credits expire at the trial end.
    const trialEnd1 = epochSeconds(7);
    const periodEnd1 = epochSeconds(30);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce(
      proSubscription({
        id: subscriptionId,
        customerId,
        status: "trialing",
        trialEnd: trialEnd1,
      }),
    );
    await api.postStripeEvent(
      stripeEvent({
        type: "invoice.paid",
        object: {
          id: `in_bdd_trial1_${suffix}`,
          customer: customerId,
          metadata: {},
          parent: { subscription_details: { subscription: subscriptionId } },
          lines: subscriptionLines(periodEnd1),
        },
      }),
      [200],
    );
    const grantedStatus = await billing.readBillingStatus(actor);
    expect(grantedStatus.tier).toBe("pro");
    expect(grantedStatus.credits).toBe(20_000);
    expect(grantedStatus.subscriptionStatus).toBe("trialing");
    expect(grantedStatus.currentPeriodEnd).toBe(isoOf(periodEnd1));
    expect(grantedStatus.creditExpiry.nextExpiryDate).toBe(isoOf(trialEnd1));

    // A later trial invoice refreshes the expiry without granting again.
    const trialEnd2 = epochSeconds(14);
    const periodEnd2 = epochSeconds(60);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce(
      proSubscription({
        id: subscriptionId,
        customerId,
        status: "trialing",
        trialEnd: trialEnd2,
      }),
    );
    await api.postStripeEvent(
      stripeEvent({
        type: "invoice.paid",
        object: {
          id: `in_bdd_trial2_${suffix}`,
          customer: customerId,
          metadata: {},
          parent: { subscription_details: { subscription: subscriptionId } },
          lines: subscriptionLines(periodEnd2),
        },
      }),
      [200],
    );
    const refreshed = await billing.readBillingStatus(actor);
    expect(refreshed.credits).toBe(20_000);
    expect(refreshed.creditGrants).toHaveLength(1);
    expect(refreshed.currentPeriodEnd).toBe(isoOf(periodEnd2));
    expect(refreshed.creditExpiry.nextExpiryDate).toBe(isoOf(trialEnd2));

    // Shortening the trial clamps the paid-through date and credit expiry.
    const trialEnd3 = epochSeconds(10);
    await api.postStripeEvent(
      stripeEvent({
        type: "customer.subscription.updated",
        object: {
          id: subscriptionId,
          status: "trialing",
          trial_end: trialEnd3,
          cancel_at_period_end: false,
          metadata: {},
          items: {
            data: [
              { price: { id: "price_bdd_pro" }, current_period_end: trialEnd3 },
            ],
          },
        },
        previousAttributes: { trial_end: trialEnd2 },
      }),
      [200],
    );
    const clamped = await billing.readBillingStatus(actor);
    expect(clamped.credits).toBe(20_000);
    expect(clamped.currentPeriodEnd).toBe(isoOf(trialEnd3));
    expect(clamped.creditExpiry.nextExpiryDate).toBe(isoOf(trialEnd3));

    // A trialing checkout completion binds the customer without re-granting.
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce(
      proSubscription({
        id: subscriptionId,
        customerId,
        status: "trialing",
        trialEnd: trialEnd3,
        metadata: { gclid: "bdd-trial-gclid" },
      }),
    );
    const trialSessionId = `cs_bdd_trial_${suffix}`;
    await api.postStripeEvent(
      stripeEvent({
        type: "checkout.session.completed",
        object: {
          id: trialSessionId,
          subscription: subscriptionId,
          customer: customerId,
          metadata: null,
        },
      }),
      [200],
    );
    const afterTrialCheckout = await billing.readBillingStatus(actor);
    expect(afterTrialCheckout.credits).toBe(20_000);
  });

  it("upgrades to team, drains the queue, and cancels the replaced pro subscription", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const billing = createBillingMediaApi(context);
    const actor = bdd.user();
    const orgId = orgOf(actor);
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    runs.configureRunnerGroup();
    const granted = await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD Team Upgrade Agent",
      visibility: "private",
    });

    const first = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "team upgrade run one",
      modelProvider: "anthropic-api-key",
    });
    const second = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "team upgrade run two",
      modelProvider: "anthropic-api-key",
    });
    const third = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "team upgrade run three",
      modelProvider: "anthropic-api-key",
    });
    expect(third.status).toBe("queued");
    const queuedBefore = await runs.readRunQueue(actor);
    expect(queuedBefore.body.concurrency.active).toBe(2);
    expect(queuedBefore.body.queue).toHaveLength(1);

    const suffix = randomUUID().slice(0, 8);
    const teamSubscriptionId = `sub_bdd_team_${suffix}`;
    const teamInvoiceId = `in_bdd_team_${suffix}`;
    const teamPeriodEnd = epochSeconds(30);
    const teamSubscription = {
      id: teamSubscriptionId,
      status: "active",
      customer: granted.customerId,
      cancel_at: null,
      cancel_at_period_end: false,
      schedule: null,
      trial_end: null,
      metadata: {},
      items: { data: [{ price: { id: "price_bdd_team" } }] },
    };
    context.mocks.stripe.subscriptions.retrieve
      .mockResolvedValueOnce(teamSubscription)
      .mockResolvedValueOnce(teamSubscription)
      .mockResolvedValueOnce(teamSubscription);
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [
        {
          id: teamSubscriptionId,
          status: "active",
          metadata: { orgId: "org_wrong" },
          items: { data: [{ price: { id: "price_bdd_team" } }] },
        },
        {
          id: granted.subscriptionId,
          status: "active",
          metadata: { orgId: "org_wrong" },
          items: { data: [{ price: { id: "price_bdd_pro" } }] },
        },
      ],
    });
    context.mocks.stripe.subscriptions.cancel.mockResolvedValue({
      id: granted.subscriptionId,
    });

    const teamInvoice = {
      id: teamInvoiceId,
      customer: granted.customerId,
      metadata: {},
      parent: { subscription_details: { subscription: teamSubscriptionId } },
      lines: subscriptionLines(teamPeriodEnd, "price_bdd_team"),
    };
    await Promise.all([
      api.postStripeEvent(
        stripeEvent({ type: "invoice.paid", object: teamInvoice }),
        [200],
      ),
      api.postStripeEvent(
        stripeEvent({ type: "invoice.paid", object: teamInvoice }),
        [200],
      ),
    ]);

    expect(context.mocks.stripe.subscriptions.cancel).toHaveBeenCalledWith(
      granted.subscriptionId,
      { invoice_now: false, prorate: false },
    );
    const upgraded = await billing.readBillingStatus(actor);
    expect(upgraded.tier).toBe("team");
    expect(upgraded.credits).toBe(140_000);
    expect(
      upgraded.creditGrants.filter((grant) => {
        return grant.amount === 120_000;
      }),
    ).toHaveLength(1);
    await expect(readOrgPlanEntitlementFixture(orgId)).resolves.toMatchObject({
      orgId,
      planKey: "team",
      planRank: 2,
      source: "stripe_subscription",
      status: "active",
      baseConcurrencyLimit: 10,
      canBuyConcurrency: true,
      autoRechargeAllowed: true,
      supportByok: true,
      restrictedBuiltInModels: false,
      videoGenerationAllowed: true,
      workflowWebhookAutomationAllowed: true,
      audioLifetimeLimit: null,
      audioDailyRateLimit: 500,
      audioDailyDurationSeconds: 30_000,
      stripeSubscriptionId: teamSubscriptionId,
      stripePriceId: "price_bdd_team",
      currentPeriodEnd: isoOf(teamPeriodEnd),
      cancelAt: null,
      expiresAt: null,
    });

    const drained = await runs.readRunQueue(actor);
    expect(drained.body.concurrency.tier).toBe("team");
    expect(drained.body.queue).toHaveLength(0);
    expect(drained.body.concurrency.active).toBe(3);

    // Redelivering the processed team invoice re-runs lingering-pro cleanup.
    const cancelCallsBefore =
      context.mocks.stripe.subscriptions.cancel.mock.calls.length;
    await deleteOrgPlanEntitlementFixture(orgId);
    await api.postStripeEvent(
      stripeEvent({ type: "invoice.paid", object: teamInvoice }),
      [200],
    );
    expect(
      context.mocks.stripe.subscriptions.cancel.mock.calls.length,
    ).toBeGreaterThan(cancelCallsBefore);
    await expect(readOrgPlanEntitlementFixture(orgId)).resolves.toMatchObject({
      planKey: "team",
      stripeSubscriptionId: teamSubscriptionId,
    });
    expect((await billing.readBillingStatus(actor)).credits).toBe(140_000);

    // A lower-tier subscription invoice cannot replace the team subscription.
    await api.postStripeEvent(
      stripeEvent({
        type: "invoice.paid",
        object: {
          id: `in_bdd_lower_${suffix}`,
          customer: granted.customerId,
          metadata: {},
          parent: {
            subscription_details: {
              subscription: `sub_bdd_lower_${suffix}`,
            },
          },
          lines: subscriptionLines(epochSeconds(30)),
        },
      }),
      [200],
    );
    const unchanged = await billing.readBillingStatus(actor);
    expect(unchanged.tier).toBe("team");
    expect(unchanged.credits).toBe(140_000);

    // A downgrade-purpose setup checkout on the team org schedules the
    // period-end downgrade to pro through a new subscription schedule.
    const downgradeScheduleId = `sched_bdd_downgrade_${suffix}`;
    const phaseStart = epochSeconds(0);
    const phaseEnd = epochSeconds(30);
    const discountId = `di_bdd_${suffix}`;
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: teamSubscriptionId,
      status: "active",
      customer: granted.customerId,
      cancel_at: null,
      cancel_at_period_end: false,
      schedule: null,
      trial_end: null,
      metadata: {},
      discounts: [discountId],
      items: {
        data: [
          {
            id: `si_bdd_team_${suffix}`,
            current_period_start: phaseStart,
            current_period_end: phaseEnd,
            quantity: 1,
            price: {
              id: "price_bdd_team",
              recurring: { interval: "month", interval_count: 1 },
            },
          },
        ],
      },
    });
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValueOnce({
      id: downgradeScheduleId,
      current_phase: { start_date: phaseStart, end_date: phaseEnd },
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValueOnce({
      id: downgradeScheduleId,
    });
    await api.postStripeEvent(
      stripeEvent({
        type: "checkout.session.completed",
        object: {
          id: `cs_bdd_team_downgrade_${suffix}`,
          mode: "setup",
          subscription: null,
          customer: granted.customerId,
          setup_intent: {
            id: `seti_bdd_team_${suffix}`,
            payment_method: "pm_bdd_team_downgrade",
          },
          metadata: {
            purpose: "billing_downgrade",
            orgId,
            subscriptionId: teamSubscriptionId,
            targetTier: "pro",
          },
        },
      }),
      [200],
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).toHaveBeenCalledWith({ from_subscription: teamSubscriptionId });
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(downgradeScheduleId, {
      end_behavior: "release",
      proration_behavior: "none",
      phases: [
        {
          start_date: phaseStart,
          end_date: phaseEnd,
          items: [{ price: "price_bdd_team", quantity: 1 }],
          proration_behavior: "none",
          discounts: [{ discount: discountId }],
        },
        {
          start_date: phaseEnd,
          duration: { interval: "month", interval_count: 1 },
          items: [{ price: "price_bdd_pro", quantity: 1 }],
          proration_behavior: "none",
          discounts: [{ discount: discountId }],
        },
      ],
    });
    const downgradeScheduled = await billing.readBillingStatus(actor);
    expect(downgradeScheduled.cancelAtPeriodEnd).toBeFalsy();
    expect(downgradeScheduled.scheduledChange).toStrictEqual({
      type: "downgrade",
      targetTier: "pro",
      effectiveDate: isoOf(phaseEnd),
    });

    // Deleting the team subscription moves the organization back to limited free.
    await api.postStripeEvent(
      stripeEvent({
        type: "customer.subscription.deleted",
        object: { id: teamSubscriptionId, metadata: {} },
      }),
      [200],
    );
    const suspended = await billing.readBillingStatus(actor);
    expect(suspended.tier).toBe("limited-free-1");
    expect(suspended.subscriptionStatus).toBe("canceled");
    expect(suspended.hasSubscription).toBeFalsy();
    expect(suspended.scheduledChange).toBeNull();
    await expect(readOrgPlanEntitlementFixture(orgId)).resolves.toMatchObject({
      orgId,
      planKey: "limited-free-1",
      planRank: 0,
      source: "stripe_subscription",
      status: "active",
      baseConcurrencyLimit: 1,
      canBuyConcurrency: false,
      autoRechargeAllowed: false,
      supportByok: false,
      restrictedBuiltInModels: true,
      videoGenerationAllowed: false,
      workflowWebhookAutomationAllowed: false,
      audioLifetimeLimit: 10,
      audioDailyRateLimit: 10,
      audioDailyDurationSeconds: 600,
      stripeSubscriptionId: null,
      stripePriceId: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAt: null,
      expiresAt: null,
    });

    await runs.requestCancelRun(actor, first.runId, [200]);
    await runs.requestCancelRun(actor, second.runId, [200]);
    await runs.requestCancelRun(actor, third.runId, [200]);
    const settled = await runs.readRunQueue(actor);
    expect(settled.body.concurrency.active).toBe(0);
  });

  it("recognizes an Atom Custom price as the main subscription without granting Plan credits", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const billing = createBillingMediaApi(context);
    const actor = bdd.user();
    const orgId = orgOf(actor);
    const granted = await runs.grantProEntitlement(actor);
    const creditsBefore = (await billing.readBillingStatus(actor)).credits;
    const suffix = randomUUID().slice(0, 8);
    const customPriceId = `price_bdd_custom_${suffix}`;
    const customSubscriptionId = `sub_bdd_custom_${suffix}`;
    const customInvoiceId = `in_bdd_custom_${suffix}`;
    const allowancePriceId = `price_bdd_custom_allowance_${suffix}`;
    const periodEnd = epochSeconds(30);
    api.configureStripeBillingEnv();
    mockEnv("OKOU_PRICE_CUSTOM", customPriceId);

    const customSubscription = {
      id: customSubscriptionId,
      status: "active",
      customer: granted.customerId,
      cancel_at: periodEnd,
      cancel_at_period_end: false,
      schedule: null,
      trial_end: null,
      metadata: {
        orgId,
        purpose: "custom_plan_subscription",
        tier: "custom",
      },
      items: {
        data: [
          {
            price: { id: customPriceId },
          },
          {
            price: { id: allowancePriceId },
          },
          {
            price: { id: "price_bdd_concurrency" },
            quantity: 3,
          },
        ],
      },
    };
    context.mocks.stripe.prices.retrieve.mockResolvedValueOnce({
      id: allowancePriceId,
      product: {
        metadata: {
          type: "usage_allowance",
          purpose: "usage_allowance",
          source: "atom_usage_allowance",
          orgId,
          shortWindowSeconds: "3600",
          shortWindowUnits: "5000",
          weeklyWindowSeconds: "604800",
          weeklyWindowUnits: "50000",
        },
      },
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce(
      customSubscription,
    );
    context.mocks.stripe.subscriptions.list.mockResolvedValueOnce({
      data: [
        customSubscription,
        {
          id: granted.subscriptionId,
          status: "active",
          metadata: {},
          items: { data: [{ price: { id: "price_bdd_pro" } }] },
        },
      ],
    });
    context.mocks.stripe.subscriptions.cancel.mockResolvedValueOnce({
      id: granted.subscriptionId,
    });

    await api.postStripeEvent(
      stripeEvent({
        type: "invoice.paid",
        object: {
          id: customInvoiceId,
          customer: granted.customerId,
          metadata: {},
          parent: {
            subscription_details: { subscription: customSubscriptionId },
          },
          lines: {
            data: [
              {
                price: { id: customPriceId },
                period: { start: epochSeconds(0), end: periodEnd },
                parent: { type: "subscription_item_details" },
              },
              {
                price: { id: allowancePriceId },
                period: { start: epochSeconds(0), end: periodEnd },
                parent: { type: "subscription_item_details" },
              },
              {
                price: { id: "price_bdd_concurrency" },
                quantity: 3,
                period: { start: epochSeconds(0), end: periodEnd },
                parent: { type: "subscription_item_details" },
              },
            ],
          },
        },
      }),
      [200],
    );

    expect(context.mocks.stripe.subscriptions.cancel).toHaveBeenCalledWith(
      granted.subscriptionId,
      { invoice_now: false, prorate: false },
    );
    const customStatus = await billing.readBillingStatus(actor);
    expect(customStatus.tier).toBe("custom");
    expect(customStatus.credits).toBe(creditsBefore);
    expect(customStatus.hasSubscription).toBeTruthy();
    expect(customStatus.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({
        id: customSubscriptionId,
        quantity: 3,
      }),
    ]);
    await expect(
      readUsageAllowanceEntitlementFixture(orgId),
    ).resolves.toMatchObject({
      status: "active",
      stripeSubscriptionId: customSubscriptionId,
      shortWindowUnits: 5000,
      weeklyWindowUnits: 50_000,
    });
    await expect(readOrgPlanEntitlementFixture(orgId)).resolves.toMatchObject({
      planKey: "custom",
      source: "stripe_subscription",
      stripeSubscriptionId: customSubscriptionId,
      stripePriceId: customPriceId,
      currentPeriodEnd: isoOf(periodEnd),
      cancelAt: isoOf(periodEnd),
      expiresAt: isoOf(periodEnd),
    });

    await api.postStripeEvent(
      stripeEvent({
        type: "customer.subscription.deleted",
        object: { id: customSubscriptionId, metadata: {} },
      }),
      [200],
    );
    const canceled = await billing.readBillingStatus(actor);
    expect(canceled.tier).toBe("limited-free-1");
    expect(canceled.hasSubscription).toBeFalsy();
  });

  it("keeps a team upgrade when the replaced pro subscription is already absent", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const billing = createBillingMediaApi(context);
    const actor = bdd.user();
    const granted = await runs.grantProEntitlement(actor);

    const suffix = randomUUID().slice(0, 8);
    const teamSubscriptionId = `sub_bdd_team_missing_${suffix}`;
    const teamInvoiceId = `in_bdd_team_missing_${suffix}`;
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: teamSubscriptionId,
      status: "active",
      customer: granted.customerId,
      cancel_at: null,
      cancel_at_period_end: false,
      schedule: null,
      trial_end: null,
      metadata: {},
      items: { data: [{ price: { id: "price_bdd_team" } }] },
    });
    context.mocks.stripe.subscriptions.list.mockResolvedValueOnce({
      data: [],
    });
    context.mocks.stripe.subscriptions.cancel.mockRejectedValueOnce({
      code: "resource_missing",
    });

    await api.postStripeEvent(
      stripeEvent({
        type: "invoice.paid",
        object: {
          id: teamInvoiceId,
          customer: granted.customerId,
          metadata: {},
          parent: {
            subscription_details: {
              subscription: teamSubscriptionId,
            },
          },
          lines: subscriptionLines(epochSeconds(30), "price_bdd_team"),
        },
      }),
      [200],
    );

    expect(context.mocks.stripe.subscriptions.cancel).toHaveBeenCalledWith(
      granted.subscriptionId,
      { invoice_now: false, prorate: false },
    );
    const upgraded = await billing.readBillingStatus(actor);
    expect(upgraded.tier).toBe("team");
    expect(upgraded.credits).toBe(140_000);
    expect(upgraded.subscriptionStatus).toBe("active");
    expect(upgraded.hasSubscription).toBeTruthy();
    expect(upgraded.scheduledChange).toBeNull();

    // The org is now bound to the new team subscription: deleting that
    // subscription suspends the org, which is only possible if the binding
    // switched to the team subscription id.
    await api.postStripeEvent(
      stripeEvent({
        type: "customer.subscription.deleted",
        object: { id: teamSubscriptionId, metadata: {} },
      }),
      [200],
    );
    const suspended = await billing.readBillingStatus(actor);
    expect(suspended.tier).toBe("limited-free-1");
    expect(suspended.hasSubscription).toBeFalsy();
  });

  it("grants concurrency slots from Stripe subscription and drains the queue", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const billing = createBillingMediaApi(context);
    const actor = bdd.user();
    const orgId = orgOf(actor);
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    runs.configureRunnerGroup();
    const granted = await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD Concurrency Add-on Agent",
      visibility: "private",
    });

    await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "concurrency add-on run one",
      modelProvider: "anthropic-api-key",
    });
    await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "concurrency add-on run two",
      modelProvider: "anthropic-api-key",
    });
    const queued = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "concurrency add-on queued run",
      modelProvider: "anthropic-api-key",
    });
    expect(queued.status).toBe("queued");
    const before = await runs.readRunQueue(actor);
    expect(before.body.concurrency.limit).toBe(2);
    expect(before.body.concurrency.active).toBe(2);
    expect(before.body.queue).toHaveLength(1);

    const suffix = randomUUID().slice(0, 8);
    const lineId = `il_bdd_concurrency_${suffix}`;
    const subscriptionId = `sub_bdd_concurrency_${suffix}`;
    const periodStart = epochSeconds(-1);
    const periodEnd = epochSeconds(30);

    await api.postStripeEvent(
      stripeEvent({
        type: "customer.subscription.created",
        object: {
          id: subscriptionId,
          customer: granted.customerId,
          status: "active",
          metadata: { purpose: "concurrency_subscription", orgId },
          cancel_at_period_end: false,
          items: {
            data: [
              {
                price: { id: "price_bdd_concurrency" },
                quantity: 2,
                current_period_end: periodEnd,
              },
            ],
          },
        },
      }),
      [200],
    );

    const invoice = {
      id: `in_bdd_concurrency_${suffix}`,
      customer: granted.customerId,
      metadata: {},
      parent: {
        subscription_details: {
          subscription: subscriptionId,
          metadata: {
            purpose: "concurrency_subscription",
            orgId,
          },
        },
      },
      lines: {
        has_more: false,
        data: [
          {
            id: lineId,
            quantity: 2,
            price: { id: "price_bdd_concurrency" },
            period: { start: periodStart, end: periodEnd },
            parent: { type: "subscription_item_details" },
          },
        ],
      },
    };

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      concurrencySubscription({
        id: subscriptionId,
        customerId: granted.customerId,
        quantity: 2,
        periodEnd,
      }),
    );
    await api.postStripeEvent(
      stripeEvent({ type: "invoice.paid", object: invoice }),
      [200],
    );

    let billingStatus = await billing.readBillingStatus(actor);
    expect(billingStatus.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({
        id: subscriptionId,
        quantity: 2,
        currentPeriodEnd: isoOf(periodEnd),
        cancelAtPeriodEnd: false,
      }),
    ]);

    const after = await runs.readRunQueue(actor);
    expect(after.body.concurrency.limit).toBe(4);
    expect(after.body.concurrency.active).toBe(3);
    expect(after.body.queue).toHaveLength(0);

    const admitted = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "concurrency add-on admitted run",
      modelProvider: "anthropic-api-key",
    });
    expect(admitted.status).toBe("pending");
    const afterAdmitted = await runs.readRunQueue(actor);
    expect(afterAdmitted.body.concurrency.active).toBe(4);
    expect(afterAdmitted.body.queue).toHaveLength(0);

    // Replaying the same invoice event must not grant additional slots.
    await api.postStripeEvent(
      stripeEvent({ type: "invoice.paid", object: invoice }),
      [200],
    );
    billingStatus = await billing.readBillingStatus(actor);
    expect(billingStatus.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({ id: subscriptionId, quantity: 2 }),
    ]);
    const afterReplay = await runs.readRunQueue(actor);
    expect(afterReplay.body.concurrency.limit).toBe(4);

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      concurrencySubscription({
        id: subscriptionId,
        customerId: granted.customerId,
        quantity: 2,
        periodEnd,
        status: "past_due",
      }),
    );
    await api.postStripeEvent(
      stripeEvent({
        type: "customer.subscription.updated",
        object: {
          id: subscriptionId,
          status: "past_due",
          cancel_at_period_end: false,
          items: {
            data: [
              {
                price: { id: "price_bdd_concurrency" },
                quantity: 2,
                current_period_end: periodEnd,
              },
            ],
          },
        },
      }),
      [200],
    );
    // A past_due subscription keeps its slots during the payment grace
    // window: the subscription stays visible and the limit is unchanged.
    billingStatus = await billing.readBillingStatus(actor);
    expect(billingStatus.concurrencySubscriptions[0]).toMatchObject({
      id: subscriptionId,
      quantity: 2,
      currentPeriodEnd: isoOf(periodEnd),
    });
    const afterPastDue = await runs.readRunQueue(actor);
    expect(afterPastDue.body.concurrency.limit).toBe(4);

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      concurrencySubscription({
        id: subscriptionId,
        customerId: granted.customerId,
        quantity: 2,
        periodEnd,
        cancelAtPeriodEnd: true,
      }),
    );
    await api.postStripeEvent(
      stripeEvent({
        type: "customer.subscription.updated",
        object: {
          id: subscriptionId,
          status: "active",
          cancel_at_period_end: true,
          items: { data: [] },
        },
      }),
      [200],
    );
    billingStatus = await billing.readBillingStatus(actor);
    expect(billingStatus.concurrencySubscriptions[0]).toMatchObject({
      id: subscriptionId,
      cancelAtPeriodEnd: true,
    });

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      concurrencySubscription({
        id: subscriptionId,
        customerId: granted.customerId,
        quantity: 2,
        periodEnd,
      }),
    );
    await api.postStripeEvent(
      stripeEvent({
        type: "customer.subscription.updated",
        object: {
          id: subscriptionId,
          status: "active",
          cancel_at_period_end: false,
          items: { data: [] },
        },
      }),
      [200],
    );
    billingStatus = await billing.readBillingStatus(actor);
    expect(billingStatus.concurrencySubscriptions[0]).toMatchObject({
      id: subscriptionId,
      cancelAtPeriodEnd: false,
    });

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: subscriptionId,
      customer: granted.customerId,
      status: "active",
      cancel_at_period_end: false,
      items: { data: [] },
    });
    await api.postStripeEvent(
      stripeEvent({
        type: "customer.subscription.updated",
        object: {
          id: subscriptionId,
          status: "active",
          cancel_at_period_end: false,
          items: { data: [] },
        },
      }),
      [200],
    );
    billingStatus = await billing.readBillingStatus(actor);
    expect(billingStatus.concurrencySubscriptions).toStrictEqual([]);
    const afterItemRemoved = await runs.readRunQueue(actor);
    expect(afterItemRemoved.body.concurrency.limit).toBe(2);

    await api.postStripeEvent(
      stripeEvent({
        type: "customer.subscription.deleted",
        object: {
          id: subscriptionId,
        },
      }),
      [200],
    );
    // A deleted subscription no longer contributes slots and disappears from
    // the billing status read.
    billingStatus = await billing.readBillingStatus(actor);
    expect(billingStatus.concurrencySubscriptions).toStrictEqual([]);
    expect(billingStatus.tier).toBe("pro");
    expect(billingStatus.hasSubscription).toBeTruthy();
    const afterDeleted = await runs.readRunQueue(actor);
    expect(afterDeleted.body.concurrency.limit).toBe(2);
  });

  it("keeps Stripe quantity across prorations and stale concurrent events", async () => {
    const bdd = createBddApi(context);
    const billing = createBillingMediaApi(context);
    const actor = bdd.user();
    const orgId = orgOf(actor);
    const granted = await createRunsApi(context).grantProEntitlement(actor);
    const suffix = randomUUID().slice(0, 8);
    const subscriptionId = `sub_bdd_concurrency_proration_${suffix}`;
    const initialInvoiceId = `in_bdd_concurrency_initial_${suffix}`;
    const initialLineId = `il_bdd_concurrency_initial_${suffix}`;
    const periodStart = epochSeconds(-1);
    const periodEnd = epochSeconds(30);

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      concurrencySubscription({
        id: subscriptionId,
        customerId: granted.customerId,
        quantity: 10,
        periodEnd,
      }),
    );
    await api.postStripeEvent(
      stripeEvent({
        type: "invoice.paid",
        object: {
          id: initialInvoiceId,
          customer: granted.customerId,
          metadata: {},
          parent: {
            subscription_details: {
              subscription: subscriptionId,
              metadata: { purpose: "concurrency_subscription", orgId },
            },
          },
          lines: {
            has_more: false,
            data: [
              {
                id: initialLineId,
                amount: 0,
                quantity: 10,
                price: { id: "price_bdd_concurrency" },
                period: { start: periodStart, end: periodEnd },
                parent: { type: "subscription_item_details" },
              },
            ],
          },
        },
      }),
      [200],
    );

    let billingStatus = await billing.readBillingStatus(actor);
    expect(billingStatus.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({ id: subscriptionId, quantity: 10 }),
    ]);

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      concurrencySubscription({
        id: subscriptionId,
        customerId: granted.customerId,
        quantity: 2,
        periodEnd,
      }),
    );
    await api.postStripeEvent(
      stripeEvent({
        type: "customer.subscription.updated",
        object: concurrencySubscription({
          id: subscriptionId,
          customerId: granted.customerId,
          quantity: 2,
          periodEnd,
        }),
      }),
      [200],
    );

    await api.postStripeEvent(
      stripeEvent({
        type: "invoice.paid",
        object: {
          id: `in_bdd_concurrency_reduction_${suffix}`,
          customer: granted.customerId,
          metadata: {},
          parent: {
            subscription_details: {
              subscription: subscriptionId,
              metadata: { purpose: "concurrency_subscription", orgId },
            },
          },
          lines: {
            has_more: false,
            data: [
              {
                id: `il_bdd_concurrency_credit_${suffix}`,
                amount: 0,
                quantity: 10,
                price: { id: "price_bdd_concurrency" },
                period: { start: periodStart, end: periodEnd },
                parent: {
                  type: "subscription_item_details",
                  subscription_item_details: {
                    proration_details: {
                      credited_items: {
                        invoice: initialInvoiceId,
                        invoice_line_items: [initialLineId],
                      },
                    },
                  },
                },
              },
              {
                id: `il_bdd_concurrency_remaining_${suffix}`,
                amount: 0,
                quantity: 2,
                price: { id: "price_bdd_concurrency" },
                period: { start: periodStart, end: periodEnd },
                parent: {
                  type: "subscription_item_details",
                  subscription_item_details: {
                    proration_details: { credited_items: null },
                  },
                },
              },
            ],
          },
        },
      }),
      [200],
    );

    billingStatus = await billing.readBillingStatus(actor);
    expect(billingStatus.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({ id: subscriptionId, quantity: 2 }),
    ]);

    const staleState = concurrencySubscription({
      id: subscriptionId,
      customerId: granted.customerId,
      quantity: 10,
      periodEnd,
    });
    const currentState = concurrencySubscription({
      id: subscriptionId,
      customerId: granted.customerId,
      quantity: 2,
      periodEnd,
    });
    const staleRetrieve = createDeferredPromise<unknown>(context.signal);
    const releaseStaleRetrieve = (): void => {
      if (!staleRetrieve.settled()) {
        staleRetrieve.resolve(staleState);
      }
    };
    onTestFinished(releaseStaleRetrieve);
    context.mocks.stripe.subscriptions.retrieve.mockReset();
    context.mocks.stripe.subscriptions.retrieve
      .mockImplementationOnce(() => {
        return staleRetrieve.promise;
      })
      .mockResolvedValue(currentState);

    const constructedEventsBefore =
      context.mocks.stripe.webhooks.constructEvent.mock.calls.length;
    const staleRequest = api.postStripeEvent(
      stripeEvent({
        type: "customer.subscription.updated",
        object: staleState,
      }),
      [200],
    );
    await expect
      .poll(() => {
        return context.mocks.stripe.subscriptions.retrieve.mock.calls.length;
      })
      .toBe(1);

    const currentRequest = api.postStripeEvent(
      stripeEvent({
        type: "customer.subscription.updated",
        object: currentState,
      }),
      [200],
    );
    await expect
      .poll(() => {
        return context.mocks.stripe.webhooks.constructEvent.mock.calls.length;
      })
      .toBe(constructedEventsBefore + 2);
    await billing.readBillingStatus(actor);
    expect(context.mocks.stripe.subscriptions.retrieve).toHaveBeenCalledTimes(
      1,
    );

    releaseStaleRetrieve();
    await Promise.all([staleRequest, currentRequest]);
    billingStatus = await billing.readBillingStatus(actor);
    expect(billingStatus.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({ id: subscriptionId, quantity: 2 }),
    ]);

    await api.postStripeEvent(
      stripeEvent({
        type: "customer.subscription.updated",
        object: concurrencySubscription({
          id: subscriptionId,
          customerId: granted.customerId,
          quantity: 10,
          periodEnd,
        }),
      }),
      [200],
    );

    billingStatus = await billing.readBillingStatus(actor);
    expect(billingStatus.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({ id: subscriptionId, quantity: 2 }),
    ]);

    await api.postStripeEvent(
      stripeEvent({
        type: "customer.subscription.deleted",
        object: { id: subscriptionId },
      }),
      [200],
    );
  });

  it("binds checkout and dashboard subscriptions to orgs without double-binding", async () => {
    const bdd = createBddApi(context);
    const billing = createBillingMediaApi(context);
    const actor = bdd.user();
    const orgId = orgOf(actor);
    api.configureStripeBillingEnv();
    await completeOnboardingWithoutCredits(actor);

    const suffix = randomUUID().slice(0, 8);
    const customerId = `cus_bdd_bind_${suffix}`;

    // A dashboard-created subscription binds the customer from its metadata.
    context.mocks.stripe.customers.retrieve.mockResolvedValueOnce({
      id: customerId,
      metadata: { orgId },
    });
    await api.postStripeEvent(
      stripeEvent({
        type: "customer.subscription.created",
        object: {
          id: `sub_bdd_dash_${suffix}`,
          customer: customerId,
          status: "active",
          metadata: {},
          cancel_at_period_end: false,
          items: {
            data: [
              {
                price: { id: "price_bdd_pro" },
                current_period_end: epochSeconds(30),
              },
            ],
          },
        },
      }),
      [200],
    );
    const bound = await billing.readBillingStatus(actor);
    expect(bound.hasSubscription).toBeTruthy();
    expect(bound.subscriptionStatus).toBe("active");
    expect(bound.tier).toBe("limited-free-1");
    expect(bound.currentPeriodEnd).toBeNull();

    // An incomplete dashboard subscription cannot replace the active one.
    await api.postStripeEvent(
      stripeEvent({
        type: "customer.subscription.created",
        object: {
          id: `sub_bdd_incomplete_${suffix}`,
          customer: customerId,
          status: "incomplete",
          metadata: {},
          cancel_at_period_end: false,
          items: { data: [{ price: { id: "price_bdd_pro" } }] },
        },
      }),
      [200],
    );
    const incomplete = await billing.readBillingStatus(actor);
    expect(incomplete.subscriptionStatus).toBe("active");
    expect(incomplete.tier).toBe("limited-free-1");

    // A subscription checkout completion binds its subscription.
    const checkoutSubscriptionId = `sub_bdd_checkout_${suffix}`;
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce(
      proSubscription({ id: checkoutSubscriptionId, customerId }),
    );
    await api.postStripeEvent(
      stripeEvent({
        type: "checkout.session.completed",
        object: {
          id: `cs_bdd_bind_${suffix}`,
          subscription: checkoutSubscriptionId,
          customer: customerId,
          metadata: null,
        },
      }),
      [200],
    );
    expect((await billing.readBillingStatus(actor)).subscriptionStatus).toBe(
      "active",
    );

    // Redelivering the checkout for the stored subscription is idempotent.
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce(
      proSubscription({ id: checkoutSubscriptionId, customerId }),
    );
    await api.postStripeEvent(
      stripeEvent({
        type: "checkout.session.completed",
        object: {
          id: `cs_bdd_bind_redelivery_${suffix}`,
          subscription: checkoutSubscriptionId,
          customer: customerId,
          metadata: null,
        },
      }),
      [200],
    );
    expect((await billing.readBillingStatus(actor)).subscriptionStatus).toBe(
      "active",
    );

    // A paid invoice grants the pro entitlement on the bound subscription.
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce(
      proSubscription({ id: checkoutSubscriptionId, customerId }),
    );
    await api.postStripeEvent(
      stripeEvent({
        type: "invoice.paid",
        object: {
          id: `in_bdd_bind_${suffix}`,
          customer: customerId,
          metadata: {},
          parent: {
            subscription_details: { subscription: checkoutSubscriptionId },
          },
          lines: subscriptionLines(epochSeconds(30)),
        },
      }),
      [200],
    );
    const entitled = await billing.readBillingStatus(actor);
    expect(entitled.tier).toBe("pro");
    expect(entitled.credits).toBe(20_000);

    // A same-or-lower-tier checkout cannot replace the current subscription.
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce(
      proSubscription({ id: `sub_bdd_lowtier_${suffix}`, customerId }),
    );
    await api.postStripeEvent(
      stripeEvent({
        type: "checkout.session.completed",
        object: {
          id: `cs_bdd_lowtier_${suffix}`,
          subscription: `sub_bdd_lowtier_${suffix}`,
          customer: customerId,
          metadata: null,
        },
      }),
      [200],
    );
    const kept = await billing.readBillingStatus(actor);
    expect(kept.tier).toBe("pro");
    expect(kept.subscriptionStatus).toBe("active");
    expect(kept.credits).toBe(20_000);

    // Dashboard subscriptions for unknown customers are ignored.
    context.mocks.stripe.customers.retrieve.mockResolvedValueOnce({
      id: `cus_bdd_unknown_${suffix}`,
      metadata: {},
    });
    await api.postStripeEvent(
      stripeEvent({
        type: "customer.subscription.created",
        object: {
          id: `sub_bdd_unknown_${suffix}`,
          customer: `cus_bdd_unknown_${suffix}`,
          status: "active",
          metadata: {},
          cancel_at_period_end: false,
          items: { data: [{ price: { id: "price_bdd_pro" } }] },
        },
      }),
      [200],
    );
    expect((await billing.readBillingStatus(actor)).tier).toBe("pro");

    // Customer metadata cannot rebind an org bound to another customer.
    context.mocks.stripe.customers.retrieve.mockResolvedValueOnce({
      id: `cus_bdd_other_${suffix}`,
      metadata: { orgId },
    });
    await api.postStripeEvent(
      stripeEvent({
        type: "customer.subscription.created",
        object: {
          id: `sub_bdd_rebind_${suffix}`,
          customer: `cus_bdd_other_${suffix}`,
          status: "active",
          metadata: {},
          cancel_at_period_end: false,
          items: { data: [{ price: { id: "price_bdd_pro" } }] },
        },
      }),
      [200],
    );
    const unmoved = await billing.readBillingStatus(actor);
    expect(unmoved.tier).toBe("pro");
    expect(unmoved.subscriptionStatus).toBe("active");

    // invoice.paid for a never-onboarded org creates its metadata from Clerk.
    const lateActor = bdd.user();
    const lateOrgId = orgOf(lateActor);
    const lateCustomerId = `cus_bdd_late_${suffix}`;
    const lateSubscriptionId = `sub_bdd_late_${suffix}`;
    context.mocks.stripe.customers.retrieve.mockResolvedValueOnce({
      id: lateCustomerId,
      metadata: { orgId: lateOrgId },
    });
    context.mocks.clerk.organizations.getOrganization.mockResolvedValueOnce({
      id: lateOrgId,
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce(
      proSubscription({ id: lateSubscriptionId, customerId: lateCustomerId }),
    );
    await api.postStripeEvent(
      stripeEvent({
        type: "invoice.paid",
        object: {
          id: `in_bdd_late_${suffix}`,
          customer: lateCustomerId,
          metadata: {},
          parent: {
            subscription_details: { subscription: lateSubscriptionId },
          },
          lines: subscriptionLines(epochSeconds(30)),
        },
      }),
      [200],
    );
    const lateStatus = await billing.readBillingStatus(lateActor);
    expect(lateStatus.tier).toBe("pro");
    expect(lateStatus.credits).toBe(20_000);
    expect(lateStatus.hasSubscription).toBeTruthy();
  });

  it("grants purchased and Atom-issued custom credits", async () => {
    const bdd = createBddApi(context);
    const billing = createBillingMediaApi(context);
    const actor = bdd.user();
    const orgId = orgOf(actor);
    api.configureStripeBillingEnv();
    await completeOnboardingWithoutCredits(actor);
    const baselineCredits = (await billing.readBillingStatus(actor)).credits;

    // A one-time checkout before payment settles grants nothing.
    const suffix = randomUUID().slice(0, 8);
    const oneTimeSessionId = `cs_bdd_once_${suffix}`;
    await api.postStripeEvent(
      stripeEvent({
        type: "checkout.session.completed",
        object: {
          id: oneTimeSessionId,
          invoice: null,
          subscription: null,
          customer: null,
          payment_status: "unpaid",
          metadata: {
            purpose: "one_time_purchase",
            orgId,
            campaignKey: "ZERO100",
          },
        },
      }),
      [200],
    );
    expect((await billing.readBillingStatus(actor)).credits).toBe(
      baselineCredits,
    );

    // The async payment success grants the campaign credits once.
    await api.postStripeEvent(
      stripeEvent({
        type: "checkout.session.async_payment_succeeded",
        object: {
          id: oneTimeSessionId,
          invoice: null,
          subscription: null,
          customer: null,
          payment_status: "paid",
          metadata: {
            purpose: "one_time_purchase",
            orgId,
            campaignKey: "ZERO100",
          },
        },
      }),
      [200],
    );
    const afterCampaign = await billing.readBillingStatus(actor);
    expect(afterCampaign.credits).toBe(baselineCredits + 100_000);
    const campaignGrant = afterCampaign.creditGrants.find((grant) => {
      return grant.source === "one_time_purchase";
    });
    expect(campaignGrant?.amount).toBe(100_000);

    const checkoutCreditExpiresAt = new Date(
      Math.floor((now() + 45 * 86_400_000) / 1000) * 1000,
    ).toISOString();
    const invoiceCreditExpiresAt = Math.floor((now() + 90 * 86_400_000) / 1000);

    // Legacy custom credit checkouts without an invoice grant immediately.
    await api.postStripeEvent(
      stripeEvent({
        type: "checkout.session.completed",
        object: {
          id: `cs_bdd_legacy_${suffix}`,
          invoice: null,
          subscription: null,
          customer: null,
          payment_status: "paid",
          amount_total: 10_000,
          metadata: {
            purpose: "credit_purchase",
            orgId,
            creditsAmountMode: "amount_total",
            creditsExpiresAt: checkoutCreditExpiresAt,
          },
        },
      }),
      [200],
    );
    const afterLegacyCredit = await billing.readBillingStatus(actor);
    expect(afterLegacyCredit.credits).toBe(baselineCredits + 200_000);
    expect(afterLegacyCredit.creditGrants).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "credit_purchase",
          amount: 100_000,
          expiresAt: checkoutCreditExpiresAt,
        }),
      ]),
    );

    // Invoice-backed custom credit checkouts defer to invoice.paid, which
    // grants from the pre-discount subtotal.
    const creditInvoiceId = `in_bdd_credit_${suffix}`;
    await api.postStripeEvent(
      stripeEvent({
        type: "checkout.session.completed",
        object: {
          id: `cs_bdd_invoice_${suffix}`,
          invoice: creditInvoiceId,
          subscription: null,
          customer: null,
          payment_status: "paid",
          amount_subtotal: 10_000,
          metadata: {
            purpose: "credit_purchase",
            orgId,
            creditsAmountMode: "amount_subtotal",
          },
        },
      }),
      [200],
    );
    expect((await billing.readBillingStatus(actor)).credits).toBe(
      baselineCredits + 200_000,
    );

    await api.postStripeEvent(
      stripeEvent({
        type: "invoice.paid",
        object: {
          id: creditInvoiceId,
          customer: null,
          subtotal: 10_000,
          metadata: {
            type: "credit_purchase",
            purpose: "credit_purchase",
            orgId,
            creditsAmountMode: "amount_subtotal",
            creditsExpiresAt: String(invoiceCreditExpiresAt),
          },
          parent: null,
        },
      }),
      [200],
    );
    const afterInvoiceCredit = await billing.readBillingStatus(actor);
    expect(afterInvoiceCredit.credits).toBe(baselineCredits + 300_000);
    expect(afterInvoiceCredit.creditGrants).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "credit_purchase",
          amount: 100_000,
          expiresAt: new Date(invoiceCreditExpiresAt * 1000).toISOString(),
        }),
      ]),
    );

    // Atom grants use the configured zero-price line and declare the credit
    // amount in trusted invoice metadata instead of encoding it in subtotal.
    const metadataCreditInvoiceId = `in_bdd_metadata_credit_${suffix}`;
    await api.postStripeEvent(
      stripeEvent({
        type: "invoice.paid",
        object: {
          id: metadataCreditInvoiceId,
          customer: null,
          subtotal: 0,
          metadata: {
            type: "atom_grant",
            purpose: "atom_grant",
            source: "atom_custom_credits",
            grantType: "credits",
            orgId,
            creditsAmount: "2500",
            creditsExpiresAt: String(invoiceCreditExpiresAt),
          },
          parent: null,
          lines: {
            has_more: false,
            data: [
              {
                id: `il_bdd_metadata_credit_${suffix}`,
                quantity: 1,
                price: { id: "price_bdd_atom_grant" },
                period: {
                  start: epochSeconds(0),
                  end: invoiceCreditExpiresAt,
                },
                parent: { type: "invoice_item_details" },
              },
            ],
          },
        },
      }),
      [200],
    );
    const afterMetadataCredit = await billing.readBillingStatus(actor);
    expect(afterMetadataCredit.credits).toBe(baselineCredits + 302_500);
    expect(afterMetadataCredit.creditGrants).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "credit_purchase",
          amount: 2500,
          expiresAt: new Date(invoiceCreditExpiresAt * 1000).toISOString(),
        }),
      ]),
    );

    // Metadata credit amounts are ignored outside the configured Atom grant
    // price path.
    await api.postStripeEvent(
      stripeEvent({
        type: "invoice.paid",
        object: {
          id: `in_bdd_untrusted_metadata_credit_${suffix}`,
          customer: null,
          subtotal: 0,
          metadata: {
            type: "atom_grant",
            purpose: "atom_grant",
            source: "atom_custom_credits",
            grantType: "credits",
            orgId,
            creditsAmount: "9000",
          },
          parent: null,
          lines: {
            has_more: false,
            data: [
              {
                id: `il_bdd_untrusted_metadata_credit_${suffix}`,
                quantity: 1,
                price: { id: "price_bdd_other" },
                period: {
                  start: epochSeconds(0),
                  end: invoiceCreditExpiresAt,
                },
                parent: { type: "invoice_item_details" },
              },
            ],
          },
        },
      }),
      [200],
    );
    expect((await billing.readBillingStatus(actor)).credits).toBe(
      baselineCredits + 302_500,
    );
  });

  it("restores and schedules cancellations through setup checkouts and schedule webhooks", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const billing = createBillingMediaApi(context);
    const actor = bdd.user();
    const orgId = orgOf(actor);
    const granted = await runs.grantProEntitlement(actor);
    const suffix = randomUUID().slice(0, 8);
    const periodEnd = epochSeconds(30);

    // The subscription is scheduled for cancellation in Stripe.
    await api.postStripeEvent(
      stripeEvent({
        type: "customer.subscription.updated",
        object: {
          id: granted.subscriptionId,
          status: "active",
          cancel_at_period_end: true,
          metadata: {},
          items: {
            data: [
              {
                price: { id: "price_bdd_pro" },
                current_period_end: periodEnd,
              },
            ],
          },
        },
      }),
      [200],
    );
    const scheduled = await billing.readBillingStatus(actor);
    expect(scheduled.cancelAtPeriodEnd).toBeTruthy();
    expect(scheduled.scheduledChange).toStrictEqual({
      type: "cancel",
      targetTier: "limited-free-1",
      effectiveDate: isoOf(periodEnd),
    });

    // Mismatched setup checkouts change nothing.
    await api.postStripeEvent(
      stripeEvent({
        type: "checkout.session.completed",
        object: {
          id: `cs_bdd_wrong_mode_${suffix}`,
          mode: "payment",
          subscription: null,
          customer: granted.customerId,
          metadata: {
            purpose: "billing_restore",
            orgId,
            subscriptionId: granted.subscriptionId,
          },
        },
      }),
      [200],
    );
    await api.postStripeEvent(
      stripeEvent({
        type: "checkout.session.completed",
        object: {
          id: `cs_bdd_no_customer_${suffix}`,
          mode: "setup",
          subscription: null,
          customer: null,
          metadata: {
            purpose: "billing_restore",
            orgId,
            subscriptionId: granted.subscriptionId,
          },
        },
      }),
      [200],
    );
    await api.postStripeEvent(
      stripeEvent({
        type: "checkout.session.completed",
        object: {
          id: `cs_bdd_wrong_sub_${suffix}`,
          mode: "setup",
          subscription: null,
          customer: granted.customerId,
          setup_intent: { id: `seti_bdd_${suffix}`, payment_method: "pm_bdd" },
          metadata: {
            purpose: "billing_restore",
            orgId,
            subscriptionId: `sub_bdd_other_${suffix}`,
          },
        },
      }),
      [200],
    );
    await api.postStripeEvent(
      stripeEvent({
        type: "checkout.session.completed",
        object: {
          id: `cs_bdd_bad_tier_${suffix}`,
          mode: "setup",
          subscription: null,
          customer: granted.customerId,
          metadata: {
            purpose: "billing_downgrade",
            orgId,
            subscriptionId: granted.subscriptionId,
            targetTier: "team",
          },
        },
      }),
      [200],
    );
    expect(
      (await billing.readBillingStatus(actor)).cancelAtPeriodEnd,
    ).toBeTruthy();

    // A restore-purpose setup checkout sets the payment method and restores.
    await api.postStripeEvent(
      stripeEvent({
        type: "checkout.session.completed",
        object: {
          id: `cs_bdd_restore_${suffix}`,
          mode: "setup",
          subscription: null,
          customer: granted.customerId,
          setup_intent: {
            id: `seti_bdd_restore_${suffix}`,
            payment_method: "pm_bdd_restore",
          },
          metadata: {
            purpose: "billing_restore",
            orgId,
            subscriptionId: granted.subscriptionId,
          },
        },
      }),
      [200],
    );
    expect(context.mocks.stripe.customers.update).toHaveBeenCalledWith(
      granted.customerId,
      { invoice_settings: { default_payment_method: "pm_bdd_restore" } },
    );
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      granted.subscriptionId,
      { cancel_at_period_end: false },
    );
    const restored = await billing.readBillingStatus(actor);
    expect(restored.cancelAtPeriodEnd).toBeFalsy();
    expect(restored.scheduledChange).toBeNull();

    // A downgrade-purpose setup checkout (string setup intent refreshed via
    // session retrieve) schedules the cancellation again.
    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValueOnce({
      id: `cs_bdd_downgrade_${suffix}`,
      setup_intent: { payment_method: "pm_bdd_downgrade" },
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: granted.subscriptionId,
      status: "active",
      customer: granted.customerId,
      cancel_at: null,
      cancel_at_period_end: false,
      schedule: null,
      trial_end: null,
      metadata: {},
      items: {
        data: [
          {
            id: `si_bdd_${suffix}`,
            current_period_start: epochSeconds(0),
            current_period_end: periodEnd,
            quantity: 1,
            price: {
              id: "price_bdd_pro",
              recurring: { interval: "month", interval_count: 1 },
            },
          },
        ],
      },
    });
    await api.postStripeEvent(
      stripeEvent({
        type: "checkout.session.completed",
        object: {
          id: `cs_bdd_downgrade_${suffix}`,
          mode: "setup",
          subscription: null,
          customer: granted.customerId,
          setup_intent: `seti_bdd_downgrade_${suffix}`,
          metadata: {
            purpose: "billing_downgrade",
            orgId,
            subscriptionId: granted.subscriptionId,
            targetTier: "limited-free-1",
          },
        },
      }),
      [200],
    );
    expect(context.mocks.stripe.customers.update).toHaveBeenCalledWith(
      granted.customerId,
      { invoice_settings: { default_payment_method: "pm_bdd_downgrade" } },
    );
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      granted.subscriptionId,
      { cancel_at_period_end: true },
    );
    const downgraded = await billing.readBillingStatus(actor);
    expect(downgraded.cancelAtPeriodEnd).toBeTruthy();
    expect(downgraded.scheduledChange?.type).toBe("cancel");

    // A schedule-managed cancellation syncs the final schedule end.
    const scheduleId = `sched_bdd_${suffix}`;
    const finalEnd = epochSeconds(60);
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValueOnce({
      id: scheduleId,
      end_behavior: "cancel",
      current_phase: { start_date: epochSeconds(0), end_date: periodEnd },
      phases: [
        { start_date: epochSeconds(0), end_date: periodEnd },
        { start_date: periodEnd, end_date: finalEnd },
      ],
    });
    await api.postStripeEvent(
      stripeEvent({
        type: "customer.subscription.updated",
        object: {
          id: granted.subscriptionId,
          status: "active",
          schedule: scheduleId,
          cancel_at_period_end: false,
          metadata: {},
          items: {
            data: [
              {
                price: { id: "price_bdd_pro" },
                current_period_end: periodEnd,
              },
            ],
          },
        },
      }),
      [200],
    );
    const scheduleManaged = await billing.readBillingStatus(actor);
    expect(scheduleManaged.currentPeriodEnd).toBe(isoOf(finalEnd));
    expect(scheduleManaged.scheduledChange).toStrictEqual({
      type: "cancel",
      targetTier: "limited-free-1",
      effectiveDate: isoOf(finalEnd),
    });

    // Releasing the schedule clears the pending change entirely.
    await api.postStripeEvent(
      stripeEvent({
        type: "subscription_schedule.released",
        object: { id: scheduleId },
      }),
      [200],
    );
    const released = await billing.readBillingStatus(actor);
    expect(released.cancelAtPeriodEnd).toBeFalsy();
    expect(released.scheduledChange).toBeNull();

    // A canceled schedule clears the pending schedule but keeps the
    // cancellation flag visible until Stripe uncancels the subscription.
    const secondScheduleId = `sched_bdd_second_${suffix}`;
    const secondFinalEnd = epochSeconds(90);
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValueOnce({
      id: secondScheduleId,
      end_behavior: "cancel",
      current_phase: { start_date: epochSeconds(0), end_date: periodEnd },
      phases: [{ start_date: periodEnd, end_date: secondFinalEnd }],
    });
    await api.postStripeEvent(
      stripeEvent({
        type: "customer.subscription.updated",
        object: {
          id: granted.subscriptionId,
          status: "active",
          schedule: secondScheduleId,
          cancel_at_period_end: false,
          metadata: {},
          items: {
            data: [
              {
                price: { id: "price_bdd_pro" },
                current_period_end: periodEnd,
              },
            ],
          },
        },
      }),
      [200],
    );
    await api.postStripeEvent(
      stripeEvent({
        type: "subscription_schedule.canceled",
        object: { id: secondScheduleId },
      }),
      [200],
    );
    const scheduleCanceled = await billing.readBillingStatus(actor);
    expect(scheduleCanceled.scheduledChange?.type).toBe("cancel");
    expect(scheduleCanceled.scheduledChange?.effectiveDate).toBe(
      isoOf(secondFinalEnd),
    );

    // Uncancelling in Stripe clears the remaining cancellation flag.
    await api.postStripeEvent(
      stripeEvent({
        type: "customer.subscription.updated",
        object: {
          id: granted.subscriptionId,
          status: "active",
          cancel_at_period_end: false,
          metadata: {},
          items: { data: [{ price: { id: "price_bdd_pro" } }] },
        },
        previousAttributes: { cancel_at_period_end: true },
      }),
      [200],
    );
    const uncancelled = await billing.readBillingStatus(actor);
    expect(uncancelled.cancelAtPeriodEnd).toBeFalsy();
    expect(uncancelled.scheduledChange).toBeNull();
  });

  it("processes preview Stripe events only for the matching job ref", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const billing = createBillingMediaApi(context);
    const actor = bdd.user();
    const granted = await runs.grantProEntitlement(actor);
    mockEnv("ENV", "preview");
    mockOptionalEnv("OKOU_PREVIEW_JOB_REF", "pr-bdd-123");

    const mismatchedMetadata = {
      vm0_environment: "preview",
      job_ref: "pr-bdd-456",
    };
    const paymentMethodId = `pm_bdd_preview_${randomUUID().slice(0, 8)}`;
    context.mocks.stripe.customers.retrieve.mockResolvedValueOnce({
      id: granted.customerId,
      deleted: false,
      metadata: mismatchedMetadata,
    });
    await api.postStripeEvent(
      stripeEvent({
        type: "payment_intent.succeeded",
        object: {
          id: `pi_bdd_preview_skip_${randomUUID().slice(0, 8)}`,
          customer: granted.customerId,
          payment_method: paymentMethodId,
          metadata: {},
        },
      }),
      [200],
    );
    expect(context.mocks.stripe.customers.update).not.toHaveBeenCalled();
    await api.postStripeEvent(
      stripeEvent({
        type: "invoice.paid",
        object: {
          id: `in_bdd_preview_skip_${randomUUID().slice(0, 8)}`,
          customer: granted.customerId,
          metadata: {},
          parent: {
            subscription_details: {
              subscription: granted.subscriptionId,
              metadata: mismatchedMetadata,
            },
          },
          lines: subscriptionLines(epochSeconds(30)),
        },
      }),
      [200],
    );
    await api.postStripeEvent(
      stripeEvent({
        type: "checkout.session.completed",
        object: {
          id: `cs_bdd_preview_skip_${randomUUID().slice(0, 8)}`,
          subscription: granted.subscriptionId,
          customer: granted.customerId,
          metadata: mismatchedMetadata,
        },
      }),
      [200],
    );
    await api.postStripeEvent(
      stripeEvent({
        type: "customer.subscription.created",
        object: {
          id: `sub_bdd_preview_skip_${randomUUID().slice(0, 8)}`,
          customer: granted.customerId,
          status: "active",
          metadata: mismatchedMetadata,
          cancel_at_period_end: false,
          items: { data: [{ price: { id: "price_bdd_pro" } }] },
        },
      }),
      [200],
    );
    const skipped = await billing.readBillingStatus(actor);
    expect(skipped.credits).toBe(20_000);
    expect(skipped.subscriptionStatus).toBe("active");

    // The matching job ref processes normally.
    await api.postStripeEvent(
      stripeEvent({
        type: "invoice.paid",
        object: {
          id: `in_bdd_preview_match_${randomUUID().slice(0, 8)}`,
          customer: granted.customerId,
          metadata: {},
          parent: {
            subscription_details: {
              subscription: granted.subscriptionId,
              metadata: { vm0_environment: "preview", job_ref: "pr-bdd-123" },
            },
          },
          lines: subscriptionLines(epochSeconds(45)),
        },
      }),
      [200],
    );
    expect((await billing.readBillingStatus(actor)).credits).toBe(40_000);

    context.mocks.stripe.customers.retrieve.mockResolvedValueOnce({
      id: granted.customerId,
      deleted: false,
      metadata: { vm0_environment: "preview", job_ref: "pr-bdd-123" },
    });
    context.mocks.stripe.paymentMethods.retrieve.mockResolvedValueOnce({
      id: paymentMethodId,
      type: "card",
      customer: granted.customerId,
    });
    await api.postStripeEvent(
      stripeEvent({
        type: "payment_intent.succeeded",
        object: {
          id: `pi_bdd_preview_match_${randomUUID().slice(0, 8)}`,
          customer: granted.customerId,
          payment_method: paymentMethodId,
          metadata: {},
        },
      }),
      [200],
    );
    expect(context.mocks.stripe.customers.update).toHaveBeenCalledWith(
      granted.customerId,
      {
        invoice_settings: { default_payment_method: paymentMethodId },
      },
    );
  });
});

describe("WHCB-08: Clerk deletion webhooks tear down account state", () => {
  it("cleans up organization state after a verified organization.deleted event", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const connectors = createConnectorBddApi(context);
    const gh = createGithubBddApi(context);
    api.configureClerkWebhookSecret();
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    runs.configureRunnerGroup();
    acceptGithubGrantRevocations();
    mockSlackConnectorOAuth();
    const customOAuthProvider = mockCustomConnectorOAuth2Provider(context);

    const actor = bdd.user();
    const granted = await runs.grantProEntitlement(actor);
    const allowanceCustomerId = generatedStripeCustomerId();
    const allowanceSubscriptionId = generatedStripeSubscriptionId();
    await postUsageAllowanceInvoicePaid(context.signal, {
      orgId: orgOf(actor),
      userId: actor.userId,
      customerId: allowanceCustomerId,
      subscriptionId: allowanceSubscriptionId,
      effectiveAt: new Date(now() - 60_000),
      expiresAt: new Date(now() + 365 * 86_400_000),
      shortWindowSeconds: 3600,
      shortWindowUnits: 100,
      weeklyWindowSeconds: 7 * 86_400,
      weeklyWindowUnits: 100,
    });
    await runs.ensureOrgModelProvider(actor);
    await connectors.connectManualGrant(actor, "openai", "api-token", {
      apiKey: "org-teardown-connector-token",
    });
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD Org Teardown Agent",
      visibility: "public",
    });
    const customManual = await connectors.createCustomConnector(actor, {
      ...customManualConnectorBodyForTeardown("org"),
      skillMarkdown: "Keep this registered teardown skill active.",
    });
    await connectors.setCustomConnectorSecret(
      actor,
      customManual.id,
      "org-teardown-custom-secret",
    );
    await connectors.updateAgentCustomConnectors(actor, agent.agentId, [
      customManual.id,
    ]);
    const customOauth = await connectors.createCustomConnector(
      actor,
      customOauthConnectorBodyForTeardown("org", customOAuthProvider),
    );
    const builtinOauthState = oauthStateFromAuthorizationUrl(
      (await connectors.startOauth(actor, "slack", "oauth", agent.agentId))
        .authorizationUrl,
    );
    const customOauthState = oauthStateFromAuthorizationUrl(
      await connectors.startCustomConnectorOAuth2(
        actor,
        customOauth.id,
        agent.agentId,
      ),
    );
    const run = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "survive until teardown",
      modelProvider: "anthropic-api-key",
    });
    expect(run.status).toBe("pending");
    const usageProvider = `org-teardown-${randomUUID().slice(0, 8)}`;
    await seedUsagePricingRows([
      {
        kind: "connector",
        provider: usageProvider,
        category: "call",
        unitPrice: 10,
        unitSize: 1,
      },
    ]);
    await api.requestAgentUsageEvent(
      {
        runId: run.runId,
        events: [
          {
            idempotencyKey: randomUUID(),
            kind: "connector",
            provider: usageProvider,
            category: "call",
            quantity: 1,
          },
        ],
      },
      { authorization: `Bearer ${runs.sandboxTokenForRun(actor, run.runId)}` },
      [200],
    );
    await createBillingMediaApi(context).processOrgUsageEvents(actor);
    await expect(
      store.set(
        materializeHourlyUsage$,
        {
          orgId: orgOf(actor),
          userId: actor.userId,
          runId: run.runId,
        },
        context.signal,
      ),
    ).resolves.toBe(1);
    await store.set(
      insertUsageEvent$,
      {
        orgId: orgOf(actor),
        userId: actor.userId,
        runId: run.runId,
        status: "processed",
        creditsCharged: 5,
        processedAt: nowDate(),
      },
      context.signal,
    );
    await expect(
      store.set(
        readUsageStorageCounts$,
        { scope: "organization", id: orgOf(actor) },
        context.signal,
      ),
    ).resolves.toStrictEqual({ raw: 1, hourly: 1 });

    await gh.installGithubApp(actor, agent.agentId, {
      oauthCode: {
        code: `whcb08a-${randomUUID().slice(0, 8)}`,
        githubUserId: newGithubUserId(),
      },
    });
    const botToken = await registerTelegramBot(actor, agent.agentId);
    await runs.applyUserPermissionGrant(actor, {
      agentId: agent.agentId,
      connectorSlug: "slack",
      permission: "conversations:read",
      action: "allow",
    });
    await expect(
      runs.listUserPermissionGrants(actor, agent.agentId),
    ).resolves.toHaveLength(1);

    // Billing cleanup completes before a failing org S3 listing aborts the
    // remaining teardown without surfacing in the webhook response.
    context.mocks.stripe.subscriptions.list
      .mockResolvedValueOnce({
        data: [
          proSubscription({
            id: granted.subscriptionId,
            customerId: granted.customerId,
          }),
        ],
        has_more: false,
      })
      .mockResolvedValueOnce({
        data: [
          proSubscription({
            id: allowanceSubscriptionId,
            customerId: allowanceCustomerId,
          }),
        ],
        has_more: false,
      })
      .mockResolvedValueOnce({
        data: [
          proSubscription({
            id: granted.subscriptionId,
            customerId: granted.customerId,
            status: "canceled",
          }),
        ],
        has_more: false,
      })
      .mockResolvedValueOnce({
        data: [
          proSubscription({
            id: allowanceSubscriptionId,
            customerId: allowanceCustomerId,
            status: "canceled",
          }),
        ],
        has_more: false,
      });
    context.mocks.stripe.subscriptions.update.mockResolvedValue({});
    context.mocks.stripe.subscriptions.cancel.mockResolvedValue({});
    context.mocks.stripe.invoices.list.mockResolvedValue({
      data: [],
      has_more: false,
    });
    context.mocks.s3.send.mockRejectedValueOnce(new Error("R2 unavailable"));
    api.verifyNextClerkWebhook({
      type: "organization.deleted",
      data: { id: orgOf(actor) },
    });
    const firstDelivery = await api.requestClerkWebhook("{}", {}, [200]);
    expect(firstDelivery.body).toBe("OK");
    await flushWaitUntilForTest();
    await waitForExpectation(() => {
      expect(context.mocks.stripe.subscriptions.cancel).toHaveBeenCalledWith(
        granted.subscriptionId,
        { invoice_now: false, prorate: false },
        {
          idempotencyKey: `org-delete:${orgOf(actor)}:${granted.subscriptionId}:cancel`,
        },
      );
      expect(context.mocks.telegram.deleteWebhook).toHaveBeenCalledWith(
        botToken,
      );
    });
    const survivingRun = await runs.requestReadRun(actor, run.runId, [200]);
    expect(survivingRun.status).toBe(200);
    // The onboarding default agent and the teardown agent both survive.
    await expect(bdd.listAgents(actor)).resolves.toHaveLength(2);

    // The redelivered event completes the teardown, deleting storage
    // objects and all org-scoped resources.
    const deletedS3Keys: string[] = [];
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      const input = commandInput(command);
      if (typeof input.Prefix === "string") {
        return Promise.resolve({
          Contents: [
            {
              Key: `${input.Prefix}/archive.bin`,
              Size: 1,
              LastModified: nowDate(),
            },
          ],
        });
      }
      const removal = input.Delete as
        | { readonly Objects?: readonly { readonly Key?: string }[] }
        | undefined;
      for (const object of removal?.Objects ?? []) {
        if (object.Key) {
          deletedS3Keys.push(object.Key);
        }
      }
      return Promise.resolve({});
    });
    const compactionLock = await holdUsageEventCompactionLockFixture(
      context.signal,
    );
    onTestFinished(async () => {
      compactionLock.release();
      await compactionLock.done;
      await flushWaitUntilForTest();
    });
    api.verifyNextClerkWebhook({
      type: "organization.deleted",
      data: { id: orgOf(actor) },
    });
    const redelivery = await compactionLock.withAcquisitionAttemptTracking(
      () => {
        return api.requestClerkWebhook("{}", {}, [200]);
      },
    );
    expect(redelivery.body).toBe("OK");
    await compactionLock.acquisitionAttempted;
    await expect.poll(compactionLock.waiterCount).toBeGreaterThanOrEqual(1);
    await expect(
      store.set(
        readUsageStorageCounts$,
        { scope: "organization", id: orgOf(actor) },
        context.signal,
      ),
    ).resolves.toStrictEqual({ raw: 1, hourly: 1 });
    compactionLock.release();
    await compactionLock.done;
    await flushWaitUntilForTest();

    await expect
      .poll(() => {
        return deletedS3Keys.length;
      })
      .toBeGreaterThan(0);
    // The redelivered webhook responds OK before the teardown finishes, so
    // the resource deletions land asynchronously — poll instead of asserting
    // a single snapshot.
    await waitForExpectation(async () => {
      await runs.requestReadRun(actor, run.runId, [404]);
    });
    await waitForExpectation(async () => {
      await expect(bdd.listAgents(actor)).resolves.toStrictEqual([]);
    });
    await waitForExpectation(async () => {
      await expect(
        store.set(
          readUsageStorageCounts$,
          { scope: "organization", id: orgOf(actor) },
          context.signal,
        ),
      ).resolves.toStrictEqual({ raw: 0, hourly: 0 });
    });
    await waitForExpectation(async () => {
      const listed = await connectors.listConnectors(actor);
      expect(listed.connectors).not.toContainEqual(
        expect.objectContaining({
          type: "openai",
          connectionStatus: "connected",
        }),
      );
    });
    await waitForExpectation(async () => {
      await expect(
        connectors.listCustomConnectors(actor),
      ).resolves.toStrictEqual([]);
    });
    await expect(
      connectors.completeOauthCallbackResult("slack", {
        code: "org-teardown-deleted-state",
        state: builtinOauthState,
      }),
    ).resolves.toMatchObject({
      body: {
        status: "error",
        message: "Invalid state - please try again",
      },
    });
    await expect(
      connectors.completeCustomConnectorOAuth2CallbackResult({
        code: "org-teardown-deleted-custom-state",
        state: customOauthState,
      }),
    ).resolves.toMatchObject({
      body: {
        status: "error",
        message: "Invalid OAuth state - please try again",
      },
    });
    // An org without a live subscription skips the Stripe update.
    const updateCalls =
      context.mocks.stripe.subscriptions.update.mock.calls.length;
    const plainActor = bdd.user();
    await bdd.bootstrapLimitedFreeOnboarding(plainActor, {
      displayName: "BDD Plain Teardown",
    });
    api.verifyNextClerkWebhook({
      type: "organization.deleted",
      data: { id: orgOf(plainActor) },
    });
    await api.requestClerkWebhook("{}", {}, [200]);
    await expect
      .poll(async () => {
        const agents = await bdd.listAgents(plainActor);
        return agents.length;
      })
      .toBe(0);
    expect(context.mocks.stripe.subscriptions.update.mock.calls).toHaveLength(
      updateCalls,
    );
  });

  it("cancels trialing Stripe subscriptions and deletes an empty org after a verified user.deleted event", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    api.configureClerkWebhookSecret();
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();

    const actor = bdd.user();
    const granted = await runs.grantProEntitlement(actor);
    const suffix = randomUUID().slice(0, 8);
    const extraSubscriptionId = `sub_bdd_extra_${suffix}`;
    const nonRenewingSubscriptionId = `sub_bdd_nonrenewing_${suffix}`;
    context.mocks.stripe.subscriptions.list
      .mockResolvedValueOnce({
        data: [
          {
            id: granted.subscriptionId,
            status: "active",
            cancel_at_period_end: false,
          },
          {
            id: nonRenewingSubscriptionId,
            status: "active",
            cancel_at_period_end: true,
          },
        ],
        has_more: true,
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: extraSubscriptionId,
            status: "trialing",
            cancel_at_period_end: true,
          },
        ],
        has_more: false,
      });
    context.mocks.stripe.subscriptions.update.mockResolvedValue({});
    context.mocks.s3.send.mockResolvedValue({});

    api.verifyNextClerkWebhook({
      type: "user.deleted",
      data: { id: actor.userId },
    });
    const response = await api.requestClerkWebhook("{}", {}, [200]);
    expect(response.body).toBe("OK");

    await flushWaitUntilForTest();
    await waitForExpectation(() => {
      expect(context.mocks.stripe.subscriptions.list).toHaveBeenNthCalledWith(
        1,
        {
          customer: granted.customerId,
          status: "all",
          limit: 100,
        },
      );
      expect(context.mocks.stripe.subscriptions.list).toHaveBeenNthCalledWith(
        2,
        {
          customer: granted.customerId,
          status: "all",
          limit: 100,
          starting_after: nonRenewingSubscriptionId,
        },
      );
      expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledTimes(
        1,
      );
      expect(context.mocks.stripe.subscriptions.update).toHaveBeenNthCalledWith(
        1,
        granted.subscriptionId,
        { cancel_at_period_end: true },
      );
      expect(context.mocks.stripe.subscriptions.cancel).toHaveBeenCalledTimes(
        1,
      );
      expect(context.mocks.stripe.subscriptions.cancel).toHaveBeenCalledWith(
        extraSubscriptionId,
      );
    });
    // Once the empty org is deleted, its billing metadata is gone: the
    // billing status read falls back to the unprovisioned defaults instead
    // of the previously granted pro subscription.
    const billing = createBillingMediaApi(context);
    await expect
      .poll(async () => {
        const status = await billing.readBillingStatus(actor);
        return [status.tier, status.subscriptionStatus, status.hasSubscription];
      })
      .toStrictEqual(["pro-suspend", null, false]);
  });

  it("preserves org data when a deleted user leaves an uncached Clerk member", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    api.configureClerkWebhookSecret();
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();

    const doomed = bdd.user();
    await runs.grantProEntitlement(doomed);
    const orgId = orgOf(doomed);
    const peer = bdd.user({ orgId, orgRole: "org:member" });
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockClear();
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [{ publicUserData: { userId: peer.userId } }],
      },
    );
    context.mocks.stripe.subscriptions.list.mockClear();
    context.mocks.stripe.subscriptions.update.mockClear();
    context.mocks.stripe.subscriptions.cancel.mockClear();
    context.mocks.s3.send.mockResolvedValue({});

    api.verifyNextClerkWebhook({
      type: "user.deleted",
      data: { id: doomed.userId },
    });
    const response = await api.requestClerkWebhook("{}", {}, [200]);
    expect(response.body).toBe("OK");

    await flushWaitUntilForTest();
    await waitForExpectation(() => {
      expect(
        context.mocks.clerk.organizations.getOrganizationMembershipList,
      ).toHaveBeenCalledWith({
        organizationId: orgId,
        limit: 100,
        offset: 0,
      });
    });
    expect(context.mocks.stripe.subscriptions.list).not.toHaveBeenCalled();
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(context.mocks.stripe.subscriptions.cancel).not.toHaveBeenCalled();
    // The org survives because the remaining Clerk member keeps it non-empty:
    // its billing entitlement is still readable by the surviving member.
    const billing = createBillingMediaApi(context);
    const preserved = await billing.readBillingStatus(peer);
    expect(preserved.tier).toBe("pro");
    expect(preserved.hasSubscription).toBeTruthy();
    expect(preserved.subscriptionStatus).toBe("active");
  });

  it("does not update a Stripe subscription already canceled upstream", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    api.configureClerkWebhookSecret();
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();

    const actor = bdd.user();
    const granted = await runs.grantProEntitlement(actor);
    context.mocks.stripe.subscriptions.list.mockResolvedValueOnce({
      data: [
        {
          id: granted.subscriptionId,
          status: "canceled",
          cancel_at_period_end: false,
        },
      ],
      has_more: false,
    });
    context.mocks.stripe.subscriptions.update.mockResolvedValue({});
    context.mocks.s3.send.mockResolvedValue({});

    api.verifyNextClerkWebhook({
      type: "user.deleted",
      data: { id: actor.userId },
    });
    const response = await api.requestClerkWebhook("{}", {}, [200]);
    expect(response.body).toBe("OK");

    await flushWaitUntilForTest();
    await waitForExpectation(() => {
      expect(context.mocks.stripe.subscriptions.list).toHaveBeenCalledWith({
        customer: granted.customerId,
        status: "all",
        limit: 100,
      });
      expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
      expect(context.mocks.stripe.subscriptions.cancel).not.toHaveBeenCalled();
    });
    // The empty org is still deleted: billing status falls back to the
    // unprovisioned defaults once the org metadata is cleaned up.
    const billing = createBillingMediaApi(context);
    await expect
      .poll(async () => {
        const status = await billing.readBillingStatus(actor);
        return [status.tier, status.subscriptionStatus, status.hasSubscription];
      })
      .toStrictEqual(["pro-suspend", null, false]);
  });

  it("cleans up user state after a verified user.deleted event", async () => {
    const bdd = createBddApi(context);
    const chat = createChatFilesBddApi(context);
    const runs = createRunsApi(context);
    const connectors = createConnectorBddApi(context);
    const userConfig = createUserConfigBddApi(context);
    const gh = createGithubBddApi(context);
    api.configureClerkWebhookSecret();
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const runnerGroup = runs.configureRunnerGroup();
    acceptGithubGrantRevocations();
    mockSlackConnectorOAuth();
    const customOAuthProvider = mockCustomConnectorOAuth2Provider(context);

    const doomed = bdd.user();
    await runs.grantProEntitlement(doomed);
    await runs.ensureOrgModelProvider(doomed);
    await connectors.connectManualGrant(doomed, "openai", "api-token", {
      apiKey: "user-teardown-connector-token",
    });
    const peer = bdd.user({ orgId: doomed.orgId, orgRole: "org:member" });
    const sharedAgent = await bdd.createAgent(peer, {
      displayName: "BDD Shared Grant Agent",
      visibility: "public",
    });
    const doomedAgent = await bdd.createAgent(doomed, {
      displayName: "BDD Doomed Agent",
      visibility: "private",
    });
    const connectorSelectionThread = await chat.createThread(doomed, {
      agentId: doomedAgent.agentId,
      title: "BDD doomed connector selection",
    });
    await runs.enableAgentConnectors(doomed, sharedAgent.agentId, ["openai"]);
    await connectors.connectManualGrant(
      peer,
      "openai",
      "api-token",
      { apiKey: "peer-teardown-connector-token" },
      sharedAgent.agentId,
    );

    const customManual = await connectors.createCustomConnector(
      doomed,
      customManualConnectorBodyForTeardown("user"),
    );
    await connectors.setCustomConnectorSecret(
      doomed,
      customManual.id,
      "doomed-custom-secret",
    );
    const customManualStorage =
      await readCustomConnectorCredentialStorageParent(context, {
        orgId: orgOf(doomed),
        userId: doomed.userId,
        customConnectorId: customManual.id,
      });
    const customManualMemberConnectorId = customManualStorage.connector?.id;
    if (!customManualMemberConnectorId) {
      throw new Error("Expected the doomed custom connector account");
    }
    await connectors.setCustomConnectorSecret(
      peer,
      customManual.id,
      "peer-custom-secret",
    );
    await connectors.updateAgentCustomConnectors(doomed, sharedAgent.agentId, [
      customManual.id,
    ]);
    await connectors.updateAgentCustomConnectors(peer, sharedAgent.agentId, [
      customManual.id,
    ]);

    const customOauth = await connectors.createCustomConnector(
      doomed,
      customOauthConnectorBodyForTeardown("user", customOAuthProvider),
    );
    const doomedBuiltinOauthState = oauthStateFromAuthorizationUrl(
      (
        await connectors.startOauth(
          doomed,
          "slack",
          "oauth",
          sharedAgent.agentId,
        )
      ).authorizationUrl,
    );
    const peerBuiltinOauthState = oauthStateFromAuthorizationUrl(
      (await connectors.startOauth(peer, "slack", "oauth", sharedAgent.agentId))
        .authorizationUrl,
    );
    const doomedCustomOauthState = oauthStateFromAuthorizationUrl(
      await connectors.startCustomConnectorOAuth2(
        doomed,
        customOauth.id,
        sharedAgent.agentId,
      ),
    );
    const peerCustomOauthState = oauthStateFromAuthorizationUrl(
      await connectors.startCustomConnectorOAuth2(
        peer,
        customOauth.id,
        sharedAgent.agentId,
      ),
    );

    const doomedKey = await runs.createCliToken(doomed);
    const doomedBearer = `Bearer ${doomedKey.token}`;
    const livePoll = await runs.requestPollRunnerAs(
      doomedBearer,
      { group: runnerGroup, supportedProfiles: ["vm0/default"] },
      [200],
    );
    expect(livePoll.status).toBe(200);

    const run = await runs.createRun(doomed, {
      agentId: sharedAgent.agentId,
      prompt: "user teardown run",
      modelProvider: "anthropic-api-key",
    });
    expect(run.status).toBe("pending");
    await seedCustomThreadConnectorSelection(context, {
      chatThreadId: connectorSelectionThread.id,
      connectorId: customManualMemberConnectorId,
      customConnectorId: customManual.id,
    });
    await runs.claimRunnerJob(run.runId);
    await store.set(
      insertUsageEvent$,
      {
        orgId: orgOf(doomed),
        userId: doomed.userId,
        runId: run.runId,
        status: "processed",
        creditsCharged: 10,
        processedAt: nowDate(),
      },
      context.signal,
    );
    await expect(
      store.set(
        materializeHourlyUsage$,
        {
          orgId: orgOf(doomed),
          userId: doomed.userId,
          runId: run.runId,
        },
        context.signal,
      ),
    ).resolves.toBe(1);
    await store.set(
      insertUsageEvent$,
      {
        orgId: orgOf(doomed),
        userId: doomed.userId,
        runId: run.runId,
        status: "processed",
        creditsCharged: 5,
        processedAt: nowDate(),
      },
      context.signal,
    );
    await expect(
      store.set(
        readUsageStorageCounts$,
        { scope: "user", id: doomed.userId },
        context.signal,
      ),
    ).resolves.toStrictEqual({ raw: 1, hourly: 1 });

    // The installation's default agent is the peer's compose, so the
    // installation itself survives the user teardown while the doomed
    // user's GitHub link is removed.
    await gh.installGithubApp(doomed, sharedAgent.agentId, {
      oauthCode: {
        code: `whcb08b-${randomUUID().slice(0, 8)}`,
        githubUserId: newGithubUserId(),
      },
    });
    expect((await gh.readInstallation(doomed)).isConnected).toBeTruthy();
    const botToken = await registerTelegramBot(doomed, doomedAgent.agentId);

    await runs.applyUserPermissionGrant(doomed, {
      agentId: sharedAgent.agentId,
      connectorSlug: "slack",
      permission: "conversations:read",
      action: "allow",
    });
    await runs.applyUserPermissionGrant(peer, {
      agentId: sharedAgent.agentId,
      connectorSlug: "slack",
      permission: "chat:write",
      action: "deny",
    });

    // User storage cleanup is best-effort: a failing S3 listing must not
    // stop the rest of the teardown.
    const s3CallCountBeforeCleanup = context.mocks.s3.send.mock.calls.length;
    context.mocks.s3.send.mockRejectedValueOnce(new Error("R2 unavailable"));
    const compactionLock = await holdUsageEventCompactionLockFixture(
      context.signal,
    );
    onTestFinished(async () => {
      compactionLock.release();
      await compactionLock.done;
      await flushWaitUntilForTest();
    });
    context.mocks.ably.publish.mockClear();
    api.verifyNextClerkWebhook({
      type: "user.deleted",
      data: { id: doomed.userId },
    });
    const response = await compactionLock.withAcquisitionAttemptTracking(() => {
      return api.requestClerkWebhook("{}", {}, [200]);
    });
    expect(response.body).toBe("OK");
    await compactionLock.acquisitionAttempted;
    await expect.poll(compactionLock.waiterCount).toBeGreaterThanOrEqual(1);
    await expect(
      store.set(
        readUsageStorageCounts$,
        { scope: "user", id: doomed.userId },
        context.signal,
      ),
    ).resolves.toStrictEqual({ raw: 1, hourly: 1 });
    compactionLock.release();
    await compactionLock.done;
    await flushWaitUntilForTest();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith("cancel", {
      runId: run.runId,
      mode: "hard",
    });
    const firstCleanupS3Prefix = commandInput(
      context.mocks.s3.send.mock.calls[s3CallCountBeforeCleanup]?.[0],
    ).Prefix;
    expect(
      typeof firstCleanupS3Prefix === "string" &&
        firstCleanupS3Prefix.startsWith(`${orgOf(doomed)}/`) &&
        firstCleanupS3Prefix.endsWith("/"),
    ).toBeTruthy();

    await waitForExpectation(() => {
      expect(context.mocks.telegram.deleteWebhook).toHaveBeenCalledWith(
        botToken,
      );
    });
    await waitForExpectation(async () => {
      const listed = await connectors.listConnectors(doomed);
      expect(listed.connectors).not.toContainEqual(
        expect.objectContaining({
          type: "openai",
          connectionStatus: "connected",
        }),
      );
    });
    let revokedPoll:
      | Awaited<ReturnType<typeof runs.requestPollRunnerAs>>
      | undefined;
    await expect
      .poll(async () => {
        revokedPoll = await runs.requestPollRunnerAs(
          doomedBearer,
          { group: runnerGroup, supportedProfiles: ["vm0/default"] },
          [200, 401],
        );
        return revokedPoll.status;
      })
      .toBe(401);
    if (!revokedPoll || revokedPoll.status !== 401) {
      throw new Error("Expected deleted user's runner token to be revoked");
    }
    expectApiError(revokedPoll.body);
    await runs.requestReadRun(doomed, run.runId, [404]);
    expect((await gh.readInstallation(doomed)).isConnected).toBeFalsy();
    await waitForExpectation(async () => {
      await expect(
        runs.listUserPermissionGrants(doomed, sharedAgent.agentId),
      ).resolves.toStrictEqual([]);
    });
    const peerGrants = await runs.listUserPermissionGrants(
      peer,
      sharedAgent.agentId,
    );
    expect(peerGrants).toHaveLength(1);
    expect(peerGrants[0]).toMatchObject({
      permission: "chat:write",
      action: "deny",
    });
    await expect(
      userConfig.readUserConnectors(doomed, sharedAgent.agentId),
    ).resolves.toStrictEqual({ enabledConnectorSlugs: [] });
    await expect(
      userConfig.readUserConnectors(peer, sharedAgent.agentId),
    ).resolves.toMatchObject({ enabledConnectorSlugs: ["openai"] });
    await expect(
      connectors.readAgentCustomConnectors(doomed, sharedAgent.agentId),
    ).resolves.toStrictEqual([]);
    await expect(
      connectors.readAgentCustomConnectors(peer, sharedAgent.agentId),
    ).resolves.toStrictEqual([customManual.id]);
    await expect(
      connectors.readCustomConnector(doomed, customManual.id),
    ).resolves.toMatchObject({
      connected: false,
      configuredFieldKeys: [],
    });
    await expect(
      readThreadConnectorSelectionState(context, {
        chatThreadId: connectorSelectionThread.id,
        connectorId: customManualMemberConnectorId,
      }),
    ).resolves.toBeFalsy();
    await expect(
      connectors.readCustomConnector(peer, customManual.id),
    ).resolves.toMatchObject({
      connected: true,
    });
    await expect(
      connectors.completeOauthCallbackResult("slack", {
        code: "doomed-deleted-state",
        state: doomedBuiltinOauthState,
      }),
    ).resolves.toMatchObject({
      body: {
        status: "error",
        message: "Invalid state - please try again",
      },
    });
    await expect(
      connectors.completeCustomConnectorOAuth2CallbackResult({
        code: "doomed-deleted-custom-state",
        state: doomedCustomOauthState,
      }),
    ).resolves.toMatchObject({
      body: {
        status: "error",
        message: "Invalid OAuth state - please try again",
      },
    });
    await expect(
      connectors.completeOauthCallbackResult("slack", {
        code: "peer-surviving-state",
        state: peerBuiltinOauthState,
      }),
    ).resolves.toMatchObject({ body: { status: "success" } });
    await expect(
      connectors.completeCustomConnectorOAuth2CallbackResult({
        code: "peer-surviving-custom-state",
        state: peerCustomOauthState,
      }),
    ).resolves.toMatchObject({ body: { status: "success" } });
    await expect(
      store.set(
        readUsageStorageCounts$,
        { scope: "user", id: doomed.userId },
        context.signal,
      ),
    ).resolves.toStrictEqual({ raw: 0, hourly: 0 });
    expect(context.mocks.stripe.subscriptions.list).not.toHaveBeenCalled();
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(context.mocks.stripe.subscriptions.cancel).not.toHaveBeenCalled();
    // The org outlives the user teardown: the surviving member still sees the
    // granted pro subscription through the billing status read.
    const billing = createBillingMediaApi(context);
    const preserved = await billing.readBillingStatus(peer);
    expect(preserved.tier).toBe("pro");
    expect(preserved.hasSubscription).toBeTruthy();
  });

  it("suspends user-owned runs after a verified user.banned event", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    api.configureClerkWebhookSecret();
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    runs.configureRunnerGroup();

    const banned = bdd.user();
    const granted = await runs.grantProEntitlement(banned);
    await runs.ensureOrgModelProvider(banned);
    const agent = await bdd.createAgent(banned, {
      displayName: "BDD Banned User Agent",
      visibility: "private",
    });

    const run = await runs.createRun(banned, {
      agentId: agent.agentId,
      prompt: "banned user cleanup run",
      modelProvider: "anthropic-api-key",
    });
    expect(run.status).toBe("pending");

    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [],
      has_more: false,
    });
    context.mocks.stripe.subscriptions.update.mockResolvedValue({});
    api.verifyNextClerkWebhook({
      type: "user.banned",
      data: { id: banned.userId },
    });
    const response = await api.requestClerkWebhook("{}", {}, [200]);
    expect(response.body).toBe("OK");
    await flushWaitUntilForTest();

    const bannedRun = await runs.readRun(banned, run.runId);
    expect(bannedRun.status).toBe("cancelled");
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      granted.subscriptionId,
      { cancel_at_period_end: true },
    );
    expect(context.mocks.stripe.subscriptions.cancel).not.toHaveBeenCalled();

    const queue = await runs.readRunQueue(banned);
    expect(queue.body.concurrency.active).toBe(0);
    expect(queue.body.queue).toStrictEqual([]);
  });
});
