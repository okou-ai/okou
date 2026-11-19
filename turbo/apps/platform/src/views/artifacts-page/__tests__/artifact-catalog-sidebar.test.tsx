import {
  artifactCatalogContract,
  type ArtifactDetail,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
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

function openCatalog(path: string, sidebarPreview: boolean) {
  return setupPage({
    context,
    path,
    featureSwitches: {
      [FeatureSwitchKey.ArtifactSidebarPreview]: sidebarPreview,
    },
  });
}

test("Without sidebar previews a text artifact opens in the lightbox and closes back to the catalog", async () => {
  mockCatalog(fileDetail("launch-plan.txt", "text/plain"));
  context.mocks.http.get(
    "https://artifacts.example.com/launch-plan.txt",
    () => {
      return HttpResponse.text("The launch plan is ready");
    },
  );
  await openCatalog("/artifacts?tab=file", false);

  click(await findArtifactAction("launch-plan.txt"));

  const preview = await screen.findByTestId("attachment-lightbox");
  await expect(
    within(preview).findByText("The launch plan is ready"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
  click(getButtonByName("Close", preview));
  await waitFor(() => {
    expect(preview).not.toBeInTheDocument();
  });
  await expect(
    findArtifactAction("launch-plan.txt"),
  ).resolves.toBeInTheDocument();
});

test("A routed website preview toggles fullscreen and Close returns to its catalog", async () => {
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
  await openCatalog(
    "/artifacts?tab=hosted-site&artifact=a0000000-0000-4000-a000-000000000001",
    true,
  );
  const preview = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(preview).findByTitle("Release website preview"),
  ).resolves.toHaveAttribute("src", "https://release.example.com/");

  click(getButtonByName("Enter fullscreen", preview));
  await waitFor(() => {
    expect(getButtonByName("Exit fullscreen", preview)).toBeEnabled();
  });
  click(getButtonByName("Exit fullscreen", preview));
  await waitFor(() => {
    expect(getButtonByName("Enter fullscreen", preview)).toBeEnabled();
  });
  click(getButtonByName("Close artifact", preview));

  await waitFor(() => {
    expect(window.location.search).toBe("?tab=hosted-site");
  });
  expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
  await expect(
    findArtifactAction("Release website"),
  ).resolves.toBeInTheDocument();
});

test("A binary artifact opens a download-capable sidebar without downloading", async () => {
  const browser = context.mocks.browser.blobDownload();
  mockCatalog(fileDetail("release-bundle.zip", "application/zip"));
  await openCatalog("/artifacts?tab=file", true);

  click(await findArtifactAction("release-bundle.zip"));

  const preview = await screen.findByTestId("artifact-sidebar");
  await waitFor(() => {
    expect(getButtonByName("Download artifact", preview)).toBeInTheDocument();
  });
  expect(
    within(preview).getAllByText("release-bundle.zip").length,
  ).toBeGreaterThan(0);
  expect(browser.downloads).toHaveLength(0);
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
  await openCatalog("/artifacts?tab=file", true);
  const card = await findArtifactAction("pending.pdf");

  click(card);
  const loading = await screen.findByRole("complementary", {
    name: "Artifact",
  });
  click(getButtonByName("Close artifact", loading));
  await waitFor(() => {
    expect(loading).not.toBeInTheDocument();
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
