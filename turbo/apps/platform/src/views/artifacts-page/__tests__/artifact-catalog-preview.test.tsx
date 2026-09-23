import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  artifact,
  findArtifactAction,
  setupArtifactCatalogPage,
} from "./artifact-catalog-test-helpers.ts";

const context = testContext();

test("An avatar card and its viewer share one private video URL", async () => {
  const fileId = "f0000000-0000-4000-a000-000000000004";
  const canonicalUrl = artifactReferencePath(fileId, "avatar-video.mp4");
  const firstUrl = "https://private.example/avatar-video.mp4?signature=first";
  const nextUrl = "https://private.example/avatar-video.mp4?signature=next";
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, {
      artifacts: [
        artifact({
          kind: "avatar",
          title: "avatar-video.mp4",
          videoSourceUrl: canonicalUrl,
        }),
      ],
      nextCursor: null,
    });
  });
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    return respond(200, {
      ...artifact({
        kind: "avatar",
        title: "avatar-video.mp4",
        videoSourceUrl: canonicalUrl,
      }),
      kind: "avatar",
      file: {
        id: fileId,
        filename: "avatar-video.mp4",
        contentType: "video/mp4",
        size: 4096,
        url: canonicalUrl,
        previewImageUrl: null,
      },
      model: "joggai-talking-avatar",
      durationSeconds: 12,
    });
  });
  let resolveCount = 0;
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    const url = resolveCount === 0 ? firstUrl : nextUrl;
    resolveCount += 1;
    return respond(200, {
      url,
      expiresAt: "2099-01-01T00:00:00.000Z",
      filename: "avatar-video.mp4",
      contentType: "video/mp4",
      target: { kind: "file", id: fileId },
    });
  });

  await setupArtifactCatalogPage(context, { path: "/artifacts?tab=avatar" });

  const avatar = await findArtifactAction("avatar-video.mp4");
  await expect(
    within(avatar).findByTestId("artifact-catalog-video-source"),
  ).resolves.toHaveAttribute("src", `${firstUrl}#t=0.001`);
  click(avatar);
  await expect(
    screen.findByLabelText("Video preview for avatar-video.mp4"),
  ).resolves.toHaveAttribute("src", firstUrl);
});

test("Opening an unpreviewable binary downloads it with the correct filename", async () => {
  const browser = context.mocks.browser.blobDownload();
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, {
      artifacts: [artifact({ title: "release-bundle.zip" })],
      nextCursor: null,
    });
  });
  context.mocks.http.get(
    "https://artifacts.example.com/release-bundle.zip",
    () => {
      return HttpResponse.text("archive bytes", {
        headers: { "Content-Type": "application/zip" },
      });
    },
  );
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    return respond(200, {
      ...artifact({ title: "release-bundle.zip" }),
      kind: "file",
      file: {
        id: "f0000000-0000-4000-a000-000000000002",
        filename: "release-bundle.zip",
        contentType: "application/zip",
        size: 2048,
        url: "https://artifacts.example.com/release-bundle.zip",
        previewImageUrl: null,
      },
    });
  });

  await setupArtifactCatalogPage(context, { path: "/artifacts?tab=file" });

  const archive = await findArtifactAction("release-bundle.zip");
  click(archive);

  await waitFor(() => {
    expect(browser.downloads).toHaveLength(1);
  });
  expect(browser.downloads[0]).toMatchObject({
    filename: "release-bundle.zip",
    url: "https://artifacts.example.com/release-bundle.zip",
  });
});

test("Opening a text artifact shows its content on demand", async () => {
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, {
      artifacts: [artifact({ title: "launch-plan.txt" })],
      nextCursor: null,
    });
  });
  context.mocks.http.get(
    "https://artifacts.example.com/launch-plan.txt",
    () => {
      return HttpResponse.text("launch plan");
    },
  );
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    return respond(200, {
      ...artifact({ title: "launch-plan.txt" }),
      kind: "file",
      file: {
        id: "f0000000-0000-4000-a000-000000000001",
        filename: "launch-plan.txt",
        contentType: "text/plain",
        size: 1024,
        url: "https://artifacts.example.com/launch-plan.txt",
        previewImageUrl: null,
      },
    });
  });

  await setupArtifactCatalogPage(context, { path: "/artifacts?tab=file" });

  const textArtifact = await findArtifactAction("launch-plan.txt");
  expect(screen.queryByText("launch plan")).not.toBeInTheDocument();
  click(textArtifact);

  await expect(screen.findByText("launch plan")).resolves.toBeInTheDocument();
});
