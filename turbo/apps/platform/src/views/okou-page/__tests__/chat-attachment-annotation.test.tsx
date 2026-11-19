import {
  chatThreadByIdContract,
  type UserMessageInputPart,
} from "@okouai/api-contracts/contracts/chat-threads";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ATTACHMENT_THREAD_ID,
  boxAnnotation,
  draftAttachment,
  draftForAttachment,
  findNamedButton,
  mockAttachmentChat,
  mockPrivateUrlSequence,
  penAnnotation,
  privateAttachmentUrl,
} from "./chat-attachment-test-helpers.ts";

type SavedFilePart = Extract<UserMessageInputPart, { type: "file" }>;

const context = testContext();

function imageBytes() {
  return HttpResponse.arrayBuffer(new Uint8Array([1, 2, 3]).buffer, {
    headers: { "Content-Type": "image/png" },
  });
}

function mockMarkedCopyRendering(): void {
  context.mocks.browser.imageDimensions({ width: 800, height: 500 });
  context.mocks.browser.canvasRendering();
}

async function openChat(): Promise<void> {
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
}

async function openAnnotationEditor(filename: string): Promise<HTMLElement> {
  click(await findNamedButton(`Open image preview for ${filename}`));
  click(await findNamedButton("Annotate"));
  const surface = await screen.findByTestId("image-annotation-surface");
  vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 800,
    bottom: 500,
    width: 800,
    height: 500,
    toJSON: () => {
      return {};
    },
  });
  Object.defineProperty(surface, "setPointerCapture", {
    configurable: true,
    value: vi.fn<(pointerId: number) => void>(),
  });
  return surface;
}

function drawBox(surface: HTMLElement): void {
  fireEvent.pointerDown(surface, { clientX: 40, clientY: 30, pointerId: 1 });
  fireEvent.pointerMove(surface, { clientX: 200, clientY: 180, pointerId: 1 });
  fireEvent.pointerUp(surface, { clientX: 200, clientY: 180, pointerId: 1 });
}

function savedFilePart(
  fileId: string,
  ready: (part: SavedFilePart) => boolean,
) {
  const saved = context.mocks.deferred<SavedFilePart>();
  context.mocks.api(chatThreadByIdContract.patch, ({ body, respond }) => {
    const part = body.draftUserMessage?.parts.find((candidate) => {
      return candidate.type === "file" && candidate.fileId === fileId;
    });
    if (part?.type === "file" && ready(part) && !saved.settled()) {
      saved.resolve(part);
    }
    return respond(204);
  });
  return saved.promise;
}

async function expectOneSendableMark(): Promise<void> {
  await waitFor(() => {
    expect(
      screen.getByTestId("composer-attachment-mark-count"),
    ).toHaveTextContent("1");
    expect(screen.getByLabelText("Send")).toBeEnabled();
  });
}

function firstPenPoint(): [number, number] {
  const points =
    screen.getByTestId("annotation-mark-1").getAttribute("points") ?? "";
  const [x, y] = points.split(" ")[0]?.split(",").map(Number) ?? [];
  if (x === undefined || y === undefined) {
    throw new Error(`Expected stroke points, got "${points}"`);
  }
  return [x, y];
}

test("Pressing outside the annotation editor keeps it open with its drawn mark", async () => {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  const image = draftAttachment("stray-press.png");
  mockAttachmentChat(context, { draft: draftForAttachment(image, "") });
  await openChat();
  drawBox(await openAnnotationEditor("stray-press.png"));
  await screen.findByTestId("annotation-mark-1");

  const backdrop = document.querySelector('[data-slot="dialog-overlay"]');
  if (!backdrop) {
    throw new Error("Expected the annotation editor's dialog backdrop");
  }
  await user.click(backdrop);

  expect(screen.getByTestId("image-annotation-editor")).toBeVisible();
  expect(screen.getByTestId("annotation-mark-1")).toBeVisible();
});

