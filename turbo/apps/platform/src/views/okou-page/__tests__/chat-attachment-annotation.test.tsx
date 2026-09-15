import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  arrowAnnotation,
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
import { fillComposer } from "./chat-test-helpers.ts";

const context = testContext();

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
  fireEvent.pointerDown(surface, {
    clientX: 40,
    clientY: 30,
    pointerId: 1,
  });
  fireEvent.pointerMove(surface, {
    clientX: 200,
    clientY: 180,
    pointerId: 1,
  });
  fireEvent.pointerUp(surface, {
    clientX: 200,
    clientY: 180,
    pointerId: 1,
  });
}

test("A selected annotation mark can be resized directly", async () => {
  const image = draftAttachment("resizable-layout.png", {
    annotatedFileId: "draft-resizable-layout-annotated",
    annotations: boxAnnotation([{ id: "resizable-mark", ordinal: 1 }]),
  });
  mockAttachmentChat(context, { draft: draftForAttachment(image, "") });

  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ComposerImageAnnotation]: true },
  });

  await openAnnotationEditor("resizable-layout.png");
  fireEvent.click(screen.getByTestId("annotation-mark-1"));

  expect(screen.getByTestId("annotation-handle-tl")).toBeVisible();
  expect(screen.getByTestId("annotation-handle-tr")).toBeVisible();
  expect(screen.getByTestId("annotation-handle-bl")).toBeVisible();
  expect(screen.getByTestId("annotation-handle-br")).toBeVisible();
});

test("Pressing outside the editor keeps the session and every mark drawn in it", async () => {
  // The editor used to be an inert overlay, so there was no dismissal to lose.
  // It now rides on a dialog that closes on an outside press by default, and
  // closing discards the whole session: marks live nowhere but here until
  // "Attach marks", and there is no undo across that boundary.
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  const image = draftAttachment("stray-press.png");
  mockAttachmentChat(context, { draft: draftForAttachment(image, "") });

  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ComposerImageAnnotation]: true },
  });

  const surface = await openAnnotationEditor("stray-press.png");
  drawBox(surface);
  await screen.findByTestId("annotation-mark-1");

  const backdrop = document.querySelector('[data-slot="dialog-overlay"]');
  if (!backdrop) {
    throw new Error("Expected the annotation editor's dialog backdrop");
  }
  await user.click(backdrop);

  expect(screen.getByTestId("image-annotation-editor")).toBeVisible();
  expect(screen.getByTestId("annotation-mark-1")).toBeVisible();
});

test("A user can click an annotation note, edit it, and close only the note", async () => {
  const user = userEvent.setup();
  const image = draftAttachment("annotated-plan.png", {
    annotatedFileId: "draft-annotated-plan-rendered",
    annotations: boxAnnotation([
      {
        id: "editable-note",
        ordinal: 1,
        note: "Move the total higher",
      },
    ]),
  });
  mockAttachmentChat(context, { draft: draftForAttachment(image, "") });

  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ComposerImageAnnotation]: true },
  });

  await openAnnotationEditor("annotated-plan.png");
  await user.click(screen.getByTestId("annotation-note-label-editable-note"));

  const note = await screen.findByLabelText("What should change?");
  await waitFor(() => {
    expect(note).toHaveFocus();
  });
  await fill(note, "Align the total with the heading");
  await user.keyboard("{Escape}");

  expect(screen.queryByTestId("annotation-inline-editor")).toBeNull();
  expect(screen.getByTestId("image-annotation-editor")).toBeVisible();
  const label = screen.getByTestId("annotation-note-label-editable-note");
  expect(label).toHaveTextContent("Align the total with the heading");
  // The printed note hugs its sentence: a note drawn as wide as its mark left
  // short sentences sitting in a strip of empty white. Only a wrap ceiling is
  // set now, never a width.
  expect(label.style.width).toBe("");
  expect(label).toHaveStyle({ maxWidth: "50%" });
});

