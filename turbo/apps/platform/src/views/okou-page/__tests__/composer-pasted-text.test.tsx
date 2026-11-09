import { artifactReferencePath } from "@okouai/api-contracts/contracts/artifact-references";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import {
  uploadsContract,
  type UploadCompleteResponse,
} from "@okouai/api-contracts/contracts/uploads";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ATTACHMENT_THREAD_ID,
  findNamedButton,
  getNamedButton,
  mockAttachmentChat,
  mockPrivateUrlSequence,
} from "./chat-attachment-test-helpers.ts";
import {
  readClipboardItemText,
  readSingleRichClipboardWrite,
} from "./chat-clipboard-test-helpers.ts";

const context = testContext();

const EXISTING_DRAFT = "Keep the existing draft.";
const FIRST_FILE_ID = "a0000000-0000-4000-a000-000000045955";
const SECOND_FILE_ID = "a0000000-0000-4000-a000-000000045956";
const FIRST_FILENAME = "Pasted text-1.txt";
const SECOND_FILENAME = "Pasted text-2.txt";

interface UploadedContent {
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  text?: string;
  uploadContentType?: string | null;
}

/** Keep the normal prepare/PUT/complete flow, including private file URLs. */
function mockComposerUploads(
  files: readonly { readonly id: string; readonly file: File }[],
): Map<string, UploadedContent> {
  const uploads = new Map<string, UploadedContent>();
  const results: UploadCompleteResponse[] = files.map(({ id, file }) => {
    return {
      id,
      filename: file.name,
      contentType: file.type,
      size: file.size,
      url: artifactReferencePath(id, file.name),
    };
  });
  for (const result of results) {
    context.mocks.upload.success(result);
    context.mocks.http.put(
      `https://mock-upload.r2.test/${result.id}`,
      async ({ request }) => {
        const upload = uploads.get(result.id);
        if (!upload) {
          throw new Error(`Upload ${result.filename} was not prepared`);
        }
        upload.text = await request.text();
        upload.uploadContentType = request.headers.get("content-type");
        return new HttpResponse(null, { status: 200 });
      },
    );
  }
  // Select by the actual filename so repeated pastes cannot reuse one file's
  // identity or hide a naming regression behind fixed mock response metadata.
  context.mocks.api(uploadsContract.prepare, ({ body, respond }) => {
    const result = results.find((file) => {
      return file.filename === body.filename;
    });
    if (!result) {
      throw new Error(`Unexpected upload: ${body.filename}`);
    }
    uploads.set(result.id, {
      filename: body.filename,
      contentType: body.contentType,
      size: body.size,
    });
    return respond(200, {
      ...result,
      filename: body.filename,
      contentType: body.contentType,
      size: body.size,
      uploadUrl: `https://mock-upload.r2.test/${result.id}`,
      uploadHeaders: {},
    });
  });
  context.mocks.api(uploadsContract.complete, ({ body, respond }) => {
    const result = results.find((file) => {
      return file.id === body.id;
    });
    if (!result) {
      throw new Error(`Unexpected upload completion: ${body.id}`);
    }
    return respond(200, result);
  });
  return uploads;
}

function textClipboard(
  text: string,
  files: readonly File[] = [],
): DataTransfer {
  const clipboard = new DataTransfer();
  clipboard.setData("text/plain", text);
  for (const file of files) {
    clipboard.items.add(file);
  }
  return clipboard;
}

async function openComposer(): Promise<HTMLElement> {
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  return await screen.findByRole("textbox", { name: "Message" });
}

test.each([
  { label: "10,000 ASCII code units", text: "a".repeat(10_000) },
  { label: "5,000 emoji (10,000 UTF-16 code units)", text: "😀".repeat(5000) },
])("Insert $label into the existing draft", async ({ text }) => {
  const user = userEvent.setup({ delay: null });
  mockAttachmentChat(context);
  const editor = await openComposer();

  await fill(editor, EXISTING_DRAFT);
  expect(editor.textContent).toBe(EXISTING_DRAFT);
  await user.paste(textClipboard(text));

  await waitFor(() => {
    expect(editor.textContent).toBe(EXISTING_DRAFT + text);
  });
  expect(
    screen.queryByLabelText(`Remove ${FIRST_FILENAME}`),
  ).not.toBeInTheDocument();
  expect(screen.getByLabelText("Send")).toBeEnabled();
});

test.each([
  {
    label: "10,001 ASCII code units with exact whitespace",
    text: `\n \t${"a".repeat(9995)} \r\n`,
  },
  {
    label: "5,000 emoji plus x (10,001 UTF-16 code units)",
    text: `${"😀".repeat(5000)}x`,
  },
])(
  "Attach and send $label without replacing selected draft text",
  async ({ text }) => {
    const user = userEvent.setup({ delay: null });
    let sentMessage: UserMessageDocument | undefined;
    mockAttachmentChat(context, {
      onSendRequest: ({ userMessage }) => {
        sentMessage = userMessage;
      },
    });
    const expectedFile = new File([text], FIRST_FILENAME, {
      type: "text/plain",
    });
    const uploads = mockComposerUploads([
      { id: FIRST_FILE_ID, file: expectedFile },
    ]);
    const editor = await openComposer();

    await fill(editor, EXISTING_DRAFT);
    expect(editor.textContent).toBe(EXISTING_DRAFT);
    await user.keyboard("{Control>}a{/Control}");
    await user.paste(textClipboard(text));

    await expect(
      findNamedButton(`Remove ${FIRST_FILENAME}`),
    ).resolves.toBeInTheDocument();
    expect(editor.textContent).toBe(EXISTING_DRAFT);
    expect(uploads.get(FIRST_FILE_ID)).toStrictEqual({
      filename: FIRST_FILENAME,
      contentType: "text/plain",
      size: expectedFile.size,
      text,
      uploadContentType: "text/plain",
    });

    const send = getNamedButton("Send");
    expect(send).toBeEnabled();
    click(send);

    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Message" }).textContent).toBe(
        "",
      );
    });
    expect(sentMessage?.parts).toContainEqual({
      type: "text",
      text: EXISTING_DRAFT,
    });
    expect(sentMessage?.parts).toContainEqual({
      type: "file",
      fileId: FIRST_FILE_ID,
      filenameSnapshot: FIRST_FILENAME,
      contentType: "text/plain",
    });
  },
);

