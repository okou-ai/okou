import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "../sidebar-breakpoint.ts";
import {
  completedConversation,
  createChatCapabilityHelpers,
  findButton,
  readyChat,
  RUN_PATH,
  selectPassage,
} from "./chat-capability-test-helpers.ts";

const context = testContext();
const { installCapabilityChat } = createChatCapabilityHelpers(context);

const PASSAGE = "The launch plan has three careful stages.";
const EXISTING_NOTES = "Existing notes for this chat";
const FORWARD_DRAFT = "Forward draft /";

interface ForwardingComposer {
  readonly dialog: HTMLElement;
  readonly editor: HTMLElement;
  readonly original: HTMLElement;
}

function chatComposerEditor(): HTMLElement {
  const editor = document.querySelector(
    '[data-slot="chat-composer-card"] [contenteditable="true"]',
  );
  if (!(editor instanceof HTMLElement)) {
    throw new Error("Chat composer editor not found");
  }
  return editor;
}

function slashRowLabel(button: HTMLElement): string | undefined {
  const label =
    button.querySelector('[data-slot="slash-workflow-name"]') ?? button;
  return label.textContent?.replace(/\s+/gu, " ").trim();
}

function slashRow(container: HTMLElement, prefix: string): HTMLElement {
  const row = queryAllByRoleFast("button", container).find((candidate) => {
    return slashRowLabel(candidate)?.startsWith(prefix);
  });
  if (!row) {
    throw new Error(`Expected slash row ${prefix}`);
  }
  return row;
}

function pointAt(element: HTMLElement): void {
  fireEvent.mouseOver(element);
  fireEvent.mouseMove(element);
}

async function openForwardingSlashMenu(
  slashActions = false,
): Promise<ForwardingComposer> {
  installCapabilityChat({ events: completedConversation(PASSAGE) });
  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.SlashActions]: slashActions },
  });
  await readyChat();
  const original = chatComposerEditor();
  await fill(original, EXISTING_NOTES);
  await selectPassage(PASSAGE);
  click(await findButton("Forward"));
  const picker = await screen.findByRole("dialog", { name: "Forward to" });
  click(await within(picker).findByRole("option", { name: "Okou" }));
  const dialog = await screen.findByRole("dialog", { name: "Okou" });
  const editor = await waitFor(() => {
    const candidate = dialog.querySelector('[contenteditable="true"]');
    if (!(candidate instanceof HTMLElement)) {
      throw new Error("Forwarding composer editor not found");
    }
    return candidate;
  });
  await fill(editor, FORWARD_DRAFT);
  await screen.findByTestId("slash-workflow-menu");
  expect(original).toHaveTextContent(EXISTING_NOTES);
  return { dialog, editor, original };
}

function expectForwardingIntact({
  dialog,
  editor,
  original,
}: ForwardingComposer): void {
  expect(dialog).toBeInTheDocument();
  expect(editor).toHaveTextContent(/^Forward draft \/$/u);
  expect(editor).toHaveFocus();
  expect(original).toHaveTextContent(EXISTING_NOTES);
  expect(original).not.toHaveTextContent("Forward draft");
}

test("Keep forwarding suggestions isolated during preview navigation", async () => {
  // The Document template preview now lives in the desktop Templates overview.
  context.mocks.browser.matchMedia((query) => {
    return query === SIDEBAR_DESKTOP_MEDIA_QUERY;
  });
  const forwarding = await openForwardingSlashMenu(true);
  const user = userEvent.setup({ delay: null });

  await user.keyboard("{ArrowUp}");
  const menu = screen.getByTestId("slash-workflow-menu");
  pointAt(
    await waitFor(() => {
      return slashRow(menu, "Templates ");
    }),
  );
  const pane = await within(menu).findByRole("region", { name: "Templates" });
  const document = slashRow(pane, "Document ");
  expect(document).toHaveAttribute("aria-pressed", "false");
  pointAt(document);

  await waitFor(() => {
    expect(document).toHaveAttribute("aria-pressed", "true");
  });
  expectForwardingIntact(forwarding);
});

test("Keep forwarding suggestions isolated during IME composition", async () => {
  const forwarding = await openForwardingSlashMenu();

  fireEvent.compositionStart(forwarding.editor);
  fireEvent.keyDown(forwarding.editor, {
    key: "Enter",
    code: "Enter",
    isComposing: true,
    keyCode: 229,
  });
  expect(screen.getByTestId("slash-workflow-menu")).toBeInTheDocument();
  fireEvent.compositionEnd(forwarding.editor, { data: "" });

  expect(screen.getByTestId("slash-workflow-menu")).toBeInTheDocument();
  expectForwardingIntact(forwarding);
});

test("Keep forwarding suggestions isolated during dismissal", async () => {
  const forwarding = await openForwardingSlashMenu();
  const user = userEvent.setup({ delay: null });

  await user.keyboard("{Escape}");

  await waitFor(() => {
    expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
  });
  expectForwardingIntact(forwarding);
});
