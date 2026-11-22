import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  continuityAttachment,
  continuityDraft,
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { findEnabledButton } from "./chat-run-test-fixtures.ts";

const context = testContext();
test("user-message-document-007 Copying the sent PDF preserves its saved attachment and empty prompt representation", async () => {
  const clipboard = context.mocks.browser.clipboardWrite();
  const pdf = continuityAttachment(
    791,
    1,
    "lighting-plan.pdf",
    "application/pdf",
  );
  const chat = continuityThread(791, 1, "Lighting brief");
  const part = {
    type: "file",
    fileId: pdf.id,
    filenameSnapshot: pdf.filename,
    contentType: pdf.contentType,
  } as const;
  const sent = context.mocks.deferred<unknown>();
  mockChatLifecycle(context, {
    threadId: chat.id,
    onSendRequest: (b) => {
      return sent.resolve(b);
    },
  });
  const workspace = installContinuityWorkspace(context, {
    caseId: 791,
    threads: [chat],
    drafts: new Map([[chat.id, continuityDraft([part], [pdf])]]),
  });
  await setupPage({
    context,
    path: "/chats/" + chat.id,
    ...workspace.pageOptions,
  });
  await expect(
    findEnabledButton("Remove lighting-plan.pdf"),
  ).resolves.toBeVisible();
  click(await findEnabledButton("Send"));
  await expect(sent.promise).resolves.toMatchObject({
    userMessage: { parts: expect.arrayContaining([part]) },
  });
  click(await findEnabledButton("Copy message"));
  const item = await waitFor(() => {
    const value = clipboard.writes.at(-1)?.[0];
    if (!value) {
      throw new Error("The page has not written the message to the clipboard");
    }
    return value;
  });
  const html = await (await item.getType("text/html")).text();
  const encoded = new DOMParser()
    .parseFromString(html, "text/html")
    .querySelector<HTMLElement>("[data-okou-chat-message]")
    ?.dataset.okouChatMessage;
  expect(JSON.parse(decodeURIComponent(encoded ?? ""))).toMatchObject({
    text: "",
    attachments: [
      expect.objectContaining({ id: pdf.id, filename: pdf.filename }),
    ],
    userMessage: { parts: expect.arrayContaining([part]) },
  });
  expect(screen.queryByRole("textbox", { name: "Message" })).toBeVisible();
});
