import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ATTACHMENT_THREAD_ID,
  draftAttachment,
  draftForAttachment,
  mockAttachmentChat,
  privateAttachmentUrl,
} from "./chat-attachment-test-helpers.ts";

const context = testContext();

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
