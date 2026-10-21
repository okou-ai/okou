import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  chatThreadDraftContract,
  type UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  AGENT_ID,
  THREAD_ID,
  openTemplatePicker,
  createTemplateGalleryHelpers,
} from "./chat-composer-template-gallery-test-helpers.ts";
import { CLAUDE_SUBSCRIPTION_PROVIDER_ID } from "./chat-composer-test-helpers.ts";
import { buildRunModel } from "./chat-model-builders.ts";
import {
  openSavedPresentationPicker,
  savedPresentationDraft,
} from "./presentation-draft-test-helpers.ts";

const context = testContext();
const { mockTemplateChat } = createTemplateGalleryHelpers(context);

const IMPORT_PROMPT =
  "Analyse this deck and save its visual language as a reusable presentation template.";

function mockDeckImportChat() {
  const capture = mockTemplateChat();
  // Importing a deck needs one usable model, not a model-switching catalog.
  context.mocks.data.availableRunModels([
    buildRunModel({
      model: "claude-sonnet-5",
      modelLabel: "Claude Sonnet 5",
      providerType: "claude-code-oauth-token",
      modelProviderId: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
    }),
  ]);
  return capture;
}

function uploadedFilePart(message: UserMessageDocument) {
  const part = message.parts.find((candidate) => {
    return candidate.type === "file";
  });
  if (!part || part.type !== "file") {
    throw new Error("Imported message has no uploaded file");
  }
  return part;
}

async function importDeck(
  user: ReturnType<typeof userEvent.setup>,
  file: File,
  openPicker?: HTMLElement,
): Promise<void> {
  const picker = openPicker ?? (await openTemplatePicker(user));
  await user.upload(
    within(picker).getByLabelText("Import your own deck"),
    file,
  );
}

test("Import a presentation deck over a saved template in an existing chat", async () => {
  const capture = mockDeckImportChat();
  const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0];
  if (!template) {
    throw new Error("Expected a saved presentation template");
  }
  context.mocks.api(chatThreadDraftContract.get, ({ respond }) => {
    return respond(200, savedPresentationDraft(template));
  });
  context.mocks.upload.success({
    id: "81000000-0000-4000-a000-000000000001",
    filename: "modern-deck.pptx",
    contentType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    size: 6,
    url: "https://cdn.example.test/modern-deck.pptx",
  });
  const user = userEvent.setup({ delay: null, skipHover: true });

  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
  });

  const picker = await openSavedPresentationPicker(template.title);
  await importDeck(
    user,
    new File(["modern"], "modern-deck.pptx", {
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }),
    picker,
  );
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(uploadedFilePart(capture.sentMessages[0]!).filenameSnapshot).toBe(
    "modern-deck.pptx",
  );
  expect(capture.runPrompts).toStrictEqual([IMPORT_PROMPT]);
  expect(capture.runClientThreadIds).toStrictEqual([undefined]);
  expect(capture.selectedTemplates).toStrictEqual([]);
  // This entry adds nothing the member cannot see. How to reach the guide is
  // already in every run's tools prompt, and the catalog needs no correction
  // here, so the deck is sent with the sentence and nothing behind it.
  expect(
    capture.sentMessages[0]!.parts.filter((part) => {
      return part.type === "additional_info";
    }),
  ).toStrictEqual([]);
});

test("Import a presentation deck from a new chat", async () => {
  const capture = mockDeckImportChat();
  context.mocks.upload.success({
    id: "81000000-0000-4000-a000-000000000003",
    filename: "new-chat-deck.pptx",
    contentType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    size: 8,
    url: "https://cdn.example.test/new-chat-deck.pptx",
  });
  const user = userEvent.setup({ delay: null });

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    host: "app.okou.ai",
  });

  await importDeck(
    user,
    new File(["new chat"], "new-chat-deck.pptx", {
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }),
  );
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(uploadedFilePart(capture.sentMessages[0]!).filenameSnapshot).toBe(
    "new-chat-deck.pptx",
  );
  expect(capture.runPrompts).toStrictEqual([IMPORT_PROMPT]);
  // This tile still opens the thread it created. Watching the analysis is the
  // only place this path reports progress, so leaving the member behind would
  // leave them with nothing.
  await waitFor(() => {
    expect(window.location.pathname).toMatch(/^\/chats\//);
  });
});

test("The Presentation tile still offers exactly the decks it always has", async () => {
  mockDeckImportChat();
  const user = userEvent.setup();

  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
  });

  await openTemplatePicker(user, "Presentation");
  // This tile publishes to the presentation catalog, which has no notion of a
  // document. Widening it because a second catalog learned to take one would
  // accept a file this path cannot compile.
  expect(
    screen.getByLabelText("Import your own deck").getAttribute("accept"),
  ).toBe(".pptx,.ppt,.pdf");
});
