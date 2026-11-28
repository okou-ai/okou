import { artifactAccessContract } from "@okouai/api-contracts/contracts/artifact-access";
import {
  artifactCatalogContract,
  type ArtifactDetail,
  type ArtifactSummary,
} from "@okouai/api-contracts/contracts/artifact-catalog";
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
  fileArtifactDetail,
  hostedSiteArtifactDetail,
} from "../../okou-page/__tests__/chat-navigation-artifact-test-helpers.ts";
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
  fileId = "a0000000-0000-4000-a000-000000000e99",
): { readonly detail: ArtifactDetail; readonly url: string } {
  const url = `https://files.example.test/catalog/${filename}`;
  return {
    detail: fileArtifactDetail(summary, {
      filename,
      contentType,
      fileId,
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

test("Switching catalog websites cancels the previous domain read and shows the selected site's permissions", async () => {
  const first = artifact({
    id: "a0000000-0000-4000-a000-000000000e41",
    kind: "hosted-site",
    title: "First website",
  });
  const second = artifact({
    id: "a0000000-0000-4000-a000-000000000e42",
    kind: "hosted-site",
    title: "Second website",
  });
  const sites = [first, second].map((item, index) => {
    const slug = index === 0 ? "first-website" : "second-website";
    return {
      item,
      siteId: item.id,
      artifactId: item.id,
      publicSlug: slug,
      url: `https://${slug}.okou.app`,
      isActive: true,
    };
  });
  const began = context.mocks.deferred<void>();
  const aborted = context.mocks.deferred<void>();
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [first, second], nextCursor: null });
  });
  context.mocks.api(artifactCatalogContract.get, ({ params, respond }) => {
    const site = sites.find((site) => {
      return site.item.id === params.artifactId;
    })!;
    return respond(
      200,
      hostedSiteArtifactDetail(site.item, {
        siteId: site.siteId,
        slug: site.publicSlug,
        url: site.url,
      }),
    );
  });
  context.mocks.api(hostContract.siteUrl, ({ params, respond }) => {
    const site = sites.find((site) => {
      return site.publicSlug === params.publicSlug;
    })!;
    return respond(200, site);
  });
  context.mocks.api(
    artifactAccessContract.getVisibility,
    ({ params, respond }) => {
      const site = sites.find((item) => {
        return item.siteId === params.artifactId;
      })!;
      const visibility = params.artifactId === first.id ? "public" : "private";
      return respond(200, {
        artifactId: params.artifactId,
        kind: "hosted-site",
        visibility,
        ownerUrl: site.url,
        shareUrl: visibility === "public" ? site.url : null,
        shortUrl: null,
        organization: { id: "org_default", name: "Default Org" },
      });
    },
  );
  context.mocks.api(hostContract.siteBanner, ({ params, respond }) => {
    return respond(200, {
      siteId: params.siteId,
      showBanner: params.siteId === first.id,
      revision: null,
    });
  });
  context.mocks.api(
    hostContract.siteDomains,
    async ({ request, params, respond }) => {
      if (params.siteId === first.id) {
        request.signal.addEventListener(
          "abort",
          () => {
            aborted.resolve();
          },
          { once: true },
        );
        began.resolve();
        await aborted.promise;
      }
      const site = sites.find((site) => {
        return site.siteId === params.siteId;
      })!;
      return respond(200, {
        siteId: site.siteId,
        defaultUrl: site.url,
        effectiveUrl: site.url,
        selectedDomainId: null,
        revision: "00000000-0000-4000-8000-000000000053",
        allowed: true,
        domains: [],
      });
    },
  );
  await setupPage({
    context,
    path: "/artifacts?tab=hosted-site",
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.HostedSiteCustomDomains]: true },
  });
  click(await findArtifactAction(first.title));
  const preview = await screen.findByTestId("artifact-sidebar");
  await waitFor(() => {
    expect(getButtonByName("Share artifact", preview)).toBeVisible();
  });
  click(getButtonByName("Share artifact", preview));
  const firstMenu = await screen.findByRole("dialog", {
    name: "Share artifact",
  });
  expect(
    within(firstMenu).getByLabelText("Anyone with the link"),
  ).toBeChecked();
  click(getButtonByName("Customize URL", firstMenu));
  await began.promise;
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(firstMenu).not.toBeInTheDocument();
  });

  click(getButtonByName("Preview Second website"));
  await aborted.promise;
  const selectedPreview = await screen.findByTestId("artifact-sidebar");
  await waitFor(() => {
    expect(within(selectedPreview).getByText(second.title)).toBeInTheDocument();
    expect(getButtonByName("Share artifact", selectedPreview)).toBeVisible();
  });
  click(getButtonByName("Share artifact", selectedPreview));
  const secondMenu = await screen.findByRole("dialog", {
    name: "Share artifact",
  });
  expect(within(secondMenu).getByLabelText("Only me")).toBeChecked();
  await expect(
    within(secondMenu).findByRole("switch", { name: "Show Okou banner" }),
  ).resolves.not.toBeChecked();
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
  const user = userEvent.setup();
  const arrival = getButtonByName("logs/arrival.md");
  await user.click(arrival);
  await expect(
    panel.findByRole("heading", { name: "Arrival manifest" }),
  ).resolves.toBeVisible();
  expect(panel.queryByText("The ferry left at noon.")).toBeNull();
  expect(getButtonByName("Download artifact")).toBeEnabled();
  await user.click(arrival);
  expect(arrival).toHaveFocus();
  expect(arrival).toHaveAttribute("aria-pressed", "false");
  expect(panel.queryByRole("heading", { name: "Arrival manifest" })).toBeNull();
  await user.keyboard("{Enter}");
  await expect(
    panel.findByRole("heading", { name: "Arrival manifest" }),
  ).resolves.toBeInTheDocument();
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