/** Clicks the surface once, which is how a text mark is placed. */
function clickSurface(surface: HTMLElement, pointerId: number): void {
  fireEvent.pointerDown(surface, { clientX: 320, clientY: 200, pointerId });
  fireEvent.pointerUp(surface, { clientX: 320, clientY: 200, pointerId });
}

/**
 * The editor advertises a letter on every tool, and the letters only reach it
 * while nothing is being typed into. It opens over a composer whose message box
 * normally holds the caret, so the keys went into the message underneath and the
 * tooltips promised shortcuts that did nothing — bingjie: *"图2 的快捷键我这不好
 * 使"*. Typing then happens on the image itself rather than in a field below it.
 */
test("A tool shortcut works on open and text is typed onto the image", async () => {
  const user = userEvent.setup();
  const image = draftAttachment("typed-label.png");
  mockAttachmentChat(context, { draft: draftForAttachment(image, "") });

  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ComposerImageAnnotation]: true },
  });

  const surface = await openAnnotationEditor("typed-label.png");
  expect(screen.getByTestId("image-annotation-panel")).toHaveFocus();

  await user.keyboard("t");
  clickSurface(surface, 7);

  const input = await screen.findByLabelText("Type here");
  await waitFor(() => {
    expect(input).toHaveFocus();
  });
  // The label used to be typed into a popover below the picture while the words
  // appeared on it, so one string was shown in two places. Both kinds of mark
  // are written in the same field on the image now.
  expect(screen.getByTestId("annotation-inline-editor")).toContainElement(
    input,
  );

  await user.keyboard("Raise this");
  await user.keyboard("{Enter}");

  expect(screen.queryByLabelText("Type here")).toBeNull();
  expect(screen.getByTestId("annotation-mark-1")).toHaveTextContent(
    "Raise this",
  );
});

/**
 * A text mark exists from the moment the canvas is clicked, so backing out of
 * one left an invisible empty mark that still counted in the header and still
 * made the draft attachable.
 */
test("A text mark nobody typed into is discarded on Escape", async () => {
  const user = userEvent.setup();
  const image = draftAttachment("abandoned-label.png");
  mockAttachmentChat(context, { draft: draftForAttachment(image, "") });

  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ComposerImageAnnotation]: true },
  });

  const surface = await openAnnotationEditor("abandoned-label.png");
  await user.keyboard("t");
  clickSurface(surface, 8);

  await screen.findByLabelText("Type here");
  await expect(findNamedButton("Attach marks")).resolves.toBeEnabled();

  await user.keyboard("{Escape}");

  expect(screen.queryByLabelText("Type here")).toBeNull();
  expect(screen.getByTestId("image-annotation-editor")).toBeVisible();
  await expect(findNamedButton("Attach marks")).resolves.toBeDisabled();
});

/**
 * Two text marks share one editor element, so the caret has to follow the mark
 * that was clicked rather than the first one that mounted.
 */
test("Clicking a second text mark moves the caret to it", async () => {
  const image = draftAttachment("two-labels.png", {
    annotatedFileId: "draft-two-labels-annotated",
    annotations: {
      marks: [
        {
          id: "first-label",
          ordinal: 1,
          shape: "text" as const,
          at: { x: 0.2, y: 0.3 },
          text: "Before",
          ink: "#5E6AD2" as const,
        },
        {
          id: "second-label",
          ordinal: 2,
          shape: "text" as const,
          at: { x: 0.6, y: 0.5 },
          text: "After",
          ink: "#5E6AD2" as const,
        },
      ],
    },
  });
  mockAttachmentChat(context, { draft: draftForAttachment(image, "") });

  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ComposerImageAnnotation]: true },
  });

  await openAnnotationEditor("two-labels.png");
  fireEvent.click(screen.getByTestId("annotation-mark-1"));

  const first = await screen.findByDisplayValue("Before");
  await waitFor(() => {
    expect(first).toHaveFocus();
  });

  fireEvent.click(screen.getByTestId("annotation-mark-2"));

  const second = await screen.findByDisplayValue("After");
  await waitFor(() => {
    expect(second).toHaveFocus();
  });
});

