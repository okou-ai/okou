import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  billingPlanCapabilities,
  defaultBillingStatus,
} from "../../../mocks/handlers/api-billing.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createMessageExperienceHelpers } from "./chat-message-experience-test-helpers.ts";

const context = testContext();
const { installMessageExperienceChat } =
  createMessageExperienceHelpers(context);
const THREAD_ID = "b0000000-0000-4000-a000-000000000c81";
const ANSWER = "Your workspace can compare the available plans here.";

test("Keep the general plans action for an existing paid workspace", async () => {
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, {
      ...defaultBillingStatus(),
      tier: "pro",
      ...billingPlanCapabilities("pro"),
    });
  });
  installMessageExperienceChat({
    threadId: THREAD_ID,
    chatEvents: [
      {
        id: "plans-answer",
        role: "assistant",
        content: `${ANSWER}\n\nhttps://app.okou.ai/?settings=billing&billingView=plans`,
        runId: "d0000000-0000-4000-a000-000000000c81",
        seqId: 1,
        createdAt: "2026-11-20T09:00:00.000Z",
      },
    ],
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
  });
  const card = await screen.findByTestId("plan-upgrade-card");
  const compare = await waitFor(() => {
    const button = queryAllByRoleFast("button", card).find((candidate) => {
      return candidate.textContent?.trim() === "Compare plans";
    });
    expect(button).toBeEnabled();
    return button as HTMLElement;
  });

  click(compare);

  await expect(
    screen.findByRole("dialog", { name: "Choose a plan" }),
  ).resolves.toBeVisible();
});
