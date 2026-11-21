import {
  artifactCatalogContract,
  type ArtifactDetail,
  type ArtifactSummary,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
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

function openCatalog(sidebarPreview: boolean, path = "/artifacts") {
  return setupPage({
    context,
    path,
    featureSwitches: {
      [FeatureSwitchKey.ArtifactSidebarPreview]: sidebarPreview,
    },
  });
}

function sidebar(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[data-testid="artifact-sidebar"]',
  );
}

test("Text artifacts use the sidebar only when sidebar previews are enabled (false)", async () => {
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
  await openCatalog(false);

  click(await findArtifactAction("launch-plan.txt"));

  const lightbox = await screen.findByRole("dialog", {
    name: "launch-plan.txt preview",
  });
  await expect(
    within(lightbox).findByText("The launch plan is ready"),
  ).resolves.toBeInTheDocument();
  expect(sidebar()).toBeNull();

  click(getButtonByName("Close", lightbox));

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
  await openCatalog(true, `/artifacts?tab=hosted-site&artifact=${summary.id}`);
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
  await openCatalog(true);

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
  await openCatalog(true);
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
