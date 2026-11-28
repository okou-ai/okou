import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { screen, waitFor, within } from "@testing-library/react";
import { test, expect } from "vitest";
import { findAction } from "./connector-integrations-test-helpers.ts";
import userEvent from "@testing-library/user-event";
import {
  captureTemplateSubmission,
  deck,
  serveDeck,
  presentationPart,
} from "./template-submission-fixtures.ts";
import { composerDraftContract } from "@okouai/api-contracts/contracts/composer-draft";
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
import {
  chatThreadDraftContract,
  type UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { RUN_THREAD_ID } from "./chat-run-test-fixtures.ts";

const context = testContext();

test("chat-composer-presentation-gallery-001 Deep dive is persisted with the selected template without sending", async () => {
  context.mocks.data.userPreferences({ presentationFormat: "pptx" });
  const sent = captureTemplateSubmission(context);
  serveDeck(context, "<section data-slide>Revenue</section>");
  const saved = context.mocks.deferred<UserMessageDocument>();
  context.mocks.api(composerDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftUserMessage: { version: 1, parts: [presentationPart()] },
      draftAttachments: [],
    });
  });
  context.mocks.api(composerDraftContract.patch, ({ body, respond }) => {
    if (
      body.draftUserMessage?.parts.some((p) => {
        return (
          p.type === "template" &&
          p.template.type === "presentation" &&
          p.template.selection.templateId === deck.templateId &&
          p.template.selection.colorSystemId === "color-system:ocean-deep"
        );
      })
    ) {
      saved.resolve(body.draftUserMessage);
    }
    return respond(204);
  });
  await setupPage({ context, path: "/", host: "app.okou.ai" });
  click(await findAction("button", "Presentation"));
  const editor = await screen.findByLabelText("Message");
  await waitFor(() => {
    return expect(editor).toHaveTextContent(deck.title);
  });
  click(await findAction("button", "Preview template " + deck.title));
  const modal = await screen.findByRole("dialog");
  click(await findAction("button", "Deep dive", modal));
  click(await findAction("button", "Use this template", modal));
  expect((await saved.promise).parts).toContainEqual(
    presentationPart("color-system:ocean-deep"),
  );
  expect(editor).toHaveTextContent(deck.title);
  expect(sent.settled()).toBeFalsy();
});
test("chat-composer-presentation-gallery-002 the restored ocean theme reaches the quarterly presentation request", async () => {
  context.mocks.data.userPreferences({ presentationFormat: "html" });
  const sent = captureTemplateSubmission(context);
  const part = presentationPart("color-system:ocean-deep");
  const prompt = "Create the quarterly presentation.";
  context.mocks.api(composerDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftUserMessage: {
        version: 1,
        parts: [part, { type: "text", text: prompt }],
      },
      draftAttachments: [],
    });
  });
  await setupPage({ context, path: "/" });
  const editor = await screen.findByLabelText("Message");
  await waitFor(() => {
    return expect(editor).toHaveTextContent(prompt);
  });
  expect(editor).toHaveTextContent(deck.title);
  click(await findAction("button", "Send"));
  const parts = (await sent.promise).userMessage?.parts;
  expect(parts).toContainEqual({ type: "text", text: prompt });
  expect(parts).toContainEqual(part);
});
test("chat-composer-presentation-gallery-003 selecting an unthemed recommendation sends its default palette", async () => {
  context.mocks.data.userPreferences({ presentationFormat: "pptx" });
  const sent = captureTemplateSubmission(context);
  await setupPage({ context, path: "/" });
  const editor = await screen.findByLabelText("Message");
  const prompt = "Create a presentation with this template.";
  await fill(editor, prompt);
  click(await findAction("button", "Presentation"));
  click(await findAction("button", deck.title));
  await waitFor(() => {
    return expect(editor).toHaveTextContent(deck.title);
  });
  click(await findAction("button", "Send"));
  const parts = (await sent.promise).userMessage?.parts;
  expect(parts).toContainEqual({ type: "text", text: prompt });
  expect(parts).toContainEqual(presentationPart());
});
test("chat-composer-presentation-gallery-004 a four-slide preview respects both ends while navigating by mouse and keyboard", async () => {
  serveDeck(
    context,
    ["Plan", "Schedule", "Owners", "Budget"]
      .map((s) => {
        return "<section data-slide>" + s + "</section>";
      })
      .join(""),
  );
  await setupPage({ context, path: "/", host: "app.okou.ai" });
  click(await findAction("button", "Presentation"));
  click(await findAction("button", "Preview template " + deck.title));
  const modal = await screen.findByRole("dialog");
  await within(modal).findByText("1 / 4");
  await expect(
    findAction("button", "Preview previous slide", modal),
  ).resolves.toBeDisabled();
  click(await findAction("button", "Preview next slide", modal));
  await within(modal).findByText("2 / 4");
  const stage = await within(modal).findByRole("group", {
    name: deck.title + " slide preview",
  });
  stage.focus();
  await userEvent.keyboard("{ArrowRight}");
  await within(modal).findByText("3 / 4");
  click(await findAction("button", "Preview slide 4", modal));
  await within(modal).findByText("4 / 4");
  stage.focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(within(modal).getByText("4 / 4")).toBeVisible();
  click(await findAction("button", "Preview previous slide", modal));
  await expect(within(modal).findByText("3 / 4")).resolves.toBeVisible();
  expect(
    within(modal)
      .getByTitle(deck.title + " HTML preview")
      .getAttribute("srcdoc"),
  ).toContain("Owners");
});

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

