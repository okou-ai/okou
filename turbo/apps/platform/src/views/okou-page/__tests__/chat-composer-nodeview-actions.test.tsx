import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import {
  completedConversation,
  context,
  findButton,
  installCapabilityChat,
  quoteSelectedPassage,
  readyChat,
  RUN_PATH,
  selectPassage,
} from "./chat-capability-test-helpers.ts";

const PASSAGE = "The launch plan has three careful stages.";

async function openComposer(): Promise<HTMLElement> {
  installCapabilityChat({ events: completedConversation(PASSAGE) });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  return screen.getByRole("textbox", { name: "Message" });
}

test("Template attachment buttons own pointer focus and restore editing after removal", async () => {
  const editor = await openComposer();
  const user = userEvent.setup({ delay: null });
  await user.click(editor);
  // Current pickers create inline chips. The supported HTML clipboard boundary
  // restores the block attachment still present in historical drafts.
  const clipboard = new DataTransfer();
  clipboard.setData(
    "text/html",
    '<div data-composer-template-attachment title="Legacy deck"></div><p>Keep this draft.</p>',
  );
  await user.paste(clipboard);
  const preview = await findButton("Preview template Legacy deck");

  await user.pointer({ target: preview, keys: "[MouseLeft>]" });
  expect(preview).toHaveFocus();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await user.pointer({ target: preview, keys: "[/MouseLeft]" });
  await expect(screen.findByRole("dialog")).resolves.toBeInTheDocument();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(preview).toHaveFocus();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  const remove = await findButton("Remove template Legacy deck");
  await user.pointer({ target: remove, keys: "[MouseRight]" });
  expect(preview).toBeInTheDocument();
  await user.pointer({ target: remove, keys: "[MouseLeft>]" });
  expect(remove).toHaveFocus();
  expect(preview).toBeInTheDocument();
  await user.pointer({ target: remove, keys: "[/MouseLeft]" });
  expect(editor).toHaveFocus();
  expect(preview).not.toBeInTheDocument();
  await user.keyboard(" Continue editing.");
  expect(editor).toHaveTextContent("Keep this draft. Continue editing.");
});

test("The quote remove button accepts pointer focus until activation and returns focus to the draft", async () => {
  const editor = await openComposer();
  await selectPassage(PASSAGE);
  const note = await quoteSelectedPassage();
  const user = userEvent.setup({ delay: null });
  await user.type(note, "Review this quote.");
  const remove = await findButton("Remove feedback");

  await user.pointer({ target: remove, keys: "[MouseLeft>]" });
  expect(remove).toHaveFocus();
  expect(note).toHaveTextContent("Review this quote.");
  await user.pointer({ target: remove, keys: "[/MouseLeft]" });
  expect(editor).toHaveFocus();
  expect(note).not.toBeInTheDocument();
  await user.keyboard("A fresh note.");
  expect(editor).toHaveTextContent("A fresh note.");
});

test.each(["{Enter}", " "])(
  "A quote can be removed with %s and editing continues in the draft",
  async (key) => {
    const editor = await openComposer();
    await selectPassage(PASSAGE);
    const note = await quoteSelectedPassage();
    const user = userEvent.setup({ delay: null });
    await user.type(note, "Review this quote.");
    const remove = await findButton("Remove feedback");
    remove.focus();
    expect(remove).toHaveFocus();

    await user.keyboard(key);
    expect(editor).toHaveFocus();
    expect(note).not.toBeInTheDocument();
    await user.keyboard("A fresh note.");
    expect(editor).toHaveTextContent("A fresh note.");
  },
);

test.each(["{Enter}", " "])(
  "An inline template opens with %s and keeps its replacement target",
  async (key) => {
    const editor = await openComposer();
    const [first, replacement] = PRESENTATION_TEMPLATE_PICKER_ITEMS;
    if (!first || !replacement) {
      throw new Error("Expected two presentation templates");
    }
    click(await findButton("Template"));
    await screen.findByRole("dialog");
    click(screen.getByLabelText(`Select template ${first.title}`));
    const preview = await findButton(`Preview template ${first.title}`);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    const user = userEvent.setup({ delay: null });
    preview.focus();
    expect(preview).toHaveFocus();

    await user.keyboard(key);
    await screen.findByRole("dialog");
    click(screen.getByLabelText(`Select template ${replacement.title}`));
    await expect(
      findButton(`Preview template ${replacement.title}`),
    ).resolves.toBeInTheDocument();
    expect(editor).not.toHaveTextContent(first.title);
    expect(editor).toHaveTextContent(replacement.title);
  },
);
