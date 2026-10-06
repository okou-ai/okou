import { randomUUID } from "node:crypto";
import { z } from "zod";
import { expect } from "vitest";
import { http, HttpResponse } from "msw";
import { seoContract } from "@okouai/api-contracts/contracts/seo";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { env, mockEnv } from "../../../../lib/env";
import { now } from "../../../../lib/time";
import { server } from "../../../../mocks/server";
import { createUsagePricingFixture } from "../../../../test-fixtures/system-config-seeds";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { settleIncludingAbort } from "../../../utils";
import { seoRoutes } from "../../seo";
import { createBddApi, type ApiTestUser } from "./api-bdd";
import { createBillingMediaApi } from "./api-bdd-billing-media";
import { createRunReadsApi } from "./api-bdd-run-reads";
import { createRunsApi } from "./api-bdd-runs";
import { createWebhookCallbackApi } from "./api-bdd-webhooks";
import { createPublicBillingZeroFixture } from "./public-billing-zero-fixture";
import { deleteFeatureSwitchesForUser } from "./feature-switches";
import { createRouteMocks } from "./route-test";

/** Exact wallets produced by a legal purchase and an actual provider charge. */
export function createPublicUsageWallet(
  context: TestContext,
  actor: ApiTestUser,
  options: { credits: -10 | 0 | 10 | 100 | 1000; otherMember?: boolean },
) {
  const orgId = actor.orgId;
  if (!orgId) {
    throw new Error("Expected a wallet organization");
  }
  const bdd = createBddApi(context);
  const api = createRunsApi(context);
  const member = options.otherMember
    ? bdd.user({ orgId, orgRole: "org:member" })
    : actor;
  const runIds = new Set<string>();
  const releases: (() => Promise<void>)[] = [];
  const owner = createPublicBillingZeroFixture(context, actor, {
    plan: {
      tier: "pro",
      priceId: "price_bdd_pro",
      webhookSecret: "whsec_public_wallet",
    },
    async beforeOrganizationCleanup() {
      const accepted = await createRunReadsApi(context).requestListLogs(
        actor,
        { limit: 100 },
        [200],
      );
      for (const run of accepted.body.data) {
        runIds.add(run.id);
      }
      for (const runId of runIds) {
        const run = await api.readRun(actor, runId);
        if (run.status === "pending" || run.status === "running") {
          await api.requestCancelRun(actor, runId, [200]);
        }
      }
      // These scenarios admit pending Runs and never claim a sandbox.
      await flushWaitUntilForTest();
      await deleteFeatureSwitchesForUser(context, { ...actor, orgId });
    },
    async afterOrganizationCleanup() {
      const results = await Promise.all(
        releases.map((release) => {
          return settleIncludingAbort(release());
        }),
      );
      const webhooks = createWebhookCallbackApi(context);
      webhooks.configureClerkWebhookSecret();
      for (const userId of new Set([actor.userId, member.userId])) {
        webhooks.verifyNextClerkWebhook({
          type: "user.deleted",
          data: { id: userId },
        });
        await webhooks.requestClerkWebhook("{}", {}, [200]);
        await flushWaitUntilForTest();
      }
      for (const result of results) {
        if (!result.ok) {
          throw result.error;
        }
      }
    },
  });
  function registerCleanup(cleanup: () => Promise<void>) {
    releases.push(cleanup);
  }
  async function initialize() {
    mockEnv("OKOU_PRICE_PRO", "price_bdd_pro");
    bdd.acceptAgentStorageWrites();
    api.configureRunnerGroup();
    await owner.initialize();
    if (member.userId !== actor.userId) {
      await bdd.completeOnboarding(member);
    }
    if (options.credits === 0) {
      return;
    }
    const priceId = `price_wallet_${randomUUID()}`;
    mockEnv("OKOU_PRICE_CUSTOM_CREDIT_UNIT", priceId);
    let checkout: unknown;
    context.mocks.stripe.checkout.sessions.create.mockImplementation(
      (params) => {
        checkout = params;
        return Promise.resolve({
          id: `cs_wallet_${randomUUID()}`,
          url: "https://checkout.stripe.com/public-wallet",
        });
      },
    );
    await createBillingMediaApi(context).startCreditCheckout(actor, {
      credits: 1000,
      customAmount: true,
      successUrl: `${env("APP_URL")}/settings/billing`,
      cancelUrl: `${env("APP_URL")}/settings/billing`,
    });
    expect(checkout).toMatchObject({
      customer: owner.customerId,
      mode: "payment",
      line_items: [{ price: priceId, quantity: 1 }],
    });
    const {
      invoice_creation: {
        invoice_data: { metadata },
      },
    } = z
      .object({
        invoice_creation: z.object({
          invoice_data: z.object({
            metadata: z.record(z.string(), z.string()),
          }),
        }),
      })
      .parse(checkout);
    await createWebhookCallbackApi(context).postStripeEvent(
      {
        id: `evt_wallet_${randomUUID()}`,
        type: "invoice.paid",
        created: Math.floor(now() / 1000),
        data: {
          object: {
            id: `in_wallet_${randomUUID()}`,
            customer: owner.customerId,
            subtotal: 100,
            amount_paid: 100,
            metadata,
            parent: null,
            lines: {
              has_more: false,
              data: [
                {
                  id: `il_wallet_${randomUUID()}`,
                  price: { id: priceId },
                  quantity: 1,
                  amount: 100,
                },
              ],
            },
          },
        },
      },
      [200],
    );
    await flushWaitUntilForTest();
    await expect(api.readBillingStatus(actor)).resolves.toMatchObject({
      tier: "pro",
      status: "active",
      credits: 1000,
    });
    if (options.credits !== 1000) {
      const charge = 1000 - options.credits;
      const cost = (800 * charge - 400) / 1_000_000;
      const pricing = await createUsagePricingFixture({
        registerCleanup,
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
      mockEnv("OKOU_SEO_DATAFORSEO_LOGIN", "test-dataforseo-login");
      mockEnv("OKOU_SEO_DATAFORSEO_PASSWORD", "test-dataforseo-password");
      const requests: unknown[] = [];
      server.use(
        http.post(
          "https://api.dataforseo.com/v3/backlinks/summary/live",
          async ({ request }) => {
            requests.push(await request.json());
            return HttpResponse.json({
              version: "0.1.20260810",
              status_code: 20_000,
              status_message: "Ok.",
              time: "0.1000 sec.",
              cost,
              tasks_count: 1,
              tasks_error: 0,
              tasks: [
                {
                  id: "wallet-task",
                  status_code: 20_000,
                  status_message: "Ok.",
                  time: "0.1000 sec.",
                  cost,
                  result_count: 1,
                  result: [
                    {
                      target: "example.com",
                      referring_domains: 1,
                      backlinks: 1,
                    },
                  ],
                },
              ],
            });
          },
        ),
      );
      createRouteMocks(context).clerk.session(
        member.userId,
        orgId,
        member.orgRole,
      );
      const response = await accept(
        setupApp({
          context,
          routes: seoRoutes,
          usagePricingResolution: pricing.resolution,
        })(seoContract).backlinksSummary({
          headers: { authorization: "Bearer clerk-session" },
          body: { target: "example.com", includeSubdomains: true },
        }),
        [200],
      );
      expect(requests).toStrictEqual([
        [{ target: "example.com", include_subdomains: true }],
      ]);
      expect(response.body).toMatchObject({
        provider: "dataforseo",
        billingCategory: "provider_cost_usd_micros",
        providerCostUsd: cost,
        creditsCharged: charge,
      });
      await flushWaitUntilForTest();
    }
    await expect(api.readBillingStatus(actor)).resolves.toMatchObject({
      tier: "pro",
      status: "active",
      credits: options.credits,
    });
  }
  return {
    ...owner,
    actor,
    orgId,
    registerCleanup,
    initialize,
    registerRun(runId: string) {
      runIds.add(runId);
    },
  };
}
