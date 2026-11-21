import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { screen, waitFor } from "@testing-library/react";
import { test, expect } from "vitest";
import { findAction } from "./connector-integrations-test-helpers.ts";
import userEvent from "@testing-library/user-event";
import {
  captureTemplateSubmission,
  deck,
  presentationPart,
} from "./template-submission-fixtures.ts";
import { chatThreadDraftContract } from "@okouai/api-contracts/contracts/chat-threads";
import { RUN_THREAD_ID } from "./chat-run-test-fixtures.ts";
const context = testContext();

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
