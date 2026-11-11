import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import type { ComposerDraft } from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  continuityAttachment,
  continuityDraft,
  continuityThread,
  draftPlainText,
  installContinuityWorkspace,
  textContinuityDraft,
} from "./chat-continuity-test-helpers.ts";

const context = testContext();

test.each(["agent", "thread"] as const)(
  "Whitespace-only %s drafts clear saved content without trimming meaningful text",
  async (kind) => {
    const thread = continuityThread(41, 1, "Whitespace draft conversation");
    const workspace = installContinuityWorkspace(context, {
      caseId: 41,
      threads: [thread],
    });
    let agentDraft = textContinuityDraft("");
    const agentPatches: ComposerDraft[] = [];
    context.mocks.api(agentDraftContract.get, ({ respond }) => {
      return respond(200, agentDraft);
    });
    context.mocks.api(agentDraftContract.patch, ({ body, respond }) => {
      agentDraft = {
        draftUserMessage: body.draftUserMessage,
        draftAttachments: body.draftAttachments ?? null,
      };
      agentPatches.push(agentDraft);
      return respond(204);
    });
    const latestPatch = () => {
      return kind === "agent"
        ? agentPatches.at(-1)
        : workspace.draftPatches.at(-1);
    };

    await setupPage({
      context,
      path:
        kind === "agent"
          ? `/agents/${thread.agentId}/chat`
          : `/chats/${thread.id}`,
      ...workspace.pageOptions,
    });
    const composer = await screen.findByRole("textbox", { name: "Message" });
    const empty = { draftUserMessage: null, draftAttachments: null };
    await fill(composer, " \t ");
    await waitFor(() => {
      expect(latestPatch()).toMatchObject(empty);
    });

    const text = "  Keep this draft\n\n    indented line  ";
    await fill(composer, text);
    await waitFor(() => {
      expect(draftPlainText(latestPatch()?.draftUserMessage ?? null)).toBe(
        text,
      );
    });

    await fill(composer, " ");
    const user = userEvent.setup({ delay: null });
    await user.keyboard("{Shift>}{Enter}{/Shift}{Enter}");
    await waitFor(() => {
      expect(latestPatch()).toMatchObject(empty);
    });
    expect(composer).not.toHaveTextContent("Keep this draft");
  },
);

test("Whitespace text preserves a draft's attachment and inline reference", async () => {
  const thread = continuityThread(42, 1, "Rich whitespace draft");
  const referenced = continuityThread(42, 2, "Referenced conversation");
  const attachment = continuityAttachment(42, 1, "keep-this-file.txt");
  const workspace = installContinuityWorkspace(context, {
    caseId: 42,
    threads: [thread, referenced],
    drafts: new Map([
      [
        thread.id,
        continuityDraft(
          [
            { type: "text", text: " \n" },
            {
              type: "chat_thread",
              threadId: referenced.id,
              titleSnapshot: referenced.title ?? "Referenced conversation",
            },
            {
              type: "file",
              fileId: attachment.id,
              filenameSnapshot: attachment.filename,
              contentType: attachment.contentType,
            },
          ],
          [attachment],
        ),
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
    expect(composer).toHaveTextContent("Referenced conversation");
    expect(document.body).toHaveTextContent(attachment.filename);
  });
  const user = userEvent.setup({ delay: null });
  await user.click(composer);
  await user.paste(" ");
  await waitFor(() => {
    const saved = workspace.draftPatches.at(-1);
    expect(saved?.draftAttachments).toStrictEqual([attachment]);
    expect(saved?.draftUserMessage?.parts).toContainEqual({
      type: "chat_thread",
      threadId: referenced.id,
      titleSnapshot: referenced.title,
    });
  });
});
