import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { chatThreadByIdContract } from "@okouai/api-contracts/contracts/chat-threads";
import { HttpResponse } from "msw";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  penAnnotation,
  privateAttachmentUrl,
  queryNamedButton,
} from "./chat-attachment-test-helpers.ts";
import { findEnabledButton } from "./chat-run-test-fixtures.ts";

const context = testContext();
const name = "freight-plan.png";
const original = draftAttachment(name, { id: "design-image" });
const copy = {
  id: "annotated-plan",
  filename: "freight-plan-marked.png",
  contentType: "image/png",
  size: 300,
  url: "https://cdn.vm7.io/marked-plan.png",
} as const;

function imageDraft(options: Partial<typeof original> = {}) {
  context.mocks.browser.canvasRendering();
  context.mocks.browser.imageDimensions({ width: 500, height: 400 });
  mockAttachmentChat(context, {
    draft: draftForAttachment(
      { ...original, ...options },
      "Inspect this drawing",
    ),
  });
}

async function annotate() {
  await setupPage({
    context,
    path: "/chats/" + ATTACHMENT_THREAD_ID,
    host: "app.okou.ai",
  });
  click(await findEnabledButton("Open image preview for " + name));
  click(await findNamedButton("Annotate"));
  const panel = await screen.findByRole("dialog", { name: "Annotate" });
  const surface = await within(panel).findByTestId("image-annotation-surface");
  vi.spyOn(surface, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 500, 400),
  );
  return { panel, surface };
}

function drag(
  start: Element,
  surface: Element,
  [x, y]: readonly [number, number],
  [dx, dy]: readonly [number, number],
) {
  fireEvent.pointerDown(start, {
    pointerId: 1,
    button: 0,
    clientX: x,
    clientY: y,
  });
  fireEvent.pointerMove(surface, {
    pointerId: 1,
    buttons: 1,
    clientX: x + dx,
    clientY: y + dy,
  });
  fireEvent.pointerUp(surface, {
    pointerId: 1,
    button: 0,
    clientX: x + dx,
    clientY: y + dy,
  });
}

async function drawBox() {
  const { panel, surface } = await annotate();
  click(await findNamedButton("Box", panel));
  drag(surface, surface, [85, 100], [110, 60]);
  await within(panel).findByTestId("annotation-mark-1");
  return panel;
}

function originalBytes() {
  return new HttpResponse(new Uint8Array([11, 22, 33]), {
    headers: { "Content-Type": "image/png" },
  });
}

function persisted(complete: boolean) {
  const result = context.mocks.deferred<unknown>();
  context.mocks.api(
    chatThreadByIdContract.patch,
    ({ params, body, respond }) => {
      const part = body.draftUserMessage?.parts.find((p) => {
        return p.type === "file" && p.fileId === original.id;
      });
      if (
        params.id === ATTACHMENT_THREAD_ID &&
        part?.type === "file" &&
        part.annotations?.marks.length &&
        (!complete || part.annotatedFileId === copy.id)
      ) {
        result.resolve(part);
      }
      return respond(204);
    },
  );
  return result.promise;
}

test("chat-attachment-annotation-001 outside press preserves the drawn box", async () => {
  imageDraft();
  const panel = await drawBox();
  const outside = panel.closest<HTMLElement>('[data-slot="dialog-viewport"]');
  if (!outside) {
    throw new Error("Annotation dialog viewport is missing");
  }
  await userEvent.setup().click(outside);
  expect(panel).toBeVisible();
  expect(within(panel).getByTestId("annotation-mark-1")).toBeVisible();
});

test("chat-attachment-annotation-002 Escape leaves the revised note on the canvas", async () => {
  imageDraft({
    annotations: boxAnnotation([
      { id: "position", ordinal: 1, note: "Move the total higher" },
    ]),
    annotatedFileId: copy.id,
  });
  const { panel } = await annotate();
  click(await within(panel).findByText("Move the total higher"));
  const field = await within(panel).findByRole("textbox");
  await fill(field, "Align the total with the heading");
  await userEvent.setup().keyboard("{Escape}");
  expect(within(panel).queryByRole("textbox")).toBeNull();
  expect(panel).toBeVisible();
  expect(
    within(panel).getByText("Align the total with the heading"),
  ).toBeVisible();
});

test("chat-attachment-annotation-004 composing Enter preserves input and plain Enter confirms both lines", async () => {
  imageDraft();
  const { panel, surface } = await annotate();
  click(await findNamedButton("Text", panel));
  drag(surface, surface, [112, 95], [0, 0]);
  const field = await within(panel).findByRole("textbox");
  fireEvent.compositionStart(field);
  fireEvent.change(field, { target: { value: "标注" } });
  fireEvent.keyDown(field, { key: "Enter", isComposing: true, keyCode: 13 });
  expect(field).toHaveValue("标注");
  expect(field).toHaveFocus();
  fireEvent.compositionEnd(field, { data: "标注" });
  const user = userEvent.setup();
  await user.keyboard("{Shift>}{Enter}{/Shift}Second line");
  expect(field).toHaveValue("标注\nSecond line");
  await user.keyboard("{Enter}");
  expect(within(panel).queryByRole("textbox")).toBeNull();
  expect(within(panel).getByText("标注 Second line")).toBeVisible();
  expect(within(panel).getByTestId("image-annotation-panel")).toHaveFocus();
});

