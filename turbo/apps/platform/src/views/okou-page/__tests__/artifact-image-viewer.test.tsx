import { browserContract } from "@okouai/api-contracts/contracts/browser";
import {
  chatThreadArtifactsContract,
  type ChatThreadArtifactFile,
} from "@okouai/api-contracts/contracts/chat-threads";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const THREAD_ID = "b0000000-0000-4000-a000-000000000050";

function artifactFile(
  url: string,
  overrides: Partial<ChatThreadArtifactFile>,
): ChatThreadArtifactFile {
  return {
    id: "artifact-image",
    filename: "image.png",
    contentType: "image/png",
    size: 1024,
    url,
    createdAt: "2026-03-10T00:00:01Z",
    googleDriveSync: { status: "not_synced", accountReady: true },
    ...overrides,
  };
}

function queryButtonByName(
  name: string,
  container: ParentNode = document.body,
): HTMLElement | undefined {
  return queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.textContent?.trim() === name ||
      candidate.getAttribute("aria-label") === name
    );
  });
}

function getButtonByName(
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryButtonByName(name, container);
  if (!button) {
    throw new Error(`Expected button named "${name}"`);
  }
  return button;
}

function getLightboxImage(): HTMLImageElement {
  const image = screen.getByTestId("attachment-lightbox-image");
  if (!(image instanceof HTMLImageElement)) {
    throw new Error("Expected the lightbox image");
  }
  return image;
}

function setImageDimensions(
  image: HTMLImageElement,
  naturalWidth: number,
  naturalHeight: number,
): void {
  Object.defineProperties(image, {
    naturalHeight: { configurable: true, value: naturalHeight },
    naturalWidth: { configurable: true, value: naturalWidth },
  });
}

async function finishLightboxImageDecode(
  image: HTMLImageElement,
  resolveDecode: () => void,
): Promise<void> {
  resolveDecode();
  await waitFor(() => {
    expect(image).toBeVisible();
  });
}

test("The image viewer supports initial preview and download focus within one assistant response", async () => {
  const firstImageUrl =
    "https://cdn.vm7.io/artifacts/test/body-image-split-navigation/first.png";
  const secondImageUrl =
    "https://cdn.vm7.io/artifacts/test/body-image-split-navigation/second.png";
  const firstDecode = context.mocks.deferred<void>();
  const secondDecode = context.mocks.deferred<void>();
  vi.spyOn(HTMLImageElement.prototype, "decode").mockImplementation(function (
    this: HTMLImageElement,
  ) {
    if (this.src === firstImageUrl) {
      return firstDecode.promise;
    }
    if (this.src === secondImageUrl) {
      return secondDecode.promise;
    }
    return Promise.resolve();
  });
  const runId = "run-body-image-split-navigation";
  context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
    return respond(200, {
      runs: [
        {
          runId,
          files: [
            artifactFile(firstImageUrl, {
              id: "artifact-body-split-first-image",
              filename: "first.png",
            }),
            artifactFile(secondImageUrl, {
              id: "artifact-body-split-second-image",
              filename: "second.png",
            }),
          ],
        },
      ],
    });
  });
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(404, {
      error: {
        code: "BROWSER_NOT_FOUND",
        message: "Managed browser not found",
      },
    });
  });
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    chatEvents: [
      {
        id: "msg-body-image-split-label",
        role: "assistant",
        content: "Generated images:",
        runId,
        runEventId: "event:0",
        sequenceNumber: 0,
        createdAt: "2026-03-10T00:00:00Z",
      },
      {
        id: "msg-body-image-split-first",
        role: "assistant",
        content: `1. ![first.png](${firstImageUrl})`,
        runId,
        runEventId: "event:1",
        sequenceNumber: 1,
        createdAt: "2026-03-10T00:00:01Z",
      },
      {
        id: "msg-body-image-split-second",
        role: "assistant",
        content: `2. ![second.png](${secondImageUrl})`,
        runId,
        runEventId: "event:2",
        sequenceNumber: 2,
        createdAt: "2026-03-10T00:00:02Z",
      },
    ],
  });
  await setupPage({ context, path: `/chats/${THREAD_ID}` });
  const expandHistory = await waitFor(() => {
    return getButtonByName("Expand work history");
  });
  click(expandHistory);
  const firstImage = await screen.findByAltText("first.png");
  const previewButton = firstImage.closest<HTMLElement>("button");
  if (!previewButton) {
    throw new Error("Expected the first generated image to open a preview");
  }
  fireEvent.load(firstImage);
  click(previewButton);
  await waitFor(() => {
    const image = getLightboxImage();
    expect(image).toHaveAttribute("alt", "first.png");
    expect(image).toHaveAttribute("src", firstImageUrl);
  });
  const dialog = screen.getByRole("dialog", { name: "first.png preview" });
  await waitFor(() => {
    expect(dialog).toHaveFocus();
  });
  const firstLightboxImage = getLightboxImage();
  expect(firstLightboxImage).not.toBeVisible();
  expect(
    screen.getByRole("status", { name: "Loading artifacts" }),
  ).toBeVisible();
  setImageDimensions(firstLightboxImage, 1600, 900);
  expect(firstLightboxImage).not.toBeVisible();
  await finishLightboxImageDecode(firstLightboxImage, () => {
    return firstDecode.resolve();
  });
  expect(firstLightboxImage).toHaveStyle({ width: "1600px" });
  expect(
    screen.queryByRole("status", { name: "Loading artifacts" }),
  ).toBeNull();
  const downloadButton = getButtonByName("Download options", dialog);
  click(downloadButton);
  const downloadMenu = await screen.findByRole("menu");
  fireEvent.keyDown(downloadMenu, { key: "Escape", code: "Escape" });
  await waitFor(() => {
    expect(downloadButton).toHaveFocus();
  });
});