/**
 * A mark drag ends where the button is released, including over the field that
 * has just opened underneath the pointer. That field used to swallow the
 * release, so the drag never ended and the mark went on following an unpressed
 * mouse — Tong: *"只是松开鼠标，text还是跟着鼠标走"*.
 */
test("Releasing a drag over the mark's own field ends the drag", async () => {
  const image = draftAttachment("dragged-label.png", {
    annotatedFileId: "draft-dragged-label-annotated",
    annotations: {
      marks: [
        {
          id: "dragged-label",
          ordinal: 1,
          shape: "text" as const,
          at: { x: 0.2, y: 0.3 },
          text: "Move me",
          ink: "#5E6AD2" as const,
        },
      ],
    },
  });
  mockAttachmentChat(context, { draft: draftForAttachment(image, "") });

  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ComposerImageAnnotation]: true },
  });

  const surface = await openAnnotationEditor("dragged-label.png");
  // Grabbing the mark opens its field under the pointer, mid-gesture.
  fireEvent.pointerDown(screen.getByTestId("annotation-mark-1"), {
    clientX: 160,
    clientY: 150,
    pointerId: 9,
  });
  fireEvent.pointerMove(surface, { clientX: 300, clientY: 250, pointerId: 9 });

  const field = await screen.findByTestId("annotation-inline-editor");
  fireEvent.pointerUp(field, { clientX: 300, clientY: 250, pointerId: 9 });
  const released = field.style.left;

  // Nothing is held now, so the pointer moving on is not the mark moving on.
  fireEvent.pointerMove(surface, { clientX: 600, clientY: 420, pointerId: 9 });

  expect(field.style.left).toBe(released);
});

/**
 * A note is written on the image in the field it will be printed in, so a long
 * one wraps instead of scrolling out of a fixed-width box, and Shift+Enter
 * breaks a line — neither of which the single-line popover input could do.
 */
test("A note can be written over more than one line", async () => {
  const user = userEvent.setup();
  const image = draftAttachment("long-note.png", {
    annotatedFileId: "draft-long-note-annotated",
    annotations: boxAnnotation([{ id: "wordy-mark", ordinal: 1 }]),
  });
  mockAttachmentChat(context, { draft: draftForAttachment(image, "") });

  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ComposerImageAnnotation]: true },
  });

  await openAnnotationEditor("long-note.png");
  fireEvent.click(screen.getByTestId("annotation-mark-1"));

  const field = await screen.findByLabelText("What should change?");
  await fill(field, "Align the total with the heading");
  await user.keyboard("{Shift>}{Enter}{/Shift}");
  await user.keyboard("and drop the divider");

  expect(field).toHaveValue(
    "Align the total with the heading\nand drop the divider",
  );

  await user.keyboard("{Enter}");

  expect(
    screen.getByTestId("annotation-note-label-wordy-mark").textContent,
  ).toBe("Align the total with the heading\nand drop the divider");
});

/** One text mark with words in it, for the tests that resize or delete one. */
function labelAttachment(filename: string, id: string) {
  return draftAttachment(filename, {
    annotatedFileId: `draft-${id}-annotated`,
    annotations: {
      marks: [
        {
          id,
          ordinal: 1,
          shape: "text" as const,
          at: { x: 0.2, y: 0.3 },
          text: "Raise this",
          ink: "#5E6AD2" as const,
        },
      ],
    },
  });
}

/**
 * A label is resized by its corners — Tong: *"text 也应该有四角拖动的标记吧？拖四角
 * 可以放大缩小文字"*. The corner opposite the one in hand stays put, so dragging
 * the bottom-right grip away from the words enlarges them without moving where
 * the label starts.
 */
