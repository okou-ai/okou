import {
  billingStatusContract,
  billingFeedbackRewardContract,
  billingUsagePackCatalogContract,
  billingUsagePackCheckoutContract,
  billingUsagePackManagementContract,
} from "@okouai/api-contracts/contracts/billing";
import { BILLING_FEEDBACK_SURVEYS } from "@okouai/core/billing-feedback";
import { initPostHog } from "../../../lib/posthog.ts";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  billingPlanCapabilities,
  defaultBillingStatus,
} from "../../../mocks/handlers/api-billing.ts";

vi.hoisted(() => {
  window.location.href = "https://app.okou.ai/";
});

const context = testContext();

function button(name: string, container: HTMLElement = document.body) {
  const result = queryAllByRoleFast("button", container).find((element) => {
    return (
      element.textContent?.trim() === name ||
      element.getAttribute("aria-label") === name
    );
  });
  if (!result) {
    throw new Error(`Button ${name} is not mounted`);
  }
  return result;
}

function freeBilling() {
  return {
    ...defaultBillingStatus(),
    tier: "limited-free-1",
    ...billingPlanCapabilities("limited-free-1"),
    credits: 0,
    hasSubscription: false,
    onboardingPaymentPending: false,
  };
}

function prepareBilling(paid = false) {
  context.mocks.api(billingFeedbackRewardContract.get, ({ respond }) => {
    return respond(200, { rewardCredits: 200, token: "signed-offer-from-api" });
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, {
      ...freeBilling(),
      ...(paid ? { tier: "pro", hasSubscription: true } : {}),
    });
  });
  context.mocks.browser.matchMedia((query) => {
    return query === "(min-width: 48rem)";
  });
  context.mocks.api(billingUsagePackManagementContract.get, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "No usage-pack subscription" },
    });
  });
  context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
    return respond(200, {
      supportsFreeMembers: true,
      usagePacks: [
        {
          usagePackUsd: 20,
          priceUsd: 20,
          purchasedCredits: 20_000,
          bonusCredits: 2000,
          totalCredits: 22_000,
        },
      ],
    });
  });
  return context.mocks.posthog();
}

function surveyImpressions(telemetry: ReturnType<typeof prepareBilling>) {
  return telemetry.events.filter((event) => {
    return event.name === "survey shown";
  });
}

async function openPlans() {
  const card = (await screen.findByText("Get Pro")).closest("button");
  if (!card) {
    throw new Error("Upgrade card is not mounted");
  }
  click(card);
  return await screen.findByRole("dialog", { name: "Choose a plan" });
}

test("closing the upgrade dialog asks its independent PostHog question and records the funnel", async () => {
  const telemetry = prepareBilling();
  await setupPage({ context, path: "/", host: "app.okou.ai" });
  const plans = await openPlans();
  click(within(plans).getByLabelText("Close"));
  await waitFor(() => {
    expect(
      surveyImpressions(telemetry).map((display) => {
        return display.properties?.$survey_id;
      }),
    ).toStrictEqual([BILLING_FEEDBACK_SURVEYS.upgrade_dismissed]);
  });
  expect(surveyImpressions(telemetry)[0]?.properties).toMatchObject({
    billing_feedback_kind: "upgrade_dismissed",
    billing_feedback_reward_token: "signed-offer-from-api",
    org_id: expect.any(String),
    billing_attempt_id: expect.any(String),
  });
  expect(
    telemetry.events
      .filter((event) => {
        return event.name.startsWith("billing_upgrade_dialog_");
      })
      .map((event) => {
        return { name: event.name, properties: event.properties };
      }),
  ).toMatchObject([
    {
      name: "billing_upgrade_dialog_opened",
      properties: { billing_attempt_id: expect.any(String) },
    },
    {
      name: "billing_upgrade_dialog_closed",
      properties: { checkout_started: false },
    },
  ]);
});

test("a Stripe cancellation includes the same signed reward offer", async () => {
  const telemetry = prepareBilling();
  await setupPage({ context, path: "/?billing=canceled", host: "app.okou.ai" });
  await waitFor(() => {
    expect(
      surveyImpressions(telemetry).map((display) => {
        return display.properties?.$survey_id;
      }),
    ).toStrictEqual([BILLING_FEEDBACK_SURVEYS.checkout_canceled]);
  });
  expect(surveyImpressions(telemetry)[0]?.properties).toMatchObject({
    billing_feedback_kind: "checkout_canceled",
    billing_feedback_reward_token: "signed-offer-from-api",
    org_id: expect.any(String),
  });
  expect(
    telemetry.events.filter((event) => {
      return event.name === "billing_checkout_canceled";
    }),
  ).toHaveLength(1);
});