test("Escape closes an edited annotation note while the editor stays open", async () => {
  const user = userEvent.setup();
  const image = draftAttachment("annotated-plan.png", {
    annotatedFileId: "draft-annotated-plan-rendered",
    annotations: boxAnnotation([
      { id: "editable-note", ordinal: 1, note: "Move the total higher" },
    ]),
  });
  mockAttachmentChat(context, { draft: draftForAttachment(image, "") });
  await openChat();
  await openAnnotationEditor("annotated-plan.png");

  await user.click(screen.getByTestId("annotation-note-label-editable-note"));
  const note = await screen.findByLabelText("What should change?");
  await waitFor(() => {
    expect(note).toHaveFocus();
  });
  await fill(note, "Align the total with the heading");
  await user.keyboard("{Escape}");

  const label = screen.getByTestId("annotation-note-label-editable-note");
  expect(label).toHaveTextContent("Align the total with the heading");
  expect(label).toBeVisible();
  expect(screen.queryByTestId("annotation-inline-editor")).toBeNull();
  expect(screen.getByTestId("image-annotation-editor")).toBeVisible();
});

test("A composing Enter keeps a text mark open until ordinary Enter confirms it", async () => {
  const user = userEvent.setup();
  const image = draftAttachment("ime-label.png");
  mockAttachmentChat(context, { draft: draftForAttachment(image, "") });
  await openChat();
  const surface = await openAnnotationEditor("ime-label.png");
  await user.keyboard("t");
  fireEvent.pointerDown(surface, { clientX: 320, clientY: 200, pointerId: 7 });
  fireEvent.pointerUp(surface, { clientX: 320, clientY: 200, pointerId: 7 });

  const input = await screen.findByLabelText("Type here");
  await waitFor(() => {
    expect(input).toHaveFocus();
  });
  fireEvent.compositionStart(input);
  fireEvent.change(input, { target: { value: "标注" } });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true, keyCode: 13 });

  expect(input).toHaveFocus();
  expect(input).toHaveValue("标注");

  fireEvent.compositionEnd(input, { data: "标注" });
  await user.keyboard("{Shift>}{Enter}{/Shift}Second line");
  expect(input).toHaveValue("标注\nSecond line");
  await user.keyboard("{Enter}");

  expect(screen.getByTestId("annotation-mark-1")).toHaveTextContent(
    "标注 Second line",
  );
  expect(screen.queryByLabelText("Type here")).toBeNull();
  expect(screen.getByTestId("image-annotation-panel")).toHaveFocus();
});

test("Attached marks are saved before their marked-up copy finishes uploading", async () => {
  const image = draftAttachment("leave-early.png");
  mockAttachmentChat(context, { draft: draftForAttachment(image, "") });
  context.mocks.http.get(image.url, imageBytes);
  mockMarkedCopyRendering();
  context.mocks.upload.pending({
    id: "draft-leave-early-annotated",
    filename: "leave-early.annotated.png",
    contentType: "image/png",
    size: 11,
    url: "https://cdn.vm7.io/artifacts/tests/chat-attachments/leave-early.annotated.png",
  });
  const saved = savedFilePart(image.id, (part) => {
    return part.annotations !== undefined;
  });
  await openChat();

  drawBox(await openAnnotationEditor("leave-early.png"));
  click(await findNamedButton("Attach marks"));

  const savedPart = await saved;
  expect(savedPart.annotations?.marks).toHaveLength(1);
  expect(savedPart.annotatedFileId).toBeUndefined();
});

