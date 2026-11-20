import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core/presentation-template-items";
import {
  userTemplatesContract,
  type UserTemplateDetail,
} from "@okouai/api-contracts/contracts/user-templates";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  composerInlineTemplates,
  findComposerEditor,
} from "./chat-composer-test-helpers.ts";
import {
  AGENT_ID,
  createTemplateGalleryHelpers,
  templatePart,
} from "./chat-composer-template-gallery-test-helpers.ts";

const context = testContext();
const { mockTemplateChat, mockPresentationHtml } =
  createTemplateGalleryHelpers(context);
const presentation = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;

const DRAFT = "Keep my quarterly launch brief.";
type CustomKind = "presentation" | "document";

function control(
  role: "button" | "tab" | "link" | "radio",
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const found = queryAllByRoleFast(role, container).find((element) => {
    return (
      element.getAttribute("aria-label") === name ||
      element.textContent?.trim() === name
    );
  });
  if (!found) {
    throw new Error(`Expected ${role} named ${name}`);
  }
  return found;
}

async function openTray(task: "Presentation" | "Document") {
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    host: "app.okou.ai",
  });
  const editor = await findComposerEditor();
  await fill(editor, DRAFT);
  const create = within(
    screen.getByRole("group", { name: "Explore Okou capabilities" }),
  ).getByRole("region", { name: "Create" });
  click(control("button", "Presentation", create));
  const types = await screen.findByRole("radiogroup", { name: "Create" });
  click(control("radio", task, types));
  const shelf = await screen.findByRole("group", {
    name: `${task} templates`,
  });
  return { editor, shelf, tray: screen.getByRole("tabpanel") };
}

function dialogAround(content: HTMLElement): HTMLElement {
  const dialog = content.closest<HTMLElement>('[role="dialog"]');
  if (!dialog) {
    throw new Error("Expected template details in a dialog");
  }
  return dialog;
}

async function expectDismissed(eye: HTMLElement) {
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(eye).toHaveFocus();
  });
  expect(composerInlineTemplates()).toHaveLength(0);
}

function mockCustomTemplate(
  kind: CustomKind,
  deleteFails: () => boolean = () => {
    return false;
  },
): UserTemplateDetail {
  let deleted = false;
  const detail: UserTemplateDetail = {
    id:
      kind === "presentation"
        ? "11111111-1111-4111-8111-111111111111"
        : "33333333-3333-4333-8333-333333333333",
    kind,
    title: `My ${kind} template`,
    sourceFilename: `source-${kind}.${kind === "presentation" ? "pptx" : "docx"}`,
    sourceUrl: `https://example.test/source-${kind}?signature=fixture`,
    coverUrl: `https://example.test/${kind}-cover.png`,
    coverHasMorePages: kind === "presentation",
    pageCount: kind === "presentation" ? 2 : null,
    pageUrls:
      kind === "presentation"
        ? ["https://example.test/page-1.png", "https://example.test/page-2.png"]
        : [],
    previewAssets: [],
    visibility: "private",
    ownerUserId: "user_self",
    ownerDisplayName: "Dana Self",
    canManage: true,
    createdAt: "2026-01-02T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
  };
  const { pageUrls: _pageUrls, sourceUrl: _sourceUrl, ...entry } = detail;
  context.mocks.api(userTemplatesContract.list, ({ respond }) => {
    return respond(200, deleted ? [] : [entry]);
  });
  context.mocks.api(userTemplatesContract.get, ({ respond }) => {
    return respond(200, detail);
  });
  context.mocks.api(userTemplatesContract.delete, ({ respond }) => {
    if (deleteFails()) {
      return respond(500, {
        error: { code: "INTERNAL_SERVER_ERROR", message: "Delete failed" },
      });
    }
    deleted = true;
    return respond(204);
  });
  return detail;
}

async function customDetail(kind: CustomKind): Promise<HTMLElement> {
  const content =
    kind === "presentation"
      ? await screen.findByAltText("Page 1")
      : await screen.findByTitle("source-document.docx preview");
  return dialogAround(content);
}

