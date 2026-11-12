import {
  billingSurveyContract,
  billingCheckoutContract,
  billingUsagePackCreditsContract,
} from "@okouai/api-contracts/contracts/billing";
import StripeSDK from "stripe";
import { object, record, string } from "zod";
import {
  mockStripeClient,
  type StripeCheckoutSession,
} from "../../external/stripe-client";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow, nowDate } from "../../../lib/time";
import { billingCheckoutRoutes } from "../billing-checkout";
import { createApp } from "../../../app-factory";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { billingSurveyRoutes } from "../billing-survey";
import { billingUsagePackCreditsRoutes } from "../billing-usage-pack-credits";

const context = testContext();
function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function signIn(actor: ApiTestUser): void {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
}

function surveyClient() {
  return setupApp({ context, routes: billingSurveyRoutes })(
    billingSurveyContract,
  );
}

async function enableSurvey(actor: ApiTestUser): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Billing survey tests require an org-scoped actor");
  }
  await updateFeatureSwitchesForUser(
    context,
    { userId: actor.userId, orgId: actor.orgId },
    { [FeatureSwitchKey.BillingSurvey]: true },
  );
}

async function bonusCredits(): Promise<number> {
  const balance = await accept(
    setupApp({ context, routes: billingUsagePackCreditsRoutes })(
      billingUsagePackCreditsContract,
    ).get({ headers: authHeaders() }),
    [200],
  );
  return balance.body.bonusCredits;
}

async function createCheckout(
  actor: ApiTestUser,
  ageMs = 31 * 60_000,
): Promise<StripeCheckoutSession> {
  signIn(actor);
  context.mocks.stripe.customers.create.mockResolvedValue({
    id: `cus_survey_${actor.orgId}`,
  });
  context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
    id: "cs_survey_test",
    url: "https://checkout.stripe.com/c/pay/cs_survey_test",
  });
  const session: StripeCheckoutSession = {
    id: "cs_survey_test",
    mode: "subscription",
    subscription: null,
    status: "open",
    payment_status: "unpaid",
    created: Math.floor((nowDate().getTime() - ageMs) / 1000),
    customer: `cus_survey_${actor.orgId}`,
    metadata: {
      orgId: actor.orgId ?? "",
      tier: "pro",
      billingSurveyUserId: actor.userId,
    },
  };
  mockCheckoutSessions([session]);
  const checkout = await accept(
    setupApp({ context, routes: billingCheckoutRoutes })(
      billingCheckoutContract,
    ).create({
      headers: authHeaders(),
      body: {
        tier: "pro",
        successUrl: "http://localhost:3002/?billing=pro",
        cancelUrl: "http://localhost:3002/?billing=canceled",
      },
    }),
    [200],
  );
  expect(checkout.body).toMatchObject({
    url: "https://checkout.stripe.com/c/pay/cs_survey_test",
  });
  expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith(
    expect.objectContaining({
      metadata: expect.objectContaining({ billingSurveyUserId: actor.userId }),
    }),
  );
  return session;
}

function mockCheckoutSessions(
  sessions: readonly StripeCheckoutSession[],
): void {
  context.mocks.stripe.checkout.sessions.list.mockResolvedValue({
    data: sessions,
    has_more: false,
  });
  context.mocks.stripe.checkout.sessions.retrieve.mockImplementation((id) => {
    const session = sessions.find((value) => {
      return value.id === id;
    });
    if (!session) {
      throw new Error("Unknown test Checkout");
    }
    return Promise.resolve(session);
  });
}

