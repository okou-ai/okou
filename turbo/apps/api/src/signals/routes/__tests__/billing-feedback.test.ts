import { setupApp } from "../../../__tests__/test-helpers";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { createRouteMocks } from "./helpers/route-test";
import {
  billingFeedbackRewardContract,
  billingUsagePackCreditsContract,
} from "@okouai/api-contracts/contracts/billing";
import { posthogSurveysContract } from "@okouai/api-contracts/contracts/posthog-surveys";
import { BILLING_FEEDBACK_SURVEYS } from "@okouai/core/billing-feedback";
import { describe, expect, it } from "vitest";

import { testContext, accept } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { billingFeedbackRoutes } from "../billing-feedback";
import { billingUsagePackCreditsRoutes } from "../billing-usage-pack-credits";
import { publicPlanLifecycle } from "./helpers/public-plan-lifecycle";

const context = testContext();

const DESTINATION_SECRET = "posthog-survey-destination-secret-0123456789";
const sessionHeaders = Object.freeze({ authorization: "Bearer clerk-session" });
const destinationHeaders = Object.freeze({
  authorization: `Bearer ${DESTINATION_SECRET}`,
});
const DAY_MS = 24 * 60 * 60 * 1000;

interface Person {
  readonly userId: string;
  readonly orgId: string;
  readonly role: "org:admin" | "org:member";
}

function feedbackApis() {
  mockEnv("BILLING_FEEDBACK_WEBHOOK_SECRET", DESTINATION_SECRET);
  const store = createStore();
  const appFor = setupApp({
    context,
    routes: [...billingFeedbackRoutes, ...billingUsagePackCreditsRoutes],
  });
  const offers = appFor(billingFeedbackRewardContract);
  const surveys = appFor(posthogSurveysContract);
  const credits = appFor(billingUsagePackCreditsContract);

  /** A Clerk member of a Free organization. */
  async function person(
    role: Person["role"] = "org:admin",
    orgId = `org_${randomUUID()}`,
  ): Promise<Person> {
    const actor = { userId: `user_${randomUUID()}`, orgId, role };
    await store.set(
      seedOrgMembership$,
      {
        orgId,
        userId: actor.userId,
        role: role === "org:admin" ? "admin" : "member",
      },
      context.signal,
    );
    return actor;
  }

  function signIn(actor: Person) {
    createRouteMocks(context).clerk.session(
      actor.userId,
      actor.orgId,
      actor.role,
    );
  }

  async function offer(actor: Person) {
    signIn(actor);
    return (await accept(offers.get({ headers: sessionHeaders }), [200])).body;
  }

  async function offerToken(actor: Person): Promise<string> {
    const body = await offer(actor);
    expect(body.rewardCredits).toBe(200);
    if (!body.token) {
      throw new Error("expected a reward offer token");
    }
    return body.token;
  }

  async function bonusCredits(actor: Person): Promise<number> {
    signIn(actor);
    const response = await accept(
      credits.get({ headers: sessionHeaders }),
      [200],
    );
    return response.body.bonusCredits;
  }

  function surveyEvent(
    actor: Person,
    token: string,
    overrides: { surveyId?: string; completed?: boolean } = {},
  ) {
    return {
      event: "survey sent" as const,
      distinct_id: actor.userId,
      properties: {
        $survey_id:
          overrides.surveyId ?? BILLING_FEEDBACK_SURVEYS.credits_exhausted,
        $survey_completed: overrides.completed ?? true,
        org_id: actor.orgId,
        billing_feedback_reward_token: token,
      },
    };
  }

  async function settle(
    body: ReturnType<typeof surveyEvent>,
    headers: { authorization: string } = destinationHeaders,
  ) {
    return await accept(surveys.reward({ headers, body }), [200, 401]);
  }

  async function settled(body: ReturnType<typeof surveyEvent>) {
    const response = await accept(
      surveys.reward({ headers: destinationHeaders, body }),
      [200],
    );
    return response.body.rewardCredits;
  }

  return {
    store,
    person,
    offer,
    offerToken,
    bonusCredits,
    surveyEvent,
    settle,
    settled,
  };
}