test("a restored upgrade dialog defers checkout feedback until closing completes", async () => {
  const telemetry = prepareBilling();
  await setupPage({
    context,
    path: "/?billing=canceled&settings=billing&billingView=plans",
    host: "app.okou.ai",
  });
  const plans = await screen.findByRole("dialog", { name: "Choose a plan" });
  await waitFor(() => {
    expect(
      telemetry.events.some((event) => {
        return event.name === "billing_checkout_canceled";
      }),
    ).toBeTruthy();
  });
  expect(surveyImpressions(telemetry)).toStrictEqual([]);

  click(within(plans).getByLabelText("Close"));
  await waitFor(() => {
    expect(
      surveyImpressions(telemetry).map((display) => {
        return display.properties?.$survey_id;
      }),
    ).toStrictEqual([BILLING_FEEDBACK_SURVEYS.checkout_canceled]);
  });
  expect(plans).not.toBeInTheDocument();
});

test("a completed in-app upgrade closes the funnel without an abandonment question", async () => {
  const telemetry = prepareBilling();
  context.mocks.api(
    billingUsagePackCheckoutContract.create,
    ({ body, respond }) => {
      if (!body.previewToken) {
        return respond(200, {
          status: "preview",
          purchaseType: "usage_pack",
          tier: "pro",
          immediateAmountCents: 2000,
          nextRecurringAmountCents: 2000,
          currency: "usd",
          expiresAt: "2026-12-01T00:00:00.000Z",
          previewToken: "upgrade-preview",
        });
      }
      return respond(200, { status: "completed", hostedInvoiceUrl: null });
    },
  );
  await setupPage({ context, path: "/", host: "app.okou.ai" });
  const plans = await openPlans();
  click(await within(plans).findByText("Start with Pro"));
  const packages = await screen.findByRole("dialog", {
    name: "Configure member packages",
  });
  click(button("Upgrade to Pro", packages));
  const confirmation = await screen.findByRole("dialog", {
    name: "Order summary",
  });
  click(button("Confirm", confirmation));
  await screen.findByText("Subscription change confirmed.");
  expect(
    telemetry.events.find((event) => {
      return event.name === "billing_purchase_completed";
    })?.properties,
  ).toMatchObject({ checkout_kind: "usage_pack" });
  const remaining = screen.queryByRole("dialog", {
    name: "Configure member packages",
  });
  if (remaining) {
    click(within(remaining).getByLabelText("Close"));
  }
  await waitFor(() => {
    expect(
      telemetry.events.some((event) => {
        return event.name === "billing_upgrade_dialog_closed";
      }),
    ).toBeTruthy();
  });
  expect(surveyImpressions(telemetry)).toStrictEqual([]);
});

test("a paid user returning from Stripe is excluded from the feedback popover", async () => {
  const telemetry = prepareBilling(true);
  await setupPage({ context, path: "/?billing=canceled", host: "app.okou.ai" });
  await screen.findByTestId("labeled-nav-rail");
  expect(
    telemetry.events.some((event) => {
      return event.name === "billing_checkout_canceled";
    }),
  ).toBeTruthy();
  expect(surveyImpressions(telemetry)).toStrictEqual([]);
});

test("a paused PostHog questionnaire stays hidden after its app trigger", async () => {
  const telemetry = prepareBilling();
  telemetry.setActiveSurveyIds([]);
  await setupPage({ context, path: "/?billing=canceled", host: "app.okou.ai" });
  await waitFor(() => {
    expect(telemetry.surveyQueries).toStrictEqual([true]);
  });
  expect(surveyImpressions(telemetry)).toStrictEqual([]);
});

test("a Stripe return waits for PostHog targeting flags before asking the question", async () => {
  const telemetry = prepareBilling();
  const flags = telemetry.deferFeatureFlags();
  await setupPage({ context, path: "/?billing=canceled", host: "app.okou.ai" });
  await flags.subscribed;
  expect(surveyImpressions(telemetry)).toStrictEqual([]);
  flags.resolve();
  await waitFor(() => {
    expect(
      surveyImpressions(telemetry).map((display) => {
        return display.properties?.$survey_id;
      }),
    ).toStrictEqual([BILLING_FEEDBACK_SURVEYS.checkout_canceled]);
  });
});

test("a cached targeting result is retried when identified-user flags arrive", async () => {
  const telemetry = prepareBilling();
  telemetry.setActiveSurveyIds([]);
  await setupPage({ context, path: "/?billing=canceled", host: "app.okou.ai" });
  await waitFor(() => {
    expect(telemetry.surveyQueries).toStrictEqual([true]);
  });
  expect(surveyImpressions(telemetry)).toStrictEqual([]);
  telemetry.setActiveSurveyIds([BILLING_FEEDBACK_SURVEYS.checkout_canceled]);
  telemetry.refreshFeatureFlags();
  await waitFor(() => {
    expect(
      surveyImpressions(telemetry).map((display) => {
        return display.properties?.$survey_id;
      }),
    ).toStrictEqual([BILLING_FEEDBACK_SURVEYS.checkout_canceled]);
  });
  telemetry.refreshFeatureFlags();
  expect(surveyImpressions(telemetry)).toHaveLength(1);
});

