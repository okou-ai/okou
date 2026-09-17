import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  AGENT_ID,
  THREAD_ID,
  context,
  mockTemplateChat,
  openTemplatePicker,
} from "./chat-composer-template-gallery-test-helpers.ts";

const IMPORT_PROMPT =
  "Analyse this deck and save its visual language as a reusable presentation template.";

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
): Promise<void> {
  await openTemplatePicker(user, "Presentation");
  await user.upload(screen.getByLabelText("Import your own deck"), file);
}

test("Do not send a presentation that failed to upload", async () => {
  const capture = mockTemplateChat();
  context.mocks.api(uploadsContract.prepare, ({ respond }) => {
    return respond(500, {
      error: { code: "INTERNAL_SERVER_ERROR", message: "Upload failed" },
    });
  });
  const user = userEvent.setup();

  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
  });

  await importDeck(
    user,
    new File(["broken"], "broken-deck.pptx", {
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }),
  );
  await waitFor(() => {
    expect(screen.getByText("Failed to upload broken-deck.pptx")).toBeVisible();
  });
  expect(capture.sentMessages).toHaveLength(0);
  expect(capture.runPrompts).toHaveLength(0);
});

test("Import a presentation deck into chat", async () => {
  const capture = mockTemplateChat();
  context.mocks.upload.success({
    id: "81000000-0000-4000-a000-000000000001",
    filename: "modern-deck.pptx",
    contentType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    size: 6,
    url: "https://cdn.example.test/modern-deck.pptx",
  });
  const user = userEvent.setup();

  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
  });

  await importDeck(
    user,
    new File(["modern"], "modern-deck.pptx", {
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }),
  );
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(uploadedFilePart(capture.sentMessages[0]!).filenameSnapshot).toBe(
    "modern-deck.pptx",
  );
  expect(capture.runPrompts).toStrictEqual([IMPORT_PROMPT]);
  expect(capture.runClientThreadIds).toStrictEqual([undefined]);
});

test("Import a legacy presentation deck into an existing chat", async () => {
  const capture = mockTemplateChat();
  context.mocks.upload.success({
    id: "81000000-0000-4000-a000-000000000002",
    filename: "legacy-deck.ppt",
    contentType: "application/vnd.ms-powerpoint",
    size: 6,
    url: "https://cdn.example.test/legacy-deck.ppt",
  });
  const user = userEvent.setup();

  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
  });

  await importDeck(
    user,
    new File(["legacy"], "legacy-deck.ppt", {
      type: "application/vnd.ms-powerpoint",
    }),
  );
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  const file = uploadedFilePart(capture.sentMessages[0]!);
  expect(file.filenameSnapshot).toBe("legacy-deck.ppt");
  expect(file.contentType).toBe("application/vnd.ms-powerpoint");
  expect(capture.runPrompts).toStrictEqual([IMPORT_PROMPT]);
});

test("Import a presentation deck from a new chat", async () => {
  const capture = mockTemplateChat();
  context.mocks.upload.success({
    id: "81000000-0000-4000-a000-000000000003",
    filename: "new-chat-deck.pptx",
    contentType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    size: 8,
    url: "https://cdn.example.test/new-chat-deck.pptx",
  });
  const user = userEvent.setup();

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
  mockTemplateChat();
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
