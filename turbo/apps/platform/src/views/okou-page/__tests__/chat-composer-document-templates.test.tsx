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
  context,
  mockTemplateChat,
  openTemplatePicker,
} from "./chat-composer-template-gallery-test-helpers.ts";
import {
  composerInlineTemplates,
  findComposerEditor,
} from "./chat-composer-test-helpers.ts";

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

async function setup(enabled = true) {
  const capture = mockTemplateChat();
  const user = userEvent.setup({ delay: null });
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.CustomTemplates]: false,
      [FeatureSwitchKey.BuiltinDocumentTemplates]: enabled,
    },
  });
  return { user, capture };
}

test("Document remains hidden when its rollout switch is off", async () => {
  const { user } = await setup(false);
  const dialog = await openTemplatePicker(user);
  expect(
    queryAllByRoleFast("tab", dialog).map((tab) => {
      return tab.textContent;
    }),
  ).not.toContain("Document");
});

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
  expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
  expect(within(dialog).getAllByLabelText(/^Preview /u)).toHaveLength(45);
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
  await fill(await findComposerEditor(), "Prepare the invoice for my client.");
  const dialog = await openTemplatePicker(user);
  click(control(dialog, "tab", "Document"));
  click(control(dialog, "button", "Use Simple invoice"));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  const preservedEditor = await findComposerEditor();
  expect(preservedEditor).toHaveTextContent(
    "Prepare the invoice for my client.",
  );
  expect(composerInlineTemplates()).toHaveLength(1);
  expect(composerInlineTemplates()[0]).toHaveTextContent("Simple invoice");
  expect(capture.sentMessages).toHaveLength(0);
  click(await findComposerEditor());
  await user.keyboard("{Enter}");
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(capture.sentMessages[0]?.parts).toContainEqual({
    type: "template",
    titleSnapshot: "Simple invoice",
    template: {
      type: "document",
      selection: { documentTemplateId: "document-template:simple-invoice" },
    },
  });
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
  expect(control(dialog, "button", "Back to templates")).toHaveFocus();
  expect(control(dialog, "button", "Previous sample page")).toBeDisabled();
  const firstPage = within(dialog).getByAltText("Page 1");
  const firstUrl = firstPage.getAttribute("src");
  expect(control(dialog, "link", "Open larger preview")).toHaveAttribute(
    "href",
    firstUrl,
  );
  click(control(dialog, "button", "Next sample page"));
  expect(firstPage).not.toBeInTheDocument();
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
  click(control(dialog, "button", "Back to templates"));
  click(control(dialog, "button", "Preview Mutual NDA"));
  expect(within(dialog).getByAltText("Page 1")).toHaveAttribute(
    "src",
    firstUrl,
  );
  click(control(dialog, "button", "Back to templates"));
  click(control(dialog, "button", "Preview Simple invoice"));
  expect(control(dialog, "button", "Previous sample page")).toBeDisabled();
  expect(control(dialog, "button", "Next sample page")).toBeDisabled();
  click(control(dialog, "button", "Use template"));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(composerInlineTemplates()[0]).toHaveTextContent("Simple invoice");
  expect(capture.sentMessages).toHaveLength(0);
});
