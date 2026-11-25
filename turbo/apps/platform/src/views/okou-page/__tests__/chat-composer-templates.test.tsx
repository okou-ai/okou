import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { getNamedButton } from "./chat-attachment-test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import {
  openTemplateRecommendations,
  createTemplateGalleryHelpers,
  expectInlineTemplate,
  sendComposerMessage,
  templatePart,
} from "./chat-composer-template-gallery-test-helpers.ts";
import { userTemplatesContract } from "@okouai/api-contracts/contracts/user-templates";
import { WEBSITE_TEMPLATE_ITEMS } from "@okouai/core/website-template-items";

const context = testContext();

const { mockTemplateChat } = createTemplateGalleryHelpers(context);

async function draft(text: string, path = "/") {
  const chat = mockTemplateChat();
  await setupPage({ context, path });
  const editor = await findComposerEditor();
  await fill(editor, text);
  return { chat, editor };
}

async function documentPicker() {
  return within(await openTemplateRecommendations("Document"));
}

test("chat-composer-document-templates-002 sends Sidebar report with the existing brief only after submission", async () => {
  const brief = "Explain this proposal to my client.";
  const { chat, editor } = await draft(brief);
  const picker = await documentPicker();
  click(picker.getByLabelText("Use template Sidebar report"));
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

test("chat-composer-document-templates-004 opens the document recommendation preview by keyboard and returns to its draft", async () => {
  const editor = await openDocumentTray();
  const eye = await screen.findByLabelText("Preview template Itemized invoice");
  eye.focus();
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("dialog");
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

test("Select and send a website template", async () => {
  const chat = mockTemplateChat();
  context.mocks.api(userTemplatesContract.list, ({ respond }) => {
    return respond(200, []);
  });
  const website = WEBSITE_TEMPLATE_ITEMS[1];
  if (!website) {
    throw new Error("Expected a built-in website template");
  }
  await setupPage({
    context,
    path: "/",
  });
  const picker = await openTemplateRecommendations("Website");
  const user = userEvent.setup({ delay: null });

  click(within(picker).getByLabelText(`Use template ${website.title}`));

  await expectInlineTemplate(website.title);
  await sendComposerMessage(user, "Build this launch site");
  const sent = await waitFor(() => {
    const message = chat.sentMessages.at(-1);
    expect(message).toBeDefined();
    return message;
  });
  expect(sent && templatePart(sent).template).toStrictEqual({
    type: "website",
    selection: { websiteTemplateId: website.id },
  });
  expect(
    sent?.parts.some((part) => {
      return (
        part.type === "text" && part.text.includes("Build this launch site")
      );
    }),
  ).toBeTruthy();
});

test("chat-composer-template-tabs-001 picks a built-in deck while the custom catalog is pending", async () => {
  mockTemplateChat();
  const started = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  context.mocks.api(userTemplatesContract.list, async ({ respond }) => {
    started.resolve();
    await release.promise;
    return respond(200, []);
  });
  try {
    await setupPage({ context, path: "/" });
    const shelf = await openTemplateRecommendations("Presentation");
    await started.promise;
    const deck = await within(shelf).findByText("Paper magazine");
    expect(deck).toBeEnabled();
    click(deck);
    await expectInlineTemplate("Paper magazine");
  } finally {
    release.resolve();
  }
});