test("The image viewer supports next image within one assistant response", async () => {
  const firstImageUrl =
    "https://cdn.vm7.io/artifacts/test/body-image-split-navigation/first.png";
  const secondImageUrl =
    "https://cdn.vm7.io/artifacts/test/body-image-split-navigation/second.png";
  const firstDecode = context.mocks.deferred<void>();
  const secondDecode = context.mocks.deferred<void>();
  vi.spyOn(HTMLImageElement.prototype, "decode").mockImplementation(function (
    this: HTMLImageElement,
  ) {
    if (this.src === firstImageUrl) {
      return firstDecode.promise;
    }
    if (this.src === secondImageUrl) {
      return secondDecode.promise;
    }
    return Promise.resolve();
  });
  const runId = "run-body-image-split-navigation";
  context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
    return respond(200, {
      runs: [
        {
          runId,
          files: [
            artifactFile(firstImageUrl, {
              id: "artifact-body-split-first-image",
              filename: "first.png",
            }),
            artifactFile(secondImageUrl, {
              id: "artifact-body-split-second-image",
              filename: "second.png",
            }),
          ],
        },
      ],
    });
  });
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(404, {
      error: {
        code: "BROWSER_NOT_FOUND",
        message: "Managed browser not found",
      },
    });
  });
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    chatEvents: [
      {
        id: "msg-body-image-split-label",
        role: "assistant",
        content: "Generated images:",
        runId,
        runEventId: "event:0",
        sequenceNumber: 0,
        createdAt: "2026-03-10T00:00:00Z",
      },
      {
        id: "msg-body-image-split-first",
        role: "assistant",
        content: `1. ![first.png](${firstImageUrl})`,
        runId,
        runEventId: "event:1",
        sequenceNumber: 1,
        createdAt: "2026-03-10T00:00:01Z",
      },
      {
        id: "msg-body-image-split-second",
        role: "assistant",
        content: `2. ![second.png](${secondImageUrl})`,
        runId,
        runEventId: "event:2",
        sequenceNumber: 2,
        createdAt: "2026-03-10T00:00:02Z",
      },
    ],
  });
  await setupPage({ context, path: `/chats/${THREAD_ID}` });
  const expandHistory = await waitFor(() => {
    return getButtonByName("Expand work history");
  });
  click(expandHistory);
  const firstImage = await screen.findByAltText("first.png");
  const previewButton = firstImage.closest<HTMLElement>("button");
  if (!previewButton) {
    throw new Error("Expected the first generated image to open a preview");
  }
  fireEvent.load(firstImage);
  click(previewButton);
  await waitFor(() => {
    const image = getLightboxImage();
    expect(image).toHaveAttribute("alt", "first.png");
    expect(image).toHaveAttribute("src", firstImageUrl);
  });
  const dialog = screen.getByRole("dialog", { name: "first.png preview" });
  await waitFor(() => {
    expect(dialog).toHaveFocus();
  });
  const firstLightboxImage = getLightboxImage();
  expect(firstLightboxImage).not.toBeVisible();
  expect(
    screen.getByRole("status", { name: "Loading artifacts" }),
  ).toBeVisible();
  setImageDimensions(firstLightboxImage, 1600, 900);
  expect(firstLightboxImage).not.toBeVisible();
  await finishLightboxImageDecode(firstLightboxImage, () => {
    return firstDecode.resolve();
  });
  expect(firstLightboxImage).toHaveStyle({ width: "1600px" });
  expect(
    screen.queryByRole("status", { name: "Loading artifacts" }),
  ).toBeNull();
  expect(queryButtonByName("Previous image artifact")).toBeUndefined();
  const nextImage = await waitFor(() => {
    return getButtonByName("Next image artifact");
  });
  click(nextImage);
  await waitFor(() => {
    const image = getLightboxImage();
    expect(image).toHaveAttribute("alt", "second.png");
    expect(image).toHaveAttribute("src", secondImageUrl);
  });
  const secondLightboxImage = getLightboxImage();
  expect(secondLightboxImage).not.toBeVisible();
  expect(
    screen.getByRole("status", { name: "Loading artifacts" }),
  ).toBeVisible();
  setImageDimensions(secondLightboxImage, 1200, 1200);
  expect(secondLightboxImage).not.toBeVisible();
  await finishLightboxImageDecode(secondLightboxImage, () => {
    return secondDecode.resolve();
  });
  expect(secondLightboxImage).toHaveStyle({ width: "1200px" });
  expect(
    screen.queryByRole("status", { name: "Loading artifacts" }),
  ).toBeNull();
});