test("Repeated oversized pastes keep distinct filenames and complete contents", async () => {
  const user = userEvent.setup({ delay: null });
  mockAttachmentChat(context);
  const firstText = `First pasted note\n${"a".repeat(10_000)}`;
  const secondText = `Second pasted note\n${"b".repeat(10_000)}`;
  const uploads = mockComposerUploads([
    {
      id: FIRST_FILE_ID,
      file: new File([firstText], FIRST_FILENAME, { type: "text/plain" }),
    },
    {
      id: SECOND_FILE_ID,
      file: new File([secondText], SECOND_FILENAME, { type: "text/plain" }),
    },
  ]);
  const editor = await openComposer();

  await fill(editor, EXISTING_DRAFT);
  expect(editor.textContent).toBe(EXISTING_DRAFT);
  await user.paste(textClipboard(firstText));
  await expect(
    findNamedButton(`Remove ${FIRST_FILENAME}`),
  ).resolves.toBeInTheDocument();
  expect(editor.textContent).toBe(EXISTING_DRAFT);

  await user.paste(textClipboard(secondText));
  await expect(
    findNamedButton(`Remove ${SECOND_FILENAME}`),
  ).resolves.toBeInTheDocument();
  expect(getNamedButton(`Remove ${FIRST_FILENAME}`)).toBeInTheDocument();
  expect(editor.textContent).toBe(EXISTING_DRAFT);
  expect(uploads.get(FIRST_FILE_ID)?.text).toBe(firstText);
  expect(uploads.get(SECOND_FILE_ID)?.text).toBe(secondText);
});

test.each([
  { filename: "clipboard-notes.txt", contentType: "text/plain" },
  { filename: "clipboard-image.png", contentType: "image/png" },
])(
  "Keep mixed oversized text and $filename as text plus the original file",
  async ({ filename, contentType }) => {
    const user = userEvent.setup({ delay: null });
    mockAttachmentChat(context);
    const file = new File(["Original clipboard file"], filename, {
      type: contentType,
    });
    mockComposerUploads([{ id: FIRST_FILE_ID, file }]);
    const text = "m".repeat(10_001);
    const editor = await openComposer();

    await fill(editor, EXISTING_DRAFT);
    expect(editor.textContent).toBe(EXISTING_DRAFT);
    await user.paste(textClipboard(text, [file]));

    await expect(
      findNamedButton(`Remove ${filename}`),
    ).resolves.toBeInTheDocument();
    expect(editor.textContent).toBe(EXISTING_DRAFT + text);
    expect(
      screen.queryByLabelText(`Remove ${FIRST_FILENAME}`),
    ).not.toBeInTheDocument();
  },
);

test("Restore a rich Okou copy before converting its oversized plain-text fallback", async () => {
  const user = userEvent.setup({ delay: null });
  const clipboard = context.mocks.browser.clipboardWrite();
  const text = `Copied structured message ${"r".repeat(10_001)}`;
  const filename = "copied-reference.txt";
  mockAttachmentChat(context, {
    chatEvents: [
      {
        id: "oversized-rich-message",
        role: "user",
        content: text,
        createdAt: "2026-03-10T00:00:01Z",
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text },
            {
              type: "file",
              fileId: FIRST_FILE_ID,
              filenameSnapshot: filename,
              contentType: "text/plain",
            },
          ],
        },
      },
    ],
  });
  mockPrivateUrlSequence(context, {
    [FIRST_FILE_ID]: [
      "https://cdn.vm7.io/artifacts/tests/copied-reference.txt",
    ],
  });
  const editor = await openComposer();
  const message = await screen.findByText(text);
  const userGroup = message.closest<HTMLElement>('[data-role="user"]');
  if (!userGroup) {
    throw new Error("Expected the copied user message");
  }

  click(getNamedButton("Copy message", userGroup));
  const copied = await readSingleRichClipboardWrite(clipboard);
  const transfer = new DataTransfer();
  transfer.setData(
    "text/plain",
    await readClipboardItemText(copied, "text/plain"),
  );
  transfer.setData(
    "text/html",
    await readClipboardItemText(copied, "text/html"),
  );
  await fill(editor, EXISTING_DRAFT);
  expect(editor.textContent).toBe(EXISTING_DRAFT);
  await user.paste(transfer);

  await expect(
    findNamedButton(`Remove ${filename}`),
  ).resolves.toBeInTheDocument();
  expect(editor.textContent).toBe(EXISTING_DRAFT + text);
  expect(
    screen.queryByLabelText(`Remove ${FIRST_FILENAME}`),
  ).not.toBeInTheDocument();
});
