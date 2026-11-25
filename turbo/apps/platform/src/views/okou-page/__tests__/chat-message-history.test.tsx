import { screen } from "@testing-library/react";
import { test, expect } from "vitest";
import { setupPage, click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { completedMarkdownReply } from "./markdown-page-test-helpers.ts";
import { findAction } from "./connector-integrations-test-helpers.ts";
import {
  createChatRunFixtures,
  promptEvent,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";
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

test("chat-message-history-001 reopening the claimed prompt presents one active turn", async () => {
  const text = "Compare the revised packing lists";
  const runId = crypto.randomUUID();
  const queued = promptEvent({ id: crypto.randomUUID(), seqId: 1, text });
  createChatRunFixtures(context).installRunChat({
    activeRunIds: [runId],
    chatEvents: [
      queued,
      {
        ...promptEvent({ id: crypto.randomUUID(), seqId: 2, text, runId }),
        revokesEventId: queued.id,
      },
    ],
  });

  await setupPage({ context, path: RUN_PATH });
  await expect(screen.findByText("Thinking...")).resolves.toBeInTheDocument();
  await expect(findAction("button", "Stop")).resolves.toBeEnabled();
  expect(screen.getByText(text)).toBeInTheDocument();
  expect(screen.queryByLabelText("Queued message")).not.toBeInTheDocument();
  expect(screen.queryByText("Waiting in")).not.toBeInTheDocument();
});
