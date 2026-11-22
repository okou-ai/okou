import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { WEBSITE_TEMPLATE_ITEMS } from "@okouai/core/website-template-items";
import { composerDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import type { ComposerDraft } from "@okouai/api-contracts/contracts/chat-threads";
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
  createTemplateGalleryHelpers,
  templatePart,
} from "./chat-composer-template-gallery-test-helpers.ts";

const context = testContext();
const { mockTemplateChat } = createTemplateGalleryHelpers(context);
const website = WEBSITE_TEMPLATE_ITEMS[0]!;
const DRAFT = "Keep my website launch brief.";
function originalDraft(): ComposerDraft {
  return {
    draftUserMessage: { version: 1, parts: [{ type: "text", text: DRAFT }] },
    draftAttachments: null,
  };
}

function control(
  role: "button" | "tab",
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const found = queryAllByRoleFast(role, container).find((element) => {
    return (
      element.getAttribute("aria-label") === name ||
      element.textContent?.replace(/\s+/gu, " ").trim() === name
    );
  });
  if (!found) {
    throw new Error(`Expected ${role} named ${name}`);
  }
  return found;
}

async function openShelf() {
  const capture = mockTemplateChat();
  let savedDraft = originalDraft();
  context.mocks.api(composerDraftContract.get, ({ respond }) => {
    return respond(200, savedDraft);
  });
  context.mocks.api(composerDraftContract.patch, ({ body, respond }) => {
    savedDraft = {
      draftUserMessage: body.draftUserMessage,
      draftAttachments: body.draftAttachments ?? null,
    };
    return respond(204);
  });
  await setupPage({
    context,
    path: `/`,
    host: "app.okou.ai",
  });
  const editor = await findComposerEditor();
  await waitFor(() => {
    expect(editor).toHaveTextContent(DRAFT);
  });
  const create = within(
    screen.getByRole("group", { name: "Explore Okou capabilities" }),
  ).getByRole("region", { name: "Create" });
  click(control("button", "Website", create));
  const shelf = await screen.findByRole("group", { name: "Website templates" });
  const eye = control("button", `Preview template ${website.title}`, shelf);
  const browse = control("button", "View all", screen.getByRole("tabpanel"));
  return {
    editor,
    shelf,
    eye,
    browse,
    capture,
    readDraft: () => {
      return savedDraft;
    },
  };
}

async function websitePreview() {
  const frame = await screen.findByTitle(
    `${website.title} website full preview`,
  );
  const dialog = frame.closest<HTMLElement>('[role="dialog"]');
  if (!dialog) {
    throw new Error("Expected website preview dialog");
  }
  expect(frame).toHaveAttribute("src", website.previewUrl);
  expect(frame).toHaveAttribute("sandbox", "allow-same-origin allow-scripts");
  const heading = within(dialog).getByRole("heading");
  expect(heading).toHaveTextContent(
    new RegExp(`Website\\s*/\\s*${website.title}`),
  );
  const prefix = within(heading).getByText("Website");
  expect(
    prefix.closest("button, a, [role='button'], [role='link']"),
  ).toBeNull();
  return { frame, dialog, prefix };
}

