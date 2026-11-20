import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ATTACHMENT_THREAD_ID,
  findNamedLink,
  getNamedButton,
  mockAttachmentChat,
  queryNamedButton,
} from "./chat-attachment-test-helpers.ts";

const context = testContext();

test("artifact-image-viewer-001 waits for decoded pixels despite knowing the first photo's size", async () => {
  const names = ["quay.png", "harbor.png"];
  mockAttachmentChat(context, {
    chatEvents: [
      {
        role: "user",
        content: "Inspect both stations",
        createdAt: "2026-03-10T01:00:00Z",
        fileParts: names.map((filename) => {
          return {
            type: "file",
            filenameSnapshot: filename,
            fileId: filename,
            contentType: "image/png",
          };
        }),
      },
    ],
  });
  context.mocks.api(webFilesContract.fileUrl, ({ query, respond }) => {
    const url = "https://media.example.test/stations/" + query.file_id;
    return respond(200, {
      url,
      downloadUrl: url,
      expiresAt: "2099-01-01T00:00:00Z",
      publicUrl: null,
    });
  });
  const decoded = context.mocks.deferred<void>();
  vi.spyOn(HTMLImageElement.prototype, "decode").mockImplementation(function (
    this: HTMLImageElement,
  ) {
    return this.alt === "quay.png" && this.closest('[role="dialog"]')
      ? decoded.promise
      : Promise.resolve();
  });
  await setupPage({
    context,
    path: "/chats/" + ATTACHMENT_THREAD_ID,
    featureSwitches: { [FeatureSwitchKey.ArtifactSidebarPreview]: false },
  });
  click(await findNamedLink("Preview quay.png"));
  const viewer = await screen.findByRole("dialog");
  const picture = await within(viewer).findByAltText("quay.png");
  Object.defineProperties(picture, {
    naturalWidth: { configurable: true, value: 1280 },
    naturalHeight: { configurable: true, value: 960 },
  });
  fireEvent.load(picture);
  expect(picture).not.toBeVisible();
  const loading = within(viewer).getByRole("status", {
    name: "Loading artifacts",
  });
  expect(loading).toBeVisible();
  decoded.resolve();
  await waitFor(() => {
    return expect(picture).toBeVisible();
  });
  expect(loading).not.toBeInTheDocument();
  expect(queryNamedButton("Previous image artifact", viewer)).toBeNull();
  expect(getNamedButton("Next image artifact", viewer)).toBeEnabled();
});
