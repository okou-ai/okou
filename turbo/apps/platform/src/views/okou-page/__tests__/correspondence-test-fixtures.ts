import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { chatRelationsContract } from "@okouai/api-contracts/contracts/chat-relations";
import { screen, within } from "@testing-library/react";
import { expect } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";
import { findEnabledButton } from "./chat-run-test-fixtures.ts";
const peer = "6e06ce72-c28d-42b2-b958-5828787cce82";
const memberRun = "0857bfa2-44f3-4e13-b200-2a97717357b2";
const timestamp = "2026-11-22T06:18:00.000Z";
export function installCorrespondence(
  context: TestContext,
  threadId: string,
  current: () => UserMessageDocument,
) {
  context.mocks.api(chatRelationsContract.communications, ({ respond }) => {
    return respond(200, {
      items: [
        {
          threadId: peer,
          title: "Review desk",
          status: "idle",
          receivedCount: 1,
          sentCount: 0,
          lastMessageAt: timestamp,
        },
      ],
    });
  });
  context.mocks.api(chatRelationsContract.messages, ({ respond }) => {
    return respond(200, {
      items: [
        {
          id: crypto.randomUUID(),
          messageEventId: crypto.randomUUID(),
          sourceRunId: memberRun,
          direction: "received",
          sourceChatThreadId: peer,
          targetChatThreadId: threadId,
          targetRunId: memberRun,
          createdAt: timestamp,
          userMessage: current(),
        },
      ],
    });
  });
  return async () => {
    click(await findEnabledButton("Artifacts and chats"));
    const panel = await screen.findByRole("dialog", {
      name: "Artifacts and chats",
    });
    click(await findEnabledButton("Messages with Review desk", panel));
    const delivered = await within(panel).findByText("Received", {
      exact: true,
    });
    const card = delivered.closest("a");
    expect(card).toHaveAttribute(
      "href",
      "/chats/" + threadId + "#run-" + memberRun,
    );
    return card?.textContent ?? "";
  };
}
