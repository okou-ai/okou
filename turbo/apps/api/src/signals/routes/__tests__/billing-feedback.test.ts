import {
  billingFeedbackRewardContract,
  billingUsagePackCreditsContract,
} from "@okouai/api-contracts/contracts/billing";
import { posthogSurveysContract } from "@okouai/api-contracts/contracts/posthog-surveys";
import { BILLING_FEEDBACK_SURVEYS } from "@okouai/core/billing-feedback";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { billingFeedbackRoutes } from "../billing-feedback";
import { billingUsagePackCreditsRoutes } from "../billing-usage-pack-credits";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRouteMocks } from "./helpers/route-test";
import { createRunsApi } from "./helpers/api-bdd-runs";

const context = testContext();
const SECRET = "posthog-survey-destination-test-secret-12345678";
const memberHeaders = Object.freeze({ authorization: "Bearer clerk-session" });
const destinationHeaders = Object.freeze({ authorization: `Bearer ${SECRET}` });

function signIn(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [{ role: actor.orgRole, organization: { id: actor.orgId } }],
  });
}

function rewardClient() {
  return setupApp({ context, routes: billingFeedbackRoutes })(
    billingFeedbackRewardContract,
  );
}

function destination() {
  return setupApp({ context, routes: billingFeedbackRoutes })(
    posthogSurveysContract,
  );
}

async function balance() {
  const response = await accept(
    setupApp({ context, routes: billingUsagePackCreditsRoutes })(
      billingUsagePackCreditsContract,
    ).get({ headers: memberHeaders }),
    [200],
  );
  return response.body.bonusCredits;
}

async function offer(actor: ApiTestUser) {
  signIn(actor);
  return (await accept(rewardClient().get({ headers: memberHeaders }), [200]))
    .body;
}

function completedResponse(actor: ApiTestUser, token: string | null) {
  if (!actor.orgId || !token) {
    throw new Error("Expected an eligible organization feedback offer");
  }
  return {
    event: "survey sent" as const,
    distinct_id: actor.userId,
    properties: {
      $survey_id: BILLING_FEEDBACK_SURVEYS.credits_exhausted,
      $survey_completed: true,
      org_id: actor.orgId,
      billing_feedback_reward_token: token,
    },
  };
}

beforeEach(() => {
  mockEnv("BILLING_FEEDBACK_WEBHOOK_SECRET", SECRET);
  context.mocks.ably.publish.mockResolvedValue(undefined);
});

test("settles a completed PostHog response once and expires the bonus after 30 days", async () => {
  const actor = createBddApi(context).user();
  const at = now();
  mockNow(at);
  const eligible = await offer(actor);
  expect(eligible.rewardCredits).toBe(200);
  const body = completedResponse(actor, eligible.token);
  const before = await balance();
  const result = await accept(
    destination().reward({ headers: destinationHeaders, body }),
    [200],
  );
  expect(result.body.rewardCredits).toBe(200);
  await expect(balance()).resolves.toBe(before + 200);
  const repeated = await accept(
    destination().reward({ headers: destinationHeaders, body }),
    [200],
  );
  expect(repeated.body.rewardCredits).toBe(0);
  await expect(offer(actor)).resolves.toStrictEqual({
    rewardCredits: 0,
    token: null,
  });
  mockNow(at + 30 * 24 * 60 * 60 * 1000);
  await expect(balance()).resolves.toBe(before);
});

test("deduplicates concurrent completed submissions from two billing admins in one organization", async () => {
  const bdd = createBddApi(context);
  const first = bdd.user();
  const second = bdd.user({ orgId: first.orgId });
  const firstOffer = await offer(first);
  const secondOffer = await offer(second);
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [{ role: "org:admin", organization: { id: first.orgId } }],
  });
  const outcomes = await Promise.all([
    destination().reward({
      headers: destinationHeaders,
      body: completedResponse(first, firstOffer.token),
    }),
    destination().reward({
      headers: destinationHeaders,
      body: completedResponse(second, secondOffer.token),
    }),
  ]);
  expect(
    outcomes
      .map((outcome) => {
        if (outcome.status !== 200) {
          throw new Error("Expected successful settlement");
        }
        return outcome.body.rewardCredits;
      })
      .sort((a, b) => {
        return a - b;
      }),
  ).toStrictEqual([0, 200]);
  signIn(first);
  const firstBalance = await balance();
  signIn(second);
  expect(firstBalance + (await balance())).toBe(200);
});

