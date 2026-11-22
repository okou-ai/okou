import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  chatListThread,
  installChatListStream,
} from "./chat-list-test-helpers.ts";

const context = testContext();
test("pwa-navigation-001 A desktop standalone chat list keeps its navigation rail and message composer", async () => {
  installChatListStream(context, {
    caseId: 68,
    snapshot: [chatListThread(1, "Coastal survey")],
  });
  context.mocks.browser.matchMedia((query) => {
    return (
      query === "(display-mode: standalone)" || query === "(min-width: 48rem)"
    );
  });
  await setupPage({
    context,
    path: "/",
    host: "app.okou.ai",
    sharedWorkerTestTransport: "message-port",
  });
  await expect(
    screen.findByText("Coastal survey"),
  ).resolves.toBeInTheDocument();
  const rail = await screen.findByRole("navigation", { name: "Sidebar" });
  expect(within(rail).getByLabelText("Workflows")).toBeVisible();
  await expect(screen.findByLabelText("Message")).resolves.toBeVisible();
  expect(location.pathname).toBe("/");
});
