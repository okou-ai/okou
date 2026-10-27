import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  continuityAttachment,
  continuityThread,
  draftPlainText,
  installContinuityWorkspace,
  textContinuityDraft,
} from "./chat-continuity-test-helpers.ts";
import { fastButton } from "./chat-list-test-helpers.ts";

const context = testContext();

test("Recover saved draft attachments safely", async () => {
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

test("Remove an unavailable saved draft attachment without losing text", async () => {
  const thread = continuityThread(7, 1, "Unavailable attachment draft");
  const attachment = continuityAttachment(7, 1, "missing-brief.txt");
  const workspace = installContinuityWorkspace(context, {
    caseId: 7,
    threads: [thread],
    drafts: new Map([
      [thread.id, textContinuityDraft("Keep this draft text", [attachment])],
    ]),
    resolveAttachment: () => {
      return "missing";
    },
  });

  await setupPage({
    context,
    path: `/chats/${thread.id}`,
    ...workspace.pageOptions,
  });

  const composer = await screen.findByRole("textbox", { name: "Message" });
  const warning = await screen.findByText(
    "missing-brief.txt is no longer available. Upload it again to send.",
  );
  expect(warning).toBeInTheDocument();
  expect(composer).toHaveTextContent("Keep this draft text");
  expect(
    queryAllByRoleFast("button", document).some((button) => {
      return button.getAttribute("aria-label") === "Remove missing-brief.txt";
    }),
  ).toBeFalsy();
  await waitFor(() => {
    expect(
      workspace.draftPatches.some((patch) => {
        return (
          patch.threadId === thread.id &&
          patch.draftAttachments === null &&
          draftPlainText(patch.draftUserMessage) === "Keep this draft text"
        );
      }),
    ).toBeTruthy();
  });
});
