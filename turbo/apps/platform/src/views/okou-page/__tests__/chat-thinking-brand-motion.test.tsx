import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { changeChatIndicators } from "../../../mocks/mock-helpers.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { thinkingBrandMotionImg } from "../platform-assets.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import { setupPage } from "./chat-lifecycle-test-helpers.ts";
import {
  assistantEvent,
  completedEvent,
  createChatRunFixtures,
  findButton,
  promptEvent,
  publishRunUpdate,
  readyChat,
  RUN_PATH,
  sendText,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);
const RUN_ID = "a0000000-0000-4000-a000-000000000e41";
const PROMPT = "Verify event data collection.";

function thinkingIndicator(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-thinking-indicator]");
}

test("Show the brand thinking artwork during a run", async () => {
  const chatEvents: MockChatEventInput[] = [];
  const activeRunIds: string[] = [];
  installRunChat({ chatEvents, activeRunIds });
  const sent = context.mocks.deferred<string>();
  const accepted = context.mocks.deferred<void>();
  context.mocks.api(chatEventsContract.send, async ({ body, respond }) => {
    sent.resolve(body.clientEventId ?? "");
    await accepted.promise;
    return respond(201, {
      threadId: body.threadId ?? "",
      createdAt: "2026-11-21T10:01:00.000Z",
    });
  });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();

  await sendText(PROMPT);
  const clientEventId = await sent.promise;

  await waitFor(() => {
    expect(thinkingIndicator()).toHaveTextContent("Thinking...");
  });
  const artwork = thinkingIndicator()?.querySelector("[aria-hidden] img");
  expect(artwork).toHaveAttribute("src", thinkingBrandMotionImg);
  expect(artwork).toHaveAttribute("alt", "");

  accepted.resolve();
  chatEvents.push(
    promptEvent({ id: clientEventId, runId: RUN_ID, seqId: 1, text: PROMPT }),
  );
  activeRunIds.push(RUN_ID);
  publishRunUpdate();
  changeChatIndicators();
  await expect(findButton("Stop")).resolves.toBeVisible();

  chatEvents.push(
    assistantEvent({
      id: "collection-answer",
      runId: RUN_ID,
      seqId: 2,
      text: "Event data collection is verified.",
    }),
    completedEvent({ id: "collection-complete", runId: RUN_ID, seqId: 3 }),
  );
  activeRunIds.splice(0);
  publishRunUpdate();
  changeChatIndicators();

  await expect(
    screen.findByText("Event data collection is verified."),
  ).resolves.toBeInTheDocument();
  await expect(findButton("Send")).resolves.toBeVisible();
});
