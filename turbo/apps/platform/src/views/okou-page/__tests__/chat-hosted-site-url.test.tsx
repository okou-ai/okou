import { hostContract } from "@okouai/api-contracts/contracts/host";
import { chatThreadMetadataContract } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  artifactRun,
  artifactSummary,
  buttonNamed,
  hostedSiteArtifactDetail,
  mockArtifactConversation,
  NAVIGATION_ARTIFACT_AGENT_ID,
  NAVIGATION_ARTIFACT_RUN_ID,
  NAVIGATION_ARTIFACT_THREAD_ID,
} from "./chat-navigation-artifact-test-helpers.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  installResourceGeometry,
  resourceButton,
} from "./chat-resources-test-helpers.ts";

const context = testContext();

const deploymentId = "00000000-0000-4000-8000-000000000041";
const siteId = "00000000-0000-4000-8000-000000000042";
const artifactId = "00000000-0000-4000-8000-000000000043";
const siteTitle = "Quarterly launch report";

async function setupHostedSite(
  sidebar: boolean,
  initialSlug = "launch-site",
  hostDomain = "okou.app",
) {
  const deploymentUrl = `https://dpl-${deploymentId}.${hostDomain}/`;
  let currentSlug = initialSlug;
  context.mocks.browser.matchMedia(true);
  context.mocks.data.userPreferences({
    timezone: "Etc/UTC",
    locale: "en-US",
    chatResourcesEnabledByDefault: false,
  });
  const summary = {
    ...artifactSummary(artifactId, "hosted-site", siteTitle),
    sourceUrl: deploymentUrl,
    aliasUrl: `https://${initialSlug}.${hostDomain}`,
  };
  const run = artifactRun({
    artifactId,
    filename: "launch-site.html",
    fileId: deploymentId,
    contentType: "text/html",
    url: deploymentUrl,
  });
  mockArtifactConversation(context, {
    catalog: [summary],
    getDetail: (requestedArtifactId) => {
      return requestedArtifactId === artifactId
        ? hostedSiteArtifactDetail(summary, {
            siteId,
            slug: currentSlug,
            url: `https://${currentSlug}.${hostDomain}`,
          })
        : null;
    },
    artifactRuns: () => {
      return [
        {
          ...run,
          files: run.files.map((file) => {
            return {
              ...file,
              title: siteTitle,
              aliasUrl: `https://${currentSlug}.${hostDomain}`,
              artifactKind: "hosted-site" as const,
            };
          }),
        },
      ];
    },
    chatEvents: [
      {
        id: "hosted-url-message",
        createdAt: "2026-09-01T12:00:00.000Z",
        role: "assistant",
        content: `[Open website](${deploymentUrl})`,
        runId: NAVIGATION_ARTIFACT_RUN_ID,
        seqId: 1,
      },
      {
        id: "hosted-url-completed",
        createdAt: "2026-09-01T12:00:01.000Z",
        role: "assistant",
        content: null,
        runId: NAVIGATION_ARTIFACT_RUN_ID,
        runLifecycleEvent: "completed",
        seqId: 2,
      },
    ],
  });
  context.mocks.api(chatThreadMetadataContract.get, ({ params, respond }) => {
    if (params.id !== NAVIGATION_ARTIFACT_THREAD_ID) {
      return respond(404, {
        error: {
          code: "CHAT_THREAD_NOT_FOUND",
          message: "Chat thread not found",
        },
      });
    }
    return respond(200, {
      id: NAVIGATION_ARTIFACT_THREAD_ID,
      agentId: NAVIGATION_ARTIFACT_AGENT_ID,
      title: "Artifact navigation",
      selectedModel: null,
      modelSettings: {},
      serviceTier: null,
      pinnedAt: null,
      archived: false,
      muted: false,
      computerUseHostId: null,
      cloudBrowserEnabled: false,
    });
  });
  context.mocks.api(hostContract.siteUrl, ({ respond }) => {
    return respond(200, {
      siteId,
      publicSlug: currentSlug,
      url: `https://${currentSlug}.${hostDomain}`,
      isActive: true,
    });
  });
  context.mocks.api(hostContract.siteUrlAvailability, ({ respond }) => {
    return respond(200, { available: true });
  });
  context.mocks.api(hostContract.updateSiteUrl, ({ body, respond }) => {
    expect(body.expectedPublicSlug).toBe(currentSlug);
    currentSlug = body.publicSlug;
    return respond(200, {
      siteId,
      publicSlug: currentSlug,
      url: `https://${currentSlug}.${hostDomain}`,
      isActive: true,
    });
  });
  context.mocks.api(hostContract.resolveAlias, ({ respond }) => {
    return respond(200, {
      pointer: {
        version: 1,
        publicBrand: "okou",
        publicSlug: currentSlug,
        siteId,
        deploymentId,
        prefix: `sites/brands/okou/publications/${deploymentId}`,
        manifestKey: `sites/brands/okou/publications/${deploymentId}/manifest.json`,
        spaFallback: false,
        updatedAt: "2026-10-27T00:00:00Z",
      },
    });
  });
  context.mocks.api(hostContract.siteVisibility, ({ respond }) => {
    return respond(200, { siteId, visibility: "public", revision: null });
  });
  context.mocks.api(hostContract.siteBanner, ({ respond }) => {
    return respond(200, { siteId, showBanner: true, revision: null });
  });
  await setupPage({
    context,
    host: "app.okou.ai",
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    featureSwitches: {
      [FeatureSwitchKey.ArtifactSidebarPreview]: sidebar,
    },
  });
  await screen.findByText("Open website");
  const link = queryAllByRoleFast("link").find((element) => {
    return element.textContent === "Open website";
  });
  expect(link).toBeDefined();
  click(link!);
  return await screen.findByTestId(
    sidebar ? "artifact-sidebar" : "attachment-lightbox",
  );
}

