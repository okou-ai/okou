import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { mockPrivateUrlSequence } from "./chat-attachment-test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  ADA_AGENT_ID,
  findFastControl,
  queryFastControl,
  createMessageExperienceHelpers,
} from "./chat-message-experience-test-helpers.ts";

const context = testContext();
const { installMessageExperienceChat } =
  createMessageExperienceHelpers(context);

test("Loading older messages restores agent references and attachment navigation", async () => {
  const firstImageUrl = "https://example.com/history-first.png";
  const secondImageUrl = "https://example.com/history-second.png";
  const historicalDocument = {
    version: 1,
    parts: [
      { type: "text", text: "Historical launch notes for " },
      { type: "agent", agentId: ADA_AGENT_ID, nameSnapshot: "Ada" },
      {
        type: "file",
        fileId: "history-first",
        filenameSnapshot: "history-first.png",
        contentType: "image/png",
      },
      {
        type: "file",
        fileId: "history-second",
        filenameSnapshot: "history-second.png",
        contentType: "image/png",
      },
    ],
  } satisfies UserMessageDocument;
  const chatEvents = Array.from({ length: 12 }, (_, index) => {
    const turn = index + 1;
    const runId = `history-resource-run-${turn.toString()}`;
    const minute = turn.toString().padStart(2, "0");
    return [
      {
        id: `history-resource-user-${turn.toString()}`,
        role: "user",
        content: `History question ${turn.toString()}`,
        ...(turn === 3 ? { userMessage: historicalDocument } : {}),
        runId,
        createdAt: `2026-08-20T12:${minute}:00.000Z`,
      },
      {
        id: `history-resource-answer-${turn.toString()}`,
        role: "assistant",
        content: `History answer ${turn.toString()}`,
        runId,
        createdAt: `2026-08-20T12:${minute}:01.000Z`,
      },
      {
        id: `history-resource-finished-${turn.toString()}`,
        role: "assistant",
        content: null,
        runId,
        runLifecycleEvent: "completed",
        createdAt: `2026-08-20T12:${minute}:02.000Z`,
      },
    ] satisfies MockChatEventInput[];
  }).flat();
  installMessageExperienceChat({
    threadId: context.resourceId,
    chatEvents,
  });
  mockPrivateUrlSequence(context, {
    "history-first": [firstImageUrl],
    "history-second": [secondImageUrl],
  });

  await setupPage({ context, path: `/chats/${context.resourceId}` });

  await expect(
    screen.findByText("History answer 12"),
  ).resolves.toBeInTheDocument();
  expect(queryFastControl("link", "Open agent Ada")).toBeNull();
  expect(queryFastControl("link", "Preview history-first.png")).toBeNull();
  const container = document.querySelector<HTMLElement>(
    `[data-chat-thread-container-id="${context.resourceId}"] [data-scroll-container]`,
  );
  if (!container) {
    throw new Error("Chat scroll container not found");
  }
  Object.defineProperties(container, {
    clientHeight: { configurable: true, value: 300 },
    scrollHeight: { configurable: true, value: 2400 },
    scrollTop: { configurable: true, value: 40, writable: true },
  });
  fireEvent.scroll(container);

  const mention = await findFastControl("link", "Open agent Ada");
  expect(mention).toHaveAttribute("href", `/agents/${ADA_AGENT_ID}/chat`);
  expect(mention.querySelector("img")).toHaveAttribute(
    "src",
    "https://cdn.vm7.io/avatars/ada.png",
  );
  const preview = await findFastControl("link", "Preview history-first.png");
  click(preview);

  await expect(
    screen.findByTestId("attachment-lightbox-image"),
  ).resolves.toHaveAttribute("src", firstImageUrl);
  click(await findFastControl("button", "Next image artifact"));

  await waitFor(() => {
    expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
      "src",
      secondImageUrl,
    );
  });
});
