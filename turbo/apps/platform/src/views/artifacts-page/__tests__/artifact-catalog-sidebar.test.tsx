import {
  artifactCatalogContract,
  type ArtifactDetail,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  artifact,
  findArtifactAction,
  getButtonByName,
} from "./artifact-catalog-test-helpers.ts";

const context = testContext();
const ARTIFACT_ID = "a0000000-0000-4000-a000-000000000001";

function fileDetail(
  filename: string,
  contentType: string,
): Extract<ArtifactDetail, { kind: "file" }> {
  return {
    ...artifact({ title: filename }),
    kind: "file",
    file: {
      id: "f0000000-0000-4000-a000-000000000001",
      filename,
      contentType,
      size: 1024,
      url: `https://artifacts.example.com/${filename}`,
      previewImageUrl: null,
    },
  };
}

function mockCatalog(detail: ArtifactDetail) {
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [detail], nextCursor: null });
  });
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    return respond(200, detail);
  });
}

test.each([false, true])(
  "Text artifacts use the sidebar only when sidebar previews are enabled (%s)",
  async (enabled) => {
    mockCatalog(fileDetail("launch-plan.txt", "text/plain"));
    context.mocks.http.get(
      "https://artifacts.example.com/launch-plan.txt",
      () => {
        return HttpResponse.text("The launch plan is ready");
      },
    );
    await setupPage({
      context,
      path: "/artifacts?tab=file",
      featureSwitches: { [FeatureSwitchKey.ArtifactSidebarPreview]: enabled },
    });
    click(await findArtifactAction("launch-plan.txt"));
    const preview = await screen.findByTestId(
      enabled ? "artifact-sidebar" : "attachment-lightbox",
    );
    await expect(
      within(preview).findByText("The launch plan is ready"),
    ).resolves.toBeInTheDocument();
    expect(
      screen.queryByTestId(
        enabled ? "attachment-lightbox" : "artifact-sidebar",
      ),
    ).not.toBeInTheDocument();
    click(getButtonByName(enabled ? "Close artifact" : "Close", preview));
    await waitFor(() => {
      expect(
        screen.queryByTestId(
          enabled ? "artifact-sidebar" : "attachment-lightbox",
        ),
      ).not.toBeInTheDocument();
    });
    await expect(
      findArtifactAction("launch-plan.txt"),
    ).resolves.toBeInTheDocument();
  },
);

test("A routed website preview opens in the sidebar and Close returns to its catalog", async () => {
  mockCatalog({
    ...artifact({ title: "Release website", kind: "hosted-site" }),
    kind: "hosted-site",
    site: {
      id: "f0000000-0000-4000-a000-000000000002",
      slug: "release-website",
      publicSlug: "release-website",
      url: "https://release.example.com/",
      deploymentVersion: 1,
      entrypoint: "index.html",
      spaFallback: false,
    },
  });
  await setupPage({
    context,
    path: `/artifacts?tab=hosted-site&artifact=${ARTIFACT_ID}`,
    featureSwitches: {
      [FeatureSwitchKey.ArtifactSidebarPreview]: true,
      [FeatureSwitchKey.StablePreviewFullscreen]: true,
    },
  });
  const preview = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(preview).findByTitle("Release website preview"),
  ).resolves.toHaveAttribute("src", "https://release.example.com/");
  expect(screen.queryByTestId("attachment-lightbox")).not.toBeInTheDocument();
  click(getButtonByName("Enter fullscreen", preview));
  await waitFor(() => {
    expect(getButtonByName("Exit fullscreen", preview)).toBeInTheDocument();
  });
  click(getButtonByName("Exit fullscreen", preview));
  click(getButtonByName("Close artifact", preview));
  await waitFor(() => {
    expect(window.location.search).toBe("?tab=hosted-site");
    expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
  });
  await expect(
    findArtifactAction("Release website"),
  ).resolves.toBeInTheDocument();
});

test("Binary artifacts open a download-capable sidebar instead of downloading on click", async () => {
  const browser = context.mocks.browser.blobDownload();
  mockCatalog(fileDetail("release-bundle.zip", "application/zip"));
  await setupPage({
    context,
    path: "/artifacts?tab=file",
    featureSwitches: { [FeatureSwitchKey.ArtifactSidebarPreview]: true },
  });
  click(await findArtifactAction("release-bundle.zip"));
  const preview = await screen.findByTestId("artifact-sidebar");
  expect(
    within(preview).getAllByText("release-bundle.zip").length,
  ).toBeGreaterThan(0);
  expect(getButtonByName("Download artifact", preview)).toBeInTheDocument();
  expect(browser.downloads).toHaveLength(0);
  expect(screen.queryByTestId("attachment-lightbox")).not.toBeInTheDocument();
});

test("An avatar sidebar reuses the private video URL already shown by its card", async () => {
  const fileId = "f0000000-0000-4000-a000-000000000004";
  const url = artifactReferencePath(fileId, "avatar.mp4");
  const firstUrl = "https://private.example/avatar.mp4?signature=first";
  const nextUrl = "https://private.example/avatar.mp4?signature=next";
  const file = fileDetail("avatar.mp4", "video/mp4").file;
  mockCatalog({
    ...artifact({ kind: "avatar", title: "avatar.mp4", videoSourceUrl: url }),
    kind: "avatar",
    file: { ...file, id: fileId, url },
    model: "joggai-talking-avatar",
    durationSeconds: 12,
  });
  let resolveCount = 0;
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    const resolved = resolveCount++ === 0 ? firstUrl : nextUrl;
    return respond(200, {
      url: resolved,
      expiresAt: "2099-01-01T00:00:00.000Z",
      filename: "avatar.mp4",
      contentType: "video/mp4",
      target: { kind: "file", id: fileId },
    });
  });
  await setupPage({
    context,
    path: "/artifacts?tab=avatar",
    featureSwitches: { [FeatureSwitchKey.ArtifactSidebarPreview]: true },
  });
  const card = await findArtifactAction("avatar.mp4");
  await expect(
    within(card).findByTestId("artifact-catalog-video-source"),
  ).resolves.toHaveAttribute("src", `${firstUrl}#t=0.001`);
  click(card);
  const sidebar = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(sidebar).findByLabelText("Video preview for avatar.mp4"),
  ).resolves.toHaveAttribute("src", firstUrl);
  expect(screen.queryByTestId("attachment-lightbox")).not.toBeInTheDocument();
});

test("Closing a loading sidebar cancels its preview and allows a later reopen", async () => {
  const release = context.mocks.deferred<void>();
  const detail = fileDetail("pending.pdf", "application/pdf");
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [detail], nextCursor: null });
  });
  context.mocks.api(artifactCatalogContract.get, async ({ respond }) => {
    await release.promise;
    return respond(200, detail);
  });
  await setupPage({
    context,
    path: "/artifacts?tab=file",
    featureSwitches: { [FeatureSwitchKey.ArtifactSidebarPreview]: true },
  });
  const card = await findArtifactAction("pending.pdf");
  click(card);
  const preview = await screen.findByRole("complementary", {
    name: "Artifact",
  });
  click(getButtonByName("Close artifact", preview));
  await waitFor(() => {
    expect(preview).not.toBeInTheDocument();
  });
  release.resolve();
  click(card);
  const reopened = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(reopened).findByTitle("pending.pdf preview"),
  ).resolves.toHaveAttribute(
    "src",
    "https://artifacts.example.com/pending.pdf#navpanes=0",
  );
  expect(screen.queryByTestId("attachment-lightbox")).not.toBeInTheDocument();
});
