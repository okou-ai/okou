import {
  composerDraftContract,
  type ComposerDraftResponse,
} from "@okouai/api-contracts/contracts/composer-draft";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { setupPage, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findAction } from "./connector-integrations-test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import {
  continuityDraft,
  continuityAttachment,
  continuityThread,
  draftPlainText,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";

const context = testContext();
async function newChat() {
  let server: ComposerDraftResponse = {
    draftUserMessage: null,
    draftAttachments: null,
  };
  context.mocks.api(composerDraftContract.get, ({ respond }) => {
    return respond(200, server);
  });
  context.mocks.api(composerDraftContract.patch, ({ body, respond }) => {
    server = {
      draftUserMessage: body.draftUserMessage,
      draftAttachments: body.draftAttachments ?? null,
    };
    return respond(204);
  });
  await setupPage({ context, path: "/" });
  return {
    editor: await findComposerEditor(),
    saved: () => {
      return server;
    },
  };
}
test("chat-whitespace-drafts-003 meaningful whitespace is preserved until the member clears the draft", async () => {
  const { editor, saved } = await newChat();
  const text = "  Harbor briefing\n\n    Third line";
  await fill(editor, text);
  await waitFor(() => {
    expect(draftPlainText(saved().draftUserMessage)).toBe(text);
  });
  await fill(editor, "  \t");
  await userEvent.keyboard("{Shift>}{Enter}{Enter}{/Shift}");
  await waitFor(() => {
    expect(saved()).toStrictEqual({
      draftUserMessage: null,
      draftAttachments: null,
    });
  });
  expect(editor).not.toHaveTextContent("Harbor briefing");
});
test("chat-whitespace-drafts-005 a pasted space retains the attached file and the link to the other chat", async () => {
  const one = continuityThread(508, 1, "Port decisions"),
    other = continuityThread(508, 2, "Shipping notes"),
    file = continuityAttachment(508, 1, "manifest.txt");
  const reference = {
    type: "chat_thread" as const,
    threadId: other.id,
    titleSnapshot: "Shipping notes",
  };
  const item = {
    type: "file" as const,
    fileId: file.id,
    filenameSnapshot: file.filename,
    contentType: file.contentType,
  };
  const draft = continuityDraft(
    [{ type: "text", text: " " }, reference, item],
    [file],
  );
  const api = installContinuityWorkspace(context, {
    caseId: 508,
    threads: [one, other],
    drafts: new Map([[one.id, draft]]),
  });
  await setupPage({ context, path: "/chats/" + one.id, ...api.pageOptions });
  const editor = await findComposerEditor();
  await waitFor(() => {
    expect(editor).toHaveTextContent("Shipping notes");
  });
  await screen.findByText("manifest.txt");
  const user = userEvent.setup();
  await user.click(editor);
  await user.paste(" ");
  await waitFor(() => {
    const update = api.draftPatches
      .filter((p) => {
        return p.threadId === one.id;
      })
      .at(-1);
    expect(update?.draftUserMessage?.parts).toStrictEqual(
      expect.arrayContaining([reference, item]),
    );
    expect(update?.draftAttachments).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: file.id, filename: "manifest.txt" }),
      ]),
    );
  });
  expect(editor).toHaveTextContent("Shipping notes");
  expect(screen.getByText("manifest.txt")).toBeInTheDocument();
});

test("The member workspace saves a blank draft after whitespace-only input", async () => {
  const saved = context.mocks.deferred<ComposerDraftResponse>();
  const blank = { draftUserMessage: null, draftAttachments: null };
  context.mocks.api(composerDraftContract.get, ({ respond }) => {
    return respond(200, blank);
  });
  context.mocks.api(composerDraftContract.patch, ({ body, respond }) => {
    saved.resolve({
      draftUserMessage: body.draftUserMessage,
      draftAttachments: body.draftAttachments ?? null,
    });
    return respond(204);
  });
  await setupPage({ context, path: "/" });
  const editor = await findComposerEditor();
  expect(editor.textContent).toBe("");
  await fill(editor, "  \t ");
  await expect(saved.promise).resolves.toStrictEqual(blank);
  await expect(findAction("button", "Send")).resolves.toBeDisabled();
});
