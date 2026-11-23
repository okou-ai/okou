import {
  artifactCatalogContract,
  type ArtifactDetail,
  type ArtifactSummary,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { act, screen, waitFor, within } from "@testing-library/react";
import { strToU8, zipSync } from "fflate";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { fileArtifactDetail } from "../../okou-page/__tests__/chat-navigation-artifact-test-helpers.ts";
import {
  artifact,
  findArtifactAction,
  getButtonByName,
  queryButtonByName,
} from "./artifact-catalog-test-helpers.ts";

const context = testContext();

function serveCatalog(summary: ArtifactSummary): void {
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [summary], nextCursor: null });
  });
}

function storedFile(
  summary: ArtifactSummary,
  filename: string,
  contentType: string,
): { readonly detail: ArtifactDetail; readonly url: string } {
  const url = `https://files.example.test/catalog/${filename}`;
  return {
    detail: fileArtifactDetail(summary, {
      filename,
      contentType,
      fileId: "a0000000-0000-4000-a000-000000000e99",
      url,
    }),
    url,
  };
}

function openCatalog(path = "/artifacts") {
  return setupPage({
    context,
    path,
  });
}

function sidebar(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[data-testid="artifact-sidebar"]',
  );
}

test("A reader can return to the catalog after previewing a text artifact", async () => {
  const summary = artifact({
    id: "a0000000-0000-4000-a000-000000000e01",
    title: "launch-plan.txt",
  });
  serveCatalog(summary);
  const { detail, url } = storedFile(summary, "launch-plan.txt", "text/plain");
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    return respond(200, detail);
  });
  context.mocks.http.get(url, () => {
    return HttpResponse.text("The launch plan is ready");
  });
  await openCatalog();

  click(await findArtifactAction("launch-plan.txt"));

  const lightbox = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(lightbox).findByText("The launch plan is ready"),
  ).resolves.toBeInTheDocument();
  click(getButtonByName("Close artifact", lightbox));

  await waitFor(() => {
    expect(lightbox).not.toBeInTheDocument();
  });
  expect(getButtonByName("Preview launch-plan.txt")).toBeEnabled();
});

test("A routed website preview opens in the sidebar and Close returns to its catalog", async () => {
  const summary = artifact({
    id: "a0000000-0000-4000-a000-000000000e11",
    kind: "hosted-site",
    title: "Release website",
  });
  serveCatalog(summary);
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    return respond(200, {
      ...summary,
      kind: "hosted-site",
      site: {
        id: "a0000000-0000-4000-a000-000000000e12",
        slug: "release",
        publicSlug: "release",
        url: "https://release.example.test/",
        deploymentVersion: 3,
        entrypoint: "/index.html",
        spaFallback: false,
      },
    });
  });
  await openCatalog(`/artifacts?tab=hosted-site&artifact=${summary.id}`);
  await waitFor(() => {
    expect(sidebar()).toBeInTheDocument();
  });
  const panel = sidebar() as HTMLElement;

  click(getButtonByName("Enter fullscreen", panel));
  await waitFor(() => {
    expect(queryButtonByName("Exit fullscreen", panel)).toBeDefined();
  });
  click(getButtonByName("Exit fullscreen", panel));
  await waitFor(() => {
    expect(queryButtonByName("Enter fullscreen", panel)).toBeDefined();
  });

  click(getButtonByName("Close artifact", panel));

  await waitFor(() => {
    expect(
      new URLSearchParams(window.location.search).has("artifact"),
    ).toBeFalsy();
  });
  expect(window.location.pathname).toBe("/artifacts");
  expect(new URLSearchParams(window.location.search).get("tab")).toBe(
    "hosted-site",
  );
  await waitFor(() => {
    expect(sidebar()).toBeNull();
  });
  expect(getButtonByName("Preview Release website")).toBeEnabled();
});

