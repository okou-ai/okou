import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { RUN_PATH, RUN_THREAD_ID } from "./chat-run-test-fixtures.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

const delivery = "Message delivered without a Run";
test("chat-runless-delivery-001 an assistant delivery with no Run opens in its own conversation", async () => {
  mockChatLifecycle(context, {
    threadId: RUN_THREAD_ID,
    chatEvents: [
      {
        createdAt: "2026-08-01T10:01:00Z",
        id: "local-delivery",
        role: "assistant",
        content: delivery,
        runId: undefined,
      },
    ],
  });
  await setupPage({ context, path: RUN_PATH });
  await expect(screen.findByText(delivery)).resolves.toBeInTheDocument();
});
test("chat-runless-delivery-003 only the earlier completed response offers its work history", async () => {
  mockChatLifecycle(context, {
    threadId: RUN_THREAD_ID,
    chatEvents: [
      {
        createdAt: "2026-08-01T10:00:00Z",
        id: "q",
        role: "user",
        content: "Review launch",
        runId: "local-run",
      },
      {
        createdAt: "2026-08-01T10:00:04Z",
        id: "step",
        role: "assistant",
        content: "Inspecting launch notes",
        runId: "local-run",
      },
      {
        createdAt: "2026-08-01T10:00:20Z",
        id: "completed",
        role: "assistant",
        content: "Launch review completed",
        runId: "local-run",
        runLifecycleEvent: "completed",
      },
      {
        createdAt: "2026-08-01T10:01:00Z",
        id: "followup",
        role: "assistant",
        content: delivery,
        runId: undefined,
      },
    ],
  });
  await setupPage({ context, path: RUN_PATH });
  const earlier = await screen.findByText("Launch review completed");
  const later = await screen.findByText(delivery);
  expect(
    earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  const response =
    earlier.closest("[data-chat-message-anchor]") ??
    earlier.closest("[data-role=assistant]")!;
  const followup = later.closest("[data-role=assistant]")!;
  expect(response).not.toContainElement(later);
  expect(
    response.querySelector('[aria-label*="work history" i]'),
  ).toBeInTheDocument();
  expect(followup.querySelector('[aria-label*="work history" i]')).toBeNull();
});
