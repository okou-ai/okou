import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getLinkByName,
  setupSharedThreadPage,
  sharedThread,
} from "./shared-thread-test-helpers.ts";

const context = testContext();
const FILE_ID = "f0000000-0000-4000-a000-000000000941";
const IMAGE = "https://app.okou.ai/artifacts/snapimage1.png#detail";
const HTML = "https://app.okou.ai/artifacts/snaphtml01.html#slide-2";
const VIDEO = "https://app.okou.ai/artifacts/snapvideo1.mp4";
const AUDIO = "https://app.okou.ai/artifacts/snapaudio1.mp3";
const PDF = "https://app.okou.ai/artifacts/snappdf001.pdf";
const R2_ORIGIN = `https://${"a".repeat(32)}.r2.cloudflarestorage.com`;
const IMAGE_URL = `${R2_ORIGIN}/snapshots/photo.png?X-Amz-Signature=image`;
const HTML_URL = `https://ps-${"a".repeat(48)}.okou.app/`;
const VIDEO_URL = `${R2_ORIGIN}/snapshots/video.mp4?X-Amz-Signature=video`;

function mockSnapshotResources() {
  context.mocks.api(
    artifactReferencesContract.resolve,
    ({ params, request, respond }) => {
      expect(request.headers.get("authorization")).toBeNull();
      const resources = {
        "snapimage1.png": {
          url: IMAGE_URL,
          filename: "photo.png",
          contentType: "image/png",
          kind: "file",
        },
        "snaphtml01.html": {
          url: HTML_URL,
          filename: "index.html",
          contentType: "text/html",
          kind: "html",
        },
        "snapvideo1.mp4": {
          url: VIDEO_URL,
          filename: "video.mp4",
          contentType: "video/mp4",
          kind: "file",
        },
        "snapaudio1.mp3": {
          url: `${R2_ORIGIN}/snapshots/audio.mp3?X-Amz-Signature=audio`,
          filename: "audio.mp3",
          contentType: "audio/mpeg",
          kind: "file",
        },
        "snappdf001.pdf": {
          url: `${R2_ORIGIN}/snapshots/brief.pdf?X-Amz-Signature=pdf`,
          filename: "brief.pdf",
          contentType: "application/pdf",
          kind: "file",
        },
      } as const;
      const resource = resources[params.reference as keyof typeof resources];
      if (!resource) {
        throw new Error(`Unexpected artifact reference: ${params.reference}`);
      }
      return respond(200, {
        url: resource.url,
        filename: resource.filename,
        contentType: resource.contentType,
        expiresAt: "2099-01-01T00:00:00Z",
        sharedThreadSnapshot: true,
        target: { kind: resource.kind, id: FILE_ID },
      });
    },
  );
}

test("anonymous conversation snapshots preview temporary bytes and keep full stable links when copied", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  const content = [
    `![Launch screenshot](${IMAGE})`,
    `![Launch slides](${HTML})`,
    `![Launch video](${VIDEO})`,
    `![Launch audio](${AUDIO})`,
    `![Launch brief](${PDF})`,
    `[Download the brief](${PDF})`,
  ].join("\n\n");
  mockSnapshotResources();
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(
      200,
      sharedThread({
        messages: [{ messageIndex: 0, role: "assistant", content }],
      }),
    );
  });

  await setupSharedThreadPage(context, { host: "app.okou.ai" });

  const image = await screen.findByRole("img", { name: "Launch screenshot" });
  expect(image).toHaveAttribute(
    "src",
    `https://a.okou.io/cdn-cgi/image/width=800,height=720,fit=scale-down,format=auto,quality=85,metadata=none/${IMAGE_URL}#detail`,
  );
  fireEvent.load(image);
  expect(image.closest("a")).toHaveAttribute("href", IMAGE);
  const html = screen.getByTestId("markdown-artifact-preview-html");
  expect(html).toHaveAttribute("href", HTML);
  await waitFor(() => {
    expect(
      within(html).getByTitle("Site preview for Launch slides"),
    ).toHaveAttribute("src", `${HTML_URL}#slide-2`);
  });
  const video = screen.getByTestId("markdown-artifact-preview-video");
  expect(video).toHaveAttribute("href", VIDEO);
  await waitFor(() => {
    expect(video.querySelector("video")).toHaveAttribute("src", VIDEO_URL);
  });
  expect(screen.getByTestId("markdown-artifact-preview-audio")).toHaveAttribute(
    "href",
    AUDIO,
  );
  expect(screen.getByTestId("markdown-artifact-preview-pdf")).toHaveAttribute(
    "href",
    PDF,
  );
  expect(getLinkByName("Download the brief")).toHaveAttribute("href", PDF);
  expect(html.closest("p")).toBeNull();

  const copy = queryAllByRoleFast("button").find((button) => {
    return button.getAttribute("aria-label") === "Copy message";
  });
  if (!copy) {
    throw new Error("Missing copy message action");
  }
  click(copy);
  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([content]);
  });
});

test("anonymous prompt attachments load snapshot thumbnails while opening the stable reference", async () => {
  mockSnapshotResources();
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(
      200,
      sharedThread({
        messages: [
          {
            messageIndex: 0,
            role: "user",
            content: "Use these materials",
            attachments: [
              {
                filename: "photo.png",
                contentType: "image/png",
                size: 42,
                url: IMAGE,
              },
              {
                filename: "brief.pdf",
                contentType: "application/pdf",
                size: 80,
                url: PDF,
              },
            ],
          },
        ],
      }),
    );
  });

  await setupSharedThreadPage(context, { host: "app.okou.ai" });

  const image = await screen.findByRole("img", { name: "photo.png" });
  expect(image).toHaveAttribute(
    "src",
    `https://a.okou.io/cdn-cgi/image/width=480,height=320,fit=scale-down,format=auto,quality=85,metadata=none/${IMAGE_URL}#detail`,
  );
  expect(screen.getByLabelText("photo.png")).toHaveAttribute("href", IMAGE);
  expect(screen.getByLabelText("brief.pdf")).toHaveAttribute("href", PDF);
});

test.each([403, 404] as const)(
  "denied or revoked snapshots show unavailable previews without loading the reference as bytes: %s",
  async (status) => {
    context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
      return respond(status, {
        error: { code: "NOT_FOUND", message: "Artifact unavailable" },
      });
    });
    context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
      return respond(
        200,
        sharedThread({
          messages: [
            {
              messageIndex: 0,
              role: "assistant",
              content: `![Screenshot](${IMAGE})\n\n![Slides](${HTML})`,
            },
            {
              messageIndex: 1,
              role: "user",
              content: "Check the screenshot",
              attachments: [
                {
                  filename: "photo.png",
                  contentType: "image/png",
                  size: 42,
                  url: IMAGE,
                },
              ],
            },
          ],
        }),
      );
    });

    await setupSharedThreadPage(context, { host: "app.okou.ai" });

    await waitFor(() => {
      expect(screen.getAllByRole("status")).toHaveLength(3);
    });
    expect(
      screen.queryByRole("img", { name: "Screenshot" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("img", { name: "photo.png" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTitle("Site preview for Slides"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("markdown-artifact-preview-html"),
    ).toHaveAttribute("href", HTML);
    expect(screen.getByLabelText("photo.png")).toHaveAttribute("href", IMAGE);
  },
);