test("Reopening a catalog item reads the file selected by its publication update", async () => {
  const item = artifact({
    id: "c0000000-0000-4000-a000-000000000189",
    title: "Field journal",
  });
  const first = storedFile(item, "field-notes.txt", "text/plain");
  const second = storedFile(
    { ...item, title: "field-notes-approved.txt" },
    "field-notes-approved.txt",
    "text/plain",
    "c0000000-0000-4000-a000-000000000190",
  );
  let current = first;
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [current.detail], nextCursor: null });
  });
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    return respond(200, current.detail);
  });
  context.mocks.http.get(first.url, () => {
    return HttpResponse.text("Draft observations from the estuary");
  });
  context.mocks.http.get(second.url, () => {
    return HttpResponse.text("Approved observations from the estuary");
  });
  await openCatalog("/artifacts?tab=file");
  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription("artifact:changed")).toBeTruthy();
  });
  click(await findArtifactAction(item.title));
  const panel = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(panel).findByText("Draft observations from the estuary"),
  ).resolves.toBeVisible();
  current = second;
  await act(() => {
    context.mocks.ably.trigger("artifact:changed", { artifactId: item.id });
  });
  await expect(
    within(await screen.findByTestId("artifact-sidebar")).findByText(
      "field-notes-approved.txt",
    ),
  ).resolves.toBeVisible();
  click(
    getButtonByName(
      "Close artifact",
      await screen.findByTestId("artifact-sidebar"),
    ),
  );
  await waitFor(() => {
    expect(sidebar()).toBeNull();
  });
  click(await findArtifactAction(second.detail.title));
  const reopened = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(reopened).findByText("Approved observations from the estuary"),
  ).resolves.toBeVisible();
});

test("Sharing follows a changed website URL from a publication notification", async () => {
  const summary = artifact({ title: "Publication audit", kind: "hosted-site" });
  const siteId = "55000000-0000-4000-8000-000000000031";
  let slug = "before-audit";
  const url = () => {
    return `https://${slug}.okou.app/`;
  };
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [summary], nextCursor: null });
  });
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    return respond(
      200,
      hostedSiteArtifactDetail(
        {
          ...summary,
          title:
            slug === "after-audit"
              ? "Updated publication audit"
              : summary.title,
        },
        { siteId, slug, url: url() },
      ),
    );
  });
  context.mocks.api(hostContract.siteUrl, ({ respond }) => {
    return respond(200, {
      siteId,
      artifactId: summary.id,
      publicSlug: slug,
      url: url(),
      isActive: true,
    });
  });
  context.mocks.api(hostContract.sitePreview, ({ respond }) => {
    return respond(200, { url: url(), expiresAt: null });
  });
  context.mocks.api(artifactAccessContract.getVisibility, ({ respond }) => {
    return respond(200, {
      artifactId: siteId,
      kind: "hosted-site",
      visibility: "public",
      ownerUrl: url(),
      shareUrl: url(),
      shortUrl: null,
      organization: { id: "org_default", name: "Default Org" },
    });
  });
  context.mocks.api(hostContract.siteBanner, ({ respond }) => {
    return respond(200, { siteId, showBanner: true, revision: null });
  });
  await setupPage({ context, path: "/artifacts", host: "app.okou.ai" });
  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription("artifact:changed")).toBeTruthy();
  });
  click(await findArtifactAction(summary.title));
  const panel = await screen.findByTestId("artifact-sidebar");
  await waitFor(() => {
    expect(getButtonByName("Share artifact", panel)).toBeVisible();
  });
  slug = "after-audit";
  await act(() => {
    context.mocks.ably.trigger("artifact:changed", { artifactId: summary.id });
  });
  await waitFor(() => {
    expect(
      within(screen.getByTestId("artifact-sidebar")).getByText(
        "Updated publication audit",
      ),
    ).toBeInTheDocument();
  });
  const current = screen.getByTestId("artifact-sidebar");
  await waitFor(() => {
    expect(getButtonByName("Share artifact", current)).toBeVisible();
  });
  click(getButtonByName("Share artifact", current));
  await expect(
    screen.findByRole("dialog", { name: "Share artifact" }),
  ).resolves.toBeInTheDocument();
});