test("A presentation recommendation previews slides and a theme before attaching it", async () => {
  const capture = mockTemplateChat();
  mockPresentationHtml(presentation.embedUrl, ["One", "Two", "Three"]);
  const { editor, shelf } = await openTray("Presentation");
  const user = userEvent.setup({ delay: null });
  const eye = control(
    "button",
    `Preview template ${presentation.title}`,
    shelf,
  );
  await user.hover(control("button", presentation.title, shelf));
  await user.click(eye);
  const stage = await screen.findByRole("group", {
    name: `${presentation.title} slide preview`,
  });
  const dialog = dialogAround(stage);
  await within(stage).findByText("1 / 3");
  click(control("button", "Preview next slide", dialog));
  expect(within(stage).getByText("2 / 3")).toBeInTheDocument();
  expect(control("button", "Preview slide 2", dialog)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  click(control("button", "Select style Deep dive", dialog));
  expect(control("button", "Select style Deep dive", dialog)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(within(stage).getByText("2 / 3")).toBeInTheDocument();
  expect(composerInlineTemplates()).toHaveLength(0);
  expect(editor).toHaveTextContent(DRAFT);
  click(control("button", `Select template ${presentation.title}`, dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(composerInlineTemplates()).toHaveLength(1);
  });
  expect(composerInlineTemplates()[0]).toHaveTextContent(presentation.title);
  expect(editor).toHaveTextContent(DRAFT);
  await waitFor(() => {
    expect(editor).toHaveFocus();
  });
  expect(capture.sentMessages).toHaveLength(0);
  click(control("button", "Send"));
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(templatePart(capture.sentMessages[0]!).template).toMatchObject({
    type: "presentation",
    selection: {
      templateId: presentation.templateId,
      colorSystemId: "color-system:ocean-deep",
    },
  });
});

test("Direct presentation dismissal restores the Eye while View all still returns to its gallery", async () => {
  const capture = mockTemplateChat();
  mockPresentationHtml(presentation.embedUrl, ["One", "Two"]);
  const { editor, shelf, tray } = await openTray("Presentation");
  const user = userEvent.setup({ delay: null });
  const eye = control(
    "button",
    `Preview template ${presentation.title}`,
    shelf,
  );
  for (const dismissal of ["Close", "Escape"]) {
    await user.click(eye);
    const stage = await screen.findByRole("group", {
      name: `${presentation.title} slide preview`,
    });
    await within(stage).findByText("1 / 2");
    const dialog = dialogAround(stage);
    const prefix = within(dialog).getByText("Template", { selector: "span" });
    expect(
      prefix.closest("button, a, [role='button'], [role='link']"),
    ).toBeNull();
    await user.click(prefix);
    expect(stage).toBeInTheDocument();
    if (dismissal === "Escape") {
      await user.keyboard("{Escape}");
    } else {
      await user.click(control("button", dismissal, dialog));
    }
    await expectDismissed(eye);
    expect(shelf).toBeInTheDocument();
    expect(editor).toHaveTextContent(DRAFT);
  }
  click(control("button", "View all", tray));
  const picker = await screen.findByRole("dialog");
  expect(control("tab", "Presentation", picker)).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const previewLabel = `Preview ${presentation.title} at current slide`;
  await user.click(control("button", previewLabel, picker));
  const stage = await screen.findByRole("group", {
    name: `${presentation.title} slide preview`,
  });
  await within(stage).findByText("1 / 2");
  const prefix = within(picker).getByText("Template", { selector: "span" });
  expect(
    prefix.closest("button, a, [role='button'], [role='link']"),
  ).toBeNull();
  await user.click(prefix);
  expect(stage).toBeInTheDocument();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(control("button", previewLabel, picker)).toHaveFocus();
  });
  expect(control("tab", "Presentation", picker)).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(editor).toHaveTextContent(DRAFT);
  expect(composerInlineTemplates()).toHaveLength(0);
  expect(capture.sentMessages).toHaveLength(0);
});

test("The recommendation Eye is keyboard reachable and opens with Enter and Space", async () => {
  mockTemplateChat();
  mockPresentationHtml(presentation.embedUrl, ["One", "Two"]);
  const { shelf } = await openTray("Presentation");
  const user = userEvent.setup({ delay: null });
  const eye = control(
    "button",
    `Preview template ${presentation.title}`,
    shelf,
  );
  control("button", presentation.title, shelf).focus();
  await user.keyboard("{Tab}");
  expect(eye).toHaveFocus();
  for (const key of ["{Enter}", " "]) {
    await user.keyboard(key);
    const stage = await screen.findByRole("group", {
      name: `${presentation.title} slide preview`,
    });
    await within(stage).findByText("1 / 2");
    expect(stage).toHaveFocus();
    await user.keyboard("{Escape}");
    await expectDismissed(eye);
  }
});

