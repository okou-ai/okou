import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  mockAttachmentChat,
  ATTACHMENT_THREAD_ID,
  ATTACHMENT_RUN_ID,
} from "./chat-attachment-test-helpers.ts";
import {
  publicConversation,
  sharedBody,
} from "../../shared-thread-page/__tests__/shared-preview-boundaries.ts";
const context = testContext();
const clip = "https://cdn.okou.io/artifacts/demo/lake.mp4";
const otherClip = "https://cdn.okou.io/artifacts/demo/night.mp4";
const publicPoster = "https://cdn.okou.io/artifacts/demo/dawn.webp";
const privatePoster =
  "https://studio.r2.cloudflarestorage.com/preview/sunrise.webp?X-Amz-Signature=local-signed-response";
function markup(src: string, poster?: string) {
  return (
    '<video controls preload="none" src="' +
    src +
    '"' +
    (poster ? ' poster="' + poster + '"' : "") +
    "></video>"
  );
}
function player(src: string) {
  return waitFor(() => {
    const element = Array.from(document.querySelectorAll("video")).find(
      (video) => {
        return video.src === src;
      },
    );
    expect(element).toBeDefined();
    return element!;
  });
}
function playback(video: HTMLVideoElement, src: string) {
  expect(video.src).toBe(src);
  expect(video.controls).toBeTruthy();
  expect(video.preload).toBe("none");
}
test("raw-video-thumbnail-001 A private poster appears only after authorization while the playable source is preserved", async () => {
  const ref = "p8s7g3n9tx.webp",
    reply = context.mocks.deferred<void>(),
    pending = context.mocks.deferred<void>();
  context.mocks.api(
    artifactReferencesContract.resolve,
    async ({ params, respond }) => {
      if (params.reference !== ref) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Unknown cover" },
        });
      }
      if (!pending.settled()) {
        pending.resolve();
      }
      await reply.promise;
      return respond(200, {
        url: privatePoster,
        downloadUrl: privatePoster,
        downloadAllowed: true,
        expiresAt: "2099-01-01T00:00:00Z",
        filename: "sunrise.webp",
        contentType: "image/webp",
        target: { kind: "file", id: context.resourceId },
      });
    },
  );
  mockAttachmentChat(context, {
    chatEvents: [
      {
        role: "assistant",
        content: markup(clip, "https://app.okou.ai/artifacts/" + ref),
        createdAt: "2026-10-10T09:00:00Z",
        runId: ATTACHMENT_RUN_ID,
        runEventId: "training-clip",
        sequenceNumber: 1,
      },
    ],
  });
  try {
    await setupPage({
      context,
      host: "app.okou.ai",
      path: "/chats/" + ATTACHMENT_THREAD_ID,
    });
    const video = await player(clip);
    await pending.promise;
    playback(video, clip);
    expect(video).not.toHaveAttribute("poster");
    reply.resolve();
    await waitFor(() => {
      return expect(video.getAttribute("poster")).toContain("/cdn-cgi/image/");
    });
    expect(video.getAttribute("poster")).toContain("/" + privatePoster);
    playback(video, clip);
  } finally {
    if (!reply.settled()) {
      reply.resolve();
    }
  }
});
test("raw-video-thumbnail-003 A signed-out visitor sees the public poster and can play either shared video", async () => {
  const content = [
    "Clips from the lake",
    markup(clip, publicPoster),
    markup(otherClip),
  ].join("\n\n");
  await publicConversation(context, [], [sharedBody(content)]);
  await screen.findByText("Clips from the lake");
  const dawn = await player(clip),
    night = await player(otherClip);
  playback(dawn, clip);
  playback(night, otherClip);
  expect(night).not.toHaveAttribute("poster");
  const transformed = new URL(dawn.getAttribute("poster")!);
  expect(transformed.origin).toBe("https://cdn.okou.io");
  expect(transformed.pathname).toMatch(
    /^\/cdn-cgi\/image\/[^/]+\/artifacts\/demo\/dawn\.webp$/,
  );
});
