import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  completedConversation,
  createChatCapabilityHelpers,
  selectPassage,
} from "./chat-capability-test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { RUN_PATH } from "./chat-run-test-fixtures.ts";

const context = testContext();

const passage = "launch plan has three careful stages";
async function startFork() {
  createChatCapabilityHelpers(context).installCapabilityChat({
    events: completedConversation(passage, "Unrelated revision feedback"),
  });
  await setupPage({ context, path: RUN_PATH });
  const original = await findComposerEditor();
  await fill(original, "Unfinished source notes");
  await screen.findByText(passage);
  await selectPassage(passage);
  return { original };
}

async function openForwardSuggestions() {
  const { original } = await startFork();
  click(await findFastControl("button", /^Fork/i));
  const dialog = await screen.findByRole("dialog");
  const editor = await within(dialog).findByRole("textbox", {
    name: "Message",
  });
  const user = userEvent.setup({ delay: null });
  const tail = editor.querySelector<HTMLElement>(
    "[data-feedback-note] p:last-child",
  );
  if (!tail) {
    throw new Error("The selected passage has no editable note");
  }
  await user.click(tail);
  const range = document.createRange();
  range.selectNodeContents(tail);
  range.collapse(false);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  fireEvent(document, new Event("selectionchange"));
  await user.keyboard("Forward draft /");
  const menu = await screen.findByTestId("slash-workflow-menu");
  return { editor, dialog, original, menu, user };
}
function expectForwardDraft(
  editor: HTMLElement,
  dialog: HTMLElement,
  original: HTMLElement,
) {
  expect(editor).toHaveTextContent("Forward draft /");
  expect(editor).toHaveFocus();
  expect(dialog).toBeInTheDocument();
  expect(original).toHaveTextContent("Unfinished source notes");
}
test("chat-capability-voice-forwarding-003 composing Enter leaves the selected passage dialog and slash menu intact", async () => {
  const { editor, dialog, original, menu } = await openForwardSuggestions();
  fireEvent.compositionStart(editor);
  fireEvent.keyDown(editor, { key: "Enter", keyCode: 229, isComposing: true });
  expect(menu).toBeInTheDocument();
  fireEvent.compositionEnd(editor, { data: "" });
  expectForwardDraft(editor, dialog, original);
});
test("chat-capability-voice-forwarding-004 Escape closes suggestions inside the selected passage composer", async () => {
  const { editor, dialog, original, menu, user } =
    await openForwardSuggestions();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(menu).not.toBeInTheDocument();
  });
  expectForwardDraft(editor, dialog, original);
});
