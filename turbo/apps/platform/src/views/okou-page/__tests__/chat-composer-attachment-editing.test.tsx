import { HttpResponse } from "msw";
import {
  click,
  fill,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import {
  attachment,
  serveUploaded,
  conversation,
} from "./attachment-preview-boundaries.ts";
import {
  draftForAttachment,
  draftAttachment,
  privateAttachmentUrl,
  ATTACHMENT_THREAD_ID,
  mockAttachmentChat,
} from "./chat-attachment-test-helpers.ts";
import { expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { captureTemplateSubmission } from "./template-submission-fixtures.ts";
import {
  findAction,
  queryAction,
} from "./connector-integrations-test-helpers.ts";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import { createTemplateGalleryHelpers } from "./chat-composer-template-gallery-test-helpers.ts";
import {
  uploadsContract,
  type UploadCompleteResponse,
} from "@okouai/api-contracts/contracts/uploads";
import { type UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { RUN_THREAD_ID, RUN_PATH } from "./chat-run-test-fixtures.ts";
import {
  readSingleRichClipboardWrite,
  readClipboardItemText,
} from "./chat-clipboard-test-helpers.ts";
import { continuityAttachment } from "./chat-continuity-test-helpers.ts";

const context = testContext();

test("chat-composer-media-previews-004 sending the recording releases its draft preview", async () => {
  const sent = captureTemplateSubmission(context);
  const browser = context.mocks.browser.blobDownload();
  const file = new File(["recording"], "field-review.mp4", {
    type: "video/mp4",
  });
  const fileId = crypto.randomUUID();
  context.mocks.upload.success({
    id: fileId,
    contentType: file.type,
    filename: file.name,
    size: file.size,
    url: "https://cdn.okou.io/artifacts/owner/upload/field-review.mp4",
  });
  await setupPage({ context, path: "/" });
  const editor = await screen.findByLabelText("Message");
  await userEvent.upload(
    await screen.findByLabelText("Attach", { selector: "input" }),
    file,
  );
  await findAction("button", "Remove " + file.name);
  const video = await waitFor(() => {
    const element = document.querySelector<HTMLVideoElement>(
      'video[src^="blob:"]',
    );
    if (!element) {
      throw new Error("No local recording preview");
    }
    return element;
  });
  const objectUrl = new URL(video.src);
  objectUrl.hash = "";
  await fill(editor, "Review this recording.");
  const send = await findAction("button", "Send");
  await waitFor(() => {
    return expect(send).toBeEnabled();
  });
  editor.focus();
  await userEvent.keyboard("{Enter}");
  const parts = (await sent.promise).userMessage?.parts;
  expect(parts).toContainEqual({
    type: "file",
    fileId,
    filenameSnapshot: file.name,
    contentType: file.type,
  });
  expect(parts).toContainEqual({
    type: "text",
    text: "Review this recording.",
  });
  await waitFor(() => {
    return expect(browser.revokedUrls).toContain(objectUrl.href);
  });
  expect(queryAction("button", "Remove " + file.name)).toBeNull();
});

test("chat-composer-media-previews-001 the same local PNG survives upload and is released after removal", async () => {
  const browser = context.mocks.browser.blobDownload();
  const upload = context.mocks.deferred<void>();
  const file = new File(["local"], "survey.png", { type: "image/png" });
  const id = crypto.randomUUID();
  context.mocks.upload.success({
    id,
    filename: file.name,
    contentType: file.type,
    size: file.size,
    url: "https://cdn.okou.io/artifacts/survey/run/survey.png",
  });
  context.mocks.http.put("https://mock-upload.r2.test/" + id, async () => {
    await upload.promise;
    return new HttpResponse(null, { status: 200 });
  });
  await setupPage({ context, path: "/" });
  await userEvent.upload(
    await screen.findByLabelText("Attach", { selector: "input" }),
    file,
  );
  const open = await findAction("button", "Open image preview for survey.png");
  const thumb = await waitFor(() => {
    const image = open.querySelector("img");
    if (!image?.src.startsWith("blob:")) {
      throw new Error("Waiting for local thumbnail");
    }
    return image;
  });
  fireEvent.load(thumb);
  await waitFor(() => {
    return expect(
      within(open).queryByTestId("composer-image-preview-loading"),
    ).toBeNull();
  });
  expect(open).toBeDisabled();
  expect(open).toHaveAttribute("aria-busy", "true");
  await expect(screen.findByRole("progressbar")).resolves.toBeVisible();
  await expect(
    findAction("button", "Cancel upload survey.png"),
  ).resolves.toBeVisible();
  upload.resolve();
  await waitFor(() => {
    return expect(open).toBeEnabled();
  });
  click(open);
  const dialog = await screen.findByTestId("attachment-lightbox");
  await waitFor(() => {
    return expect(dialog.querySelector("img")).toHaveAttribute(
      "src",
      thumb.src,
    );
  });
  await expect(
    within(dialog).findByTestId("artifact-dialog-annotate"),
  ).resolves.toBeVisible();
  click(await findAction("button", "Close", dialog));
  click(await findAction("button", "Remove survey.png"));
  await waitFor(() => {
    return expect(browser.revokedUrls).toContain(thumb.src);
  });
  expect(queryAction("button", "Open image preview for survey.png")).toBeNull();
});

test("chat-composer-media-previews-005 a failed restored video thumbnail still opens the authenticated player", async () => {
  const file = attachment("crossing.mp4", "video/mp4");
  serveUploaded(context, [file]);
  await conversation(context, {
    draft: draftForAttachment(
      draftAttachment(file.filename, {
        id: file.id,
        contentType: file.contentType,
        url: privateAttachmentUrl(file.id),
      }),
    ),
  });
  const open = await findAction(
    "button",
    "Open video preview for crossing.mp4",
  );
  const thumbnail = await waitFor(() => {
    const video = open.querySelector("video");
    if (!video?.src) {
      throw new Error("Waiting for video thumbnail");
    }
    return video;
  });
  fireEvent.error(thumbnail);
  await waitFor(() => {
    return expect(
      within(open)
        .getByTestId("composer-video-preview-loading")
        .querySelector("svg"),
    ).toHaveClass("lucide-video");
  });
  click(open);
  const dialog = await screen.findByTestId("attachment-lightbox");
  await waitFor(() => {
    return expect(dialog.querySelector("video")).toHaveAttribute(
      "src",
      file.url,
    );
  });
  expect(dialog.querySelector("video")).toHaveAttribute("controls");
  await expect(
    findAction("button", "Download options", dialog),
  ).resolves.toBeEnabled();
});

/** The composer chip; a modal preview hides it from the role tree, not the page. */
function previewButton(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    'button[aria-label="Open image preview for composer-photo.png"]',
  );
}

test("restored private composer images show a presigned thumbnail and open the same original", async () => {
  const fileId = "e0000000-0000-4000-a000-000000000db1";
  const signed =
    "https://uploads.r2.cloudflarestorage.com/private/composer-photo.png?X-Amz-Signature=composer-sig";
  mockAttachmentChat(context, {
    draft: draftForAttachment(
      draftAttachment("composer-photo.png", {
        id: fileId,
        url: privateAttachmentUrl(fileId),
      }),
      "Compare this photo",
    ),
  });
  context.mocks.api(webFilesContract.fileUrl, ({ respond }) => {
    return respond(200, {
      url: signed,
      downloadUrl: `${signed}&download=1`,
      expiresAt: "2099-01-01T00:00:00.000Z",
      publicUrl: null,
    });
  });
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  const thumbnail = await waitFor(() => {
    const image = previewButton()?.querySelector("img");
    expect(image?.getAttribute("src")).toMatch(/\/cdn-cgi\/image\/[^/]+\//u);
    return image as HTMLImageElement;
  });
  const thumbnailSource = thumbnail.getAttribute("src");
  // The thumbnail is a resized copy of the presigned original.
  expect(thumbnailSource?.endsWith(`/${signed}`)).toBeTruthy();

  click(previewButton() as HTMLElement);

  const dialog = await screen.findByRole("dialog", {
    name: "composer-photo.png preview",
  });
  await waitFor(() => {
    expect(within(dialog).getByRole("img")).toHaveAttribute("src", signed);
  });
  expect(previewButton()?.querySelector("img")).toHaveAttribute(
    "src",
    thumbnailSource,
  );
});

const { mockTemplateChat } = createTemplateGalleryHelpers(context);

/** Composer HTML copied from a client that still wrote block template chips. */
const LEGACY_CLIPBOARD =
  '<div data-composer-template-attachment="" templatetype="presentation" title="Legacy deck" category="slides"></div><p>Keep this draft.</p>';

async function findChipControl(label: string): Promise<HTMLElement> {
  return await waitFor(() => {
    const control = queryAllByRoleFast("button").find((button) => {
      return button.getAttribute("aria-label") === label;
    });
    expect(control).toBeDefined();
    return control as HTMLElement;
  });
}

test("A template attachment keeps clipboard metadata without native hover hints", async () => {
  mockTemplateChat();
  await setupPage({ context, path: "/" });
  const editor = await findComposerEditor();
  const user = userEvent.setup({ delay: null });
  await user.click(editor);
  // Copied composer HTML is plain HTML, so the paste is parsed as markup.
  const legacy = new DataTransfer();
  legacy.setData("text/html", LEGACY_CLIPBOARD);
  await user.paste(legacy);
  const remove = await findChipControl("Remove template Legacy deck");
  const chip = remove.closest<HTMLElement>(
    "[data-composer-template-attachment]",
  ) as HTMLElement;
  expect(editor).toHaveTextContent("Keep this draft.");
  expect(chip).not.toHaveAttribute("title");
  expect(chip.querySelector("[title]")).toBeNull();

  await user.click(editor);
  await user.keyboard("{Control>}a{/Control}");
  const copied = await user.copy();

  expect(copied?.getData("text/html")).toContain('title="Legacy deck"');

  click(remove);

  await waitFor(() => {
    expect(
      editor.querySelector("[data-composer-template-attachment]"),
    ).toBeNull();
  });
  expect(editor).toHaveTextContent("Keep this draft.");
});

const draft = "Keep the existing draft.";
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
