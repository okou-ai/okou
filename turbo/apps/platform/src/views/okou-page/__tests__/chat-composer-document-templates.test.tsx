import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  AGENT_ID,
  createTemplateGalleryHelpers,
  openTemplatePicker,
} from "./chat-composer-template-gallery-test-helpers.ts";
import {
  composerInlineTemplates,
  findComposerEditor,
} from "./chat-composer-test-helpers.ts";

const context = testContext();
const { mockTemplateChat } = createTemplateGalleryHelpers(context);

function control(
  container: HTMLElement,
  role: "tab" | "button" | "radio",
  name: string,
): HTMLElement {
  const result = queryAllByRoleFast(role, container).find((element) => {
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

async function openDraft(draft: string) {
  const capture = mockTemplateChat();
  const user = userEvent.setup({ delay: null });
  await setupPage({ context, path: `/agents/${AGENT_ID}/chat` });
  const editor = await findComposerEditor();
  await fill(editor, draft);
  return { capture, user, editor };
}

async function openDocumentTray(): Promise<HTMLElement> {
  const cards = await screen.findByRole("group", {
    name: "Explore Okou capabilities",
  });
  const create = within(cards).getByRole("region", { name: "Create" });
  click(control(create, "button", "Presentation"));
  const types = await screen.findByRole("radiogroup", { name: "Create" });
  click(control(types, "radio", "Document"));
  return await screen.findByRole("group", { name: "Document templates" });
}

function documentGrid(dialog: HTMLElement): HTMLElement {
  const grid = dialog.querySelector<HTMLElement>(
    "[data-document-template-grid-scroll]",
  );
  if (!grid) {
    throw new Error("Document grid not found");
  }
  return grid;
}

test("Document category and scroll survive preview", async () => {
  const draft = "Prepare the invoice for my client.";
  const { capture, user } = await openDraft(draft);
  const dialog = await openTemplatePicker(user);
  click(control(dialog, "tab", "Document"));
  click(control(dialog, "button", "Invoice"));
  expect(within(dialog).getAllByLabelText(/^Preview /u)).toHaveLength(7);
  const grid = documentGrid(dialog);
  grid.scrollTop = 120;
  fireEvent.scroll(grid);

  click(control(dialog, "button", "Preview Simple invoice"));
  expect(
    within(dialog).getByRole("heading", {
      name: "Document / Simple invoice",
      level: 2,
    }),
  ).toBeVisible();
  await user.keyboard("{Escape}");

  expect(control(dialog, "tab", "Document")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(control(dialog, "button", "Invoice")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(within(dialog).getAllByLabelText(/^Preview /u)).toHaveLength(7);
  expect(documentGrid(dialog).scrollTop).toBe(120);
  expect(control(dialog, "button", "Preview Simple invoice")).toHaveFocus();
  await expect(findComposerEditor()).resolves.toHaveProperty(
    "textContent",
    draft,
  );
  expect(capture.sentMessages).toHaveLength(0);
});

test("Using a document template preserves the draft until the user sends it", async () => {
  const draft = "Explain this proposal to my client.";
  const { capture, user } = await openDraft(draft);
  const dialog = await openTemplatePicker(user);
  click(control(dialog, "tab", "Document"));

  click(control(dialog, "button", "Use Sidebar report"));

  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  await expect(findComposerEditor()).resolves.toHaveTextContent(draft);
  expect(composerInlineTemplates()).toHaveLength(1);
  expect(composerInlineTemplates()[0]).toHaveTextContent("Sidebar report");
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

test("The Document tray opens its picker with the keyboard", async () => {
  const { capture, user, editor } = await openDraft("Keep this draft");
  await openDocumentTray();

  control(screen.getByRole("tabpanel"), "button", "View all").focus();
  await user.keyboard("{Enter}");
  const dialog = await screen.findByRole("dialog");
  expect(control(dialog, "tab", "Document")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await user.keyboard("{Escape}");

  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(editor).toHaveTextContent("Keep this draft");
  expect(
    control(document.body, "button", "Remove Document"),
  ).toBeInTheDocument();
  expect(capture.sentMessages).toHaveLength(0);
});

test("A Document tray cover attaches its template and keeps the draft", async () => {
  const { capture, editor } = await openDraft("Keep this draft");
  const shelf = await openDocumentTray();

  click(control(shelf, "button", "Use template Itemized invoice"));

  await waitFor(() => {
    expect(composerInlineTemplates()[0]).toHaveTextContent("Itemized invoice");
  });
  expect(editor).toHaveTextContent("Keep this draft");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(
    control(document.body, "button", "Remove Document"),
  ).toBeInTheDocument();
  expect(capture.sentMessages).toHaveLength(0);
});