test("chat-attachment-annotation-013 the saved draft retains the mark while its upload is pending", async () => {
  imageDraft();
  context.mocks.http.get(original.url, originalBytes);
  context.mocks.upload.pending(copy);
  const saved = persisted(false);
  const panel = await drawBox();
  click(await findNamedButton("Attach marks", panel));
  const file = await saved;
  expect(file).toMatchObject({
    fileId: original.id,
    annotations: { marks: [{ shape: "box" }] },
  });
  expect(file).not.toHaveProperty("annotatedFileId");
});

test("chat-attachment-annotation-014 retrying the failed copy unlocks sending", async () => {
  imageDraft();
  context.mocks.http.get(original.url, originalBytes);
  context.mocks.upload.success(copy);
  let storageAvailable = false;
  context.mocks.http.put("https://mock-upload.r2.test/" + copy.id, () => {
    return new HttpResponse(null, { status: storageAvailable ? 200 : 503 });
  });
  const panel = await drawBox();
  click(await findNamedButton("Attach marks", panel));
  const retryLabel = "Retry the marked-up copy of " + name;
  const retry = await findNamedButton(retryLabel);
  await expect(findNamedButton("Send")).resolves.toBeDisabled();
  storageAvailable = true;
  click(retry);
  await findEnabledButton("Send");
  expect(queryNamedButton(retryLabel)).toBeNull();
});

test("chat-attachment-annotation-015 the public image produces the copy when its private read fails", async () => {
  const cdn = "https://cdn.vm7.io/signed/design.png";
  imageDraft({ url: privateAttachmentUrl(original.id) });
  context.mocks.api(webFilesContract.fileUrl, ({ respond }) => {
    return respond(200, {
      url: cdn,
      downloadUrl: cdn + "?download",
      expiresAt: "2099-01-01T00:00:00Z",
      publicUrl: original.url,
    });
  });
  context.mocks.http.get(cdn, () => {
    return new HttpResponse(null, { status: 403 });
  });
  context.mocks.http.get(original.url, originalBytes);
  context.mocks.upload.success(copy);
  const panel = await drawBox();
  click(await findNamedButton("Attach marks", panel));
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Annotate" })).toBeNull();
  });
  await expect(
    screen.findByTestId("composer-attachment-mark-count"),
  ).resolves.toHaveTextContent("1");
  await expect(findEnabledButton("Send")).resolves.toBeEnabled();
});

test("chat-attachment-annotation-016 completed upload persists the marked file next to its source", async () => {
  imageDraft();
  context.mocks.http.get(original.url, originalBytes);
  context.mocks.upload.success(copy);
  const saved = persisted(true);
  const panel = await drawBox();
  click(await findNamedButton("Attach marks", panel));
  await expect(saved).resolves.toMatchObject({
    fileId: original.id,
    annotatedFileId: copy.id,
    annotations: { marks: [{ shape: "box" }] },
  });
  await expect(
    screen.findByTestId("composer-attachment-mark-count"),
  ).resolves.toHaveTextContent("1");
  await expect(findEnabledButton("Send")).resolves.toBeEnabled();
});

test("chat-attachment-annotation-017 a previewed image still yields an attachable copy", async () => {
  imageDraft();
  context.mocks.browser.requestCacheMode();
  context.mocks.http.get(original.url, ({ request }) => {
    return ["no-store", "reload", "no-cache"].includes(request.cache)
      ? originalBytes()
      : new HttpResponse(null, { status: 403 });
  });
  context.mocks.upload.success(copy);
  const panel = await drawBox();
  click(await findNamedButton("Attach marks", panel));
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Annotate" })).toBeNull();
  });
  await expect(
    screen.findByTestId("composer-attachment-mark-count"),
  ).resolves.toHaveTextContent("1");
  await expect(findEnabledButton("Send")).resolves.toBeEnabled();
});

test("chat-attachment-annotation-020 the selected pen stroke moves with its pointer", async () => {
  imageDraft({ annotations: penAnnotation("route"), annotatedFileId: copy.id });
  const { panel, surface } = await annotate();
  const stroke = within(panel).getByTestId("annotation-mark-1");
  expect(stroke.getAttribute("points")).toMatch(/^20,25 /);
  click(stroke);
  await within(panel).findByRole("textbox");
  drag(stroke, surface, [100, 100], [50, 40]);
  const moved = within(panel)
    .getByTestId("annotation-mark-1")
    .getAttribute("points")!
    .split(" ")[0]!
    .split(",")
    .map(Number);
  expect(moved[0]).toBeCloseTo(30);
  expect(moved[1]).toBeCloseTo(35);
});

test("chat-attachment-annotation-021 undo reverses the drag after confirming the note", async () => {
  imageDraft({
    annotations: boxAnnotation([{ id: "panel", ordinal: 1 }]),
    annotatedFileId: copy.id,
  });
  const { panel, surface } = await annotate();
  const mark = within(panel).getByTestId("annotation-mark-1");
  click(mark);
  const field = await within(panel).findByRole("textbox");
  await fill(field, "Raise this panel");
  const user = userEvent.setup();
  await user.keyboard("{Enter}");
  expect(within(panel).queryByRole("textbox")).toBeNull();
  expect(within(panel).getByText("Raise this panel")).toBeVisible();
  expect(mark.style.left).toBe("8%");
  drag(mark, surface, [50, 50], [60, 40]);
  expect(mark.style.left).not.toBe("8%");
  await user.keyboard("{Control>}z{/Control}");
  expect(mark.style.left).toBe("8%");
});
