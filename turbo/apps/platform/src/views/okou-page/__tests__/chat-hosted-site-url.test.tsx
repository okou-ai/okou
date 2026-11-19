import { chatThreadMetadataContract } from "@okouai/api-contracts/contracts/chat-threads";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
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
import {
  resourceButton,
  resourcePanel,
} from "./chat-resources-test-helpers.ts";

const context = testContext();

const deploymentId = "00000000-0000-4000-8000-000000000041";
const siteId = "00000000-0000-4000-8000-000000000042";
const artifactId = "00000000-0000-4000-8000-000000000043";
const siteTitle = "Quarterly launch report";
const deploymentUrl = `https://dpl-${deploymentId}.okou.app/`;

function siteAddress(slug: string) {
  return `https://${slug}.okou.app`;
}

function mockHostedSite() {
  let currentSlug = "launch-site";
  const summary = {
    ...artifactSummary(artifactId, "hosted-site", siteTitle),
    sourceUrl: deploymentUrl,
    aliasUrl: siteAddress(currentSlug),
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
            url: siteAddress(currentSlug),
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
              aliasUrl: siteAddress(currentSlug),
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
  const site = () => {
    return {
      siteId,
      publicSlug: currentSlug,
      url: siteAddress(currentSlug),
      isActive: true,
    };
  };
  context.mocks.api(hostContract.siteUrl, ({ respond }) => {
    return respond(200, site());
  });
  context.mocks.api(hostContract.siteUrlAvailability, ({ respond }) => {
    return respond(200, { available: true });
  });
  context.mocks.api(hostContract.updateSiteUrl, ({ body, respond }) => {
    expect(body.expectedPublicSlug).toBe(currentSlug);
    currentSlug = body.publicSlug;
    return respond(200, site());
  });
  context.mocks.api(hostContract.resolveAlias, ({ params, respond }) => {
    if (params.publicSlug !== currentSlug) {
      return respond(200, { pointer: null });
    }
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
}

async function openDeploymentLink(sidebar: boolean) {
  context.mocks.browser.matchMedia(true);
  context.mocks.data.userPreferences({ timezone: "Etc/UTC", locale: "en-US" });
  mockHostedSite();
  await setupPage({
    context,
    host: "app.okou.ai",
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    featureSwitches: {
      [FeatureSwitchKey.ArtifactSidebarPreview]: sidebar,
    },
  });
  const link = await waitFor(() => {
    const match = queryAllByRoleFast("link", document.body).find((item) => {
      return item.textContent === "Open website";
    });
    if (!match) {
      throw new Error("Missing deployment link");
    }
    return match;
  });
  click(link);
  return await screen.findByTestId(
    sidebar ? "artifact-sidebar" : "attachment-lightbox",
  );
}

function shareLabel(sidebar: boolean) {
  return sidebar ? "Share artifact" : "Share";
}

async function openShare(preview: HTMLElement, sidebar: boolean) {
  await waitFor(() => {
    expect(buttonNamed(shareLabel(sidebar), preview)).toBeEnabled();
  });
  click(buttonNamed(shareLabel(sidebar), preview));
  const menu = await screen.findByRole("dialog", { name: shareLabel(sidebar) });
  await within(menu).findByText("Who can access");
  return menu;
}

async function renameSite(menu: HTMLElement, slug: string) {
  await waitFor(() => {
    expect(buttonNamed("Customize URL", menu)).toBeEnabled();
  });
  click(buttonNamed("Customize URL", menu));
  const input = await within(menu).findByLabelText("Website URL");
  fireEvent.change(input, { target: { value: slug } });
  await within(menu).findByText("Available");
  click(buttonNamed("Save", menu));
  await waitFor(() => {
    expect(buttonNamed("Copy link", menu)).toBeEnabled();
  });
}

test.each([false, true])(
  "An owner sees the banner and link visibility settings from a chat deployment link with sidebar preview %s",
  async (sidebar) => {
    const preview = await openDeploymentLink(sidebar);

    const menu = await openShare(preview, sidebar);

    const banner = await within(menu).findByRole("switch", {
      name: "Show Okou banner",
    });
    expect(banner).toBeEnabled();
    expect(banner).toBeChecked();
    const publicAccess = queryAllByRoleFast("radio", menu).find((item) => {
      return item.getAttribute("aria-label") === "Anyone with the link";
    });
    expect(publicAccess).toBeEnabled();
    expect(publicAccess).toHaveAttribute("aria-checked", "true");
  },
);

test.each([false, true])(
  "Consecutive site renames keep the title and update Share and Resources link copies with sidebar preview %s",
  async (sidebar) => {
    const preview = await openDeploymentLink(sidebar);
    const title = await within(preview).findByTestId("artifact-title-link");
    const menu = await openShare(preview, sidebar);
    const clipboard = context.mocks.browser.clipboardWriteText();

    for (const slug of ["renamed-site", "final-site"]) {
      await renameSite(menu, slug);
      click(buttonNamed("Copy link", menu));
      await waitFor(() => {
        expect(clipboard.writes.at(-1)).toBe(siteAddress(slug));
      });
      expect(title).toHaveAttribute("href", `${siteAddress(slug)}/`);
      expect(title).toHaveTextContent(siteTitle);
    }
    expect(clipboard.writes).toStrictEqual([
      siteAddress("renamed-site"),
      siteAddress("final-site"),
    ]);

    await userEvent.keyboard("{Escape}", { delay: null });
    await waitFor(() => {
      expect(menu).not.toBeInTheDocument();
    });
    click(buttonNamed(sidebar ? "Close artifact" : "Close", preview));
    await waitFor(() => {
      expect(title).not.toBeInTheDocument();
    });
    if (!resourcePanel()) {
      click(resourceButton());
    }
    const resources = await screen.findByRole("dialog", {
      name: "Artifacts and chats",
    });
    const row = (await within(resources).findByText(siteTitle)).closest("li");
    if (!row) {
      throw new Error("Missing hosted site resource row");
    }
    const resourceClipboard = context.mocks.browser.clipboardWriteText();
    click(buttonNamed("Copy link", row));

    await waitFor(() => {
      expect(resourceClipboard.writes).toStrictEqual([
        siteAddress("final-site"),
      ]);
    });
  },
);
