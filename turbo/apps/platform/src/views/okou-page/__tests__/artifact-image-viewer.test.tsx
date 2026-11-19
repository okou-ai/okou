import { browserContract } from "@okouai/api-contracts/contracts/browser";
import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import {
  chatThreadArtifactsContract,
  type ChatThreadArtifactFile,
} from "@okouai/api-contracts/contracts/chat-threads";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
const RUN_ID = "run-body-image-split-navigation";
const FIRST_IMAGE_URL =
  "https://cdn.vm7.io/artifacts/test/body-image-split-navigation/first.png";
const SECOND_IMAGE_URL =
  "https://cdn.vm7.io/artifacts/test/body-image-split-navigation/second.png";
const SECOND_IMAGE_ID = "f0000000-0000-4000-a000-000000000050";

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

function queryButtonByName(name: string, container: ParentNode) {
  return queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.textContent?.trim() === name ||
      candidate.getAttribute("aria-label") === name
    );
  });
}

function getButtonByName(name: string, container: ParentNode = document.body) {
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

function loadingStatus(container: ParentNode = document.body) {
  return within(container as HTMLElement).queryByRole("status", {
    name: "Loading artifacts",
  });
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

function wheelImage(image: HTMLElement, init: WheelEventInit): void {
  const event = new WheelEvent("wheel", {
    ...init,
    bubbles: true,
    cancelable: true,
  });
  // Happy-dom's WheelEvent omits the MouseEvent fields emitted by browsers.
  Object.defineProperties(event, {
    ctrlKey: { value: init.ctrlKey ?? false },
    metaKey: { value: init.metaKey ?? false },
    clientX: { value: 0 },
    clientY: { value: 0 },
  });
  fireEvent(image, event);
}

async function openImageViewer({
  deferFirstDecode,
}: {
  deferFirstDecode: boolean;
}) {
  const secondImageReference = artifactReferencePath(
    SECOND_IMAGE_ID,
    "second.png",
  );
  const secondUrlReady = context.mocks.deferred<void>();
  const firstDecode = context.mocks.deferred<void>();
  const secondDecode = context.mocks.deferred<void>();
  context.mocks.api(artifactReferencesContract.resolve, async ({ respond }) => {
    await secondUrlReady.promise;
    return respond(200, {
      downloadUrl: new URL("?download=1", SECOND_IMAGE_URL).href,
      url: SECOND_IMAGE_URL,
      filename: "second.png",
      contentType: "image/png",
      expiresAt: "2026-09-21T00:00:00.000Z",
      target: { kind: "file", id: SECOND_IMAGE_ID },
    });
  });
  vi.spyOn(HTMLImageElement.prototype, "decode").mockImplementation(function (
    this: HTMLImageElement,
  ) {
    if (this.src === FIRST_IMAGE_URL) {
      return deferFirstDecode ? firstDecode.promise : Promise.resolve();
    }
    if (this.src === SECOND_IMAGE_URL) {
      return secondDecode.promise;
    }
    return Promise.resolve();
  });
  context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
    return respond(200, {
      runs: [
        {
          runId: RUN_ID,
          files: [
            artifactFile(FIRST_IMAGE_URL, {
              id: "artifact-body-split-first-image",
              filename: "first.png",
            }),
            artifactFile(secondImageReference, {
              id: SECOND_IMAGE_ID,
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
        runId: RUN_ID,
        runEventId: "event:0",
        sequenceNumber: 0,
        createdAt: "2026-03-10T00:00:00Z",
      },
      {
        id: "msg-body-image-split-first",
        role: "assistant",
        content: `1. ![first.png](${FIRST_IMAGE_URL})`,
        runId: RUN_ID,
        runEventId: "event:1",
        sequenceNumber: 1,
        createdAt: "2026-03-10T00:00:01Z",
      },
      {
        id: "msg-body-image-split-second",
        role: "assistant",
        content: `2. ![second.png](${secondImageReference})`,
        runId: RUN_ID,
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
    expect(image).toHaveAttribute("src", FIRST_IMAGE_URL);
  });
  const dialog = screen.getByRole("dialog", { name: "first.png preview" });
  await waitFor(() => {
    expect(
      within(dialog).getByRole("group", { name: "first.png preview" }),
    ).toHaveFocus();
  });
  return {
    dialog,
    firstLightboxImage: getLightboxImage(),
    firstDecode,
    secondUrlReady,
    secondDecode,
  };
}

test("The image viewer keeps a preview hidden until it decodes", async () => {
  const { firstLightboxImage, firstDecode } = await openImageViewer({
    deferFirstDecode: true,
  });
  expect(firstLightboxImage).not.toBeVisible();
  expect(loadingStatus()).toBeVisible();

  setImageDimensions(firstLightboxImage, 1600, 900);
  expect(firstLightboxImage).not.toBeVisible();
  expect(loadingStatus()).toBeVisible();

  firstDecode.resolve();
  await waitFor(() => {
    expect(firstLightboxImage).toBeVisible();
  });
  expect(loadingStatus()).toBeNull();
  expect(
    queryButtonByName("Previous image artifact", document.body),
  ).toBeUndefined();
  expect(getButtonByName("Next image artifact")).toBeEnabled();
});

test("Arrow Right resolves and decodes the next image inside the viewer", async () => {
  const { dialog, firstLightboxImage, secondUrlReady, secondDecode } =
    await openImageViewer({ deferFirstDecode: false });
  await waitFor(() => {
    expect(firstLightboxImage).toBeVisible();
  });
  expect(getButtonByName("Next image artifact")).toBeEnabled();

  await userEvent.setup({ delay: null }).keyboard("{ArrowRight}");
  await waitFor(() => {
    expect(loadingStatus(dialog)).toBeVisible();
  });
  expect(firstLightboxImage).not.toBeInTheDocument();
  expect(dialog).toHaveAccessibleName("second.png preview");
  expect(within(dialog).getByRole("group")).toHaveFocus();

  secondUrlReady.resolve();
  await waitFor(() => {
    expect(getLightboxImage()).toHaveAttribute("src", SECOND_IMAGE_URL);
  });
  const secondLightboxImage = getLightboxImage();
  expect(secondLightboxImage).not.toBeVisible();
  setImageDimensions(secondLightboxImage, 1200, 1200);
  expect(secondLightboxImage).not.toBeVisible();

  secondDecode.resolve();
  await waitFor(() => {
    expect(secondLightboxImage).toBeVisible();
  });
  expect(loadingStatus()).toBeNull();
});

test("Lightbox image gestures zoom continuously within their bounds", async () => {
  const { dialog } = await openImageViewer({ deferFirstDecode: false });
  const image = await within(dialog).findByTestId("attachment-lightbox-image");
  const zoom = await within(dialog).findByTestId(
    "artifact-dialog-image-zoom-level",
  );
  await waitFor(() => {
    expect(image).toBeVisible();
    expect(zoom).toHaveTextContent("100%");
  });

  click(getButtonByName("Zoom in", dialog));
  await waitFor(() => {
    expect(zoom).toHaveTextContent("112%");
  });
  click(getButtonByName("Zoom out", dialog));
  await waitFor(() => {
    expect(zoom).toHaveTextContent("100%");
  });

  wheelImage(image, { ctrlKey: true, deltaY: -1 });
  await waitFor(() => {
    expect(zoom).toHaveTextContent("101%");
  });
  wheelImage(image, { ctrlKey: true, deltaY: 1 });
  await waitFor(() => {
    expect(zoom).toHaveTextContent("100%");
  });

  for (let index = 0; index < 20; index++) {
    wheelImage(image, { ctrlKey: true, deltaY: -1 });
  }
  await waitFor(() => {
    expect(zoom).toHaveTextContent("120%");
  });
  click(getButtonByName("Reset zoom", dialog));
  wheelImage(image, { ctrlKey: true, deltaY: -20 });
  await waitFor(() => {
    expect(zoom).toHaveTextContent("120%");
  });
  click(getButtonByName("Reset zoom", dialog));

  wheelImage(image, { ctrlKey: true, deltaY: -16 });
  await waitFor(() => {
    expect(zoom).toHaveTextContent("115%");
  });
  click(getButtonByName("Reset zoom", dialog));
  wheelImage(image, { ctrlKey: true, deltaY: -1, deltaMode: 1 });
  await waitFor(() => {
    expect(zoom).toHaveTextContent("115%");
  });
  click(getButtonByName("Reset zoom", dialog));

  // The Meta gesture's exact 115% proves the two earlier wheels did not zoom.
  wheelImage(image, { ctrlKey: true, deltaY: 0 });
  wheelImage(image, { deltaY: -20 });
  wheelImage(image, { metaKey: true, deltaY: -16 });
  await waitFor(() => {
    expect(zoom).toHaveTextContent("115%");
  });

  wheelImage(image, { ctrlKey: true, deltaY: 100_000 });
  await waitFor(() => {
    expect(zoom).toHaveTextContent("10%");
  });
  expect(getButtonByName("Zoom out", dialog)).toBeDisabled();
  wheelImage(image, { ctrlKey: true, deltaY: -100_000 });
  await waitFor(() => {
    expect(zoom).toHaveTextContent("300%");
  });
  expect(getButtonByName("Zoom in", dialog)).toBeDisabled();

  click(getButtonByName("Reset zoom", dialog));
  await waitFor(() => {
    expect(zoom).toHaveTextContent("100%");
  });
});