test("A marked-up copy that fails to read can be retried until sending is enabled", async () => {
  const image = draftAttachment("flaky-copy.png");
  let failNextRead = true;
  mockAttachmentChat(context, { draft: draftForAttachment(image, "") });
  context.mocks.http.get(image.url, () => {
    if (failNextRead) {
      failNextRead = false;
      return HttpResponse.error();
    }
    return imageBytes();
  });
  mockMarkedCopyRendering();
  context.mocks.upload.success({
    id: "a0000000-0000-4000-a000-000000000096",
    filename: "flaky-copy.annotated.png",
    contentType: "image/png",
    size: 11,
    url: "https://files.example.test/flaky-copy.annotated.png",
  });
  await openChat();
  drawBox(await openAnnotationEditor("flaky-copy.png"));
  click(await findNamedButton("Attach marks"));

  click(await findNamedButton("Retry the marked-up copy of flaky-copy.png"));

  await waitFor(() => {
    expect(screen.getByLabelText("Send")).toBeEnabled();
  });
  expect(
    screen.queryByLabelText("Retry the marked-up copy of flaky-copy.png"),
  ).toBeNull();
});

test("Marks attach to a private image through its readable public URL", async () => {
  const fileId = "a0000000-0000-4000-a000-000000000091";
  const resourceUrl = "https://private-files.example/annotated-billing.png";
  const shareUrl = "https://cdn.vm7.io/annotated-billing.png";
  const image = draftAttachment("annotated-billing.png", {
    id: fileId,
    url: privateAttachmentUrl(fileId),
  });
  let publicReads = 0;
  mockAttachmentChat(context, { draft: draftForAttachment(image, "") });
  mockPrivateUrlSequence(
    context,
    { [fileId]: [resourceUrl] },
    { [fileId]: shareUrl },
  );
  context.mocks.http.get(resourceUrl, () => {
    return HttpResponse.error();
  });
  context.mocks.http.get(shareUrl, () => {
    publicReads += 1;
    return imageBytes();
  });
  mockMarkedCopyRendering();
  context.mocks.upload.success({
    id: "a0000000-0000-4000-a000-000000000092",
    filename: "annotated-billing.annotated.png",
    contentType: "image/png",
    size: 11,
    url: "https://files.example.test/annotated-billing.annotated.png",
  });
  await openChat();

  drawBox(await openAnnotationEditor("annotated-billing.png"));
  click(await findNamedButton("Attach marks"));

  await expectOneSendableMark();
  expect(screen.queryByTestId("image-annotation-editor")).toBeNull();
  expect(publicReads).toBeGreaterThan(0);
});

test("Confirmed marks are saved with their completed annotated file", async () => {
  const image = draftAttachment("persist-marks.png");
  const annotatedFileId = "a0000000-0000-4000-a000-000000000095";
  mockAttachmentChat(context, { draft: draftForAttachment(image, "") });
  context.mocks.http.get(image.url, imageBytes);
  mockMarkedCopyRendering();
  context.mocks.upload.success({
    id: annotatedFileId,
    filename: "persist-marks.annotated.png",
    contentType: "image/png",
    size: 11,
    url: "https://files.example.test/persist-marks.annotated.png",
  });
  const saved = savedFilePart(image.id, (part) => {
    return part.annotatedFileId !== undefined;
  });
  await openChat();

  drawBox(await openAnnotationEditor("persist-marks.png"));
  click(await findNamedButton("Attach marks"));

  const savedPart = await saved;
  expect(savedPart.annotatedFileId).toBe(annotatedFileId);
  expect(savedPart.annotations?.marks).toHaveLength(1);
  await expectOneSendableMark();
});

test("Marks attach to a public image after it was previewed", async () => {
  const image = draftAttachment("cached-preview.png");
  mockAttachmentChat(context, { draft: draftForAttachment(image, "") });
  context.mocks.browser.requestCacheMode();
  context.mocks.http.get(image.url, ({ request }) => {
    if (request.cache !== "no-store") {
      return HttpResponse.error();
    }
    return imageBytes();
  });
  mockMarkedCopyRendering();
  context.mocks.upload.success({
    id: "a0000000-0000-4000-a000-000000000094",
    filename: "cached-preview.annotated.png",
    contentType: "image/png",
    size: 11,
    url: "https://files.example.test/cached-preview.annotated.png",
  });
  await openChat();

  drawBox(await openAnnotationEditor("cached-preview.png"));
  click(await findNamedButton("Attach marks"));

  await expectOneSendableMark();
  expect(screen.queryByTestId("image-annotation-editor")).toBeNull();
});

