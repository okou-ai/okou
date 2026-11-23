import { HttpResponse } from "msw";
import { screen, within, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  billingSurveyContract,
  type BillingSurveyRequest,
} from "@okouai/api-contracts/contracts/billing";
import { setupPage, click, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  billing,
  setBilling,
  action,
  findAction,
} from "./workspace-billing-fixtures.ts";
import {
  RUN_PATH,
  createChatRunFixtures,
  promptEvent,
} from "./chat-run-test-fixtures.ts";
const context = testContext();
const exhausted = "What's stopping you from upgrading today?",
  abandoned = "What stopped you from completing your purchase?";
function surveyBoundary(answered: boolean | "until-canceled-return" = false) {
  let recorded: BillingSurveyRequest | undefined;
  context.mocks.api(billingSurveyContract.status, ({ query, respond }) => {
    return respond(200, {
      answered:
        answered === true ||
        (answered === "until-canceled-return" &&
          query.checkoutReturn !== "canceled")
          ? ["credits_exhausted"]
          : recorded
            ? [recorded.survey]
            : [],
      creditsExhaustedReward: 200,
      abandonedCheckout:
        query.checkoutReturn === "canceled" && !recorded
          ? { checkoutSessionId: "cs_local_billing", checkoutKind: "plan" }
          : null,
    });
  });
  context.mocks.api(billingSurveyContract.submit, ({ body, respond }) => {
    recorded = body;
    return respond(200, {
      recorded: true,
      rewardCredits: body.survey === "credits_exhausted" ? 200 : 0,
    });
  });
  return {
    answer: () => {
      return recorded;
    },
  };
}
function openChat(search = "") {
  const runId = crypto.randomUUID();
  context.mocks.http.get("https://api.instatus.com/issues", () => {
    return HttpResponse.json({ activeIncidents: [] });
  });
  context.mocks.data.userPreferences({ locale: "en-US", timezone: "UTC" });
  createChatRunFixtures(context).installRunChat({
    chatEvents: [
      promptEvent({
        id: crypto.randomUUID(),
        runId,
        seqId: 1,
        text: "Review this month's costs",
      }),
      {
        id: crypto.randomUUID(),
        role: "assistant",
        runId,
        content: null,
        runLifecycleEvent: "failed",
        failureReason: "insufficient_credits",
        createdAt: "2026-08-01T10:00:03Z",
        seqId: 2,
      },
    ],
  });
  setBilling(context, () => {
    return billing("limited-free-1", { credits: 0 });
  });
  context.mocks.data.org({ role: "admin" });
  context.mocks.data.orgMembers({ role: "admin" });
  return setupPage({
    context,
    path: RUN_PATH + search,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BillingSurvey]: true },
    sharedWorkerTestTransport: "message-port",
  });
}
test("billing-survey-001 A workspace administrator can explain an exhausted balance and receives the promised reward", async () => {
  const service = surveyBoundary();
  await openChat();
  await expect(action("Upgrade to Pro")).resolves.toBeEnabled();
  click(await action(exhausted));
  const form = await screen.findByRole("form", { name: exhausted });
  expect(
    within(form).getByText(
      "The first eligible answer in this workspace earns 200 bonus credits, valid for 30 days.",
    ),
  ).toBeInTheDocument();
  const submit = await action("Submit", form);
  expect(submit).toBeDisabled();
  click(within(form).getByText("Something else"));
  expect(submit).toBeEnabled();
  await fill(within(form).getByRole("textbox"), "Waiting for my team budget");
  click(submit);
  await screen.findByText(
    "Thanks! 200 credits were added, so you can keep going.",
  );
  expect(service.answer()).toStrictEqual({
    survey: "credits_exhausted",
    answer: "other",
    detail: "Waiting for my team budget",
  });
});
test("billing-survey-002 A previously answered workspace retains its direct Pro upgrade action", async () => {
  surveyBoundary(true);
  // The checkout dialog and the chat question both consume this workspace's
  // survey status. Its dismissal restores the chat after that status arrived.
  await openChat("?billing=canceled");
  await submitPriceFeedback();
  await expect(action("Upgrade to Pro")).resolves.toBeEnabled();
  expect(findAction(exhausted)).toBeUndefined();
});
async function submitPriceFeedback() {
  const dialog = await screen.findByRole("dialog", { name: abandoned });
  click(within(dialog).getByText("The price was higher than I expected"));
  click(await action("Submit", dialog));
  await waitFor(() => {
    return expect(dialog).not.toBeInTheDocument();
  });
}
function planAnswer() {
  return {
    survey: "checkout_abandoned",
    checkoutSessionId: "cs_local_billing",
    checkoutKind: "plan",
    answer: "price_higher_than_expected",
  };
}
test("billing-survey-003 A canceled checkout records the price objection for that plan session and clears the return URL", async () => {
  const service = surveyBoundary();
  await openChat("?billing=canceled");
  await submitPriceFeedback();
  expect(service.answer()).toStrictEqual(planAnswer());
  expect(new URL(location.href).searchParams.has("billing")).toBeFalsy();
});
test("billing-survey-006 An exhausted workspace can answer in chat while a separate unpaid checkout is still open", async () => {
  surveyBoundary();
  await openChat();
  click(await action(exhausted));
  await screen.findByRole("form", { name: exhausted });
  expect(screen.queryByRole("dialog", { name: abandoned })).toBeNull();
});

test("billing-survey-004 the restored plan chooser takes precedence once the checkout survey is available", async () => {
  // Only the canceled-return response makes the chat's exhaustion question available.
  const service = surveyBoundary("until-canceled-return");
  await openChat("?settings=billing&billingView=plans&billing=canceled");
  const plans = await screen.findByRole("dialog", { name: "Choose a plan" });
  await screen.findByLabelText(exhausted, { selector: "button" });
  expect(plans).toBeVisible();
  expect(screen.queryByText(abandoned)).toBeNull();
  click(await action("Close", plans));
  await submitPriceFeedback();
  expect(service.answer()).toStrictEqual(planAnswer());
});
