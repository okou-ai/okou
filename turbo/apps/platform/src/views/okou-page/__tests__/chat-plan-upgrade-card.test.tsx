import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import {
  billingPlanCapabilities,
  defaultBillingStatus,
} from "../../../mocks/handlers/api-billing.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  completedConversation,
  readyChat,
  RUN_PATH,
} from "./chat-capability-test-helpers.ts";
import {
  createChatRunFixtures,
  findEnabledButton,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);

test("Keep the general plans action for an existing paid workspace", async () => {
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, {
      ...defaultBillingStatus(),
      tier: "pro",
      ...billingPlanCapabilities("pro"),
      onboardingPaymentPending: false,
    });
  });
  installRunChat({
    chatEvents: completedConversation(
      "Your report is ready.\n\n[Compare plans](https://app.okou.ai/?settings=billing&billingView=plans)",
    ),
  });
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  await readyChat();
  const card = await screen.findByTestId("plan-upgrade-card");
  await expect(
    within(card).findByText("Upgrade your workspace"),
  ).resolves.toBeVisible();
  click(await findEnabledButton("Compare plans", card));
  await expect(
    screen.findByRole("dialog", { name: "Choose a plan" }),
  ).resolves.toBeVisible();
});
