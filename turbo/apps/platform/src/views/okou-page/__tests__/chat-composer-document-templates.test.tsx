import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { getNamedButton } from "./chat-attachment-test-helpers.ts";
import { clickComposerAddMenuItem } from "./chat-composer-add-menu-test-helpers.ts";
import { findComposerEditor, tabByText } from "./chat-composer-test-helpers.ts";
import {
  AGENT_ID,
  createTemplateGalleryHelpers,
  expectInlineTemplate,
} from "./chat-composer-template-gallery-test-helpers.ts";

const context = testContext();
const { mockTemplateChat } = createTemplateGalleryHelpers(context);

async function draft(text: string, path = `/agents/${AGENT_ID}/chat`) {
  const chat = mockTemplateChat();
  await setupPage({ context, path });
  const editor = await findComposerEditor();
  await fill(editor, text);
  return { chat, editor };
}

async function documentPicker() {
  await clickComposerAddMenuItem("Template");
  const picker = await screen.findByRole("dialog");
  click(tabByText("Document"));
  return within(picker);
}

test("chat-composer-document-templates-001 returns from an invoice preview to the same place in the filtered catalog", async () => {
  const brief = "Prepare the invoice for my client.";
  const { editor } = await draft(brief);
  const picker = await documentPicker();
  click(picker.getByText("Invoice", { selector: "button" }));
  const preview = picker.getByLabelText("Preview Simple invoice");
  const scrollArea = preview.closest<HTMLElement>(
    "[data-document-template-grid-scroll]",
  )!;
  fireEvent.scroll(scrollArea, { target: { scrollTop: 120 } });
  click(preview);
  await expect(
    picker.findByText("Open larger preview"),
  ).resolves.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");

  const returned = await picker.findByLabelText("Preview Simple invoice");
  await waitFor(() => {
    expect(returned).toHaveFocus();
  });
  expect(tabByText("Document")).toHaveAttribute("aria-selected", "true");
  expect(picker.getByText("Invoice", { selector: "button" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(picker.getAllByLabelText(/^Preview /)).toHaveLength(7);
  expect(
    returned.closest("[data-document-template-grid-scroll]"),
  ).toHaveProperty("scrollTop", 120);
  expect(within(editor).getByText(brief, { exact: true })).toBeInTheDocument();
  expect(document.querySelector("[data-role='user']")).not.toBeInTheDocument();
});

test("chat-composer-document-templates-002 sends Sidebar report with the existing brief only after submission", async () => {
  const brief = "Explain this proposal to my client.";
  const { chat, editor } = await draft(brief);
  const picker = await documentPicker();
  click(picker.getByLabelText("Use Sidebar report"));
  await expectInlineTemplate("Sidebar report");
  expect(within(editor).getByText(brief, { exact: true })).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(document.querySelector("[data-role='user']")).not.toBeInTheDocument();

  click(getNamedButton("Send"));
  const delivered = await screen.findAllByText(brief, {
    selector: "[data-role='user'] *",
  });
  expect(delivered).toHaveLength(1);
  await waitFor(() => {
    expect(chat.sentMessages.at(-1)?.parts).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining(brief),
        }),
        expect.objectContaining({
          type: "template",
          template: {
            type: "document",
            selection: {
              documentTemplateId: "document-template:sidebar-report",
            },
          },
        }),
      ]),
    );
  });
});

async function openDocumentTray() {
  const { editor } = await draft("Keep this draft", "/");
  const create = await screen.findByRole("region", { name: "Create" });
  click(getNamedButton("Document", create));
  return editor;
}

test("chat-composer-document-templates-004 browses Document by keyboard and returns to its draft", async () => {
  const editor = await openDocumentTray();
  const browse = await screen.findByText("View all", { selector: "button" });
  browse.focus();
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("dialog");
  expect(tabByText("Document")).toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(screen.getByLabelText("Remove Document")).toBeInTheDocument();
  expect(
    within(editor).getByText("Keep this draft", { exact: true }),
  ).toBeInTheDocument();
  expect(document.querySelector("[data-role='user']")).not.toBeInTheDocument();
});

test("chat-composer-document-templates-005 attaches Itemized invoice directly from the tray", async () => {
  const editor = await openDocumentTray();
  click(await screen.findByLabelText("Use template Itemized invoice"));
  const attachment = await expectInlineTemplate("Itemized invoice");
  expect(editor).toContainElement(attachment);
  expect(
    within(editor).getByText("Keep this draft", { exact: true }),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("Remove Document")).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(document.querySelector("[data-role='user']")).not.toBeInTheDocument();
});
