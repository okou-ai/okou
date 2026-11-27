import { bankingWorkspaceContract } from "@okouai/api-contracts/contracts/banking";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

import { createMessageExperienceHelpers } from "./chat-message-experience-test-helpers.ts";

const context = testContext();
const { installMessageExperienceChat } =
  createMessageExperienceHelpers(context);
const THREAD_ID = "b0000000-0000-4000-a000-000000000c91";
const CHANNEL = "user:test-user-123";
const TOPIC = "bankingAccessChanged";
const ANSWER = "I need read access to your bank accounts.";

function bankingLink(): string {
  const params = new URLSearchParams({
    reason: "Review this month's cash flow",
    callbackPrompt: "Continue the cash flow review.",
    threadId: THREAD_ID,
  });
  return `https://app.okou.ai/banking/access?${params}`;
}

async function expectBothCards(summary: string): Promise<void> {
  await waitFor(() => {
    const cards = screen.queryAllByTestId("banking-action-card");
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card).toHaveTextContent(summary);
    }
  });
}

test("Duplicate banking cards update together on events and recover after a continuity gap", async () => {
  let pending = false;
  context.mocks.api(
    bankingWorkspaceContract.accessRequestStatus,
    ({ respond }) => {
      return respond(200, {
        connection: null,
        session: pending
          ? {
              id: "c0000000-0000-4000-a000-000000000001",
              mode: "connect",
              status: "pending",
              institutionLoginId: null,
            }
          : null,
        grant: null,
      });
    },
  );
  installMessageExperienceChat({
    threadId: THREAD_ID,
    chatEvents: [
      {
        id: "banking-request",
        role: "assistant",
        content: `${ANSWER}\n\n${bankingLink()}\n\nSame request again:\n\n${bankingLink()}`,
        runId: "d0000000-0000-4000-a000-000000000c91",
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
  await expectBothCards("Review this month's cash flow");
  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscriptionOnChannel(CHANNEL, TOPIC),
    ).toBeTruthy();
  });

  pending = true;
  context.mocks.ably.triggerOnChannel(CHANNEL, TOPIC, {});

  await expectBothCards(
    "Waiting for Mastercard Data Connect. Finish there, then return to Chat.",
  );

  // The external session finishes before realtime reconnects.
  context.mocks.ably.triggerConnectionState("suspended", {
    channelName: CHANNEL,
  });
  pending = false;
  context.mocks.ably.triggerReconnect();

  await expectBothCards("Review this month's cash flow");
});
