import {
  uploadsContract,
  type UploadCompleteResponse,
} from "@okouai/api-contracts/contracts/uploads";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { HttpResponse } from "msw";
import { setupPage, fill, click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { RUN_THREAD_ID, RUN_PATH } from "./chat-run-test-fixtures.ts";
import {
  readSingleRichClipboardWrite,
  readClipboardItemText,
} from "./chat-clipboard-test-helpers.ts";
import { continuityAttachment } from "./chat-continuity-test-helpers.ts";
const context = testContext(),
  draft = "Keep the existing draft.";
function uploads() {
  const metadata = new Map<string, UploadCompleteResponse>(),
    contents = new Map<string, string>();
  context.mocks.api(uploadsContract.prepare, ({ body, respond }) => {
    const id = crypto.randomUUID(),
      file = {
        id,
        filename: body.filename,
        size: body.size,
        contentType: body.contentType,
        url:
          "https://cdn.vm7.io/artifacts/local/notes/" +
          encodeURIComponent(body.filename),
      };
    metadata.set(id, file);
    return respond(200, {
      ...file,
      uploadUrl: "https://upload.example.test/" + id,
      uploadHeaders: {},
    });
  });
  context.mocks.http.put(
    "https://upload.example.test/:id",
    async ({ request, params }) => {
      const meta = metadata.get(String(params.id));
      if (!meta) {
        return new HttpResponse(null, { status: 404 });
      }
      contents.set(meta.filename, await request.text());
      return new HttpResponse(null, { status: 200 });
    },
  );
  context.mocks.api(uploadsContract.complete, ({ body, respond }) => {
    const file = metadata.get(body.id);
    if (!file) {
      throw new Error("Prepared upload missing");
    }
    return respond(200, file);
  });
  return contents;
}
async function openComposer(
  events: NonNullable<
    NonNullable<Parameters<typeof mockChatLifecycle>[1]>["chatEvents"]
  > = [],
) {
  const sent: UserMessageDocument[] = [];
  mockChatLifecycle(context, {
    threadId: RUN_THREAD_ID,
    chatEvents: events,
    onSendRequest(body) {
      if (body.userMessage) {
        sent.push(body.userMessage);
      }
    },
  });
  await setupPage({ context, path: RUN_PATH });
  const editor = await findComposerEditor(),
    user = userEvent.setup();
  await fill(editor, draft);
  return { editor, user, sent };
}
test("composer-pasted-text-002 five thousand emoji stay inline at the UTF-16 threshold", async () => {
  const { editor, user } = await openComposer();
  const text = "🌊".repeat(5000);
  await user.paste(text);
  expect(editor.textContent).toBe(draft + text);
  expect(screen.queryByText(/Pasted text-\d+\.txt/)).toBeNull();
  await expect(findFastControl("button", "Send")).resolves.toBeEnabled();
});
test("composer-pasted-text-003 a file over five gigabytes falls back to sending the selected replacement inline", async () => {
  const { editor, user, sent } = await openComposer();
  await user.keyboard("{Control>}a{/Control}");
  const text = "p".repeat(10_001);
  const original = Object.getOwnPropertyDescriptor(Blob.prototype, "size")?.get;
  if (!original) {
    throw new Error("Blob size getter missing");
  }
  vi.spyOn(Blob.prototype, "size", "get").mockImplementation(function (
    this: Blob,
  ) {
    return this instanceof File && this.name === "Pasted text-1.txt"
      ? 6 * 1024 ** 3
      : Number(original.call(this));
  });
  await user.paste(text);
  await screen.findByText(/exceeds the 5 GB limit/);
  expect(editor.textContent).toBe(text);
  expect(screen.queryByText("Pasted text-1.txt", { exact: true })).toBeNull();
  click(await findFastControl("button", "Send"));
  await waitFor(() => {
    expect(
      sent[0]?.parts.filter((x) => {
        return x.type === "text" || x.type === "file";
      }),
    ).toStrictEqual([{ type: "text", text }]);
  });
});
test("composer-pasted-text-004 the original draft and a whitespace-exact text upload are sent together", async () => {
  const contents = uploads(),
    { editor, user, sent } = await openComposer();
  const text = "\n \t" + "x".repeat(9995) + " \r\n";
  await user.keyboard("{Control>}a{/Control}");
  await user.paste(text);
  await screen.findByText("Pasted text-1.txt");
  await waitFor(() => {
    expect(contents.get("Pasted text-1.txt")).toBe(text);
  });
  expect(editor.textContent).toBe(draft);
  click(await findFastControl("button", "Send"));
  await waitFor(() => {
    expect(sent[0]?.parts).toStrictEqual(
      expect.arrayContaining([
        { type: "text", text: draft },
        expect.objectContaining({
          type: "file",
          filenameSnapshot: "Pasted text-1.txt",
        }),
      ]),
    );
  });
});
test("composer-pasted-text-006 two large notes retain their individual filenames and exact uploaded bodies", async () => {
  const contents = uploads(),
    { editor, user } = await openComposer();
  const first = "First pasted note " + "a".repeat(10_010),
    second = "Second pasted note " + "b".repeat(10_020);
  await user.paste(first);
  await screen.findByText("Pasted text-1.txt");
  editor.focus();
  await user.paste(second);
  await screen.findByText("Pasted text-2.txt");
  await waitFor(() => {
    expect(contents.get("Pasted text-1.txt")).toBe(first);
    expect(contents.get("Pasted text-2.txt")).toBe(second);
  });
  expect(editor.textContent).toBe(draft);
});
test("composer-pasted-text-009 chat rich copy restores its own attachment and appends long text inline", async () => {
  const content = "Collected notes " + "z".repeat(10_001),
    file = continuityAttachment(730, 1, "coastal-log.txt");
  const { editor, user } = await openComposer([
    {
      role: "user",
      content,
      createdAt: "2026-08-10T08:00:00Z",
      fileParts: [
        {
          type: "file",
          fileId: file.id,
          filenameSnapshot: file.filename,
          contentType: file.contentType,
        },
      ],
    },
  ]);
  const post = await screen.findByText(content);
  const bubble = post.closest('[data-role="user"]');
  if (!(bubble instanceof HTMLElement)) {
    throw new Error("Missing source chat message");
  }
  const clipboard = context.mocks.browser.clipboardWrite();
  click(await findFastControl("button", "Copy message", bubble));
  const message = await readSingleRichClipboardWrite(clipboard),
    transfer = new DataTransfer();
  for (const type of ["text/html", "text/plain"]) {
    transfer.setData(type, await readClipboardItemText(message, type));
  }
  editor.focus();
  await user.paste(transfer);
  await waitFor(() => {
    expect(editor.textContent).toBe(draft + content);
  });
  const composer = editor.closest('[data-slot="chat-composer-card"]');
  expect(composer).toHaveTextContent("coastal-log.txt");
  expect(composer).not.toHaveTextContent(/Pasted text-\d+\.txt/);
});
