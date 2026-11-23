import {
  composerDraftContract,
  type ComposerDraftResponse,
} from "@okouai/api-contracts/contracts/composer-draft";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";

const context = testContext();

async function openDraft(titleSnapshot: string) {
  const reference = {
    type: "chat_thread" as const,
    threadId: crypto.randomUUID(),
    titleSnapshot,
  };
  let saved: ComposerDraftResponse = {
    draftUserMessage: {
      version: 1,
      parts: [
        { type: "text", text: "Review " },
        reference,
        { type: "text", text: " before planning." },
      ],
    },
    draftAttachments: null,
  };
  context.mocks.api(composerDraftContract.get, ({ respond }) => {
    return respond(200, saved);
  });
  context.mocks.api(composerDraftContract.patch, ({ body, respond }) => {
    saved = {
      draftUserMessage: body.draftUserMessage,
      draftAttachments: body.draftAttachments ?? null,
    };
    return respond(204);
  });
  await setupPage({ context, path: "/" });
  const editor = await findComposerEditor();
  const chip = await within(editor).findByText(titleSnapshot);
  return {
    reference,
    editor,
    chip,
    saved: () => {
      return saved.draftUserMessage?.parts;
    },
  };
}

test("The member Home draft displays Weekly sync as a separate chip between its surrounding words", async () => {
  const { editor, chip, reference } = await openDraft("Weekly sync");
  expect(chip.closest("[data-chat-thread-mention]")).toHaveAttribute(
    "data-chat-thread-mention",
    reference.threadId,
  );
  expect(chip.closest('[contenteditable="false"]')).toBeInTheDocument();
  expect(editor.textContent).toBe("Review Weekly sync before planning.");
});

test("chat-mentions-003 revised Home draft retains the selected conversation after returning from Workflows", async () => {
  const title = String.raw`Release [QA] \ notes`;
  const { editor, reference, saved } = await openDraft(title);
  const user = userEvent.setup();
  await user.click(editor);
  const selection = window.getSelection();
  selection?.selectAllChildren(editor);
  selection?.collapseToEnd();
  await user.paste(" Approved.");
  await waitFor(() => {
    expect(saved()).toContainEqual(reference);
    expect(saved()).toContainEqual({
      type: "text",
      text: " before planning. Approved.",
    });
  });
  await user.click(
    within(screen.getByTestId("labeled-nav-rail")).getByLabelText("Workflows"),
  );
  await screen.findByRole("heading", { name: "Workflows" });
  history.back();
  const restored = await findComposerEditor();
  const chip = await within(restored).findByText(title);
  expect(chip.closest("[data-chat-thread-mention]")).toHaveAttribute(
    "data-chat-thread-mention",
    reference.threadId,
  );
  expect(restored.textContent).toBe(
    "Review " + title + " before planning. Approved.",
  );
  expect(location.pathname).toBe("/");
});
