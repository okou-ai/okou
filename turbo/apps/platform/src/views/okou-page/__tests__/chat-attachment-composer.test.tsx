import { artifactReferencePath } from "@okouai/api-contracts/contracts/artifact-references";
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
  mockAttachmentChat,
} from "./chat-attachment-test-helpers.ts";
import { fillComposer } from "./chat-test-helpers.ts";

const context = testContext();

type SentRequest = Parameters<
  NonNullable<
    NonNullable<Parameters<typeof mockAttachmentChat>[1]>["onSendRequest"]
  >
>[0];

function composerRoot(): HTMLElement {
  const composer = document.querySelector<HTMLElement>(
    "[data-slot='chat-composer-card']",
  );
  if (!composer) {
    throw new Error("Expected the chat composer");
  }
  return composer;
}

async function expectComposerAttachment(filename: string) {
  await expect(
    within(composerRoot()).findByText(filename),
  ).resolves.toBeVisible();
  await expect(
    findNamedButton(`Remove ${filename}`, composerRoot()),
  ).resolves.toBeVisible();
}

test("Pasted text and file and a dropped PDF land in the composer", async () => {
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

  await expectComposerAttachment("notes.txt");
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

  await expectComposerAttachment("brief.pdf");
  await expectComposerAttachment("notes.txt");
});

test("A confirmed image annotation reaches the agent as structured data", async () => {
  const annotation = boxAnnotation([
    { id: "billing-mark", ordinal: 1, note: "Tighten this spacing" },
  ]);
  const image = draftAttachment("billing-page.png", {
    annotatedFileId: "draft-billing-page-annotated",
    annotations: annotation,
  });
  const sent: SentRequest[] = [];
  context.mocks.browser.imageDimensions(null);
  mockAttachmentChat(context, {
    draft: draftForAttachment(image, ""),
    threadTitle: "Annotation Agent",
    onSendRequest: (body) => {
      sent.push(body);
    },
  });

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  const editor = await screen.findByRole("textbox", { name: "Message" });
  await findNamedButton(
    "Open image preview for billing-page.png",
    composerRoot(),
  );
  await fillComposer(editor, "Fix the billing page");
  await userEvent.setup().keyboard("{Enter}");

  await waitFor(() => {
    expect(sent).toHaveLength(1);
  });
  expect(sent[0]?.prompt).toBe("Fix the billing page");
  expect(sent[0]?.userMessage?.parts).toContainEqual({
    type: "file",
    fileId: image.id,
    filenameSnapshot: "billing-page.png",
    contentType: "image/png",
    annotatedFileId: "draft-billing-page-annotated",
    annotations: annotation,
  });
});

test("A restored draft image keeps its saved annotation mark", async () => {
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
    1600,
  );
  vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(
    900,
  );
  const image = draftAttachment("saved-layout.png", {
    annotatedFileId: "draft-saved-layout-annotated",
    annotations: boxAnnotation([
      { id: "saved-mark", ordinal: 1, note: "Align this edge" },
    ]),
  });
  mockAttachmentChat(context, { draft: draftForAttachment(image, "") });

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  await expect(
    within(composerRoot()).findByTestId("composer-attachment-mark-count"),
  ).resolves.toHaveTextContent("1");
  click(await findNamedButton("Open image preview for saved-layout.png"));

  const preview = await screen.findByRole("dialog", {
    name: "saved-layout.png preview",
  });
  const markLayer = await within(preview).findByTestId("annotation-mark-layer");
  await waitFor(() => {
    expect(markLayer).toBeVisible();
    expect(within(markLayer).getByText("1")).toBeVisible();
  });
});