describe("/api/billing/survey", () => {
  beforeEach(() => {
    context.mocks.ably.publish.mockResolvedValue(undefined);
    mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
  });

  it("is unavailable while the feature switch is off", async () => {
    const bdd = createBddApi(context);
    const actor = bdd.user();
    signIn(actor);

    const status = await accept(
      surveyClient().status({ headers: authHeaders() }),
      [404],
    );
    expect(status.status).toBe(404);
    const submit = await accept(
      surveyClient().submit({
        headers: authHeaders(),
        body: { survey: "credits_exhausted", answer: "too_expensive" },
      }),
      [404],
    );
    expect(submit.status).toBe(404);
  });

  it("thanks an unpaid member with credits once for the credits-exhausted answer", async () => {
    mockNow(new Date("2026-11-11T08:00:00.000Z"));
    const bdd = createBddApi(context);
    const actor = bdd.user();
    await enableSurvey(actor);
    signIn(actor);

    const before = await accept(
      surveyClient().status({ headers: authHeaders() }),
      [200],
    );
    expect(before.body.answered).toStrictEqual([]);
    const reward = before.body.creditsExhaustedReward;
    expect(reward).toBeGreaterThan(0);
    const creditsBefore = await bonusCredits();

    const first = await accept(
      surveyClient().submit({
        headers: authHeaders(),
        body: {
          survey: "credits_exhausted",
          answer: "other",
          detail: "Waiting for my team budget",
        },
      }),
      [200],
    );
    expect(first.body).toStrictEqual({ recorded: true, rewardCredits: reward });
    await expect(bonusCredits()).resolves.toBe(creditsBefore + reward);

    const repeated = await accept(
      surveyClient().submit({
        headers: authHeaders(),
        body: { survey: "credits_exhausted", answer: "too_expensive" },
      }),
      [200],
    );
    expect(repeated.body).toStrictEqual({ recorded: false, rewardCredits: 0 });
    await expect(bonusCredits()).resolves.toBe(creditsBefore + reward);

    const after = await accept(
      surveyClient().status({ headers: authHeaders() }),
      [200],
    );
    expect(after.body.answered).toStrictEqual(["credits_exhausted"]);
    expect(after.body.creditsExhaustedReward).toBe(0);
    mockNow(new Date(nowDate().getTime() + 30 * 24 * 60 * 60 * 1000));
    await expect(bonusCredits()).resolves.toBe(creditsBefore);
  });

  it("grants the thank-you credits only once per organization", async () => {
    const bdd = createBddApi(context);
    const admin = bdd.user();
    const member = bdd.user({ orgId: admin.orgId, orgRole: "org:admin" });
    await enableSurvey(admin);
    await enableSurvey(member);

    signIn(admin);
    const first = await accept(
      surveyClient().submit({
        headers: authHeaders(),
        body: { survey: "credits_exhausted", answer: "not_sure_worth_it" },
      }),
      [200],
    );
    expect(first.body.rewardCredits).toBeGreaterThan(0);

    signIn(member);
    const offered = await accept(
      surveyClient().status({ headers: authHeaders() }),
      [200],
    );
    expect(offered.body.creditsExhaustedReward).toBe(0);
    const second = await accept(
      surveyClient().submit({
        headers: authHeaders(),
        body: { survey: "credits_exhausted", answer: "still_trying" },
      }),
      [200],
    );
    expect(second.body).toStrictEqual({ recorded: true, rewardCredits: 0 });
  });

  it("records a paid organization's answer without granting credits", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const actor = bdd.user();
    await runs.grantProEntitlement(actor, { tier: "pro" });
    await enableSurvey(actor);
    signIn(actor);
    const creditsBefore = await bonusCredits();

    const result = await accept(
      surveyClient().submit({
        headers: authHeaders(),
        body: { survey: "credits_exhausted", answer: "no_need_now" },
      }),
      [200],
    );
    expect(result.body).toStrictEqual({ recorded: true, rewardCredits: 0 });
    await expect(bonusCredits()).resolves.toBe(creditsBefore);
  });

  it("records an abandoned-checkout answer once without credits", async () => {
    const bdd = createBddApi(context);
    const actor = bdd.user();
    await enableSurvey(actor);
    await createCheckout(actor);
    signIn(actor);
    const creditsBefore = await bonusCredits();

    const body = {
      survey: "checkout_abandoned",
      answer: "payment_issue",
      checkoutKind: "plan",
      checkoutSessionId: "cs_survey_test",
    } as const;
    const first = await accept(
      surveyClient().submit({ headers: authHeaders(), body }),
      [200],
    );
    expect(first.body).toStrictEqual({ recorded: true, rewardCredits: 0 });
    const repeated = await accept(
      surveyClient().submit({ headers: authHeaders(), body }),
      [200],
    );
    expect(repeated.body.recorded).toBeFalsy();
    await expect(bonusCredits()).resolves.toBe(creditsBefore);

    const status = await accept(
      surveyClient().status({ headers: authHeaders() }),
      [200],
    );
    expect(status.body.answered).toStrictEqual(["checkout_abandoned"]);
  });

  it("discovers an unpaid Checkout on a new visit without a browser marker", async () => {
    const actor = createBddApi(context).user();
    await enableSurvey(actor);
    await createCheckout(actor);
    const result = await accept(
      surveyClient().status({ headers: authHeaders() }),
      [200],
    );
    expect(result.body.abandonedCheckout).toStrictEqual({
      checkoutSessionId: "cs_survey_test",
      checkoutKind: "plan",
    });
  });

  it.each(["credits", "usage_pack"] as const)(
    "derives %s purchases from Stripe metadata",
    async (kind) => {
      const actor = createBddApi(context).user();
      await enableSurvey(actor);
      const session = await createCheckout(actor);
      const metadata: Record<string, string> =
        kind === "credits"
          ? { purpose: "credit_purchase" }
          : { usagePackSubscriptionId: "pack_survey" };
      mockCheckoutSessions([
        {
          ...session,
          mode: kind === "credits" ? "payment" : "subscription",
          metadata: { ...session.metadata, ...metadata },
        },
      ]);
      const status = await accept(
        surveyClient().status({ headers: authHeaders() }),
        [200],
      );
      expect(status.body.abandonedCheckout).toStrictEqual({
        checkoutSessionId: session.id,
        checkoutKind: kind,
      });
    },
  );

  it("rechecks Stripe before accepting feedback after payment finishes", async () => {
    const actor = createBddApi(context).user();
    await enableSurvey(actor);
    const session = await createCheckout(actor);
    const before = await accept(
      surveyClient().status({ headers: authHeaders() }),
      [200],
    );
    expect(before.body.abandonedCheckout?.checkoutSessionId).toBe(session.id);
    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
      ...session,
      status: "complete",
      payment_status: "paid",
    });
    const submitted = await accept(
      surveyClient().submit({
        headers: authHeaders(),
        body: {
          survey: "checkout_abandoned",
          answer: "payment_issue",
          checkoutSessionId: session.id,
        },
      }),
      [200],
    );
    expect(submitted.body).toStrictEqual({ recorded: false, rewardCredits: 0 });
    const after = await accept(
      surveyClient().status({ headers: authHeaders() }),
      [200],
    );
    expect(after.body.answered).toStrictEqual([]);
  });

  it.each([
    { ageMs: 29 * 60_000, returned: false, eligible: false },
    { ageMs: 30 * 60_000, returned: false, eligible: true },
    { ageMs: 60_000, returned: true, eligible: true },
    { ageMs: 7 * 24 * 60 * 60_000, returned: true, eligible: false },
  ])(
    "applies the Checkout time window ($ageMs ms, returned=$returned)",
    async ({ ageMs, returned, eligible }) => {
      mockNow(new Date("2026-11-12T08:00:00.000Z"));
      const actor = createBddApi(context).user();
      await enableSurvey(actor);
      await createCheckout(actor, ageMs);
      const status = await accept(
        surveyClient().status({
          headers: authHeaders(),
          query: returned ? { checkoutReturn: "canceled" } : {},
        }),
        [200],
      );
      expect(status.body.abandonedCheckout).toStrictEqual(
        eligible
          ? { checkoutSessionId: "cs_survey_test", checkoutKind: "plan" }
          : null,
      );
    },
  );

  it.each([
    { status: "complete", payment_status: "paid" },
    { status: "complete", payment_status: "unpaid" },
    { status: "open", payment_status: "paid" },
  ])(
    "suppresses earlier unpaid purchases after a newer completed Checkout ($payment_status)",
    async (state) => {
      const actor = createBddApi(context).user();
      await enableSurvey(actor);
      const session = await createCheckout(actor);
      const completed = { ...session, ...state };
      mockCheckoutSessions([
        completed,
        { ...session, id: "cs_older", created: (session.created ?? 0) - 60 },
      ]);
      const status = await accept(
        surveyClient().status({ headers: authHeaders() }),
        [200],
      );
      expect(status.body.abandonedCheckout).toBeNull();
      const submitted = await accept(
        surveyClient().submit({
          headers: authHeaders(),
          body: {
            survey: "checkout_abandoned",
            answer: "payment_issue",
            checkoutSessionId: session.id,
          },
        }),
        [200],
      );
      expect(submitted.body).toStrictEqual({
        recorded: false,
        rewardCredits: 0,
      });
      const after = await accept(
        surveyClient().status({ headers: authHeaders() }),
        [200],
      );
      expect(after.body.answered).toStrictEqual([]);
    },
  );

  it.each(["organization", "member", "legacy"] as const)(
    "keeps a %s Checkout out of another member's feedback",
    async (owner) => {
      const actor = createBddApi(context).user();
      await enableSurvey(actor);
      const session = await createCheckout(actor);
      const metadata = {
        orgId: owner === "organization" ? "org_other" : (actor.orgId ?? ""),
        tier: "pro",
        ...(owner === "legacy"
          ? {}
          : {
              billingSurveyUserId:
                owner === "member" ? "user_other" : actor.userId,
            }),
      };
      mockCheckoutSessions([
        {
          ...session,
          metadata,
          customer: owner === "organization" ? "cus_other" : session.customer,
        },
      ]);
      const status = await accept(
        surveyClient().status({ headers: authHeaders() }),
        [200],
      );
      expect(status.body.abandonedCheckout).toBeNull();
      const submitted = await accept(
        surveyClient().submit({
          headers: authHeaders(),
          body: {
            survey: "checkout_abandoned",
            answer: "payment_issue",
            checkoutSessionId: session.id,
          },
        }),
        [200],
      );
      expect(submitted.body.recorded).toBeFalsy();
      await accept(
        surveyClient().dismiss({
          headers: authHeaders(),
          body: { checkoutSessionId: session.id },
        }),
        [200],
      );
      expect(
        context.mocks.stripe.checkout.sessions.update,
      ).not.toHaveBeenCalled();
    },
  );

  it("finds the member's Checkout on a later Stripe result page", async () => {
    const actor = createBddApi(context).user();
    await enableSurvey(actor);
    const session = await createCheckout(actor);
    const otherMember = {
      ...session,
      id: "cs_other",
      metadata: { ...session.metadata, billingSurveyUserId: "user_other" },
    };
    context.mocks.stripe.checkout.sessions.list.mockResolvedValueOnce({
      data: [otherMember],
      has_more: true,
    });
    const status = await accept(
      surveyClient().status({ headers: authHeaders() }),
      [200],
    );
    expect(status.body.abandonedCheckout?.checkoutSessionId).toBe(session.id);
    expect(
      context.mocks.stripe.checkout.sessions.list,
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({ starting_after: "cs_other" }),
    );
  });

  it.each(["open", "expired"])(
    "remembers Not now for an %s Session across visits, without consuming the member's answer",
    async (state) => {
      const actor = createBddApi(context).user();
      await enableSurvey(actor);
      const checkout = await createCheckout(actor);
      let session = { ...checkout, status: state };
      mockCheckoutSessions([session]);
      context.mocks.stripe.checkout.sessions.update.mockImplementation(
        (id, args) => {
          expect(id).toBe(session.id);
          const update = object({ metadata: record(string(), string()) }).parse(
            args,
          );
          session = {
            ...session,
            metadata: { ...session.metadata, ...update.metadata },
          };
          mockCheckoutSessions([
            session,
            {
              ...checkout,
              id: "cs_older",
              created: (checkout.created ?? 0) - 60,
            },
          ]);
          return Promise.resolve(session);
        },
      );
      const before = await accept(
        surveyClient().status({ headers: authHeaders() }),
        [200],
      );
      expect(before.body.abandonedCheckout?.checkoutSessionId).toBe(
        checkout.id,
      );
      await accept(
        surveyClient().dismiss({
          headers: authHeaders(),
          body: { checkoutSessionId: checkout.id },
        }),
        [200],
      );
      const nextVisit = await accept(
        surveyClient().status({ headers: authHeaders() }),
        [200],
      );
      expect(nextVisit.body.abandonedCheckout).toBeNull();
      expect(nextVisit.body.answered).toStrictEqual([]);
      mockCheckoutSessions([{ ...checkout, id: "cs_next_purchase" }, session]);
      const nextPurchase = await accept(
        surveyClient().status({ headers: authHeaders() }),
        [200],
      );
      expect(nextPurchase.body.abandonedCheckout?.checkoutSessionId).toBe(
        "cs_next_purchase",
      );
    },
  );

  it("does not reward a free member while starter credits are still available", async () => {
    const bdd = createBddApi(context);
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    await bdd.bootstrapLimitedFreeOnboarding(actor, {
      displayName: "Survey test",
    });
    await enableSurvey(actor);
    signIn(actor);
    const status = await accept(
      surveyClient().status({ headers: authHeaders() }),
      [200],
    );
    expect(status.body.creditsExhaustedReward).toBe(0);
    const submitted = await accept(
      surveyClient().submit({
        headers: authHeaders(),
        body: { survey: "credits_exhausted", answer: "still_trying" },
      }),
      [200],
    );
    expect(submitted.body.rewardCredits).toBe(0);
  });

  it("does not offer or grant a reward to a non-admin member", async () => {
    const actor = createBddApi(context).user({ orgRole: "org:member" });
    await enableSurvey(actor);
    signIn(actor);
    const status = await accept(
      surveyClient().status({ headers: authHeaders() }),
      [200],
    );
    expect(status.body.creditsExhaustedReward).toBe(0);
    const submitted = await accept(
      surveyClient().submit({
        headers: authHeaders(),
        body: { survey: "credits_exhausted", answer: "still_trying" },
      }),
      [200],
    );
    expect(submitted.body.rewardCredits).toBe(0);
  });

  it("rejects an answer that does not belong to the survey", async () => {
    const bdd = createBddApi(context);
    const actor = bdd.user();
    await enableSurvey(actor);
    signIn(actor);

    const response = await createApp({
      signal: context.signal,
      routes: billingSurveyRoutes,
    }).request("/api/billing/survey", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        survey: "credits_exhausted",
        answer: "payment_issue",
      }),
    });
    expect(response.status).toBe(400);
  });
});
