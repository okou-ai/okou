import { screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const THREAD_ID = "11111111-1111-4111-8111-111111111111";

function pushedUrls(): string[] {
  return vi.mocked(window.history.pushState).mock.calls.map((call) => {
    return call[2]?.toString() ?? "";
  });
}

test("A relative chat notification opens its conversation", async () => {
  const serviceWorker = context.mocks.browser.serviceWorker();
  await setupPage({ context, path: "/agents", host: "app.okou.ai" });
  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeVisible();

  serviceWorker.dispatchMessage({
    type: "NOTIFICATION_CLICK",
    url: `/chats/${THREAD_ID}`,
  });

  await waitFor(() => {
    expect(pushedUrls()).toContain(`/chats/${THREAD_ID}`);
  });
});

test("An untrusted or non-chat notification does not navigate Platform", async () => {
  const serviceWorker = context.mocks.browser.serviceWorker();
  await setupPage({ context, path: "/agents", host: "app.okou.ai" });
  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeVisible();
  const navigationCount = pushedUrls().length;

  serviceWorker.dispatchMessage({
    type: "NOTIFICATION_CLICK",
    url: `https://external.example/chats/${THREAD_ID}`,
  });
  serviceWorker.dispatchMessage({
    type: "NOTIFICATION_CLICK",
    url: `https://okou.ai/chats/${THREAD_ID}`,
  });
  serviceWorker.dispatchMessage({
    type: "NOTIFICATION_CLICK",
    url: "https://app.okou.ai/agents",
  });

  expect(pushedUrls()).toHaveLength(navigationCount);
  expect(window.location.pathname).toBe("/agents");
  expect(screen.getByRole("heading", { name: "Agents" })).toBeVisible();
});
