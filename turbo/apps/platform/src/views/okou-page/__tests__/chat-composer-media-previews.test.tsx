import { artifactReferencePath } from "@okouai/api-contracts/contracts/artifact-references";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
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

function mediaSource(preview: HTMLElement, tag: "img" | "video"): string {
  const source = preview.querySelector(tag)?.getAttribute("src");
  if (!source) {
    throw new Error(`Expected a ${tag} thumbnail source`);
  }
  return source;
}

test("An uploading image shows its local thumbnail and enables preview after completion", async () => {
  mockAttachmentChat(context);
  const blobs = context.mocks.browser.blobDownload();
  const transfer = context.mocks.deferred<void>();
  context.mocks.upload.success({
    id: FILE_ID,
    filename: "photo.png",
    contentType: "image/png",
    size: 5,
    url: artifactReferencePath(FILE_ID, "photo.png"),
  });
  context.mocks.http.put(`https://mock-upload.r2.test/${FILE_ID}`, async () => {
    await transfer.promise;
    return new Response(null, { status: 200 });
  });
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  const file = new File(["media"], "photo.png", { type: "image/png" });
  selectFile(file);
  const openPreview = await findNamedButton("Open image preview for photo.png");
  await waitFor(() => {
    expect(openPreview.querySelector("img")).toHaveAttribute(
      "src",
      expect.stringMatching(/^blob:/u),
    );
  });
  const localUrl = mediaSource(openPreview, "img").split("#")[0];
  expect(blobs.blobForUrl(localUrl)).toBe(file);
  expect(openPreview).toBeDisabled();
  expect(openPreview).toHaveAttribute("aria-busy", "true");
  expect(getNamedButton("Cancel upload photo.png")).toBeVisible();
  expect(screen.getByRole("progressbar")).toBeVisible();
  const thumbnail = openPreview.querySelector("img");
  if (!thumbnail) {
    throw new Error("Expected the image thumbnail");
  }
  fireEvent.load(thumbnail);

  transfer.resolve();
  await findNamedButton("Remove photo.png");
  expect(openPreview).toBeEnabled();
  click(openPreview);
  const dialog = await screen.findByRole("dialog", {
    name: "photo.png preview",
  });
  await waitFor(() => {
    expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
      "src",
      localUrl,
    );
  });
  expect(getNamedButton("Annotate", dialog)).toBeInTheDocument();
  click(getNamedButton("Close", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  click(getNamedButton("Remove photo.png"));
  await waitFor(() => {
    expect(queryNamedButton("Open image preview for photo.png")).toBeNull();
  });
  expect(blobs.revokedUrls).toContain(localUrl);
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
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  selectFile(new File(["media"], "send.mp4", { type: "video/mp4" }));
  await findNamedButton("Remove send.mp4");
  const preview = getNamedButton("Open video preview for send.mp4");
  await waitFor(() => {
    expect(preview.querySelector("video")).toHaveAttribute("src");
  });
  const localUrl = mediaSource(preview, "video").split("#")[0];
  await fillComposer(
    screen.getByRole("textbox", { name: "Message" }),
    "Review this recording.",
  );

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
  expect(blobs.revokedUrls).toContain(localUrl);
});

test("A restored private video opens its authenticated player even when its thumbnail fails", async () => {
  const video = draftAttachment("restored.mp4", {
    id: FILE_ID,
    contentType: "video/mp4",
  });
  const signedUrl = "https://private-files.example/restored.mp4?signature=test";
  mockAttachmentChat(context, { draft: draftForAttachment(video, "") });
  mockPrivateUrlSequence(context, { [FILE_ID]: [signedUrl] });
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  const preview = await findNamedButton("Open video preview for restored.mp4");
  await waitFor(() => {
    expect(preview.querySelector("video")).toHaveAttribute(
      "src",
      `${signedUrl}#t=0.001`,
    );
  });
  const thumbnail = preview.querySelector("video");
  if (!thumbnail) {
    throw new Error("Expected the video thumbnail");
  }
  fireEvent.error(thumbnail);

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
