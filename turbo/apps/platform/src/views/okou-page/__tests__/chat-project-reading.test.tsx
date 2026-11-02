import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import { waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  chatEventRowsResponse,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import { createMessageExperienceHelpers } from "./chat-message-experience-test-helpers.ts";

const context = testContext();
const { installMessageExperienceChat } =
  createMessageExperienceHelpers(context);

test("future Project references remain readable in a restored conversation and feedback", async () => {
  const projectId = "00000000-0000-4000-8000-000000000071";
  const reference = {
    type: "project",
    projectId,
    nameSnapshot: "Original launch",
  };
  installMessageExperienceChat({
    threadId: context.resourceId,
    chatEvents: [],
  });
  const row: ChatEventRow = {
    id: "00000000-0000-4000-8000-000000000001",
    chatThreadId: context.resourceId,
    runId: null,
    revokesEventId: null,
    contextType: "web",
    contextId: context.resourceId,
    runEventSequenceNumber: null,
    runEventId: null,
    seqId: 1,
    createdAt: "2026-11-02T00:00:00.000Z",
    eventType: "input.prompt",
    payload: {
      userMessage: {
        version: 1,
        parts: [
          { type: "text", text: "Review " },
          reference,
          { type: "feedback", quote: "Check the schedule", note: [reference] },
        ],
      },
    },
  };
  context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
    return respond(
      200,
      chatEventRowsResponse(query.sinceSeqId === 0 ? [row] : [], query),
    );
  });
  await setupPage({ context, path: `/chats/${context.resourceId}` });
  await waitFor(() => {
    const message = document.querySelector("[data-structured-user-message]");
    expect(message).toHaveTextContent("Original launch");
    expect(message).toHaveTextContent(`/projects/${projectId}`);
    expect(message).toHaveTextContent("Check the schedule");
  });
});
