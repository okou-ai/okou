import {
  billingStatusContract,
  billingSurveyContract,
  type BillingStatusResponse,
  type BillingSurveyKind,
  type BillingSurveyRequest,
} from "@okouai/api-contracts/contracts/billing";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { localStorageSignals } from "../../../signals/external/local-storage.ts";
import { billingPlanCapabilities } from "../../../mocks/handlers/api-billing.ts";
import { now } from "../../../lib/time.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  findButton,
  promptEvent,
  readyChat,
  RUN_PATH,
  createChatRunFixtures,
} from "./chat-run-test-fixtures.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);
const pendingCheckoutStorage = localStorageSignals("billing-checkout-pending");

function buttonIn(container: HTMLElement, name: string): HTMLElement {
  const match = queryAllByRoleFast("button", container).find((button) => {
    return button.textContent?.replace(/\s+/gu, " ").trim() === name;
  });
  if (!match) {
    throw new Error(`${name} button was not visible`);
  }
  return match;
}

const BILLING_RUN_ID = "d0000000-0000-4000-a000-000000001401";
const SURVEY_SWITCHES = { [FeatureSwitchKey.BillingSurvey]: true } as const;

function outOfCreditsChat(): MockChatEventInput[] {
  return [
    promptEvent({
      id: "survey-user-prompt",
      runId: BILLING_RUN_ID,
      seqId: 1,
      text: "Draft the launch plan",
    }),
    {
      id: "survey-run-error",
      eventType: "output.error",
      role: "assistant",
      content: null,
      error: "insufficient_credits",
      runId: BILLING_RUN_ID,
      seqId: 2,
      createdAt: "2026-08-01T10:00:02.000Z",
    },
  ];
}

function freeBillingStatus(): BillingStatusResponse {
  return {
    showUsagePack: false,
    tier: "limited-free-1",
    ...billingPlanCapabilities("limited-free-1"),
    canBuyCredits: false,
    credits: 0,
    onboardingPaymentPending: false,
    subscriptionStatus: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    scheduledChange: null,
    hasSubscription: false,
    autoRecharge: { enabled: false, threshold: null, amount: null },
    creditExpiry: { expiringNextCycle: 0, nextExpiryDate: null },
    creditBreakdown: [],
    creditGrants: [],
    concurrencyLimit: 0,
    concurrencySubscriptions: [],
  };
}

function installSurveyApi(answered: readonly BillingSurveyKind[] = []) {
  const submitted: BillingSurveyRequest[] = [];
  context.mocks.data.org({
    id: "org_billing_survey",
    name: "Billing Survey Workspace",
    role: "admin",
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, freeBillingStatus());
  });
  context.mocks.api(billingSurveyContract.status, ({ respond }) => {
    return respond(200, {
      answered: [
        ...answered,
        ...submitted.map((request) => {
          return request.survey;
        }),
      ],
      creditsExhaustedReward: 200,
      checkoutUnpaid: true,
    });
  });
  context.mocks.api(billingSurveyContract.submit, ({ body, respond }) => {
    submitted.push(body);
    return respond(200, {
      recorded: true,
      rewardCredits: body.survey === "credits_exhausted" ? 200 : 0,
    });
  });
  return submitted;
}

/**
 * A Checkout the browser started on an earlier visit. The browser keeps this
 * record itself, so the test restores it the way a returning tab finds it.
 */
function rememberCheckout(args: {
  readonly startedAgoMs: number;
  readonly kind: "plan" | "credits";
}): void {
  context.store.set(
    pendingCheckoutStorage.set$,
    JSON.stringify({
      version: 1,
      sessionId: "cs_survey_test",
      orgId: "org_default",
      userId: "test-user-123",
      kind: args.kind,
      startedAt: now() - args.startedAgoMs,
      returnedAt: null,
    }),
  );
}

test("Ask a free workspace admin why they are not upgrading and thank them with credits", async () => {
  const user = userEvent.setup({ delay: null });
  const submitted = installSurveyApi();
  installRunChat({ chatEvents: outOfCreditsChat() });

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: SURVEY_SWITCHES,
  });
  await readyChat();

  const survey = await screen.findByRole("form", {
    name: "What's stopping you from upgrading today?",
  });
  expect(
    within(survey).getByText(
      "The first eligible answer in this workspace earns 200 bonus credits, valid for 30 days.",
    ),
  ).toBeVisible();
  // The upgrade action stays the card's primary choice.
  expect(
    buttonIn(
      screen.getByTestId("assistant-error-card-shell"),
      "Upgrade to Pro",
    ),
  ).toBeVisible();
  const submit = buttonIn(survey, "Submit");
  expect(submit).toBeDisabled();

  await user.click(
    within(survey).getByRole("radio", { name: "Something else" }),
  );
  await user.type(
    within(survey).getByRole("textbox", { name: "Your answer" }),
    "Waiting for my team budget",
  );
  await user.click(submit);

  await expect(
    screen.findByText("Thanks! 200 credits were added, so you can keep going."),
  ).resolves.toBeVisible();
  expect(submitted).toStrictEqual([
    {
      survey: "credits_exhausted",
      answer: "other",
      detail: "Waiting for my team budget",
    },
  ]);
});

