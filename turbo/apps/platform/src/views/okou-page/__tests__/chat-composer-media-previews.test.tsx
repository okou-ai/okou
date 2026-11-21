import { HttpResponse } from "msw";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
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
} from "./chat-attachment-test-helpers.ts";
import { expect, test } from "vitest";
import userEvent from "@testing-library/user-event";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { captureTemplateSubmission } from "./template-submission-fixtures.ts";
import {
  findAction,
  queryAction,
} from "./connector-integrations-test-helpers.ts";

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