test("Dragging a label's corner resizes its type", async () => {
  const image = labelAttachment("resizable-label.png", "sized-label");
  mockAttachmentChat(context, { draft: draftForAttachment(image, "") });

  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ComposerImageAnnotation]: true },
  });

  const surface = await openAnnotationEditor("resizable-label.png");
  fireEvent.click(screen.getByTestId("annotation-mark-1"));

  const field = await screen.findByTestId("annotation-inline-editor");
  // One fixed selection colour, never the mark's own ink: in the ink the frame
  // reads as part of the annotation, and the yellow one disappears.
  expect(field.style.outline).toBe("#2F6FED dashed 1px");
  const before = field.style.fontSize;
  vi.spyOn(field, "getBoundingClientRect").mockReturnValue({
    x: 160,
    y: 150,
    top: 150,
    left: 160,
    right: 260,
    bottom: 175,
    width: 100,
    height: 25,
    toJSON: () => {
      return {};
    },
  });

  fireEvent.pointerDown(screen.getByTestId("annotation-label-handle-br"), {
    clientX: 260,
    clientY: 175,
    pointerId: 11,
  });
  fireEvent.pointerMove(surface, { clientX: 420, clientY: 250, pointerId: 11 });
  fireEvent.pointerUp(surface, { clientX: 420, clientY: 250, pointerId: 11 });

  await waitFor(() => {
    expect(
      Number.parseFloat(
        screen.getByTestId("annotation-inline-editor").style.fontSize,
      ),
    ).toBeGreaterThan(Number.parseFloat(before || "14"));
  });
  // The grabbed corner moved; the opposite one is what the label grew from.
  expect(screen.getByTestId("annotation-inline-editor").style.left).toBe("20%");
});

/**
 * There is no bin any more — Tong: *"所有text 都不需要加delete button，让用户直接
 * 退回删除或者全选text删除就成"*. Emptying the field and pressing backspace once
 * more is the delete path.
 */
test("Emptying a mark's words and backspacing again removes it", async () => {
  const user = userEvent.setup();
  const image = labelAttachment("deletable-label.png", "spare-label");
  mockAttachmentChat(context, { draft: draftForAttachment(image, "") });

  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ComposerImageAnnotation]: true },
  });

  await openAnnotationEditor("deletable-label.png");
  fireEvent.click(screen.getByTestId("annotation-mark-1"));
  const editor = await screen.findByTestId("annotation-inline-editor");
  // The bin that used to sit beside the words is gone; the one in the pill is
  // the only delete control, and it is not on the picture.
  expect(queryAllByRoleFast("button", editor)).toHaveLength(0);

  const field = await screen.findByDisplayValue("Raise this");
  await fill(field, "");
  await user.keyboard("{Backspace}");

  await waitFor(() => {
    expect(screen.queryByTestId("annotation-inline-editor")).toBeNull();
  });
  expect(screen.queryByTestId("annotation-mark-1")).toBeNull();
  expect(screen.getByText("0 marks")).toBeVisible();
});

/**
 * Undo, redo and delete sit together in the pill, next to the tools. Delete
 * only means something while a mark is open, so it says so until one is.
 */
test("The pill deletes the open mark and is dead until one is", async () => {
  const image = draftAttachment("pill-delete.png", {
    annotatedFileId: "draft-pill-delete-annotated",
    annotations: boxAnnotation([{ id: "doomed-mark", ordinal: 1 }]),
  });
  mockAttachmentChat(context, { draft: draftForAttachment(image, "") });

  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ComposerImageAnnotation]: true },
  });

  await openAnnotationEditor("pill-delete.png");
  await expect(findNamedButton("Remove mark")).resolves.toBeDisabled();

  fireEvent.click(screen.getByTestId("annotation-mark-1"));
  const remove = await findNamedButton("Remove mark");
  await waitFor(() => {
    expect(remove).toBeEnabled();
  });

  click(remove);

  await waitFor(() => {
    expect(screen.queryByTestId("annotation-mark-1")).toBeNull();
  });
  expect(screen.getByText("0 marks")).toBeVisible();
});