test("Binary artifacts open a download-capable sidebar instead of downloading on click", async () => {
  const summary = artifact({
    id: "a0000000-0000-4000-a000-000000000e21",
    title: "release-bundle.zip",
  });
  serveCatalog(summary);
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    return respond(
      200,
      storedFile(summary, "release-bundle.zip", "application/zip").detail,
    );
  });
  const browser = context.mocks.browser.blobDownload();
  await openCatalog();

  click(await findArtifactAction("release-bundle.zip"));

  await waitFor(() => {
    expect(sidebar()).toBeInTheDocument();
  });
  const panel = sidebar() as HTMLElement;
  await expect(
    within(panel).findAllByText("release-bundle.zip"),
  ).resolves.not.toHaveLength(0);
  expect(getButtonByName("Download artifact", panel)).toBeEnabled();
  expect(browser.downloads).toStrictEqual([]);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("Closing a loading sidebar cancels its preview and allows a later reopen", async () => {
  const summary = artifact({
    id: "a0000000-0000-4000-a000-000000000e31",
    title: "pending.pdf",
  });
  serveCatalog(summary);
  const { detail, url } = storedFile(summary, "pending.pdf", "application/pdf");
  const firstRead = { held: true };
  const release = context.mocks.deferred<void>();
  const answered = context.mocks.deferred<void>();
  context.mocks.api(artifactCatalogContract.get, async ({ respond }) => {
    if (firstRead.held) {
      firstRead.held = false;
      await release.promise;
      answered.resolve();
    }
    return respond(200, detail);
  });
  await openCatalog();
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
  await answered.promise;
  click(card);

  const frame = await screen.findByTestId("artifact-sidebar-body-pdf");
  expect(frame).toHaveAttribute("src", `${url}#navpanes=0`);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("The catalog sidebar refreshes a private website after publication changes", async () => {
  let version = 1;
  const title = "Private release website";
  const detail: ArtifactDetail = {
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
  };
  serveCatalog(detail);
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    return respond(200, detail);
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
    context.mocks.ably.trigger("artifact:changed", { artifactId: detail.id });
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

async function inspectArchive(size: number, bytes: Uint8Array<ArrayBuffer>) {
  const summary = artifact({ title: "Harbor records.zip" });
  serveCatalog(summary);
  const { detail, url } = storedFile(summary, "records.zip", "application/zip");
  if (detail.kind !== "file") {
    throw new Error("The archive fixture must represent a file");
  }
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    return respond(200, { ...detail, file: { ...detail.file, size } });
  });
  context.mocks.http.get(url, () => {
    return new HttpResponse(bytes.buffer, {
      headers: { "Content-Type": "application/zip" },
    });
  });
  await setupPage({
    context,
    path: "/artifacts",
    featureSwitches: { [FeatureSwitchKey.ZipArtifactPreview]: true },
  });
  click(await findArtifactAction(summary.title));
  return within(await screen.findByTestId("artifact-sidebar"));
}

test("Opening entries in a catalog ZIP changes the document shown in its sidebar", async () => {
  const archive = zipSync({
    "logs/departure.txt": strToU8("The ferry left at noon."),
    "logs/arrival.md": strToU8("# Arrival manifest"),
    "private.html": strToU8("<p>Not an interactive archive entry.</p>"),
  }).slice();
  const panel = await inspectArchive(archive.byteLength, archive);
  const first = await panel.findByText("logs/departure.txt");
  expect(panel.getByText("private.html").closest("button")).toBeNull();
  expect(panel.queryByText("The ferry left at noon.")).toBeNull();
  click(first);
  await expect(
    panel.findByText("The ferry left at noon."),
  ).resolves.toBeVisible();
  click(panel.getByText("logs/arrival.md"));
  await expect(
    panel.findByRole("heading", { name: "Arrival manifest" }),
  ).resolves.toBeVisible();
  expect(panel.queryByText("The ferry left at noon.")).toBeNull();
  expect(getButtonByName("Download artifact")).toBeEnabled();
});

test("The catalog offers the download fallback for a ZIP whose declared size exceeds the preview limit", async () => {
  const archive = zipSync({
    "small.txt": strToU8("Previewable if admitted"),
  }).slice();
  const panel = await inspectArchive(5 * 1024 * 1024 + 1, archive);
  await expect(
    panel.findByText("No inline preview available for this file."),
  ).resolves.toBeVisible();
  expect(panel.queryByText("small.txt")).toBeNull();
  expect(getButtonByName("Download artifact")).toBeEnabled();
});
