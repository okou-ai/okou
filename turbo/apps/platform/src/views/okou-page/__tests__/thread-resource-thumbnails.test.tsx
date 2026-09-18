import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import { fireEvent, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "../sidebar-breakpoint.ts";
import {
  artifactSummary,
  buttonNamed,
  imageArtifactDetail,
  mockArtifactConversation,
  NAVIGATION_ARTIFACT_THREAD_ID,
} from "./chat-navigation-artifact-test-helpers.ts";

const context = testContext();
const ARTIFACT_ID = "a0000000-0000-4000-a000-000000000940";
const IMAGE_ID = "f0000000-0000-4000-a000-000000000940";
const SEARCH_LABEL = "Search workspace...";
const ORIGINAL_IMAGE_URL =
  `https://${"a".repeat(32)}.r2.cloudflarestorage.com/private-artifacts/chart.bin` +
  "?X-Amz-Signature=thumbnail-signature";

function mockPrivateImage() {
  context.mocks.browser.matchMedia((query) => {
    return (
      query === SIDEBAR_DESKTOP_MEDIA_QUERY || query === "(min-width: 1280px)"
    );
  });
  const reference = artifactReferencePath(IMAGE_ID, "chart.png");
  const summary = {
    ...artifactSummary(ARTIFACT_ID, "image", "Private chart"),
    thumbnail: { url: reference },
  };
  mockArtifactConversation(context, {
    catalog: [summary],
    details: new Map([
      [
        ARTIFACT_ID,
        imageArtifactDetail(summary, {
          fileId: IMAGE_ID,
          filename: "chart.png",
          url: reference,
        }),
      ],
    ]),
  });
  const authorized = context.mocks.deferred<void>();
  context.mocks.api(artifactReferencesContract.resolve, async ({ respond }) => {
    await authorized.promise;
    return respond(200, {
      url: ORIGINAL_IMAGE_URL,
      expiresAt: "2099-01-01T00:00:00Z",
      filename: "chart.png",
      contentType: "image/png",
      target: { kind: "file", id: IMAGE_ID },
    });
  });
  return authorized;
}

test("Thread artifacts use authorized thumbnails and open the original image", async () => {
  const authorized = mockPrivateImage();
  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
  });
  const openArtifacts = await screen.findByLabelText("Open artifacts");
  click(openArtifacts);
  const sidebar = await screen.findByTestId("thread-sidebar-artifacts");
  await within(sidebar).findByText("Private chart");
  expect(
    within(sidebar).queryByTestId("artifact-catalog-thumbnail"),
  ).toBeNull();

  authorized.resolve();
  const thumbnail = await within(sidebar).findByTestId(
    "artifact-catalog-thumbnail",
  );
  expect(thumbnail).toHaveAttribute(
    "src",
    `https://a.okou.io/cdn-cgi/image/width=640,fit=scale-down,format=auto,quality=85,metadata=none/${ORIGINAL_IMAGE_URL}`,
  );

  click(buttonNamed("Preview Private chart", sidebar));
  await expect(
    screen.findByTestId("artifact-sidebar-body-image"),
  ).resolves.toHaveAttribute("src", ORIGINAL_IMAGE_URL);
});

test("Workspace search uses a small authorized thumbnail for a private image", async () => {
  const authorized = mockPrivateImage();
  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
  });
  await screen.findByLabelText("Open artifacts");
  fireEvent.keyDown(document.body, {
    key: "f",
    code: "KeyF",
    ctrlKey: true,
    shiftKey: true,
  });
  const dialog = await screen.findByRole("dialog", { name: SEARCH_LABEL });
  await fill(within(dialog).getByPlaceholderText(SEARCH_LABEL), "Private");
  await within(dialog).findByText("Private chart");
  expect(
    within(dialog).queryByTestId("spotlight-artifact-thumbnail"),
  ).toBeNull();

  authorized.resolve();
  const thumbnail = await within(dialog).findByTestId(
    "spotlight-artifact-thumbnail",
  );
  expect(thumbnail).toHaveAttribute(
    "src",
    `https://a.okou.io/cdn-cgi/image/width=64,fit=scale-down,format=auto,quality=85,metadata=none/${ORIGINAL_IMAGE_URL}`,
  );
});

test("Thread video cards wait for their poster and fall back after a thumbnail error", async () => {
  context.mocks.browser.matchMedia((query) => {
    return (
      query === SIDEBAR_DESKTOP_MEDIA_QUERY || query === "(min-width: 1280px)"
    );
  });
  const videoUrl = "https://videos.example.test/private-movie.mp4";
  mockArtifactConversation(context, {
    catalog: [
      {
        ...artifactSummary(ARTIFACT_ID, "video", "Private movie"),
        thumbnail: { url: artifactReferencePath(IMAGE_ID, "poster.jpg") },
        videoSourceUrl: videoUrl,
      },
    ],
  });
  const authorized = context.mocks.deferred<void>();
  context.mocks.api(artifactReferencesContract.resolve, async ({ respond }) => {
    await authorized.promise;
    return respond(200, {
      url: ORIGINAL_IMAGE_URL,
      expiresAt: "2099-01-01T00:00:00Z",
      filename: "poster.jpg",
      contentType: "image/jpeg",
      target: { kind: "file", id: IMAGE_ID },
    });
  });

  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
  });
  click(await screen.findByLabelText("Open artifacts"));
  const sidebar = await screen.findByTestId("thread-sidebar-artifacts");
  await within(sidebar).findByText("Private movie");
  expect(
    within(sidebar).queryByTestId("artifact-catalog-video-source"),
  ).toBeNull();

  authorized.resolve();
  const thumbnail = await within(sidebar).findByTestId(
    "artifact-catalog-thumbnail",
  );
  expect(thumbnail).toHaveAttribute(
    "src",
    `https://a.okou.io/cdn-cgi/image/width=640,fit=scale-down,format=auto,quality=85,metadata=none/${ORIGINAL_IMAGE_URL}`,
  );
  expect(
    within(sidebar).queryByTestId("artifact-catalog-video-source"),
  ).toBeNull();

  fireEvent.error(thumbnail);
  await expect(
    within(sidebar).findByTestId("artifact-catalog-video-source"),
  ).resolves.toHaveAttribute("src", `${videoUrl}#t=0.001`);
});