test("seeing checkout feedback prevents a later upgrade prompt even without a response", async () => {
  const telemetry = prepareBilling();
  initPostHog();
  await setupPage({ context, path: "/?billing=canceled", host: "app.okou.ai" });
  await waitFor(() => {
    expect(surveyImpressions(telemetry)).toHaveLength(1);
  });
  const feedback = await screen.findByRole("dialog", {
    name: "What stopped you from completing your purchase?",
  });
  click(within(feedback).getByLabelText("Close"));
  const plans = await openPlans();
  click(within(plans).getByLabelText("Close"));
  await waitFor(() => {
    expect(plans).not.toBeInTheDocument();
  });
  telemetry.refreshFeatureFlags();
  expect(
    surveyImpressions(telemetry).map((display) => {
      return display.properties?.$survey_id;
    }),
  ).toStrictEqual([BILLING_FEEDBACK_SURVEYS.checkout_canceled]);
});

test("an already rewarded workspace is not offered another rewarded survey", async () => {
  const telemetry = prepareBilling();
  context.mocks.api(billingFeedbackRewardContract.get, ({ respond }) => {
    return respond(200, { rewardCredits: 0, token: null });
  });
  await setupPage({ context, path: "/?billing=canceled", host: "app.okou.ai" });
  const plans = await openPlans();
  click(within(plans).getByLabelText("Close"));
  await waitFor(() => {
    expect(plans).not.toBeInTheDocument();
  });
  expect(surveyImpressions(telemetry)).toStrictEqual([]);
});

test("a grouped selection submits a completed PostHog response with the signed reward offer only once", async () => {
  const telemetry = prepareBilling();
  initPostHog();
  await setupPage({ context, path: "/?billing=canceled", host: "app.okou.ai" });
  const feedback = await screen.findByRole("dialog", {
    name: "What stopped you from completing your purchase?",
  });
  const submit = button("Submit feedback", feedback);
  expect(submit).toBeDisabled();
  await userEvent.click(
    within(feedback).getByLabelText("It's too expensive", {
      selector: '[role="radio"]',
    }),
  );
  await userEvent.keyboard("{ArrowDown}");
  expect(
    within(feedback).getByLabelText("I want to try it more first", {
      selector: '[role="radio"]',
    }),
  ).toBeChecked();
  expect(submit).toBeEnabled();
  click(submit);
  await screen.findByRole("dialog", { name: "Thank you for your feedback!" });
  const sent = telemetry.events.filter((event) => {
    return event.name === "survey sent";
  });
  expect(sent).toHaveLength(1);
  expect(sent[0]?.properties).toMatchObject({
    $survey_id: BILLING_FEEDBACK_SURVEYS.checkout_canceled,
    $survey_completed: true,
    $survey_submission_id: expect.any(String),
    $survey_response: "I want to try it more first",
    [`$survey_response_${BILLING_FEEDBACK_SURVEYS.checkout_canceled}-question`]:
      "I want to try it more first",
    $survey_questions: [
      {
        id: `${BILLING_FEEDBACK_SURVEYS.checkout_canceled}-question`,
        question: "What stopped you from completing your purchase?",
        response: "I want to try it more first",
      },
    ],
    billing_feedback_reward_token: "signed-offer-from-api",
  });
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(feedback).not.toBeInTheDocument();
  });
});

test("translated other feedback requires text and sends the localized answer", async () => {
  const telemetry = prepareBilling();
  await setupPage({
    context,
    path: "/?billing=canceled",
    host: "app.okou.ai",
    locale: "zh-Hans",
  });
  const feedback = await screen.findByRole("dialog", {
    name: "是什么让你没有完成购买？",
  });
  click(
    within(feedback).getByLabelText("其他原因", { selector: '[role="radio"]' }),
  );
  const submit = button("Submit feedback", feedback);
  expect(submit).toBeDisabled();
  await fill(
    within(feedback).getByRole("textbox", { name: "其他原因" }),
    "需要更多试用时间",
  );
  expect(submit).toBeEnabled();
  click(submit);
  await waitFor(() => {
    expect(
      telemetry.events.find((event) => {
        return event.name === "survey sent";
      })?.properties,
    ).toMatchObject({
      $survey_language: "zh-cn",
      $survey_response: "需要更多试用时间",
      $survey_completed: true,
    });
  });
});