test("A restored draft with marks rebuilds its copy from one image read and can send", async () => {
  const image = draftAttachment("restored-marks.png", {
    annotations: boxAnnotation([{ id: "restored-mark", ordinal: 1 }]),
  });
  let imageReads = 0;
  mockAttachmentChat(context, { draft: draftForAttachment(image, "") });
  context.mocks.http.get(image.url, () => {
    imageReads += 1;
    return imageBytes();
  });
  mockMarkedCopyRendering();
  context.mocks.upload.success({
    id: "a0000000-0000-4000-a000-000000000093",
    filename: "restored-marks.annotated.png",
    contentType: "image/png",
    size: 11,
    url: "https://files.example.test/restored-marks.annotated.png",
  });

  await openChat();

  await expectOneSendableMark();
  expect(imageReads).toBe(1);
});

test("A selected freehand stroke opens its note and moves with a drag", async () => {
  const image = draftAttachment("sketch.png", {
    annotatedFileId: "draft-sketch-annotated",
    annotations: penAnnotation("movable-stroke"),
  });
  mockAttachmentChat(context, { draft: draftForAttachment(image, "") });
  await openChat();
  const surface = await openAnnotationEditor("sketch.png");
  expect(firstPenPoint()).toStrictEqual([20, 25]);

  fireEvent.click(screen.getByTestId("annotation-mark-1"));
  await waitFor(() => {
    expect(screen.getByTestId("annotation-inline-editor")).toBeVisible();
  });
  fireEvent.pointerDown(screen.getByTestId("annotation-mark-1"), {
    clientX: 280,
    clientY: 200,
    pointerId: 3,
  });
  fireEvent.pointerMove(surface, { clientX: 360, clientY: 250, pointerId: 3 });
  fireEvent.pointerUp(surface, { clientX: 360, clientY: 250, pointerId: 3 });

  await waitFor(() => {
    const [x, y] = firstPenPoint();
    expect(x).toBeCloseTo(30, 6);
    expect(y).toBeCloseTo(35, 6);
  });
});

test("Enter confirms a note and one undo reverts a whole drag", async () => {
  const user = userEvent.setup();
  const image = draftAttachment("keyboard-plan.png", {
    annotatedFileId: "draft-keyboard-plan-annotated",
    annotations: boxAnnotation([{ id: "keyboard-mark", ordinal: 1 }]),
  });
  mockAttachmentChat(context, { draft: draftForAttachment(image, "") });
  await openChat();
  const surface = await openAnnotationEditor("keyboard-plan.png");
  expect(screen.getByTestId("annotation-mark-1")).toHaveStyle({ left: "8%" });

  fireEvent.click(screen.getByTestId("annotation-mark-1"));
  await fill(
    await screen.findByLabelText("What should change?"),
    "Raise this panel",
  );
  await user.keyboard("{Enter}");

  expect(
    screen.getByTestId("annotation-note-label-keyboard-mark"),
  ).toHaveTextContent("Raise this panel");
  expect(screen.queryByTestId("annotation-inline-editor")).toBeNull();

  fireEvent.pointerDown(screen.getByTestId("annotation-mark-1"), {
    clientX: 100,
    clientY: 80,
    pointerId: 4,
  });
  for (const clientX of [140, 180, 220, 260]) {
    fireEvent.pointerMove(surface, { clientX, clientY: 140, pointerId: 4 });
  }
  fireEvent.pointerUp(surface, { clientX: 260, clientY: 140, pointerId: 4 });
  expect(screen.getByTestId("annotation-mark-1").style.left).not.toBe("8%");

  await user.keyboard("{Control>}z{/Control}");
  await waitFor(() => {
    expect(screen.getByTestId("annotation-mark-1")).toHaveStyle({ left: "8%" });
  });
});
