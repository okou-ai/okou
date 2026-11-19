import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  continuityAttachment,
  continuityThread,
  installContinuityWorkspace,
  textContinuityDraft,
} from "./chat-continuity-test-helpers.ts";
import { fastButton } from "./chat-list-test-helpers.ts";

const context = testContext();

test("Opening a chat restores its saved draft text and available attachment", async () => {
  const thread = continuityThread(6, 1, "Available attachment draft");
  const attachment = continuityAttachment(6, 1, "available-brief.txt");
  const workspace = installContinuityWorkspace(context, {
    caseId: 6,
    threads: [thread],
    drafts: new Map([
      [
        thread.id,
        textContinuityDraft("Review the available brief", [attachment]),
      ],
    ]),
  });

  await setupPage({
    context,
    path: `/chats/${thread.id}`,
    ...workspace.pageOptions,
  });

  const composer = await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => {
    expect(composer).toHaveTextContent("Review the available brief");
    expect(fastButton("Remove available-brief.txt")).toBeVisible();
  });
  expect(document.body).not.toHaveTextContent(
    "available-brief.txt is no longer available",
  );
});