test("Leave the out-of-credits card unchanged once the member has answered", async () => {
  installSurveyApi(["credits_exhausted"]);
  installRunChat({ chatEvents: outOfCreditsChat() });

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: SURVEY_SWITCHES,
  });
  await readyChat();

  await expect(findButton("Upgrade to Pro")).resolves.toBeVisible();
  expect(
    screen.queryByRole("form", {
      name: "What's stopping you from upgrading today?",
    }),
  ).not.toBeInTheDocument();
});

test("Ask why a purchase was not completed when Stripe sends the member back", async () => {
  const user = userEvent.setup({ delay: null });
  const submitted = installSurveyApi();
  rememberCheckout({ startedAgoMs: 60_000, kind: "plan" });
  installRunChat({ chatEvents: [] });

  await setupPage({
    context,
    path: `${RUN_PATH}?billing=canceled`,
    featureSwitches: SURVEY_SWITCHES,
  });

  const dialog = await screen.findByRole("dialog", {
    name: "What stopped you from completing your purchase?",
  });
  await user.click(
    within(dialog).getByRole("radio", {
      name: "The price was higher than I expected",
    }),
  );
  await user.click(buttonIn(dialog, "Submit"));

  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", {
        name: "What stopped you from completing your purchase?",
      }),
    ).not.toBeInTheDocument();
  });
  expect(submitted).toStrictEqual([
    {
      survey: "checkout_abandoned",
      answer: "price_higher_than_expected",
      checkoutKind: "plan",
      checkoutSessionId: "cs_survey_test",
    },
  ]);
  expect(window.location.search).not.toContain("billing=");
});

test("Ask on the next visit after a Checkout tab was closed without paying", async () => {
  const user = userEvent.setup({ delay: null });
  const submitted = installSurveyApi();
  rememberCheckout({ startedAgoMs: 2 * 60 * 60 * 1000, kind: "credits" });
  installRunChat({ chatEvents: [] });

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: SURVEY_SWITCHES,
  });

  const dialog = await screen.findByRole("dialog", {
    name: "What stopped you from completing your purchase?",
  });
  await user.click(buttonIn(dialog, "Not now"));

  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(submitted).toStrictEqual([]);
  expect(context.store.get(pendingCheckoutStorage.get$)).toBeNull();
});

test("Wait while a recent Checkout may still be open in another tab", async () => {
  installSurveyApi();
  rememberCheckout({ startedAgoMs: 60_000, kind: "plan" });
  installRunChat({ chatEvents: outOfCreditsChat() });

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: SURVEY_SWITCHES,
  });
  await readyChat();

  await expect(
    screen.findByRole("form", {
      name: "What's stopping you from upgrading today?",
    }),
  ).resolves.toBeVisible();
  expect(
    screen.queryByRole("dialog", {
      name: "What stopped you from completing your purchase?",
    }),
  ).not.toBeInTheDocument();
});

test.each([0, 500])(
  "Keep the Pro upgrade action without an exhaustion survey for a Pro-only model with %i credits",
  async (credits) => {
    installSurveyApi();
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, { ...freeBillingStatus(), credits });
    });
    installRunChat({
      chatEvents: outOfCreditsChat().map((event) => {
        return event.eventType === "output.error"
          ? { ...event, error: "pro_required" }
          : event;
      }),
    });
    await setupPage({
      context,
      path: RUN_PATH,
      featureSwitches: SURVEY_SWITCHES,
    });
    await readyChat();
    await expect(findButton("Upgrade to Pro")).resolves.toBeInTheDocument();
    expect(
      screen.queryByRole("form", {
        name: "What's stopping you from upgrading today?",
      }),
    ).not.toBeInTheDocument();
  },
);

test("Ask another admin for feedback without promising an already claimed organization reward", async () => {
  installSurveyApi();
  context.mocks.api(billingSurveyContract.status, ({ respond }) => {
    return respond(200, {
      answered: [],
      creditsExhaustedReward: 0,
      checkoutUnpaid: false,
    });
  });
  installRunChat({ chatEvents: outOfCreditsChat() });
  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: SURVEY_SWITCHES,
  });
  const survey = await screen.findByRole("form", {
    name: "What's stopping you from upgrading today?",
  });
  expect(
    within(survey).queryByText(
      "The first eligible answer in this workspace earns 200 bonus credits, valid for 30 days.",
    ),
  ).not.toBeInTheDocument();
});

test("Keep a completed Checkout out of the abandonment survey even without a success redirect", async () => {
  installSurveyApi();
  context.mocks.api(billingSurveyContract.status, ({ respond }) => {
    return respond(200, {
      answered: [],
      creditsExhaustedReward: 200,
      checkoutUnpaid: false,
    });
  });
  rememberCheckout({ startedAgoMs: 2 * 60 * 60 * 1000, kind: "plan" });
  installRunChat({ chatEvents: outOfCreditsChat() });
  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: SURVEY_SWITCHES,
  });
  await screen.findByRole("form", {
    name: "What's stopping you from upgrading today?",
  });
  expect(
    screen.queryByRole("dialog", {
      name: "What stopped you from completing your purchase?",
    }),
  ).not.toBeInTheDocument();
});