/**
 * Switching tools throws the open mark away, so a tool letter is only a tool
 * letter while nothing is open — Tong: *"我在输入文字的时候，如果按到了快捷按钮，
 * 也不应该直接切换mark啊，只有为未选中任何mark的情况，按快捷按钮才会切换功能项"*.
 * The caret can be a frame late on the field, and a keystroke landing in that
 * gap must not cost the mark.
 */
test("A tool letter is ignored while a mark is open", async () => {
  const user = userEvent.setup();
  const image = draftAttachment("busy-typing.png", {
    annotatedFileId: "draft-busy-typing-annotated",
    annotations: boxAnnotation([{ id: "typing-mark", ordinal: 1 }]),
  });
  mockAttachmentChat(context, { draft: draftForAttachment(image, "") });

  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ComposerImageAnnotation]: true },
  });

  const surface = await openAnnotationEditor("busy-typing.png");
  fireEvent.click(screen.getByTestId("annotation-mark-1"));
  const note = await screen.findByLabelText("What should change?");
  await waitFor(() => {
    expect(note).toHaveFocus();
  });

  // The keystroke that misses the field, because the caret has not landed yet.
  note.blur();
  await user.keyboard("t");

  expect(screen.getByTestId("annotation-inline-editor")).toBeVisible();
  // Still the box tool: a drag draws a second box, not a label.
  drawBox(surface);
  await expect(screen.findByTestId("annotation-mark-2")).resolves.toBeVisible();
  expect(screen.getByTestId("annotation-mark-2")).toHaveStyle({ left: "5%" });
});

test("A confirmed annotation blocks sending while its image uploads", async () => {
  const image = draftAttachment("billing-page.png");
  mockAttachmentChat(context, { draft: draftForAttachment(image, "") });
  context.mocks.http.get(image.url, () => {
    return HttpResponse.arrayBuffer(new Uint8Array([1, 2, 3]).buffer, {
      headers: { "Content-Type": "image/png" },
    });
  });
  context.mocks.browser.imageDimensions({ width: 800, height: 500 });
  context.mocks.browser.canvasRendering();
  context.mocks.upload.pending({
    id: "draft-billing-page-annotated",
    filename: "billing-page.annotated.png",
    contentType: "image/png",
    size: 11,
    url: "https://cdn.vm7.io/artifacts/tests/chat-attachments/billing-page.annotated.png",
  });

  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ComposerImageAnnotation]: true },
  });

  await fillComposer(
    await screen.findByRole("textbox", { name: "Message" }),
    "Fix the billing page",
  );
  await expect(screen.findByLabelText("Send")).resolves.toBeEnabled();

  const surface = await openAnnotationEditor("billing-page.png");
  drawBox(surface);
  click(await findNamedButton("Attach marks"));

  await waitFor(() => {
    expect(screen.queryByTestId("image-annotation-editor")).toBeNull();
    expect(screen.getByLabelText("Send")).toBeDisabled();
  });
});