test("rejects direct browser claims and a reward offer reused for another identity", async () => {
  const bdd = createBddApi(context);
  const actor = bdd.user();
  const other = bdd.user();
  const eligible = await offer(actor);
  const body = completedResponse(actor, eligible.token);
  expect(
    (
      await accept(
        destination().reward({ headers: memberHeaders, body }),
        [401],
      )
    ).status,
  ).toBe(401);
  const stolen = {
    ...body,
    distinct_id: other.userId,
    properties: { ...body.properties, org_id: other.orgId ?? "" },
  };
  expect(
    (
      await accept(
        destination().reward({ headers: destinationHeaders, body: stolen }),
        [401],
      )
    ).status,
  ).toBe(401);
  await expect(balance()).resolves.toBe(0);
});

test("does not reward partial responses or either abandonment questionnaire", async () => {
  const actor = createBddApi(context).user();
  const eligible = await offer(actor);
  const body = completedResponse(actor, eligible.token);
  for (const properties of [
    { ...body.properties, $survey_completed: false },
    {
      ...body.properties,
      $survey_id: BILLING_FEEDBACK_SURVEYS.upgrade_dismissed,
    },
    {
      ...body.properties,
      $survey_id: BILLING_FEEDBACK_SURVEYS.checkout_canceled,
    },
  ]) {
    const result = await accept(
      destination().reward({
        headers: destinationHeaders,
        body: { ...body, properties },
      }),
      [200],
    );
    expect(result.body.rewardCredits).toBe(0);
  }
  await expect(balance()).resolves.toBe(0);
  expect((await offer(actor)).rewardCredits).toBe(200);
});

test("rechecks current paid eligibility when an offered response arrives after upgrading", async () => {
  const actor = createBddApi(context).user();
  const eligible = await offer(actor);
  await createRunsApi(context).grantProEntitlement(actor, { tier: "pro" });
  signIn(actor);
  const before = await balance();
  const result = await accept(
    destination().reward({
      headers: destinationHeaders,
      body: completedResponse(actor, eligible.token),
    }),
    [200],
  );
  expect(result.body.rewardCredits).toBe(0);
  await expect(balance()).resolves.toBe(before);
  await expect(offer(actor)).resolves.toStrictEqual({
    rewardCredits: 0,
    token: null,
  });
});

test("does not offer a reward to non-admins and rechecks revoked membership on settlement", async () => {
  const bdd = createBddApi(context);
  const actor = bdd.user();
  const member = bdd.user({ orgId: actor.orgId, orgRole: "org:member" });
  await expect(offer(member)).resolves.toStrictEqual({
    rewardCredits: 0,
    token: null,
  });
  const eligible = await offer(actor);
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [],
  });
  const result = await accept(
    destination().reward({
      headers: destinationHeaders,
      body: completedResponse(actor, eligible.token),
    }),
    [200],
  );
  expect(result.body.rewardCredits).toBe(0);
  await expect(balance()).resolves.toBe(0);
});

test("rejects expired server offers", async () => {
  const actor = createBddApi(context).user();
  const at = now();
  mockNow(at);
  const eligible = await offer(actor);
  mockNow(at + 24 * 60 * 60 * 1000);
  const result = await accept(
    destination().reward({
      headers: destinationHeaders,
      body: completedResponse(actor, eligible.token),
    }),
    [401],
  );
  expect(result.status).toBe(401);
  await expect(balance()).resolves.toBe(0);
});

test("withholds reward offers until trusted PostHog settlement is configured", async () => {
  mockEnv("BILLING_FEEDBACK_WEBHOOK_SECRET", undefined);
  const actor = createBddApi(context).user();
  await expect(offer(actor)).resolves.toStrictEqual({
    rewardCredits: 0,
    token: null,
  });
});
