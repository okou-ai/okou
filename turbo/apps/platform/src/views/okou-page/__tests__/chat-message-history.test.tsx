import { screen } from "@testing-library/react";
import { test, expect } from "vitest";
import { setupPage, click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { completedMarkdownReply } from "./markdown-page-test-helpers.ts";
import { findAction } from "./connector-integrations-test-helpers.ts";
const context = testContext();
test("chat-message-history-002 the artifacts panel explains that this completed conversation has no artifacts", async () => {
  await setupPage({
    context,
    path: completedMarkdownReply(context, "No files were requested."),
  });
  await screen.findByText("No files were requested.");
  click(await findAction("button", "Artifacts and chats"));
  const title = await screen.findByRole("heading", {
    name: "Artifacts and chats",
  });
  expect(title).toBeVisible();
  await expect(screen.findByText("No artifacts yet")).resolves.toBeVisible();
});
