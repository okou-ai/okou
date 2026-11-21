import { test, expect } from "vitest";
import { screen, within, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { assistantRow, conversation } from "./attachment-preview-boundaries.ts";
import { findAction } from "./connector-integrations-test-helpers.ts";
import {
  artifactSummary,
  hostedSiteArtifactDetail,
  fileArtifactDetail,
  mockArtifactConversation,
  NAVIGATION_ARTIFACT_THREAD_ID,
  openResourceArtifact,
} from "./chat-navigation-artifact-test-helpers.ts";
import { findNamedMenuItem } from "./chat-attachment-test-helpers.ts";
const context = testContext();
test.each([
  ["chat-navigation-artifact-sidebar-002", "docx"],
  ["chat-navigation-artifact-sidebar-003", "pptx"],
  ["chat-navigation-artifact-sidebar-004", "xlsx"],
] as const)(
  "%s preserves the Office viewer source when moving the generated file to the sidebar",
  async (_id, ext) => {
    const url = "https://cdn.okou.io/artifacts/field/outputs/brief." + ext;
    await conversation(context, {
      chatEvents: [assistantRow("[Generated brief](" + url + ")")],
    });
    click(await findAction("link", "Generated brief"));
    const dialog = await screen.findByTestId("attachment-lightbox");
    async function check(surface: HTMLElement) {
      const frame = await within(surface).findByTitle(
        "brief." + ext + " preview",
      );
      expect(frame).toBeVisible();
      const viewer = new URL(frame.getAttribute("src")!);
      expect(viewer.origin + viewer.pathname).toBe(
        "https://view.officeapps.live.com/op/embed.aspx",
      );
      expect(viewer.searchParams.get("src")).toBe(url);
      expect(frame.tagName).toBe("IFRAME");
      expect(
        Number(frame.getAttribute("tabindex") ?? "0"),
      ).toBeGreaterThanOrEqual(0);
      expect(frame.closest("[inert]")).toBeNull();
      frame.focus();
      expect(frame).toHaveFocus();
    }
    await check(dialog);
    click(await findAction("button", "Open in split view", dialog));
    await check(await screen.findByTestId("artifact-sidebar"));
    expect(dialog).not.toBeInTheDocument();
  },
);
test("chat-navigation-artifact-sidebar-007 the embedded thumbnail transforms the public image but opens its original", async () => {
  const url = "https://a.okou.io/a1b2c3d4e5.png";
  await conversation(context, {
    chatEvents: [assistantRow("![Lookout](" + url + ")")],
  });
  const img = await screen.findByAltText("Lookout");
  const source = new URL(img.getAttribute("src")!);
  expect(source.origin + source.pathname).toBe(url);
  expect(Object.fromEntries(source.searchParams)).toMatchObject({
    thumbnail: "1",
    width: "800",
    height: "720",
    fit: "scale-down",
    quality: "85",
  });
  fireEvent.load(img);
  click(img);
  const dialog = await screen.findByTestId("attachment-lightbox");
  await waitFor(() => {
    return expect(dialog.querySelector("img")).toHaveAttribute("src", url);
  });
});
const launchUrl = "https://summit.okou.app/";
const title = "Launch dashboard";
async function loadCatalog(mobile = false) {
  const item = artifactSummary(crypto.randomUUID(), "hosted-site", title);
  const details = hostedSiteArtifactDetail(item, {
    slug: "summit",
    siteId: crypto.randomUUID(),
    url: launchUrl,
  });
  if (mobile) {
    context.mocks.browser.matchMedia((q) => {
      return q.includes("standalone") || q.includes("max-width");
    });
  }
  context.mocks.api(hostContract.sitePreview, ({ respond }) => {
    return respond(200, { url: launchUrl, expiresAt: null });
  });
  mockArtifactConversation(context, {
    catalog: [item],
    details: new Map([[item.id, details]]),
  });
  await setupPage({
    context,
    path: "/chats/" + NAVIGATION_ARTIFACT_THREAD_ID,
    featureSwitches: { [FeatureSwitchKey.ArtifactSidebarPreview]: true },
  });
}
test("chat-navigation-artifact-sidebar-011 fullscreen and list navigation keep the hosted site address", async () => {
  await loadCatalog();
  await openResourceArtifact(title);
  async function preview() {
    const side = await screen.findByTestId("artifact-sidebar");
    const frame = await within(side).findByTitle(title + " preview");
    expect(frame).toBeVisible();
    expect(frame.getAttribute("src")).toBe(launchUrl);
    return side;
  }
  const side = await preview();
  click(await findAction("button", "Back to all artifacts", side));
  const list = await screen.findByTestId("thread-sidebar-fullscreen-toggle");
  click(list);
  await expect(findAction("button", "Exit fullscreen")).resolves.toBeVisible();
  click(list);
  click((await screen.findByText(title)).closest("button")!);
  const reopened = await preview();
  click(await findAction("button", "Enter fullscreen", reopened));
  await preview();
  click(await findAction("button", "Exit fullscreen", reopened));
  await preview();
  click(await findAction("button", "More artifact actions", reopened));
  click(await findNamedMenuItem("Close preview menu"));
  await waitFor(() => {
    return expect(reopened).not.toBeInTheDocument();
  });
  await expect(
    findAction("button", "Artifacts and chats"),
  ).resolves.toBeVisible();
});
test("chat-navigation-artifact-sidebar-013 a standalone mobile reader follows Back to chats from the site", async () => {
  await loadCatalog(true);
  await openResourceArtifact(title);
  const side = await screen.findByTestId("artifact-sidebar");
  await waitFor(() => {
    return expect(side.querySelector("iframe")?.src).toBe(launchUrl);
  });
  const back = await findAction("link", "Back to chats");
  const destination = new URL(back.getAttribute("href")!, location.href);
  click(back);
  await waitFor(() => {
    return expect(location.pathname).toBe(destination.pathname);
  });
  await waitFor(() => {
    return expect(side).not.toBeInTheDocument();
  });
  expect(screen.queryByTitle(/Launch dashboard preview/i)).toBeNull();
  await expect(
    screen.findByRole("navigation", { name: "Main navigation" }),
  ).resolves.toBeVisible();
});
test("chat-navigation-artifact-sidebar-014 the resources dialog lists the release notes for this thread", async () => {
  const item = artifactSummary(crypto.randomUUID(), "file", "Release notes");
  const other = artifactSummary(
    crypto.randomUUID(),
    "file",
    "Earlier project notes",
  );
  mockArtifactConversation(context, { catalog: [] });
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    return respond(200, {
      artifacts:
        query.chatThreadId === NAVIGATION_ARTIFACT_THREAD_ID ? [item] : [other],
      nextCursor: null,
    });
  });
  await setupPage({ context, path: "/chats/" + NAVIGATION_ARTIFACT_THREAD_ID });
  click(await findAction("button", "Artifacts and chats"));
  const list = await screen.findByRole("dialog", {
    name: "Artifacts and chats",
  });
  await expect(within(list).findByText(item.title)).resolves.toBeVisible();
  expect(list).not.toHaveTextContent(other.title);
});
test("chat-navigation-artifact-sidebar-010 an expanded diagram owns its image while fullscreen keeps the source open", async () => {
  const browser = context.mocks.browser.blobDownload(),
    url = "https://cdn.okou.io/artifacts/field/document/deployment.md";
  const item = artifactSummary(crypto.randomUUID(), "file", "Deployment flow");
  const file = fileArtifactDetail(item, {
    fileId: crypto.randomUUID(),
    filename: "deployment.md",
    contentType: "text/markdown",
    url,
  });
  mockArtifactConversation(context, {
    catalog: [item],
    details: new Map([[item.id, file]]),
  });
  context.mocks.http.get(url, () => {
    return HttpResponse.text(
      "# Deployment flow\n\n```mermaid\nflowchart TD\nBuild-->Release\n```",
    );
  });
  await setupPage({
    context,
    path: "/chats/" + NAVIGATION_ARTIFACT_THREAD_ID,
    featureSwitches: { [FeatureSwitchKey.ArtifactSidebarPreview]: true },
  });
  await openResourceArtifact(item.title);
  const side = await screen.findByTestId("artifact-sidebar");
  click(await findAction("button", "Enter fullscreen", side));
  click(await within(side).findByText("Diagram source"));
  const source = side.querySelector("details")!;
  expect(source.open).toBeTruthy();
  const inline = await within(side).findByRole("img", { name: "Diagram" });
  const original = inline.getAttribute("src")!;
  const expand = await findAction("button", "Expand diagram", side);
  click(expand);
  const layer = await screen.findByTestId("artifact-diagram-lightbox");
  const image = await within(layer).findByRole("img");
  const enlarged = image.getAttribute("src")!;
  expect(enlarged).not.toBe(original);
  const svg = browser.blobForUrl(original);
  expect(svg).toBeTruthy();
  await expect(browser.blobForUrl(enlarged)?.text()).resolves.toBe(
    await svg!.text(),
  );
  click(await findAction("button", "Close", layer));
  await waitFor(() => {
    return expect(browser.revokedUrls).toContain(enlarged);
  });
  expect(browser.revokedUrls).not.toContain(original);
  await waitFor(() => {
    return expect(expand).toHaveFocus();
  });
  expect(source.open).toBeTruthy();
  await expect(
    findAction("button", "Exit fullscreen", side),
  ).resolves.toBeVisible();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    return expect(within(side).getByRole("document")).toHaveFocus();
  });
  await expect(
    findAction("button", "Exit fullscreen", side),
  ).resolves.toBeVisible();
});
