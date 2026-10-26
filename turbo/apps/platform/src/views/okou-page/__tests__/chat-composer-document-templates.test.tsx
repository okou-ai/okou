import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  click,
  fill,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import {
  AGENT_ID,
  openTemplatePicker,
  createTemplateGalleryHelpers,
} from "./chat-composer-template-gallery-test-helpers.ts";
import {
  composerInlineTemplates,
  findComposerEditor,
} from "./chat-composer-test-helpers.ts";

const context = testContext();
const { mockTemplateChat } = createTemplateGalleryHelpers(context);

function control(
  dialog: HTMLElement,
  role: "tab" | "button" | "link",
  name: string,
): HTMLElement {
  const result = queryAllByRoleFast(role, dialog).find((element) => {
    return (
      element.getAttribute("aria-label") === name ||
      element.textContent?.trim() === name
    );
  });
  if (!result) {
    throw new Error(`Missing ${role}: ${name}`);
  }
  return result;
}

async function setup() {
  const capture = mockTemplateChat();
  const user = userEvent.setup({ delay: null });
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.CustomTemplates]: false,
    },
  });
  return { user, capture };
}

test("Document category and scroll survive preview", async () => {
  const { user, capture } = await setup();
  await fill(await findComposerEditor(), "Prepare the invoice for my client.");
  const dialog = await openTemplatePicker(user);
  const tabs = queryAllByRoleFast("tab", dialog);
  expect(
    tabs.map((tab) => {
      return tab.textContent;
    }),
  ).toStrictEqual([
    "Presentation",
    "Document",
    "Website",
    "Illustration",
    "Workflow",
  ]);
  click(control(dialog, "tab", "Document"));
  expect(within(dialog).getAllByLabelText(/^Preview /u)).toHaveLength(46);
  click(control(dialog, "button", "Invoice"));
  expect(within(dialog).getAllByLabelText(/^Preview /u)).toHaveLength(7);
  const grid = dialog.querySelector<HTMLElement>(
    "[data-document-template-grid-scroll]",
  );
  if (!grid) {
    throw new Error("Document grid not found");
  }
  grid.scrollTop = 120;
  fireEvent.scroll(grid);
  click(control(dialog, "button", "Preview Simple invoice"));
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(
    within(dialog).getByRole("heading", {
      name: "Document / Simple invoice",
      level: 2,
    }),
  ).toBeVisible();
  await user.keyboard("{Escape}");
  expect(control(dialog, "button", "Invoice")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(within(dialog).getAllByLabelText(/^Preview /u)).toHaveLength(7);
  const restored = dialog.querySelector<HTMLElement>(
    "[data-document-template-grid-scroll]",
  );
  expect(restored?.scrollTop).toBe(120);
  expect(control(dialog, "button", "Preview Simple invoice")).toHaveFocus();
  await expect(findComposerEditor()).resolves.toHaveTextContent(
    "Prepare the invoice for my client.",
  );
  expect(capture.sentMessages).toHaveLength(0);
});

test("Using a document template preserves the draft until the user sends it", async () => {
  const { user, capture } = await setup();
  await fill(await findComposerEditor(), "Explain this proposal to my client.");
  const dialog = await openTemplatePicker(user);
  click(control(dialog, "tab", "Document"));
  click(control(dialog, "button", "Use Sidebar report"));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  const preservedEditor = await findComposerEditor();
  expect(preservedEditor).toHaveTextContent(
    "Explain this proposal to my client.",
  );
  expect(composerInlineTemplates()).toHaveLength(1);
  expect(composerInlineTemplates()[0]).toHaveTextContent("Sidebar report");
  expect(
    control(document.body, "button", "Remove Document"),
  ).toBeInTheDocument();
  expect(capture.sentMessages).toHaveLength(0);
  click(await findComposerEditor());
  await user.keyboard("{Enter}");
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(capture.sentMessages[0]?.parts).toContainEqual({
    type: "template",
    titleSnapshot: "Sidebar report",
    template: {
      type: "document",
      selection: { documentTemplateId: "document-template:sidebar-report" },
    },
  });
});

test("Document purposes are directly selectable without losing the draft or selected template", async () => {
  const { user, capture } = await setup();
  const editor = await findComposerEditor();
  await fill(editor, "Prepare the invoice for my client.");
  click(
    control(
      screen.getByRole("group", { name: "Choose a task" }),
      "button",
      "Document",
    ),
  );
  const shelf = await screen.findByRole("group", {
    name: "Document templates",
  });
  const categories = within(shelf).getByRole("group", {
    name: "Document category",
  });
  expect(control(categories, "button", "Creative brief")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(within(categories).queryByText("Custom")).not.toBeInTheDocument();
  expect(
    within(shelf).queryByLabelText("Import your own document"),
  ).not.toBeInTheDocument();
  click(control(categories, "button", "Invoice"));
  expect(control(categories, "button", "Invoice")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(within(shelf).getAllByLabelText(/^Use template /u)).toHaveLength(7);
  click(control(shelf, "button", "Use template Itemized invoice"));
  expect(composerInlineTemplates()[0]).toHaveTextContent("Itemized invoice");
  click(control(categories, "button", "Reports"));
  expect(within(shelf).getAllByLabelText(/^Use template /u)).toHaveLength(6);
  expect(
    control(shelf, "button", "Use template Two-column report"),
  ).toBeInTheDocument();
  expect(editor).toHaveTextContent("Prepare the invoice for my client.");
  expect(composerInlineTemplates()[0]).toHaveTextContent("Itemized invoice");
  expect(capture.sentMessages).toHaveLength(0);
  click(control(shelf, "button", "More templates"));
  const dialog = await screen.findByRole("dialog");
  expect(control(dialog, "button", "Reports")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(within(dialog).getAllByLabelText(/^Preview /u)).toHaveLength(6);
  await user.keyboard("{Escape}");
  click(control(document.body, "button", "Remove Document"));
  await screen.findByRole("group", { name: "Choose a task" });
  expect(editor).toHaveTextContent("Prepare the invoice for my client.");
  expect(composerInlineTemplates()[0]).toHaveTextContent("Itemized invoice");
});

test("Slash Document opens its picker with the keyboard", async () => {
  const { user, capture } = await setup();
  const editor = await findComposerEditor();
  await fill(editor, "Keep this draft /doc");
  const menu = await screen.findByTestId("slash-workflow-menu");
  expect(control(menu, "button", "Document")).toBeInTheDocument();
  await user.keyboard("{ArrowDown}{Enter}");
  const dialog = await screen.findByRole("dialog");
  expect(control(dialog, "tab", "Document")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(editor).toHaveTextContent("Keep this draft");
  expect(editor).not.toHaveTextContent("/doc");
  await user.keyboard("{Escape}");
  expect(
    control(document.body, "button", "Remove Document"),
  ).toBeInTheDocument();
  expect(capture.sentMessages).toHaveLength(0);
});

test("A slash document cover attaches its template and keeps the draft", async () => {
  const { user, capture } = await setup();
  const editor = await findComposerEditor();
  await fill(editor, "Keep this draft /doc");
  const menu = await screen.findByTestId("slash-workflow-menu");
  await user.hover(control(menu, "button", "Document"));
  const previews = await within(menu).findByRole("region", {
    name: "Document",
  });
  click(control(previews, "button", "Use template Itemized invoice"));
  expect(editor).toHaveTextContent("Keep this draft");
  expect(editor).not.toHaveTextContent("/doc");
  expect(composerInlineTemplates()[0]).toHaveTextContent("Itemized invoice");
  expect(
    control(document.body, "button", "Remove Document"),
  ).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(capture.sentMessages).toHaveLength(0);
});

test("Document sends its creation intent and keeps its task chip in the new thread", async () => {
  const { capture } = await setup();
  const editor = await findComposerEditor();
  click(
    control(
      screen.getByRole("group", { name: "Choose a task" }),
      "button",
      "Document",
    ),
  );
  await fill(editor, "Prepare a project brief.");
  click(control(document.body, "button", "Send"));
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(capture.runPrompts).toStrictEqual(["Prepare a project brief."]);
  expect(capture.sentMessages[0]?.parts).toContainEqual({
    type: "additional_info",
    text: "Create a document.",
  });
  await findComposerEditor();
  expect(
    control(document.body, "button", "Remove Document"),
  ).toBeInTheDocument();
});

test("Document failed preview pages can be retried", async () => {
  const { user } = await setup();
  const dialog = await openTemplatePicker(user);
  click(control(dialog, "tab", "Document"));
  click(control(dialog, "button", "Preview Simple invoice"));
  fireEvent.error(within(dialog).getByAltText("Page 1"));
  expect(within(dialog).getByText("Preview unavailable")).toBeVisible();
  click(control(dialog, "button", "Retry"));
  expect(within(dialog).getByAltText("Page 1")).toBeInTheDocument();
});

test("Document preview pages navigate, reset on reopen, and can be selected from details", async () => {
  const { user, capture } = await setup();
  const dialog = await openTemplatePicker(user);
  click(control(dialog, "tab", "Document"));
  click(control(dialog, "button", "Preview Mutual NDA"));
  expect(control(dialog, "button", "Document")).toHaveFocus();
  expect(control(dialog, "button", "Previous sample page")).toBeDisabled();
  const firstPage = within(dialog).getByAltText("Page 1");
  const firstUrl = firstPage.getAttribute("src");
  expect(control(dialog, "link", "Open larger preview")).toHaveAttribute(
    "href",
    firstUrl,
  );
  click(control(dialog, "button", "Next sample page"));
  const secondUrl = within(dialog).getByAltText("Page 2").getAttribute("src");
  expect(secondUrl).not.toBe(firstUrl);
  expect(control(dialog, "button", "Next sample page")).toBeDisabled();
  expect(control(dialog, "link", "Open larger preview")).toHaveAttribute(
    "href",
    secondUrl,
  );
  click(control(dialog, "button", "Previous sample page"));
  expect(within(dialog).getByAltText("Page 1")).toHaveAttribute(
    "src",
    firstUrl,
  );
  click(control(dialog, "button", "Next sample page"));
  click(control(dialog, "button", "Document"));
  click(control(dialog, "button", "Preview Mutual NDA"));
  expect(within(dialog).getByAltText("Page 1")).toHaveAttribute(
    "src",
    firstUrl,
  );
  click(control(dialog, "button", "Document"));
  click(control(dialog, "button", "Preview Simple invoice"));
  // A single sample page has nowhere to page to, so it shows no arrows.
  expect(
    within(dialog).queryByLabelText("Next sample page"),
  ).not.toBeInTheDocument();
  click(control(dialog, "button", "Use this template"));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(composerInlineTemplates()[0]).toHaveTextContent("Simple invoice");
  expect(capture.sentMessages).toHaveLength(0);
});
