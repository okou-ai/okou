import { artifactReferencePath } from "@okouai/api-contracts/contracts/artifact-references";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ATTACHMENT_THREAD_ID,
  draftAttachment,
  draftForAttachment,
  findNamedButton,
  getNamedButton,
  mockAttachmentChat,
  mockPrivateUrlSequence,
  queryNamedButton,
} from "./chat-attachment-test-helpers.ts";
import { fillComposer } from "./chat-test-helpers.ts";

const context = testContext();
const FILE_ID = "a0000000-0000-4000-a000-000000000096";

function selectFile(file: File): void {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) {
    throw new Error("Expected the composer file input");
  }
  fireEvent.change(input, { target: { files: [file] } });
}

test.each([
  { kind: "image", filename: "photo.png", contentType: "image/png" },
  { kind: "video", filename: "recording.mp4", contentType: "video/mp4" },
] as const)(
  "A $kind is previewable before upload completes and keeps its preview afterward",
  async ({ kind, filename, contentType }) => {
    mockAttachmentChat(context);
    const blobs = context.mocks.browser.blobDownload();
    const transfer = context.mocks.deferred<void>();
    context.mocks.upload.success({
      id: FILE_ID,
      filename,
      contentType,
      size: 5,
      url: artifactReferencePath(FILE_ID, filename),
    });
    context.mocks.http.put(
      `https://mock-upload.r2.test/${FILE_ID}`,
      async () => {
        await transfer.promise;
        return new Response(null, { status: 200 });
      },
    );

    await setupPage({
      context,
      path: `/chats/${ATTACHMENT_THREAD_ID}`,
      featureSwitches: { [FeatureSwitchKey.ComposerMediaPreviews]: true },
    });

    const file = new File(["media"], filename, { type: contentType });
    selectFile(file);
    const openPreview = await findNamedButton(
      `Open ${kind} preview for ${filename}`,
    );
    const tag = kind === "image" ? "img" : "video";
    await waitFor(() => {
      expect(openPreview.querySelector(tag)).toHaveAttribute(
        "src",
        expect.stringMatching(/^blob:/u),
      );
    });
    const thumbnail = openPreview.querySelector(tag)!;
    const thumbnailUrl = thumbnail.getAttribute("src")!;
    const localUrl = thumbnailUrl.split("#")[0];
    expect(blobs.blobForUrl(localUrl)).toBe(file);
    expect(openPreview).toBeEnabled();
    expect(getNamedButton(`Cancel upload ${filename}`)).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    if (kind === "image") {
      fireEvent.load(thumbnail);
    } else {
      fireEvent.loadedData(thumbnail);
    }

    click(openPreview);
    const dialog = await screen.findByRole("dialog", {
      name: `${filename} preview`,
    });
    await waitFor(() => {
      const media =
        kind === "image"
          ? screen.getByTestId("attachment-lightbox-image")
          : dialog.querySelector("video");
      expect(media).toHaveAttribute("src", localUrl);
    });
    const mediaControl =
      kind === "video"
        ? dialog.querySelector("video[controls]")
        : getNamedButton("Annotate", dialog);
    expect(mediaControl).toBeInTheDocument();
    click(getNamedButton("Close", dialog));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    transfer.resolve();
    await findNamedButton(`Remove ${filename}`);
    expect(openPreview.querySelector(tag)).toBe(thumbnail);
    expect(thumbnail).toHaveAttribute("src", thumbnailUrl);
    click(openPreview);
    const completedDialog = await screen.findByRole("dialog", {
      name: `${filename} preview`,
    });
    click(getNamedButton("Close", completedDialog));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    click(getNamedButton(`Remove ${filename}`));
    await waitFor(() => {
      expect(
        queryNamedButton(`Open ${kind} preview for ${filename}`),
      ).toBeNull();
    });
    expect(blobs.revokedUrls).toContain(localUrl);
  },
);

test("Cancelling a media upload releases its local preview", async () => {
  mockAttachmentChat(context);
  const blobs = context.mocks.browser.blobDownload();
  context.mocks.upload.pending({
    id: FILE_ID,
    filename: "cancel.mp4",
    contentType: "video/mp4",
    size: 5,
    url: artifactReferencePath(FILE_ID, "cancel.mp4"),
  });
  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ComposerMediaPreviews]: true },
  });

  selectFile(new File(["media"], "cancel.mp4", { type: "video/mp4" }));
  const preview = await findNamedButton("Open video preview for cancel.mp4");
  await waitFor(() => {
    expect(preview.querySelector("video")).toHaveAttribute("src");
  });
  const url = preview
    .querySelector("video")!
    .getAttribute("src")!
    .split("#")[0];
  click(getNamedButton("Cancel upload cancel.mp4"));
  await waitFor(() => {
    expect(queryNamedButton("Open video preview for cancel.mp4")).toBeNull();
  });
  expect(blobs.revokedUrls).toContain(url);
});

test("Sending local media uses the uploaded file identity and releases its draft preview", async () => {
  let sentMessage: UserMessageDocument | undefined;
  mockAttachmentChat(context, {
    onSendRequest: (body) => {
      sentMessage = body.userMessage;
    },
  });
  const blobs = context.mocks.browser.blobDownload();
  context.mocks.upload.success({
    id: FILE_ID,
    filename: "send.mp4",
    contentType: "video/mp4",
    size: 5,
    url: artifactReferencePath(FILE_ID, "send.mp4"),
  });
  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ComposerMediaPreviews]: true },
  });

  selectFile(new File(["media"], "send.mp4", { type: "video/mp4" }));
  await findNamedButton("Remove send.mp4");
  const preview = getNamedButton("Open video preview for send.mp4");
  await waitFor(() => {
    expect(preview.querySelector("video")).toHaveAttribute("src");
  });
  const url = preview
    .querySelector("video")!
    .getAttribute("src")!
    .split("#")[0];
  const editor = screen.getByRole("textbox", { name: "Message" });
  await fillComposer(editor, "Review this recording");
  await userEvent.setup().keyboard("{Enter}");
  await waitFor(() => {
    expect(queryNamedButton("Remove send.mp4")).toBeNull();
  });
  expect(sentMessage?.parts).toContainEqual({
    type: "file",
    fileId: FILE_ID,
    filenameSnapshot: "send.mp4",
    contentType: "video/mp4",
  });
  expect(blobs.revokedUrls).toContain(url);
});

test("A restored private video opens its authenticated player even when its thumbnail fails", async () => {
  const video = draftAttachment("restored.mp4", {
    id: FILE_ID,
    contentType: "video/mp4",
  });
  const signedUrl = "https://private-files.example/restored.mp4?signature=test";
  mockAttachmentChat(context, { draft: draftForAttachment(video, "") });
  mockPrivateUrlSequence(context, { [FILE_ID]: [signedUrl] });
  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ComposerMediaPreviews]: true },
  });

  const preview = await findNamedButton("Open video preview for restored.mp4");
  await waitFor(() => {
    expect(preview.querySelector("video")).toHaveAttribute(
      "src",
      `${signedUrl}#t=0.001`,
    );
  });
  fireEvent.error(preview.querySelector("video")!);
  click(preview);
  const dialog = await screen.findByRole("dialog", {
    name: "restored.mp4 preview",
  });
  await waitFor(() => {
    expect(dialog.querySelector("video")).toHaveAttribute("src", signedUrl);
  });
  expect(dialog.querySelector("video")).toHaveAttribute("controls");
  expect(getNamedButton("Download options", dialog)).toBeInTheDocument();
});
