import { testContext } from "../../../signals/__tests__/test-helpers.ts";
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
  openTemplateRecommendations,
  createTemplateGalleryHelpers,
} from "./chat-composer-template-gallery-test-helpers.ts";
import {
  composerInlineTemplates,
  findComposerEditor,
} from "./chat-composer-test-helpers.ts";

const context = testContext();
const { mockTemplateChat } = createTemplateGalleryHelpers(context);

function control(
  container: ParentNode,
  role: "button" | "link",
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

async function setup(draft = "Keep this draft") {
  const capture = mockTemplateChat();
  const user = userEvent.setup({ delay: null });
  await setupPage({ context, path: "/" });
  const editor = await findComposerEditor();
  await fill(editor, draft);
  const shelf = await openTemplateRecommendations("Document");
  return { user, capture, editor, shelf };
}

async function preview(shelf: HTMLElement, title: string) {
  await userEvent.click(control(shelf, "button", `Preview template ${title}`));
  const heading = await screen.findByRole("heading", {
    name: `Document / ${title}`,
  });
  const dialog = heading.closest<HTMLElement>('[role="dialog"]');
  if (!dialog) {
    throw new Error(`Expected document detail for ${title}`);
  }
  return dialog;
}

test("Using a document recommendation preserves the draft until the user sends it", async () => {
  const { user, capture, editor, shelf } = await setup(
    "Explain this proposal to my client.",
  );
  click(control(shelf, "button", "Use template Sidebar report"));
  await waitFor(() => {
    expect(composerInlineTemplates()[0]).toHaveTextContent("Sidebar report");
  });
  expect(editor).toHaveTextContent("Explain this proposal to my client.");
  expect(
    control(document.body, "button", "Remove Document"),
  ).toBeInTheDocument();
  expect(capture.sentMessages).toHaveLength(0);
  click(editor);
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

test("Meeting notes can be previewed and attached without sending the draft", async () => {
  const { capture, editor, shelf } = await setup(
    "Summarize these meeting notes.",
  );
  const dialog = await preview(shelf, "Meeting notes");
  const pageUrl = within(dialog).getByAltText("Page 1").getAttribute("src");
  expect(pageUrl).toContain("/document-meeting-notes/page-01.png");
  expect(control(dialog, "link", "Open larger preview")).toHaveAttribute(
    "href",
    pageUrl,
  );
  expect(
    within(dialog).queryByLabelText("Next sample page"),
  ).not.toBeInTheDocument();
  click(control(dialog, "button", "Use this template"));
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
    expect(composerInlineTemplates()[0]).toHaveTextContent("Meeting notes");
  });
  expect(editor).toHaveTextContent("Summarize these meeting notes.");
  expect(capture.sentMessages).toHaveLength(0);
  click(control(document.body, "button", "Send"));
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(capture.sentMessages[0]?.parts).toContainEqual({
    type: "template",
    titleSnapshot: "Meeting notes",
    template: {
      type: "document",
      selection: { documentTemplateId: "document-template:meeting-notes" },
    },
  });
});

test("A Document tray cover attaches its template and keeps the draft", async () => {
  const { capture, editor, shelf } = await setup();
  click(control(shelf, "button", "Use template Itemized invoice"));
  await waitFor(() => {
    expect(composerInlineTemplates()[0]).toHaveTextContent("Itemized invoice");
  });
  expect(editor).toHaveTextContent("Keep this draft");
  expect(
    control(document.body, "button", "Remove Document"),
  ).toBeInTheDocument();
  expect(capture.sentMessages).toHaveLength(0);
});

test("Document sends its creation intent and keeps its task chip in the new thread", async () => {
  const { capture } = await setup("Prepare a project brief.");
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

test("Document preview pages display unavailable images", async () => {
  const { shelf } = await setup();
  const dialog = await preview(shelf, "Simple invoice");
  fireEvent.error(within(dialog).getByAltText("Page 1"));
  expect(within(dialog).getByText("Preview unavailable")).toBeInTheDocument();
});

test("Document details navigate sample pages and reopen from the Eye at the first page", async () => {
  const { user, capture, editor, shelf } = await setup();
  const eye = control(shelf, "button", "Preview template Mutual NDA");
  const dialog = await preview(shelf, "Mutual NDA");
  expect(control(dialog, "button", "Document")).toHaveFocus();
  expect(control(dialog, "button", "Previous sample page")).toBeDisabled();
  const firstUrl = within(dialog).getByAltText("Page 1").getAttribute("src");
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
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
    expect(eye).toHaveFocus();
  });
  const reopened = await preview(shelf, "Mutual NDA");
  expect(within(reopened).getByAltText("Page 1")).toHaveAttribute(
    "src",
    firstUrl,
  );
  click(control(reopened, "button", "Use this template"));
  await waitFor(() => {
    expect(reopened).not.toBeInTheDocument();
    expect(composerInlineTemplates()[0]).toHaveTextContent("Mutual NDA");
  });
  expect(editor).toHaveTextContent("Keep this draft");
  expect(capture.sentMessages).toHaveLength(0);
});