function uploadedDeck(filename: string) {
  const fileType =
    "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  const file = new File(["deck"], filename, { type: fileType });
  const fileId = crypto.randomUUID();
  context.mocks.upload.success({
    id: fileId,
    filename,
    contentType: file.type,
    size: file.size,
    url: "https://cdn.okou.io/artifacts/owner/import/" + filename,
  });
  return { file, fileId };
}

async function importDeck(file: File) {
  click(await findAction("button", "Presentation"));
  const input = await screen.findByLabelText("Import your own deck", {
    selector: "input",
  });
  expect(input).toHaveAttribute("accept", ".pptx,.ppt,.pdf");
  await userEvent.upload(input, file);
}

test("chat-composer-presentation-import-001 importing a deck replaces the existing chat's template with a reusable-template request", async () => {
  const sent = captureTemplateSubmission(context);
  const { file, fileId } = uploadedDeck("modern-deck.pptx");
  context.mocks.api(chatThreadDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftUserMessage: { version: 1, parts: [presentationPart()] },
      draftAttachments: [],
    });
  });
  await setupPage({ context, path: "/chats/" + RUN_THREAD_ID });
  const editor = await screen.findByLabelText("Message");
  await waitFor(() => {
    return expect(editor).toHaveTextContent(deck.title);
  });
  await importDeck(file);
  const body = await sent.promise;
  expect(body.threadId).toBe(RUN_THREAD_ID);
  expect(body.clientThreadId).toBeUndefined();
  const parts = body.userMessage?.parts;
  expect(parts).toContainEqual({
    type: "file",
    fileId,
    filenameSnapshot: file.name,
    contentType: file.type,
  });
  expect(parts).toContainEqual({
    type: "text",
    text: "Analyse this file and save it as a reusable template.",
  });
  expect(
    parts?.find((p) => {
      return p.type === "additional_info";
    })?.text,
  ).toContain("okou user-template publish");
  expect(
    parts?.find((p) => {
      return p.type === "template";
    }),
  ).toBeUndefined();
  await waitFor(() => {
    return expect(document.querySelectorAll('[data-role="user"]')).toHaveLength(
      1,
    );
  });
});

test("chat-composer-presentation-import-002 importing from home opens the new conversation containing the deck", async () => {
  const created = context.mocks.deferred<string>();
  const sent = captureTemplateSubmission(context, ({ clientThreadId }) => {
    created.resolve(clientThreadId ?? RUN_THREAD_ID);
  });
  const { file, fileId } = uploadedDeck("new-chat-deck.pptx");
  await setupPage({ context, path: "/" });
  await importDeck(file);
  const body = await sent.promise;
  const newId = await created.promise;
  expect(body.threadId).toBe(newId);
  await waitFor(() => {
    return expect(location.pathname).toBe("/chats/" + newId);
  });
  const parts = body.userMessage?.parts;
  expect(parts).toContainEqual({
    type: "file",
    fileId,
    filenameSnapshot: file.name,
    contentType: file.type,
  });
  expect(parts).toContainEqual({
    type: "text",
    text: "Analyse this file and save it as a reusable template.",
  });
  await waitFor(() => {
    return expect(document.querySelectorAll('[data-role="user"]')).toHaveLength(
      1,
    );
  });
});

async function presentationDraft() {
  context.mocks.data.userPreferences({ presentationFormat: "html" });
  const sent = captureTemplateSubmission(context);
  await setupPage({ context, path: "/" });
  const editor = await screen.findByLabelText("Message");
  await fill(editor, "Our launch");
  click(await findAction("button", "Presentation"));
  return { sent, editor };
}

test("chat-composer-presentation-options-001 the launch brief survives opening the presentation shelf", async () => {
  const { editor } = await presentationDraft();
  await screen.findByRole("group", { name: "Presentation templates" });
  expect(editor).toHaveTextContent(/^Our launch$/);
});

test("chat-composer-presentation-options-004 a slide range is sent alongside the unchanged launch brief", async () => {
  const { sent } = await presentationDraft();
  click(await screen.findByLabelText("Slide count"));
  click(await screen.findByText("20–24 slides"));
  click(await findAction("button", "Send"));
  const { userMessage } = await sent.promise;
  expect(userMessage?.parts).toContainEqual({
    type: "text",
    text: "Our launch",
  });
  expect(
    userMessage?.parts.find((p) => {
      return p.type === "additional_info";
    })?.text,
  ).toMatch(
    /Slide count: 20-24[\s\S]*different .*slide count, the message wins/i,
  );
});

test("chat-composer-presentation-options-005 removing presentation discards the Auto preference before sending", async () => {
  const { sent } = await presentationDraft();
  await screen.findByRole("group", { name: "Presentation templates" });
  click(await screen.findByLabelText("Slide count"));
  click(await screen.findByText("Auto"));
  click(await findAction("button", "Remove Presentation"));
  await waitFor(() => {
    return expect(
      screen.queryByRole("group", { name: "Presentation templates" }),
    ).toBeNull();
  });
  click(await findAction("button", "Send"));
  expect((await sent.promise).userMessage?.parts).toStrictEqual([
    { type: "text", text: "Our launch" },
  ]);
});