describe("billing feedback rewards", () => {
  it("billing-feedback-006 ignores partial responses and unrelated surveys", async () => {
    const api = feedbackApis();
    const admin = await api.person();
    const token = await api.offerToken(admin);

    await expect(
      api.settled(api.surveyEvent(admin, token, { completed: false })),
    ).resolves.toBe(0);
    await expect(
      api.settled(
        api.surveyEvent(admin, token, { surveyId: "unrelated-survey" }),
      ),
    ).resolves.toBe(0);

    await expect(api.bonusCredits(admin)).resolves.toBe(0);
    await expect(api.offer(admin)).resolves.toMatchObject({
      rewardCredits: 200,
    });
  });

  it("billing-feedback-005 rejects a browser claim and an offer replayed for another identity", async () => {
    const api = feedbackApis();
    const admin = await api.person();
    const other = await api.person();
    const token = await api.offerToken(admin);

    const browserClaim = await api.settle(
      api.surveyEvent(admin, token),
      sessionHeaders,
    );
    const replayed = await api.settle(api.surveyEvent(other, token));

    expect(browserClaim.status).toBe(401);
    expect(replayed.status).toBe(401);
    await expect(api.bonusCredits(admin)).resolves.toBe(0);
  });

  it("billing-feedback-001 settles a completed survey once and expires the bonus after 30 days", async () => {
    const start = now();
    mockNow(start);
    const api = feedbackApis();
    const admin = await api.person();
    const before = await api.bonusCredits(admin);
    const token = await api.offerToken(admin);
    const event = api.surveyEvent(admin, token);

    await expect(api.settled(event)).resolves.toBe(200);
    await expect(api.bonusCredits(admin)).resolves.toBe(before + 200);
    await expect(api.settled(event)).resolves.toBe(0);
    await expect(api.offer(admin)).resolves.toStrictEqual({
      rewardCredits: 0,
      token: null,
    });

    mockNow(start + 30 * DAY_MS);
    await expect(api.bonusCredits(admin)).resolves.toBe(before);
    await expect(api.offer(admin)).resolves.toStrictEqual({
      rewardCredits: 0,
      token: null,
    });
  });

  it("billing-feedback-004 rewards one of two concurrent surveys from admins of one organization", async () => {
    const api = feedbackApis();
    const first = await api.person();
    const second = await api.person("org:admin", first.orgId);
    const firstToken = await api.offerToken(first);
    const secondToken = await api.offerToken(second);

    const rewards = await Promise.all([
      api.settled(
        api.surveyEvent(first, firstToken, {
          surveyId: BILLING_FEEDBACK_SURVEYS.upgrade_dismissed,
        }),
      ),
      api.settled(
        api.surveyEvent(second, secondToken, {
          surveyId: BILLING_FEEDBACK_SURVEYS.checkout_canceled,
        }),
      ),
    ]);

    expect(
      [...rewards].sort((a, b) => {
        return a - b;
      }),
    ).toStrictEqual([0, 200]);
    await expect(api.settled(api.surveyEvent(first, firstToken))).resolves.toBe(
      0,
    );
    const total =
      (await api.bonusCredits(first)) + (await api.bonusCredits(second));
    expect(total).toBe(200);
  });

  it("billing-feedback-007 rechecks paid eligibility for an offer answered after upgrading", async () => {
    const api = feedbackApis();
    const admin = await api.person();
    const token = await api.offerToken(admin);
    await publicPlanLifecycle(
      context,
      {
        userId: admin.userId,
        orgId: admin.orgId,
        orgRole: "org:admin",
        email: `${admin.userId}@example.test`,
      },
      "pro",
    ).update("active");

    await expect(api.settled(api.surveyEvent(admin, token))).resolves.toBe(0);

    await expect(api.bonusCredits(admin)).resolves.toBe(0);
    await expect(api.offer(admin)).resolves.toStrictEqual({
      rewardCredits: 0,
      token: null,
    });
  });

  it("billing-feedback-008 offers nothing to members and rechecks revoked admin membership", async () => {
    const api = feedbackApis();
    const admin = await api.person();
    const member = await api.person("org:member", admin.orgId);
    const token = await api.offerToken(admin);
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [],
    });

    await expect(api.offer(member)).resolves.toStrictEqual({
      rewardCredits: 0,
      token: null,
    });
    await expect(api.settled(api.surveyEvent(admin, token))).resolves.toBe(0);
    await expect(api.bonusCredits(admin)).resolves.toBe(0);
  });
});
