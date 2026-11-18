import { artifactReferencePath } from "@okouai/api-contracts/contracts/artifact-references";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ATTACHMENT_THREAD_ID,
  draftAttachment,
  draftForAttachment,
  findNamedButton,
  mockAttachmentChat,
} from "./chat-attachment-test-helpers.ts";

const context = testContext();
const FILE_ID = "f0000000-0000-4000-a000-000000000951";
const FILENAME = "composer-photo.png";
const R2_ORIGIN = `https://${"a".repeat(32)}.r2.cloudflarestorage.com`;
const ORIGINAL_URL = `${R2_ORIGIN}/uploads/composer%20photo.png?X-Amz-Credential=key%2F20260911%2Fauto%2Fs3%2Faws4_request&X-Amz-Signature=original`;
const NEXT_URL = `${R2_ORIGIN}/uploads/composer%20photo.png?X-Amz-Signature=next`;
const THUMBNAIL_URL = `https://a.okou.io/cdn-cgi/image/width=800,height=720,fit=scale-down,format=auto,quality=85,metadata=none/${ORIGINAL_URL}`;

test("restored private composer images show a presigned thumbnail and open the same original", async () => {
  mockNow(Date.parse("2026-09-11T00:00:00.000Z"), context.signal);
  const attachment = draftAttachment(FILENAME, {
    id: FILE_ID,
    url: artifactReferencePath(FILE_ID, FILENAME),
  });
  mockAttachmentChat(context, { draft: draftForAttachment(attachment, "") });
  let resolvedUrl = ORIGINAL_URL;
  context.mocks.api(webFilesContract.fileUrl, ({ respond }) => {
    const url = resolvedUrl;
    resolvedUrl = NEXT_URL;
    return respond(200, {
      downloadUrl: new URL("?download=1", url).href,
      url,
      expiresAt: "2026-09-13T00:00:00.000Z",
      publicUrl: null,
    });
  });

  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    host: "app.okou.ai",
  });
  const openPreview = await findNamedButton(
    `Open image preview for ${FILENAME}`,
  );
  await waitFor(() => {
    expect(openPreview.querySelector("img")).toHaveAttribute(
      "src",
      THUMBNAIL_URL,
    );
  });
  const thumbnail = openPreview.querySelector("img");
  if (!thumbnail) {
    throw new Error("Expected the composer image thumbnail");
  }
  fireEvent.load(thumbnail);

  click(openPreview);
  await waitFor(() => {
    expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
      "src",
      ORIGINAL_URL,
    );
  });
  expect(
    screen.getByRole("dialog", { name: `${FILENAME} preview` }),
  ).toBeVisible();
  expect(thumbnail).toHaveAttribute("src", THUMBNAIL_URL);
});
