import {
  artifactCatalogContract,
  type ArtifactDetail,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { strToU8, zipSync } from "fflate";
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

test("Text artifacts open and close in the catalog sidebar", async () => {
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
  });
  click(await findArtifactAction("launch-plan.txt"));
  const preview = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(preview).findByText("The launch plan is ready"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByTestId("attachment-lightbox")).not.toBeInTheDocument();
  click(getButtonByName("Close artifact", preview));
  await waitFor(() => {
    expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
  });
  await expect(
    findArtifactAction("launch-plan.txt"),
  ).resolves.toBeInTheDocument();
});

test("A reopened catalog preview loads its newly selected file identity", async () => {
  let detail = fileDetail("launch-plan.txt", "text/plain");
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [detail], nextCursor: null });
  });
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    return respond(200, detail);
  });
  context.mocks.http.get(detail.file.url, () => {
    return HttpResponse.text("The original launch plan");
  });
  const revised = fileDetail("revised-launch-plan.txt", "text/plain");
  context.mocks.http.get(revised.file.url, () => {
    return HttpResponse.text("The revised launch plan");
  });
  await setupPage({ context, path: "/artifacts?tab=file" });
  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription("artifact:changed")).toBeTruthy();
  });
  click(await findArtifactAction(detail.title));
  const preview = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(preview).findByText("The original launch plan"),
  ).resolves.toBeInTheDocument();

  detail = {
    ...revised,
    file: {
      ...revised.file,
      id: "f0000000-0000-4000-a000-000000000003",
    },
  };
  await act(() => {
    context.mocks.ably.trigger("artifact:changed", { artifactId: ARTIFACT_ID });
  });
  await waitFor(() => {
    expect(
      within(screen.getByTestId("artifact-sidebar")).getByText(
        revised.file.filename,
      ),
    ).toBeInTheDocument();
  });
  click(
    getButtonByName("Close artifact", screen.getByTestId("artifact-sidebar")),
  );
  await waitFor(() => {
    expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
  });
  click(await findArtifactAction(detail.title));
  await expect(
    screen.findByText("The revised launch plan"),
  ).resolves.toBeInTheDocument();
});

test("HEIC catalog previews convert extensionless image sources", async () => {
  const detail = fileDetail("iPhone.heic", "image/heic");
  const source = `https://${"a".repeat(32)}.r2.cloudflarestorage.com/private/opaque?X-Amz-Signature=signature`;
  mockCatalog({ ...detail, file: { ...detail.file, url: source } });
  await setupPage({
    context,
    path: "/artifacts?tab=file",
  });

  click(await findArtifactAction("iPhone.heic"));
  const preview = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(preview).findByTestId("artifact-sidebar-body-image"),
  ).resolves.toHaveAttribute(
    "src",
    `https://cdn.vm7.io/cdn-cgi/image/fit=scale-down,format=auto,quality=85,metadata=none/${source}`,
  );
});

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

test("The catalog sidebar refreshes a private website after publication changes", async () => {
  let version = 1;
  const title = "Private release website";
  mockCatalog({
    ...artifact({ title, kind: "hosted-site" }),
    kind: "hosted-site",
    site: {
      id: "f0000000-0000-4000-a000-000000000002",
      slug: "private-release",
      publicSlug: "private-release",
      url: "https://private-release.okou.app/",
      deploymentVersion: 1,
      entrypoint: "index.html",
      spaFallback: false,
    },
  });
  context.mocks.api(hostContract.sitePreview, ({ respond }) => {
    return respond(200, {
      url: `https://pv-private-release-v${version}.okou.app/`,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
  });
  await setupPage({
    context,
    path: "/artifacts?tab=hosted-site",
    host: "app.okou.ai",
  });
  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription("artifact:changed")).toBeTruthy();
  });
  click(await findArtifactAction(title));
  await expect(screen.findByTitle(`${title} preview`)).resolves.toHaveAttribute(
    "src",
    "https://pv-private-release-v1.okou.app/",
  );

  version = 2;
  await act(() => {
    context.mocks.ably.trigger("artifact:changed", { artifactId: ARTIFACT_ID });
  });
  await waitFor(() => {
    expect(screen.getByTitle(`${title} preview`)).toHaveAttribute(
      "src",
      "https://pv-private-release-v2.okou.app/",
    );
  });
  const sidebar = screen.getByTestId("artifact-sidebar");
  click(getButtonByName("Close artifact", sidebar));
  await expect(findArtifactAction(title)).resolves.toBeInTheDocument();
  click(await findArtifactAction(title));
  await expect(screen.findByTitle(`${title} preview`)).resolves.toHaveAttribute(
    "src",
    "https://pv-private-release-v2.okou.app/",
  );
});

