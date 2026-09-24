import { artifactReferencePath } from "@okouai/api-contracts/contracts/artifact-references";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ATTACHMENT_THREAD_ID,
  boxAnnotation,
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

function composerFileInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) {
    throw new Error("Expected the composer file input");
  }
  return input;
}

function composerRoot(): HTMLElement {
  const composer = document.querySelector<HTMLElement>(
    "[data-slot='chat-composer-card']",
  );
  if (!composer) {
    throw new Error("Expected the chat composer");
  }
  return composer;
}

test("A user can paste or drop private attachments", async () => {
  mockAttachmentChat(context);
  context.mocks.upload.success({
    id: "a0000000-0000-4000-a000-000000000081",
    filename: "notes.txt",
    contentType: "text/plain",
    size: 11,
    url: artifactReferencePath(
      "a0000000-0000-4000-a000-000000000081",
      "notes.txt",
    ),
  });

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  const editor = await screen.findByRole("textbox", { name: "Message" });
  const textFile = new File(["file notes"], "notes.txt", {
    type: "text/plain",
  });
  fireEvent.paste(editor, {
    clipboardData: {
      getData: (type: string) => {
        return type === "text/plain" ? "Pasted planning notes" : "";
      },
      items: [
        {
          kind: "file",
          type: "text/plain",
          getAsFile: () => {
            return textFile;
          },
        },
      ],
    },
  });

  await expect(screen.findByText("notes.txt")).resolves.toBeVisible();
  await expect(findNamedButton("Remove notes.txt")).resolves.toBeVisible();
  await waitFor(() => {
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
      "Pasted planning notes",
    );
  });

  context.mocks.upload.success({
    id: "a0000000-0000-4000-a000-000000000082",
    filename: "brief.pdf",
    contentType: "application/pdf",
    size: 12,
    url: artifactReferencePath(
      "a0000000-0000-4000-a000-000000000082",
      "brief.pdf",
    ),
  });
  const pdf = new File(["pdf contents"], "brief.pdf", {
    type: "application/pdf",
  });
  // Drag-over exposes file metadata before the browser releases file data.
  fireEvent.dragOver(composerRoot(), {
    dataTransfer: { types: ["Files"], items: [], files: [] },
  });
  fireEvent.drop(composerRoot(), {
    dataTransfer: { types: ["Files"], files: [pdf] },
  });

  await expect(screen.findByText("brief.pdf")).resolves.toBeVisible();
  await expect(findNamedButton("Remove brief.pdf")).resolves.toBeVisible();
});

test("Image annotation is offered only when the feature is available", async () => {
  const image = draftAttachment("billing-page.png");
  mockAttachmentChat(context, {
    draft: draftForAttachment(image, ""),
  });

  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ComposerImageAnnotation]: false },
  });

  click(await findNamedButton("Open image preview for billing-page.png"));

  await expect(
    screen.findByRole("dialog", { name: "billing-page.png preview" }),
  ).resolves.toBeVisible();
  expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
    "alt",
    "billing-page.png",
  );
  expect(queryNamedButton("Annotate")).toBeNull();
});

test("A deliberate backdrop click closes an image preview", async () => {
  const image = draftAttachment("photo.png");
  mockAttachmentChat(context, {
    draft: draftForAttachment(image, ""),
  });

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  click(await findNamedButton("Open image preview for photo.png"));
  await expect(
    screen.findByRole("dialog", { name: "photo.png preview" }),
  ).resolves.toBeVisible();

  const viewport = document.querySelector('[data-slot="dialog-viewport"]');
  if (!viewport) {
    throw new Error("Expected the image preview viewport");
  }
  click(viewport);

  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "photo.png preview" }),
    ).not.toBeInTheDocument();
  });
});

test("A confirmed image annotation reaches the agent as structured data", async () => {
  const annotation = boxAnnotation([
    {
      id: "billing-mark",
      ordinal: 1,
      note: "Tighten this spacing",
    },
  ]);
  const image = draftAttachment("billing-page.png", {
    annotatedFileId: "draft-billing-page-annotated",
    annotations: annotation,
  });
  let sentRequest:
    | Parameters<
        NonNullable<
          NonNullable<Parameters<typeof mockAttachmentChat>[1]>["onSendRequest"]
        >
      >[0]
    | undefined;
  context.mocks.browser.imageDimensions(null);
  mockAttachmentChat(context, {
    draft: draftForAttachment(image, ""),
    threadTitle: "Annotation Agent",
    onSendRequest: (body) => {
      sentRequest = body;
    },
  });

  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ComposerImageAnnotation]: true },
  });

  const editor = await screen.findByRole("textbox", { name: "Message" });
  await expect(
    screen.findByTestId("composer-attachment-mark-count"),
  ).resolves.toHaveTextContent("1");
  await fillComposer(editor, "Fix the billing page");
  await userEvent.setup().keyboard("{Enter}");

  await waitFor(() => {
    expect(sentRequest).toBeDefined();
  });
  expect(sentRequest?.prompt).toBe("Fix the billing page");
  expect(sentRequest?.userMessage?.parts).toContainEqual({
    type: "file",
    fileId: image.id,
    filenameSnapshot: "billing-page.png",
    contentType: "image/png",
    annotatedFileId: image.annotatedFileId,
    annotations: annotation,
  });
});

