import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "../../okou-page/__tests__/chat-test-helpers.ts";

const context = testContext();

test("notification-navigation-001 revised Workflows notification opens the conversation named by the relative link", async () => {
  const destination = crypto.randomUUID();
  const message = "The shipment cleared customs";
  mockChatLifecycle(context, {
    threadId: destination,
    chatEvents: [
      {
        role: "user",
        content: message,
        createdAt: "2026-06-11T09:00:00Z",
      },
    ],
  });
  const worker = context.mocks.browser.serviceWorker();
  await setupPage({ context, path: "/workflows" });
  await screen.findByRole("heading", { name: "Workflows" });
  expect(screen.queryByText(message)).toBeNull();
  worker.dispatchMessage({
    type: "NOTIFICATION_CLICK",
    url: "/chats/" + destination,
  });
  await expect(screen.findByText(message)).resolves.toBeInTheDocument();
  expect(location.pathname).toBe("/chats/" + destination);
});