test("Pending custom deletion keeps its confirmation guarded and recovers after failure", async () => {
  const capture = mockTemplateChat();
  const detail = mockCustomTemplate("presentation");
  const release = context.mocks.deferred<void>();
  context.mocks.api(userTemplatesContract.delete, async ({ respond }) => {
    await release.promise;
    return respond(500, {
      error: { code: "INTERNAL_SERVER_ERROR", message: "Delete failed" },
    });
  });
  const { editor, shelf } = await openTray("Presentation");
  const user = userEvent.setup({ delay: null });
  const eye = await waitFor(() => {
    return control("button", `Preview template ${detail.title}`, shelf);
  });
  await user.click(eye);
  const preview = await customDetail("presentation");
  click(control("button", "Delete", preview));
  const confirmation = await screen.findByRole("dialog", {
    name: "Delete template?",
  });
  click(control("button", "Delete template", confirmation));
  const deleting = await waitFor(() => {
    return control("button", "Deleting...", confirmation);
  });
  expect(deleting).toBeDisabled();
  expect(control("button", "Cancel", confirmation)).toBeDisabled();
  await user.keyboard("{Escape}");
  expect(confirmation).toBeInTheDocument();
  expect(preview).toBeInTheDocument();
  await user.click(control("button", "Close", confirmation));
  expect(confirmation).toBeInTheDocument();
  expect(preview).toBeInTheDocument();
  release.resolve();
  await within(confirmation).findByText("Couldn't delete the template.");
  expect(control("button", "Delete template", confirmation)).toBeEnabled();
  expect(control("button", "Cancel", confirmation)).toBeEnabled();
  click(control("button", "Cancel", confirmation));
  await waitFor(() => {
    expect(confirmation).not.toBeInTheDocument();
  });
  expect(preview).toBeInTheDocument();
  expect(within(shelf).getByText(detail.title)).toBeInTheDocument();
  await user.keyboard("{Escape}");
  await expectDismissed(eye);
  expect(editor).toHaveTextContent(DRAFT);
  expect(capture.sentMessages).toHaveLength(0);
});

async function dismissCustomPresentation(
  dialog: HTMLElement,
  detail: UserTemplateDetail,
  user: ReturnType<typeof userEvent.setup>,
) {
  click(control("button", "Preview slide 2", dialog));
  expect(within(dialog).getByAltText("Page 2")).toHaveAttribute(
    "src",
    detail.pageUrls[1],
  );
  await user.keyboard("{Escape}");
}

test.each([
  {
    kind: "presentation" as "presentation" | "document",
    dismiss: dismissCustomPresentation,
  },
] as const)(
  "A custom $kind recommendation opens its existing detail, dismisses to the Eye and can be used",
  async ({ kind, dismiss }) => {
    const capture = mockTemplateChat();
    const detail = mockCustomTemplate(kind);
    const { editor, shelf, tray } = await openTray(
      kind === "presentation" ? "Presentation" : "Document",
    );
    await within(shelf).findByText(detail.title);
    if (kind === "document") {
      click(control("button", "View all", tray));
      const picker = await screen.findByRole("dialog");
      click(control("button", "Invoice", picker));
      click(control("button", "Close", picker));
      await screen.findByRole("group", { name: "Document templates" });
    }
    const user = userEvent.setup({ delay: null });
    const eye = control("button", `Preview template ${detail.title}`, shelf);
    await user.click(eye);
    const dialog = await customDetail(kind);
    expect(
      within(dialog).getByLabelText("Rename template"),
    ).toBeInTheDocument();
    await dismiss(dialog, detail, user);
    await expectDismissed(eye);
    expect(editor).toHaveTextContent(DRAFT);
    await user.click(eye);
    const reopened = await customDetail(kind);
    click(control("button", "Use this template", reopened));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(composerInlineTemplates()).toHaveLength(1);
    });
    expect(composerInlineTemplates()[0]).toHaveTextContent(detail.title);
    expect(editor).toHaveTextContent(DRAFT);
    expect(capture.sentMessages).toHaveLength(0);
    click(control("button", "Send"));
    await waitFor(() => {
      expect(capture.sentMessages).toHaveLength(1);
    });
    expect(templatePart(capture.sentMessages[0]!).template).toStrictEqual({
      type: "custom",
      selection: { userTemplateId: detail.id },
    });
  },
);
