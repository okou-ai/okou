import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import userEvent from "@testing-library/user-event";
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

function twoImageChat() {
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
}

async function openFirstPhoto() {
  await setupPage({
    context,
    path: "/chats/" + ATTACHMENT_THREAD_ID,
    featureSwitches: { [FeatureSwitchKey.ArtifactSidebarPreview]: false },
  });
  click(await findNamedLink("Preview quay.png"));
  return await screen.findByRole("dialog");
}

test("artifact-image-viewer-001 waits for decoded pixels despite knowing the first photo's size", async () => {
  twoImageChat();
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
  const viewer = await openFirstPhoto();
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

test("artifact-image-viewer-002 keeps keyboard focus through the next photo's URL and decoding", async () => {
  twoImageChat();
  const secondUrl = context.mocks.deferred<void>();
  const secondDecode = context.mocks.deferred<void>();
  context.mocks.api(webFilesContract.fileUrl, async ({ query, respond }) => {
    if (query.file_id === "harbor.png") {
      await secondUrl.promise;
    }
    const url = "https://media.example.test/photos/" + query.file_id;
    return respond(200, {
      url,
      downloadUrl: url,
      expiresAt: "2099-01-01T00:00:00Z",
      publicUrl: null,
    });
  });
  vi.spyOn(HTMLImageElement.prototype, "decode").mockImplementation(function (
    this: HTMLImageElement,
  ) {
    return this.alt === "harbor.png" && this.closest('[role="dialog"]')
      ? secondDecode.promise
      : Promise.resolve();
  });
  const viewer = await openFirstPhoto();
  const first = await within(viewer).findByAltText("quay.png");
  await waitFor(() => {
    return expect(first).toBeVisible();
  });
  const user = userEvent.setup({ delay: null });
  await user.click(
    within(viewer).getByRole("group", { name: "quay.png preview" }),
  );
  await user.keyboard("{ArrowRight}");
  const next = await within(viewer).findByRole("group", {
    name: "harbor.png preview",
  });
  expect(next).toHaveFocus();
  expect(within(viewer).queryByAltText("quay.png")).not.toBeInTheDocument();
  expect(
    within(next).getByRole("status", { name: "Loading artifacts" }),
  ).toBeVisible();
  secondUrl.resolve();
  const photo = await within(next).findByAltText("harbor.png");
  expect(photo).toHaveAttribute(
    "src",
    "https://media.example.test/photos/harbor.png",
  );
  expect(photo).not.toBeVisible();
  secondDecode.resolve();
  await waitFor(() => {
    return expect(photo).toBeVisible();
  });
  expect(within(next).queryByRole("status")).not.toBeInTheDocument();
  expect(next).toHaveFocus();
});

test("artifact-image-viewer-003 applies continuous lightbox zoom for buttons and modified wheel gestures", async () => {
  twoImageChat();
  context.mocks.api(webFilesContract.fileUrl, ({ query, respond }) => {
    const url = "https://media.example.test/photos/" + query.file_id;
    return respond(200, {
      url,
      downloadUrl: url,
      expiresAt: "2099-01-01T00:00:00Z",
      publicUrl: null,
    });
  });
  const viewer = await openFirstPhoto();
  const photo = await within(viewer).findByAltText("quay.png");
  const zoom = within(viewer);
  await expect(zoom.findByText("100%")).resolves.toBeInTheDocument();
  const increase = getNamedButton("Zoom in", viewer);
  const decrease = getNamedButton("Zoom out", viewer);
  const reset = getNamedButton("Reset zoom", viewer);
  click(increase);
  expect(zoom.getByText("112%")).toBeInTheDocument();
  click(decrease);
  expect(zoom.getByText("100%")).toBeInTheDocument();
  const wheel = (deltaY: number, opts: WheelEventInit = { ctrlKey: true }) => {
    // Happy DOM lacks WheelEvent. Preserve the pointer modifiers and wheel units.
    const event = new MouseEvent("wheel", {
      bubbles: true,
      cancelable: true,
      ...opts,
    });
    Object.defineProperties(event, {
      deltaX: { value: 0 },
      deltaY: { value: deltaY },
      deltaMode: { value: opts.deltaMode ?? 0 },
    });
    fireEvent(photo, event);
  };
  wheel(-1);
  expect(zoom.getByText("101%")).toBeInTheDocument();
  for (let i = 1; i < 20; i++) {
    wheel(-1);
  }
  expect(zoom.getByText("120%")).toBeInTheDocument();
  for (const [delta, opts, level] of [
    [-20, { ctrlKey: true }, "120%"],
    [-16, { metaKey: true }, "115%"],
    [-1, { ctrlKey: true, deltaMode: 1 }, "115%"],
    [0, { ctrlKey: true }, "100%"],
    [-20, {}, "100%"],
  ] as const) {
    click(reset);
    wheel(delta, opts);
    expect(zoom.getByText(level)).toBeInTheDocument();
  }
  wheel(2000);
  expect(zoom.getByText("10%")).toBeInTheDocument();
  expect(decrease).toBeDisabled();
  wheel(-2000);
  expect(increase).toBeDisabled();
  expect(zoom.getByText("300%")).toBeInTheDocument();
  click(reset);
  expect(zoom.getByText("100%")).toBeInTheDocument();
});