async function expectShelfReturn(eye: HTMLElement) {
  await waitFor(() => {
    expect(eye).toHaveFocus();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(composerInlineTemplates()).toHaveLength(0);
}

test("Website recommendation dismissal returns to its Eye without changing the draft", async () => {
  const { editor, shelf, eye, capture, readDraft } = await openShelf();
  // Exercise real pointer focus: closing both dialogs must restore the Eye,
  // not the hidden parent gallery or the template selection button.
  const user = userEvent.setup({ delay: null });
  for (const dismissal of ["Close", "Escape"]) {
    await user.click(eye);
    const { dialog, frame, prefix } = await websitePreview();
    await user.click(prefix);
    expect(frame).toBeInTheDocument();
    expect(composerInlineTemplates()).toHaveLength(0);
    expect(editor).toHaveTextContent(DRAFT);
    expect(capture.sentMessages).toHaveLength(0);
    expect(readDraft()).toStrictEqual(originalDraft());
    if (dismissal === "Escape") {
      await user.keyboard("{Escape}");
    } else {
      click(control("button", dismissal, dialog));
    }
    await expectShelfReturn(eye);
    expect(shelf).toBeInTheDocument();
    expect(editor).toHaveTextContent(DRAFT);
    expect(readDraft()).toStrictEqual(originalDraft());
    expect(capture.sentMessages).toHaveLength(0);
  }
});

test("The Website Eye is Tab reachable and Enter/Space preview without selecting", async () => {
  const { eye, shelf, editor, capture, readDraft } = await openShelf();
  const user = userEvent.setup({ delay: null });
  control("button", `Use template ${website.title}`, shelf).focus();
  await user.keyboard("{Tab}");
  expect(eye).toHaveFocus();
  for (const key of ["{Enter}", " "]) {
    await user.keyboard(key);
    await websitePreview();
    expect(composerInlineTemplates()).toHaveLength(0);
    expect(editor).toHaveTextContent(DRAFT);
    await user.keyboard("{Escape}");
    await expectShelfReturn(eye);
  }
  expect(readDraft()).toStrictEqual(originalDraft());
  expect(capture.sentMessages).toHaveLength(0);
});

test("Selecting the original Website cover after preview attaches and serializes that website", async () => {
  const { eye, shelf, editor, capture } = await openShelf();
  const user = userEvent.setup({ delay: null });
  const prompt = "Build this launch site and keep the draft text.";
  await fill(editor, prompt);
  await user.click(eye);
  const { dialog } = await websitePreview();
  click(control("button", "Close", dialog));
  await expectShelfReturn(eye);
  click(control("button", `Use template ${website.title}`, shelf));
  await waitFor(() => {
    expect(composerInlineTemplates()).toHaveLength(1);
  });
  expect(composerInlineTemplates()[0]).toHaveTextContent(website.title);
  expect(editor).toHaveTextContent(prompt);
  expect(capture.sentMessages).toHaveLength(0);
  click(control("button", "Send"));
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(templatePart(capture.sentMessages[0]!).template).toStrictEqual({
    type: "website",
    selection: { websiteTemplateId: website.id },
  });
  expect(capture.sentMessages[0]!.parts).toContainEqual({
    type: "text",
    text: prompt,
  });
});

test("View all resets direct Website preview dismissal to the normal gallery", async () => {
  const { eye, browse, editor, capture, readDraft } = await openShelf();
  const user = userEvent.setup({ delay: null });
  await user.click(eye);
  const direct = await websitePreview();
  const directSrc = direct.frame.getAttribute("src");
  const directSandbox = direct.frame.getAttribute("sandbox");
  click(control("button", "Close", direct.dialog));
  await expectShelfReturn(eye);
  click(browse);
  const picker = await screen.findByRole("dialog");
  expect(control("tab", "Website", picker)).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const galleryEyeLabel = `Preview website template ${website.title}`;
  for (const dismissal of ["Close", "Escape"]) {
    await user.click(control("button", galleryEyeLabel, picker));
    const nested = await websitePreview();
    await user.click(nested.prefix);
    expect(nested.frame).toBeInTheDocument();
    expect(nested.frame).toHaveAttribute("src", directSrc);
    expect(nested.frame).toHaveAttribute("sandbox", directSandbox);
    if (dismissal === "Escape") {
      await user.keyboard("{Escape}");
    } else {
      click(control("button", dismissal, nested.dialog));
    }
    await waitFor(() => {
      expect(nested.dialog).not.toBeInTheDocument();
      expect(control("button", galleryEyeLabel, picker)).toHaveFocus();
    });
    expect(picker).toBeVisible();
    expect(control("tab", "Website", picker)).toHaveAttribute(
      "aria-selected",
      "true",
    );
  }
  expect(editor).toHaveTextContent(DRAFT);
  expect(composerInlineTemplates()).toHaveLength(0);
  expect(readDraft()).toStrictEqual(originalDraft());
  expect(capture.sentMessages).toHaveLength(0);
});
