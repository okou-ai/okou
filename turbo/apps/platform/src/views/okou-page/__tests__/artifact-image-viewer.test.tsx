import userEvent from "@testing-library/user-event";
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
import { expect, test, vi } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "../sidebar-breakpoint.ts";

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

async function openImageViewer(deferFirstDecode: boolean) {
  const firstImageUrl =
    "https://cdn.vm7.io/artifacts/test/body-image-split-navigation/first.png";
  const secondImageUrl =
    "https://cdn.vm7.io/artifacts/test/body-image-split-navigation/second.png";
  const secondImageId = "f0000000-0000-4000-a000-000000000050";
  const secondImageReference = artifactReferencePath(
    secondImageId,
    "second.png",
  );
  const secondUrlReady = context.mocks.deferred<void>();
  const firstDecode = context.mocks.deferred<void>();
  const secondDecode = context.mocks.deferred<void>();
  context.mocks.api(artifactReferencesContract.resolve, async ({ respond }) => {
    await secondUrlReady.promise;
    return respond(200, {
      downloadUrl: new URL("?download=1", secondImageUrl).href,
      url: secondImageUrl,
      filename: "second.png",
      contentType: "image/png",
      expiresAt: "2026-09-21T00:00:00.000Z",
      target: { kind: "file", id: secondImageId },
    });
  });
  vi.spyOn(HTMLImageElement.prototype, "decode").mockImplementation(function (
    this: HTMLImageElement,
  ) {
    if (this.src === firstImageUrl) {
      return deferFirstDecode ? firstDecode.promise : Promise.resolve();
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
            artifactFile(secondImageReference, {
              id: secondImageId,
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
        content: `2. ![second.png](${secondImageReference})`,
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
    expect(
      within(dialog).getByRole("group", { name: "first.png preview" }),
    ).toHaveFocus();
  });
  const firstLightboxImage = getLightboxImage();
  return {
    dialog,
    firstLightboxImage,
    firstDecode,
    secondUrlReady,
    secondDecode,
    secondImageUrl,
  };
}

test("The image viewer waits for the preview image to decode", async () => {
  const { firstLightboxImage, firstDecode } = await openImageViewer(true);
  expect(firstLightboxImage).not.toBeVisible();
  expect(
    screen.getByRole("status", { name: "Loading artifacts" }),
  ).toBeVisible();
  setImageDimensions(firstLightboxImage, 1600, 900);
  expect(firstLightboxImage).not.toBeVisible();
  await finishLightboxImageDecode(firstLightboxImage, () => {
    return firstDecode.resolve();
  });
  expect(
    screen.queryByRole("status", { name: "Loading artifacts" }),
  ).toBeNull();
  expect(queryButtonByName("Previous image artifact")).toBeUndefined();
  expect(getButtonByName("Next image artifact")).toBeEnabled();
});

test("The image viewer resolves and decodes the next image during keyboard navigation", async () => {
  const {
    dialog,
    firstLightboxImage,
    secondUrlReady,
    secondDecode,
    secondImageUrl,
  } = await openImageViewer(false);
  await waitFor(() => {
    expect(firstLightboxImage).toBeVisible();
  });
  expect(getButtonByName("Next image artifact")).toBeEnabled();
  await userEvent.setup({ delay: null }).keyboard("{ArrowRight}");
  await waitFor(() => {
    expect(
      within(dialog).getByRole("status", { name: "Loading artifacts" }),
    ).toBeVisible();
  });
  expect(firstLightboxImage).not.toBeInTheDocument();
  expect(dialog).toHaveAccessibleName("second.png preview");
  expect(within(dialog).getByRole("group")).toHaveFocus();
  secondUrlReady.resolve();
  await waitFor(() => {
    const image = getLightboxImage();
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
  expect(within(dialog).getByRole("group")).toHaveFocus();
  expect(
    screen.queryByRole("status", { name: "Loading artifacts" }),
  ).toBeNull();
});

test.each(["lightbox", "sidebar", "fullscreen"] as const)(
  "Image gestures use the approved continuous zoom in the %s",
  async (surface) => {
    context.mocks.browser.matchMedia((query) => {
      return (
        query === SIDEBAR_DESKTOP_MEDIA_QUERY || query === "(min-width: 1280px)"
      );
    });
    const { dialog } = await openImageViewer(false);
    let preview = dialog;
    if (surface !== "lightbox") {
      click(getButtonByName("Open in split view", dialog));
      preview = await screen.findByTestId("artifact-sidebar");
      if (surface === "fullscreen") {
        click(getButtonByName("Enter fullscreen", preview));
        await waitFor(() => {
          return getButtonByName("Exit fullscreen", preview);
        });
      }
    }
    const image = await within(preview).findByTestId(
      surface === "lightbox"
        ? "attachment-lightbox-image"
        : "artifact-sidebar-body-image",
    );
    const zoom = await within(preview).findByTestId(
      surface === "lightbox"
        ? "artifact-dialog-image-zoom-level"
        : "artifact-sidebar-image-zoom-level",
    );
    await waitFor(() => {
      expect(image).toBeVisible();
      expect(zoom).toHaveTextContent("100%");
    });

    // Buttons keep their existing discrete step, independently of gestures.
    click(getButtonByName("Zoom in", preview));
    await waitFor(() => {
      expect(zoom).toHaveTextContent("112%");
    });
    click(getButtonByName("Zoom out", preview));
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

    // Equal total movement must produce the same zoom despite event frequency.
    for (let index = 0; index < 20; index++) {
      wheelImage(image, { ctrlKey: true, deltaY: -1 });
    }
    await waitFor(() => {
      expect(zoom).toHaveTextContent("120%");
    });
    click(getButtonByName("Reset zoom", preview));
    wheelImage(image, { ctrlKey: true, deltaY: -20 });
    await waitFor(() => {
      expect(zoom).toHaveTextContent("120%");
    });
    wheelImage(image, { ctrlKey: true, deltaY: 20 });
    await waitFor(() => {
      expect(zoom).toHaveTextContent("100%");
    });

    // A line-mode event is normalized to the same 16-pixel movement.
    wheelImage(image, { ctrlKey: true, deltaY: -16 });
    await waitFor(() => {
      expect(zoom).toHaveTextContent("115%");
    });
    click(getButtonByName("Reset zoom", preview));
    wheelImage(image, { ctrlKey: true, deltaY: -1, deltaMode: 1 });
    await waitFor(() => {
      expect(zoom).toHaveTextContent("115%");
    });
    click(getButtonByName("Reset zoom", preview));

    wheelImage(image, { ctrlKey: true, deltaY: 0 });
    wheelImage(image, { deltaY: -20 });
    expect(zoom).toHaveTextContent("100%");
    wheelImage(image, { metaKey: true, deltaY: -16 });
    await waitFor(() => {
      expect(zoom).toHaveTextContent("115%");
    });

    wheelImage(image, { ctrlKey: true, deltaY: 100_000 });
    await waitFor(() => {
      expect(zoom).toHaveTextContent("10%");
      expect(getButtonByName("Zoom out", preview)).toBeDisabled();
    });
    wheelImage(image, { ctrlKey: true, deltaY: -100_000 });
    await waitFor(() => {
      expect(getButtonByName("Zoom in", preview)).toBeDisabled();
    });
    click(getButtonByName("Reset zoom", preview));
    await waitFor(() => {
      expect(zoom).toHaveTextContent("100%");
    });
  },
);