test("A user can attach marks to a private image through its public URL", async () => {
  const fileId = "a0000000-0000-4000-a000-000000000091";
  const resourceUrl = "https://private-files.example/annotated-billing.png";
  const shareUrl = "https://cdn.vm7.io/annotated-billing.png";
  const image = draftAttachment("annotated-billing.png", {
    id: fileId,
    url: privateAttachmentUrl(fileId),
  });
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
    return HttpResponse.arrayBuffer(new Uint8Array([1, 2, 3]).buffer, {
      headers: { "Content-Type": "image/png" },
    });
  });
  context.mocks.browser.imageDimensions({ width: 800, height: 500 });
  context.mocks.browser.canvasRendering();
  context.mocks.upload.success({
    id: "a0000000-0000-4000-a000-000000000092",
    filename: "annotated-billing.annotated.png",
    contentType: "image/png",
    size: 11,
    url: "https://files.example.test/annotated-billing.annotated.png",
  });

  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ComposerImageAnnotation]: true },
  });

  const surface = await openAnnotationEditor("annotated-billing.png");
  drawBox(surface);
  click(await findNamedButton("Attach marks"));

  await waitFor(() => {
    expect(screen.queryByTestId("image-annotation-editor")).toBeNull();
    expect(
      screen.getByTestId("composer-attachment-mark-count"),
    ).toHaveTextContent("1");
    expect(screen.getByLabelText("Send")).toBeEnabled();
  });
  expect(
    screen.queryByLabelText(
      "Failed to upload annotated-billing.png. Try again.",
    ),
  ).toBeNull();
});

test("A user can attach marks after previewing a public image", async () => {
  const image = draftAttachment("cached-preview.png");
  mockAttachmentChat(context, { draft: draftForAttachment(image, "") });
  context.mocks.browser.requestCacheMode();
  context.mocks.http.get(image.url, ({ request }) => {
    // A plain cross-origin <img> can populate the browser cache with an opaque
    // response. Reading pixels must bypass that entry and perform a CORS fetch.
    if (request.cache !== "no-store") {
      return HttpResponse.error();
    }
    return HttpResponse.arrayBuffer(new Uint8Array([1, 2, 3]).buffer, {
      headers: { "Content-Type": "image/png" },
    });
  });
  context.mocks.browser.imageDimensions({ width: 800, height: 500 });
  context.mocks.browser.canvasRendering();
  context.mocks.upload.success({
    id: "a0000000-0000-4000-a000-000000000094",
    filename: "cached-preview.annotated.png",
    contentType: "image/png",
    size: 11,
    url: "https://files.example.test/cached-preview.annotated.png",
  });

  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ComposerImageAnnotation]: true },
  });

  const surface = await openAnnotationEditor("cached-preview.png");
  drawBox(surface);
  click(await findNamedButton("Attach marks"));

  await waitFor(() => {
    expect(screen.queryByTestId("image-annotation-editor")).toBeNull();
    expect(
      screen.getByTestId("composer-attachment-mark-count"),
    ).toHaveTextContent("1");
    expect(screen.getByLabelText("Send")).toBeEnabled();
  });
  expect(
    screen.queryByLabelText("Failed to upload cached-preview.png. Try again."),
  ).toBeNull();
});

test("Retry attaching marks when the original image cannot be read", async () => {
  const image = draftAttachment("retry-billing.png");
  let imageReads = 0;
  mockAttachmentChat(context, { draft: draftForAttachment(image, "") });
  context.mocks.http.get(image.url, () => {
    imageReads += 1;
    if (imageReads === 1) {
      return new HttpResponse(null, { status: 403, statusText: "Forbidden" });
    }
    return HttpResponse.arrayBuffer(new Uint8Array([1, 2, 3]).buffer, {
      headers: { "Content-Type": "image/png" },
    });
  });
  context.mocks.browser.imageDimensions({ width: 800, height: 500 });
  context.mocks.browser.canvasRendering();
  context.mocks.upload.success({
    id: "a0000000-0000-4000-a000-000000000093",
    filename: "retry-billing.annotated.png",
    contentType: "image/png",
    size: 11,
    url: "https://files.example.test/retry-billing.annotated.png",
  });

  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ComposerImageAnnotation]: true },
  });

  const surface = await openAnnotationEditor("retry-billing.png");
  drawBox(surface);
  click(await findNamedButton("Attach marks"));

  const retry = await findNamedButton(
    "Failed to upload retry-billing.png. Try again.",
  );
  expect(
    screen.getByTestId("composer-attachment-mark-count"),
  ).toHaveTextContent("1");
  expect(screen.getByLabelText("Send")).toBeDisabled();

  click(retry);

  await waitFor(() => {
    expect(
      screen.queryByLabelText("Failed to upload retry-billing.png. Try again."),
    ).toBeNull();
    expect(screen.getByLabelText("Send")).toBeEnabled();
  });
  expect(imageReads).toBe(2);
});

