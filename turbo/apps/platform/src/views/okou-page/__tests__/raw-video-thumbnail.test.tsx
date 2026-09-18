import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  setupSharedThreadPage,
  sharedThread,
} from "../../shared-thread-page/__tests__/shared-thread-test-helpers.ts";
import { createMarkdownChatFixture } from "./markdown-page-test-helpers.ts";

const context = testContext();
const POSTER_ID = "f0000000-0000-4000-a000-000000000941";
const VIDEO_URL = "https://videos.example.test/clip.mp4";
const R2_ORIGIN = `https://${"a".repeat(32)}.r2.cloudflarestorage.com`;

function rawVideo(poster: string): string {
  return `<video aria-label="Preview clip" controls preload="none" src="${VIDEO_URL}" poster="${poster}"></video>`;
}

test.each(["artifact-reference", "uploaded-file"] as const)(
  "Raw video resolves an authorized %s poster before displaying a thumbnail",
  async (source) => {
    const poster =
      source === "artifact-reference"
        ? artifactReferencePath(POSTER_ID, "poster.jpg")
        : `https://api.okou.ai/api/web/download-file?file_id=${POSTER_ID}`;
    const extension = source === "artifact-reference" ? "bin" : "jpg";
    const originalPoster = `${R2_ORIGIN}/private/poster%20%2B.${extension}?X-Amz-Signature=poster&X-Amz-Security-Token=token%2B%2F%3D`;
    const authorized = context.mocks.deferred<void>();
    context.mocks.api(
      artifactReferencesContract.resolve,
      async ({ respond }) => {
        await authorized.promise;
        return respond(200, {
          url: originalPoster,
          expiresAt: "2099-01-01T00:00:00Z",
          filename: "poster.jpg",
          contentType: "image/jpeg",
          target: { kind: "file", id: POSTER_ID },
        });
      },
    );
    context.mocks.api(webFilesContract.fileUrl, async ({ respond }) => {
      await authorized.promise;
      return respond(200, {
        url: originalPoster,
        expiresAt: "2099-01-01T00:00:00Z",
        publicUrl: null,
      });
    });
    const fixture = createMarkdownChatFixture(context);
    fixture.install({
      rows: () => {
        return [
          fixture.outputMessage(rawVideo(poster), { seqId: 1 }),
          fixture.runCompleted({ seqId: 2 }),
        ];
      },
    });

    await setupPage({ context, path: fixture.path, host: "app.okou.ai" });
    const video = await screen.findByLabelText("Preview clip");
    expect(video).not.toHaveAttribute("poster");
    expect(video).toHaveAttribute("src", VIDEO_URL);
    expect(video).toHaveAttribute("controls");
    expect(video).toHaveAttribute("preload", "none");

    authorized.resolve();
    await waitFor(() => {
      expect(video).toHaveAttribute(
        "poster",
        `https://a.okou.io/cdn-cgi/image/width=800,height=720,fit=scale-down,format=auto,quality=85,metadata=none/${originalPoster}`,
      );
    });
    expect(video).toHaveAttribute("src", VIDEO_URL);
  },
);

test("Shared raw videos resize public posters without changing playback", async () => {
  const poster = "https://a.okou.io/shared-threads/public/video/poster.jpg";
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(
      200,
      sharedThread({
        messages: [
          {
            messageIndex: 0,
            role: "assistant",
            content: rawVideo(poster),
            runIndex: 0,
          },
        ],
      }),
    );
  });

  await setupSharedThreadPage(context, { host: "app.okou.ai" });
  const video = await screen.findByLabelText("Preview clip");
  expect(video).toHaveAttribute(
    "poster",
    "https://a.okou.io/cdn-cgi/image/width=800,height=720,fit=scale-down,format=auto,quality=85,metadata=none/shared-threads/public/video/poster.jpg",
  );
  expect(video).toHaveAttribute("src", VIDEO_URL);
  expect(video).toHaveAttribute("controls");
});
