import { screen, within } from "@testing-library/react";
import { test, expect } from "vitest";
import { setupPage, click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { personalModelProviderAccountsByIdContract as accounts } from "@okouai/api-contracts/contracts/personal-model-providers";
import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";
import {
  personalAccount,
  usageWindow,
} from "./personal-account-settings-fixtures.ts";
import { createMessageExperienceHelpers } from "./chat-message-experience-test-helpers.ts";
const context = testContext();
const thread = "ac000062-0000-4000-8000-000000000054";
const key = "df000062-0000-4000-8000-000000000012";
const recovery = "Manual reset is not supported; usage recovers naturally.";
const confirmation =
  "Reset uses one reset credit. Only clicking Reset submits the request.";
function account(
  fields: Partial<ModelProviderResponse> = {},
  provider: "Claude" | "ChatGPT" = "ChatGPT",
) {
  return personalAccount(provider, 1, {
    subscriptionResetSupported: provider === "ChatGPT",
    subscriptionResetCredits: 3,
    subscriptionUsage: {
      fiveHour: usageWindow(0, 18_000),
      weekly: usageWindow(60, 604_800),
    },
    ...fields,
  });
}
function path(member: ModelProviderResponse) {
  return "/subscriptions/" + member.id + "/reset?idempotencyKey=" + key;
}
async function chat(member: ModelProviderResponse, duplicate = false) {
  context.mocks.data.personalModelProviders([member]);
  const url = "https://app.okou.ai" + path(member);
  const content = duplicate ? url + "\n\nAnother copy\n\n" + url : url;
  createMessageExperienceHelpers(context).installMessageExperienceChat({
    threadId: thread,
    historyEvents: [
      {
        role: "user",
        content: "Show my reset options",
        createdAt: "2026-11-01T02:00:00Z",
      },
      { role: "assistant", content, createdAt: "2026-11-01T02:01:00Z" },
    ],
  });
  await setupPage({ context, path: "/chats/" + thread });
}
async function standalone(member: ModelProviderResponse) {
  context.mocks.data.personalModelProviders([member]);
  await setupPage({ context, path: path(member) });
}
async function details() {
  click(
    await screen.findByLabelText("member1@example.test 5h remaining", {
      selector: "button",
    }),
  );
  return within(await screen.findByRole("dialog"));
}
test("subscription-reset-card-001 the member submits from the original frame after reviewing quota", async () => {
  const member = account();
  let redeemed = false;
  context.mocks.api(
    accounts.resetSubscriptionUsage,
    ({ params, body, respond }) => {
      redeemed = params.id === member.id && body.idempotencyKey === key;
      return respond(200, { outcome: "reset" });
    },
  );
  await chat(member);
  const reset = await screen.findByLabelText("3 resets", {
    selector: "button",
  });
  const frame = screen.getByTestId("subscription-reset-card-shell");
  const view = within(frame);
  expect(frame).toHaveTextContent("member1@example.test");
  expect(
    view.getByRole("progressbar", { name: /5h remaining/u }),
  ).toHaveAttribute("aria-valuenow", "0");
  expect(
    view.getByRole("progressbar", { name: /Week remaining/u }),
  ).toHaveAttribute("aria-valuenow", "60");
  expect(reset).toHaveAccessibleDescription(/Remaining resets: 3/u);
  expect(redeemed).toBeFalsy();
  click(reset);
  await view.findByText("Usage reset successfully.");
  expect(reset).toBeDisabled();
  expect(redeemed).toBeTruthy();
  expect(screen.getByTestId("subscription-reset-card-shell")).toBe(frame);
});
test("subscription-reset-card-002 both copies submit the link key and share the refreshed entitlement", async () => {
  const member = account();
  const gate = context.mocks.deferred<void>();
  const first = context.mocks.deferred<string>();
  const second = context.mocks.deferred<string>();
  let receipt = first;
  context.mocks.api(
    accounts.resetSubscriptionUsage,
    async ({ body, params, respond }) => {
      if (params.id === member.id) {
        receipt.resolve(body.idempotencyKey);
      }
      await gate.promise;
      context.mocks.data.personalModelProviders([
        { ...member, subscriptionResetCredits: 2 },
      ]);
      return respond(200, { outcome: "reset" });
    },
  );
  await chat(member, true);
  const frames = await screen.findAllByTestId("subscription-reset-card-shell");
  expect(frames).toHaveLength(2);
  const [a, b] = frames.map((f) => {
    return within(f);
  });
  click(await a!.findByLabelText("3 resets", { selector: "button" }));
  await expect(first.promise).resolves.toBe(key);
  receipt = second;
  click(await b!.findByLabelText("3 resets", { selector: "button" }));
  await expect(second.promise).resolves.toBe(key);
  gate.resolve();
  for (const frame of frames) {
    const view = within(frame);
    await view.findByText("Usage reset successfully.");
    await expect(
      view.findByLabelText("2 resets", { selector: "button" }),
    ).resolves.toBeDisabled();
  }
});
test("subscription-reset-card-003 a direct link waits for confirmation and reports a previously redeemed key", async () => {
  const member = account();
  let receipt: string | undefined;
  context.mocks.api(
    accounts.resetSubscriptionUsage,
    ({ params, body, respond }) => {
      if (params.id === member.id) {
        receipt = body.idempotencyKey;
      }
      return respond(200, { outcome: "alreadyRedeemed" });
    },
  );
  await standalone(member);
  const button = await screen.findByLabelText("3 resets", {
    selector: "button",
  });
  expect(button).toHaveAccessibleDescription(
    expect.stringContaining(confirmation),
  );
  expect(receipt).toBeUndefined();
  click(button);
  await screen.findByText("This reset request has already been redeemed.");
  expect(receipt).toBe(key);
});
test("subscription-reset-card-004 the standalone Claude page offers natural recovery and explains its five-hour usage", async () => {
  await standalone(account({}, "Claude"));
  const main = within(await screen.findByRole("main"));
  await main.findByText(recovery);
  expect(main.queryByLabelText(/resets?$/u, { selector: "button" })).toBeNull();
  expect(main.queryByText(/Remaining resets:/u)).toBeNull();
  const pop = await details();
  expect(pop.getByText("0% left")).toBeVisible();
  expect(pop.getByText(recovery)).toBeVisible();
  expect(pop.queryByText(confirmation)).toBeNull();
});
test("subscription-reset-card-006 the chat card explains exhaustion and disables its action", async () => {
  await chat(account({ subscriptionResetCredits: 0 }));
  const frame = within(
    await screen.findByTestId("subscription-reset-card-shell"),
  );
  await frame.findByText("No reset credits are available.");
  expect(
    frame.getByLabelText("0 resets", { selector: "button" }),
  ).toBeDisabled();
});
test("subscription-reset-card-007 the card directs an expired account back to Models despite available credits", async () => {
  await chat(account({ needsReconnect: true }));
  await screen.findByText("Reconnect this subscription in Settings > Models.");
  expect(
    screen.getByLabelText("3 resets", { selector: "button" }),
  ).toBeDisabled();
});
test("subscription-reset-card-008 chat quota details for Claude omit credit and submission controls", async () => {
  await chat(account({}, "Claude"));
  const pop = await details();
  expect(pop.getByText(recovery)).toBeVisible();
  expect(pop.queryByText(/Remaining resets:/u)).toBeNull();
  expect(pop.queryByText(confirmation)).toBeNull();
});
test("subscription-reset-card-010 five-hour details disclose expiry outside the original card", async () => {
  await chat(
    account({ subscriptionResetCreditsNextExpiresAt: "2030-10-12T12:00:00Z" }),
  );
  const frame = await screen.findByTestId("subscription-reset-card-shell");
  const pop = await details();
  const expiry = pop.getByText(/Credits expire:.*Oct.*12.*2030/u);
  expect(expiry).toBeVisible();
  expect(pop.getByText("0% left")).toBeVisible();
  expect(pop.getByText(confirmation)).toBeVisible();
  expect(frame.contains(expiry)).toBeFalsy();
  expect(screen.getByTestId("subscription-reset-card-shell")).toBe(frame);
});
test("subscription-reset-card-013 zero credits expose a single disabled reset action", async () => {
  await chat(account({ subscriptionResetCredits: 0 }));
  const frame = within(
    await screen.findByTestId("subscription-reset-card-shell"),
  );
  await frame.findByText("No reset credits are available.");
  const action = frame.getByLabelText(/resets?$/u, { selector: "button" });
  expect(action).toHaveAccessibleName("0 resets");
  expect(action).toBeDisabled();
});