/**
 * A draft that carries marks but no annotated copy is missing a derivative, not
 * a failure — nothing was ever attempted for it. Reporting `failed` put a retry
 * badge on it, and committing wrote exactly that shape by saving before the
 * copy finished uploading.
 *
 * Restoring rebuilds the copy instead. This enters through the chat-thread page
 * load, which reaches `seed$` rather than `restoreAttachments$`: the state is
 * set for every restored attachment, so the rebuild has to cover every path
 * that restores one. Asserting only that no badge appears would pass on a
 * permanently pending attachment that can never be sent, so this pins the
 * composer becoming sendable.
 */
test("A draft with marks but no annotated copy rebuilds it and can send", async () => {
  const image = draftAttachment("restored-marks.png", {
    annotations: boxAnnotation([{ id: "restored-mark", ordinal: 1 }]),
  });
  let imageReads = 0;
  mockAttachmentChat(context, { draft: draftForAttachment(image, "") });
  context.mocks.http.get(image.url, () => {
    imageReads += 1;
    return HttpResponse.arrayBuffer(new Uint8Array([1, 2, 3]).buffer, {
      headers: { "Content-Type": "image/png" },
    });
  });
  context.mocks.browser.imageDimensions({ width: 800, height: 500 });
  context.mocks.browser.canvasRendering();
  context.mocks.upload.success({
    id: "a0000000-0000-4000-a000-000000000093",
    filename: "restored-marks.annotated.png",
    contentType: "image/png",
    size: 11,
    url: "https://files.example.test/restored-marks.annotated.png",
  });

  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ComposerImageAnnotation]: true },
  });

  await waitFor(() => {
    expect(
      screen.getByTestId("composer-attachment-mark-count"),
    ).toHaveTextContent("1");
    expect(screen.getByLabelText("Send")).toBeEnabled();
  });
  // Rebuilt from the original rather than presented as a failure.
  expect(imageReads).toBe(1);
  expect(screen.queryByLabelText(/Try again/)).toBeNull();
});

test("An arrow can be selected and re-aimed by dragging its tip", async () => {
  const image = draftAttachment("arrow-flow.png", {
    annotatedFileId: "draft-arrow-flow-annotated",
    annotations: arrowAnnotation("aimable-arrow"),
  });
  mockAttachmentChat(context, { draft: draftForAttachment(image, "") });

  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ComposerImageAnnotation]: true },
  });

  const surface = await openAnnotationEditor("arrow-flow.png");
  // The arrow used to render as decoration, so this click reached the canvas
  // underneath and started a new stroke instead of selecting anything.
  fireEvent.click(screen.getByTestId("annotation-mark-1"));

  const tip = screen.getByTestId("annotation-handle-to");
  expect(tip).toBeVisible();
  expect(screen.getByTestId("annotation-handle-from")).toBeVisible();
  // An arrow is aimed, not resized: it gets two ends rather than eight grips.
  expect(screen.queryByTestId("annotation-handle-tl")).toBeNull();

  fireEvent.pointerDown(tip, { clientX: 560, clientY: 300, pointerId: 2 });
  fireEvent.pointerMove(surface, { clientX: 200, clientY: 450, pointerId: 2 });
  fireEvent.pointerUp(surface, { clientX: 200, clientY: 450, pointerId: 2 });

  await waitFor(() => {
    expect(screen.getByTestId("annotation-handle-to")).toHaveStyle({
      left: "25%",
      top: "90%",
    });
  });
});

