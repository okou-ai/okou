import {
  billingSurveyContract,
  billingCheckoutContract,
  billingUsagePackCreditsContract,
} from "@okouai/api-contracts/contracts/billing";
import StripeSDK from "stripe";
import { mockStripeClient } from "../../external/stripe-client";
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

async function createCheckout(actor: ApiTestUser): Promise<void> {
  signIn(actor);
  context.mocks.stripe.customers.create.mockResolvedValue({
    id: `cus_survey_${actor.orgId}`,
  });
  context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
    id: "cs_survey_test",
    url: "https://checkout.stripe.com/c/pay/cs_survey_test",
  });
  context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
    id: "cs_survey_test",
    status: "open",
    payment_status: "unpaid",
    customer: `cus_survey_${actor.orgId}`,
    metadata: { orgId: actor.orgId },
  });
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
  expect(checkout.body).toMatchObject({ checkoutSessionId: "cs_survey_test" });
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

  it.each([
    { status: "complete", payment_status: "paid" },
    { status: "complete", payment_status: "unpaid" },
    { status: "open", payment_status: "paid" },
  ])(
    "does not survey a completed or paid Checkout ($status, $payment_status)",
    async (session) => {
      const actor = createBddApi(context).user();
      await enableSurvey(actor);
      await createCheckout(actor);
      context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
        ...session,
        id: "cs_survey_test",
        customer: `cus_survey_${actor.orgId}`,
        metadata: { orgId: actor.orgId },
      });
      const status = await accept(
        surveyClient().status({
          headers: authHeaders(),
          query: { checkoutSessionId: "cs_survey_test" },
        }),
        [200],
      );
      expect(status.body.checkoutUnpaid).toBeFalsy();
      const submitted = await accept(
        surveyClient().submit({
          headers: authHeaders(),
          body: {
            survey: "checkout_abandoned",
            answer: "payment_issue",
            checkoutKind: "plan",
            checkoutSessionId: "cs_survey_test",
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

  it("does not survey a Checkout owned by a different organization", async () => {
    const actor = createBddApi(context).user();
    await enableSurvey(actor);
    await createCheckout(actor);
    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: "cs_other",
      status: "open",
      payment_status: "unpaid",
      customer: "cus_other",
      metadata: { orgId: "org_other" },
    });
    const status = await accept(
      surveyClient().status({
        headers: authHeaders(),
        query: { checkoutSessionId: "cs_other" },
      }),
      [200],
    );
    expect(status.body.checkoutUnpaid).toBeFalsy();
  });

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