test("Composer attachments show a clear upload lifecycle", async () => {
  mockAttachmentChat(context);
  context.mocks.upload.pending({
    id: "a0000000-0000-4000-a000-000000000083",
    filename: "proposal.docx",
    contentType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    size: 8,
    url: "https://cdn.vm7.io/artifacts/tests/chat-attachments/proposal.docx",
  });

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  await screen.findByRole("textbox", { name: "Message" });
  const documentFile = new File(["document"], "proposal.docx", {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  fireEvent.change(composerFileInput(), {
    target: { files: [documentFile] },
  });

  await expect(screen.findByText("proposal.docx")).resolves.toBeVisible();
  await expect(
    findNamedButton("Cancel upload proposal.docx"),
  ).resolves.toBeVisible();

  context.mocks.upload.success({
    id: "a0000000-0000-4000-a000-000000000084",
    filename: "dashboard.png",
    contentType: "image/png",
    size: 8,
    url: "https://cdn.vm7.io/artifacts/tests/chat-attachments/dashboard.png",
  });
  const imageFile = new File(["image"], "dashboard.png", {
    type: "image/png",
  });
  fireEvent.change(composerFileInput(), { target: { files: [imageFile] } });

  const openPreview = await findNamedButton(
    "Open image preview for dashboard.png",
  );
  await expect(findNamedButton("Remove dashboard.png")).resolves.toBeVisible();
  await screen.findByTestId("composer-image-preview-loading");
  const previewImage = openPreview.querySelector("img");
  if (!previewImage) {
    throw new Error("Expected the completed image thumbnail");
  }
  fireEvent.load(previewImage);
  await waitFor(() => {
    expect(screen.queryByTestId("composer-image-preview-loading")).toBeNull();
  });

  click(getNamedButton("Remove dashboard.png"));
  await waitFor(() => {
    expect(queryNamedButton("Remove dashboard.png")).toBeNull();
  });
});

test("A restored image draft uses its MIME type for a binary storage thumbnail", async () => {
  const originalUrl =
    `https://${"a".repeat(32)}.r2.cloudflarestorage.com/artifacts/draft-image.bin` +
    "?X-Amz-Signature=image-signature";
  const image = draftAttachment("image", {
    id: "a0000000-0000-4000-a000-000000000085",
    contentType: "image/jpeg",
    url: originalUrl,
  });
  mockAttachmentChat(context, { draft: draftForAttachment(image, "") });
  mockPrivateUrlSequence(context, { [image.id]: [originalUrl] });

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  await screen.findByRole("textbox", { name: "Message" });
  const openPreview = await findNamedButton("Open image preview for image");
  await waitFor(() => {
    expect(openPreview.querySelector("img")).toHaveAttribute(
      "src",
      `https://cdn.vm7.io/cdn-cgi/image/width=800,height=720,fit=scale-down,format=auto,quality=85,metadata=none/${originalUrl}`,
    );
  });
  click(openPreview);
  await expect(
    screen.findByTestId("attachment-lightbox-image"),
  ).resolves.toHaveAttribute("src", originalUrl);
});

test("Saved image annotations return with the draft", async () => {
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
    1600,
  );
  vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(
    900,
  );
  const annotation = boxAnnotation([
    { id: "saved-mark", ordinal: 1, note: "Align this edge" },
  ]);
  const image = draftAttachment("saved-layout.png", {
    annotatedFileId: "draft-saved-layout-annotated",
    annotations: annotation,
  });
  mockAttachmentChat(context, {
    draft: draftForAttachment(image, ""),
  });

  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ComposerImageAnnotation]: true },
  });

  await expect(
    screen.findByTestId("composer-attachment-mark-count"),
  ).resolves.toHaveTextContent("1");
  click(await findNamedButton("Open image preview for saved-layout.png"));

  const markLayer = await screen.findByTestId("annotation-mark-layer");
  await waitFor(() => {
    expect(markLayer).toBeVisible();
    expect(within(markLayer).getByText("1")).toBeVisible();
  });
});
