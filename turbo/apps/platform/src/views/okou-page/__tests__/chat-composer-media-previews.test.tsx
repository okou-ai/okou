import { expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fill, setupPage } from "../../../__tests__/page-helper.ts";
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