async function copyFromResources() {
  click(resourceButton());
  const resources = await screen.findByRole("region", {
    name: "Artifacts and chats",
  });
  const title = await within(resources).findByText(siteTitle);
  const row = title.closest("li")!;
  click(buttonNamed("Copy link", row));
}

async function openHostedSiteShare(preview: HTMLElement, sidebar: boolean) {
  const shareLabel = sidebar ? "Share artifact" : "Share";
  await waitFor(() => {
    expect(buttonNamed(shareLabel, preview)).toBeEnabled();
  });
  click(buttonNamed(shareLabel, preview));
  const shareMenu = await waitFor(() => {
    const dialog = buttonNamed("Customize URL").closest('[role="dialog"]');
    if (!(dialog instanceof HTMLElement)) {
      throw new Error("Expected the hosted site's Share dialog");
    }
    expect(dialog).toHaveAccessibleName(shareLabel);
    return dialog;
  });
  await within(shareMenu).findByText("Who can access");
  return shareMenu;
}

async function renameHostedSite(shareMenu: HTMLElement, slug: string) {
  await waitFor(() => {
    expect(buttonNamed("Customize URL", shareMenu)).toBeEnabled();
  });
  click(buttonNamed("Customize URL", shareMenu));
  const input = await within(shareMenu).findByLabelText("Website URL");
  expect(input).toHaveFocus();
  fireEvent.change(input, { target: { value: slug } });
  expect(input).toHaveValue(slug);
  await within(shareMenu).findByText("Available");
  expect(buttonNamed("Save", shareMenu)).toBeEnabled();
  click(buttonNamed("Save", shareMenu));
  await waitFor(() => {
    expect(buttonNamed("Customize URL", shareMenu)).toHaveFocus();
  });
  expect(buttonNamed("Copied", shareMenu)).toBeEnabled();
}

test.each([false, true])(
  "consecutive site renames preserve the title, link and Share/Resources copy addresses (sidebar=%s)",
  async (sidebar) => {
    installResourceGeometry(480);
    const preview = await setupHostedSite(sidebar);
    const title = await within(preview).findByTestId("artifact-title-link");
    expect(title).toHaveTextContent(siteTitle);
    const shareMenu = await openHostedSiteShare(preview, sidebar);
    const clipboard = context.mocks.browser.clipboardWriteText();
    for (const slug of ["renamed-site", "final-site"]) {
      await renameHostedSite(shareMenu, slug);
      await waitFor(() => {
        expect(title).toHaveTextContent(siteTitle);
        expect(title).toHaveAttribute("href", `https://${slug}.okou.app/`);
        expect(clipboard.writes.at(-1)).toBe(`https://${slug}.okou.app`);
      });
    }
    expect(clipboard.writes).toStrictEqual([
      "https://renamed-site.okou.app",
      "https://final-site.okou.app",
    ]);
    await userEvent.keyboard("{Escape}");
    click(buttonNamed(sidebar ? "Close artifact" : "Close", preview));
    await waitFor(() => {
      expect(title).not.toBeInTheDocument();
    });
    const resourceClipboard = context.mocks.browser.clipboardWriteText();
    await copyFromResources();
    await waitFor(() => {
      expect(resourceClipboard.writes.at(-1)).toBe(
        "https://final-site.okou.app",
      );
    });
    expect(resourceClipboard.writes).toStrictEqual([
      "https://final-site.okou.app",
    ]);
  },
);

test("a reopened chat shows the catalog title and copies the current site address", async () => {
  installResourceGeometry(480);
  const clipboard = context.mocks.browser.clipboardWriteText();
  const preview = await setupHostedSite(true, "already-renamed");
  const title = await within(preview).findByTestId("artifact-title-link");
  expect(title).toHaveTextContent(siteTitle);
  expect(title).toHaveAttribute("href", "https://already-renamed.okou.app/");
  click(buttonNamed("Close artifact", preview));
  await waitFor(() => {
    expect(title).not.toBeInTheDocument();
  });
  await copyFromResources();
  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([
      "https://already-renamed.okou.app",
    ]);
  });
});

test.each([false, true])(
  "Share directly copies legacy website links without URL customization (sidebar=%s)",
  async (sidebar) => {
    const clipboard = context.mocks.browser.clipboardWriteText();
    const preview = await setupHostedSite(
      sidebar,
      "legacy-site",
      "sites.vm0.io",
    );
    const title = await within(preview).findByTestId("artifact-title-link");
    expect(title).toHaveTextContent(siteTitle);
    expect(title).toHaveAttribute("href", "https://legacy-site.sites.vm0.io/");
    const shareLabel = sidebar ? "Share artifact" : "Share";
    await waitFor(() => {
      expect(buttonNamed(shareLabel, preview)).toBeEnabled();
    });
    click(buttonNamed(shareLabel, preview));
    await screen.findByText("Link copied");
    expect(clipboard.writes).toStrictEqual([
      "https://legacy-site.sites.vm0.io",
    ]);
    expect(
      screen.queryByRole("dialog", { name: shareLabel }),
    ).not.toBeInTheDocument();
  },
);