test("Binary artifacts open a download-capable sidebar instead of downloading on click", async () => {
  const browser = context.mocks.browser.blobDownload();
  mockCatalog(fileDetail("release-bundle.zip", "application/zip"));
  await setupPage({
    context,
    path: "/artifacts?tab=file",
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

test("A ZIP lists nested files and lets a selected entry's preview be dismissed", async () => {
  const user = userEvent.setup();
  const archive = zipSync({
    "docs/notes.txt": strToU8("Notes from inside the archive"),
    "docs/report.md": strToU8("# Inside the release report"),
    "index.html": strToU8("<p>Website source</p>"),
  });
  const detail = fileDetail("release-bundle.zip", "application/zip");
  mockCatalog({
    ...detail,
    file: { ...detail.file, size: archive.byteLength },
  });
  context.mocks.http.get(detail.file.url, () => {
    return new HttpResponse(archive.slice().buffer, {
      headers: { "Content-Type": "application/zip" },
    });
  });
  await setupPage({
    context,
    path: "/artifacts?tab=file",
    featureSwitches: { [FeatureSwitchKey.ZipArtifactPreview]: true },
  });

  click(await findArtifactAction("release-bundle.zip"));
  const preview = await screen.findByTestId("artifact-sidebar");
  const notes = await within(preview).findByText("docs/notes.txt");
  expect(within(preview).getByText("index.html").closest("button")).toBeNull();
  expect(
    within(preview).queryByText("Notes from inside the archive"),
  ).not.toBeInTheDocument();
  click(notes);
  await expect(
    within(preview).findByText("Notes from inside the archive"),
  ).resolves.toBeInTheDocument();
  const report = getButtonByName("docs/report.md", preview);
  const reportHeading = { name: "Inside the release report" };
  await user.click(report);
  await within(preview).findByRole("heading", reportHeading);
  expect(
    within(preview).queryByText("Notes from inside the archive"),
  ).not.toBeInTheDocument();
  expect(getButtonByName("Download artifact", preview)).toBeInTheDocument();

  await user.click(report);
  expect(report).toHaveAttribute("aria-pressed", "false");
  expect(report).toHaveFocus();
  expect(within(preview).queryByRole("heading", reportHeading)).toBeNull();
  expect(notes).toBeInTheDocument();

  await user.keyboard("{Enter}");
  await expect(
    within(preview).findByRole("heading", reportHeading),
  ).resolves.toBeInTheDocument();
});

test("A ZIP larger than 5 MiB keeps the download fallback without fetching the archive", async () => {
  const detail = fileDetail("large.zip", "application/zip");
  mockCatalog({
    ...detail,
    file: { ...detail.file, size: 5 * 1024 * 1024 + 1 },
  });
  let requests = 0;
  context.mocks.http.get(detail.file.url, () => {
    requests += 1;
    return HttpResponse.text("Unexpected archive request");
  });
  await setupPage({
    context,
    path: "/artifacts?tab=file",
    featureSwitches: { [FeatureSwitchKey.ZipArtifactPreview]: true },
  });

  click(await findArtifactAction("large.zip"));
  const preview = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(preview).findByText("No inline preview available for this file."),
  ).resolves.toBeInTheDocument();
  expect(getButtonByName("Download artifact", preview)).toBeInTheDocument();
  expect(requests).toBe(0);
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
      downloadUrl: new URL("?download=1", resolved).href,
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