/** The first vertex of the rendered freehand stroke, in percent-of-image units. */
function firstPenPoint(): [number, number] {
  const points =
    screen.getByTestId("annotation-mark-1").getAttribute("points") ?? "";
  const [x, y] = points.split(" ")[0]?.split(",").map(Number) ?? [];
  if (x === undefined || y === undefined) {
    throw new Error(`Expected stroke points, got "${points}"`);
  }
  return [x, y];
}

test("A freehand stroke can be selected and moved", async () => {
  const image = draftAttachment("sketch.png", {
    annotatedFileId: "draft-sketch-annotated",
    annotations: penAnnotation("movable-stroke"),
  });
  mockAttachmentChat(context, { draft: draftForAttachment(image, "") });

  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ComposerImageAnnotation]: true },
  });

  const surface = await openAnnotationEditor("sketch.png");
  fireEvent.click(screen.getByTestId("annotation-mark-1"));

  // A stroke draws no selection furniture of its own — its note field opening
  // is what says the click landed on it.
  await waitFor(() => {
    expect(screen.getByTestId("annotation-inline-editor")).toBeVisible();
  });
  expect(firstPenPoint()).toStrictEqual([20, 25]);

  fireEvent.pointerDown(screen.getByTestId("annotation-mark-1"), {
    clientX: 280,
    clientY: 200,
    pointerId: 3,
  });
  fireEvent.pointerMove(surface, { clientX: 360, clientY: 250, pointerId: 3 });
  fireEvent.pointerUp(surface, { clientX: 360, clientY: 250, pointerId: 3 });

  // Compared as numbers: the offset accumulates in floating point, so the point
  // lands on 30.000000000000004 and an exact match would be asserting the
  // arithmetic rather than the move.
  await waitFor(() => {
    const [x, y] = firstPenPoint();
    expect(x).toBeCloseTo(30, 6);
    expect(y).toBeCloseTo(35, 6);
  });
});

test("Enter confirms a note and one drag is a single undo step", async () => {
  const user = userEvent.setup();
  const image = draftAttachment("keyboard-plan.png", {
    annotatedFileId: "draft-keyboard-plan-annotated",
    annotations: boxAnnotation([{ id: "keyboard-mark", ordinal: 1 }]),
  });
  mockAttachmentChat(context, { draft: draftForAttachment(image, "") });

  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ComposerImageAnnotation]: true },
  });

  const surface = await openAnnotationEditor("keyboard-plan.png");
  fireEvent.click(screen.getByTestId("annotation-mark-1"));

  const note = await screen.findByLabelText("What should change?");
  await fill(note, "Raise this panel");
  // Enter had no binding at all: the only way out of the field was Escape or
  // clicking off it.
  await user.keyboard("{Enter}");
  expect(screen.queryByTestId("annotation-inline-editor")).toBeNull();
  expect(
    screen.getByTestId("annotation-note-label-keyboard-mark"),
  ).toHaveTextContent("Raise this panel");

  // Every pointer move used to push its own history entry, so undoing one
  // gesture took one Cmd+Z per frame it lasted.
  fireEvent.pointerDown(screen.getByTestId("annotation-mark-1"), {
    clientX: 100,
    clientY: 80,
    pointerId: 4,
  });
  for (const clientX of [140, 180, 220, 260]) {
    fireEvent.pointerMove(surface, { clientX, clientY: 140, pointerId: 4 });
  }
  fireEvent.pointerUp(surface, { clientX: 260, clientY: 140, pointerId: 4 });

  const moved = screen.getByTestId("annotation-mark-1").style.left;
  expect(moved).not.toBe("8%");

  await user.keyboard("{Control>}z{/Control}");
  await waitFor(() => {
    expect(screen.getByTestId("annotation-mark-1")).toHaveStyle({ left: "8%" });
  });
});
