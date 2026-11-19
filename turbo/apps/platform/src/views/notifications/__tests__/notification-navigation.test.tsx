import { act, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

test("A relative chat notification opens the linked conversation", async () => {
  const worker = context.mocks.browser.serviceWorker();
  const chat = "/chats/94000000-0000-4000-a000-000000000001";
  await setupPage({ context, path: "/agents", host: "app.okou.ai" });
  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeInTheDocument();

  await act(() => {
    worker.dispatchMessage({ type: "NOTIFICATION_CLICK", url: chat });
  });

  await waitFor(() => {
    expect(window.location.pathname).toBe(chat);
  });
});
