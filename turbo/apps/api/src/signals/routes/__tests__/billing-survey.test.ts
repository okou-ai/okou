import {
  billingSurveyContract,
  billingUsagePackCreditsContract,
} from "@okouai/api-contracts/contracts/billing";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
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

describe("/api/billing/survey", () => {
  beforeEach(() => {
    context.mocks.ably.publish.mockResolvedValue(undefined);
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
  });

  it("grants the thank-you credits only once per organization", async () => {
    const bdd = createBddApi(context);
    const admin = bdd.user();
    const member = bdd.user({ orgId: admin.orgId, orgRole: "org:member" });
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
    signIn(actor);
    const creditsBefore = await bonusCredits();

    const body = {
      survey: "checkout_abandoned",
      answer: "payment_issue",
      checkoutKind: "plan",
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
