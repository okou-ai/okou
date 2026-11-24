import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { hostedDomainSettingsSchema } from "@okouai/api-contracts/contracts/hosted-site-domains";
import type { infer as zInfer } from "zod";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { chatThreadMetadataContract } from "@okouai/api-contracts/contracts/chat-threads";
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
  NAVIGATION_ARTIFACT_RUN_ID,
  NAVIGATION_ARTIFACT_THREAD_ID,
} from "./chat-navigation-artifact-test-helpers.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  resourceButton,
  resourcePanel,
} from "./chat-resources-test-helpers.ts";

const context = testContext();

const deploymentId = "00000000-0000-4000-8000-000000000041";
const siteId = "00000000-0000-4000-8000-000000000042";
const artifactId = "00000000-0000-4000-8000-000000000043";
const siteTitle = "Quarterly launch report";

function tabNamed(name: string, container: HTMLElement) {
  const tab = queryAllByRoleFast("tab", container).find((item) => {
    return item.textContent?.startsWith(name);
  });
  if (!tab) {
    throw new Error(`Tab not found: ${name}`);
  }
  return tab;
}

async function setupHostedSite(
  initialSlug = "launch-site",
  hostDomain = "okou.app",
  customDomains = false,
) {
  const deploymentUrl = `https://dpl-${deploymentId}.${hostDomain}/`;
  let currentSlug = initialSlug;
  context.mocks.browser.matchMedia(true);
  context.mocks.data.userPreferences({
    timezone: "Etc/UTC",
    locale: "en-US",
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
  await setupPage({
    context,
    host: "app.okou.ai",
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    featureSwitches: {
      [FeatureSwitchKey.HostedSiteCustomDomains]: customDomains,
    },
  });
  await screen.findByText("Open website");
  const link = queryAllByRoleFast("link").find((element) => {
    return element.textContent === "Open website";
  });
  expect(link).toBeDefined();
  click(link!);
  return await screen.findByTestId("artifact-sidebar");
}

async function copyFromResources() {
  // Working in the artifact preview dismisses the resource panel like any
  // outside press, so reopen it from the header.
  if (!resourcePanel()) {
    click(resourceButton());
  }
  const resources = await screen.findByRole("dialog", {
    name: "Artifacts and chats",
  });
  const title = await within(resources).findByText(siteTitle);
  const row = title.closest("li")!;
  click(buttonNamed("Copy link", row));
}

async function openHostedSiteShare(preview: HTMLElement) {
  const shareLabel = "Share artifact";
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
  expect(buttonNamed("Copy link", shareMenu)).toBeEnabled();
}

test("owners see visibility and banner settings from chat deployment links", async () => {
  const preview = await setupHostedSite();
  const menu = await openHostedSiteShare(preview);
  const banner = await within(menu).findByRole("switch", {
    name: "Show Okou banner",
  });
  expect(banner).toBeChecked();
  expect(banner).toBeEnabled();
  const publicAccess = queryAllByRoleFast("radio", menu).find((row) => {
    return row.getAttribute("aria-label") === "Anyone with the link";
  });
  expect(publicAccess).toHaveAttribute("aria-checked", "true");
  expect(publicAccess).toBeEnabled();
});

test("consecutive site renames preserve the title, link and Share/Resources copy addresses", async () => {
  const preview = await setupHostedSite();
  const title = await within(preview).findByTestId("artifact-title-link");
  expect(title).toHaveTextContent(siteTitle);
  const shareMenu = await openHostedSiteShare(preview);
  const clipboard = context.mocks.browser.clipboardWriteText();
  for (const slug of ["renamed-site", "final-site"]) {
    await renameHostedSite(shareMenu, slug);
    click(buttonNamed("Copy link", shareMenu));
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
  await userEvent.keyboard("{Escape}", { delay: null });
  await waitFor(() => {
    expect(shareMenu).not.toBeInTheDocument();
  });
  click(buttonNamed("Close artifact", preview));
  await waitFor(() => {
    expect(title).not.toBeInTheDocument();
  });
  const resourceClipboard = context.mocks.browser.clipboardWriteText();
  await copyFromResources();
  await waitFor(() => {
    expect(resourceClipboard.writes.at(-1)).toBe("https://final-site.okou.app");
  });
  expect(resourceClipboard.writes).toStrictEqual([
    "https://final-site.okou.app",
  ]);
});

test("a reopened chat shows the catalog title and copies the current site address", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  const preview = await setupHostedSite("already-renamed");
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

test("Share directly copies legacy website links without URL customization", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  const preview = await setupHostedSite("legacy-site", "sites.vm0.io");
  const title = await within(preview).findByTestId("artifact-title-link");
  expect(title).toHaveTextContent(siteTitle);
  expect(title).toHaveAttribute("href", "https://legacy-site.sites.vm0.io/");
  const shareLabel = "Share artifact";
  await waitFor(() => {
    expect(buttonNamed(shareLabel, preview)).toBeEnabled();
  });
  click(buttonNamed(shareLabel, preview));
  await screen.findByText("Link copied");
  expect(clipboard.writes).toStrictEqual(["https://legacy-site.sites.vm0.io"]);
  expect(
    screen.queryByRole("dialog", { name: shareLabel }),
  ).not.toBeInTheDocument();
});

test("custom domain verification stays manual and saves directly from the verification view", async () => {
  const domainId = "00000000-0000-4000-8000-000000000051";
  const revision = "00000000-0000-4000-8000-000000000052";
  let settings: zInfer<typeof hostedDomainSettingsSchema> = {
    siteId,
    defaultUrl: "https://launch-site.okou.app",
    effectiveUrl: "https://launch-site.okou.app",
    selectedDomainId: null,
    revision,
    allowed: true,
    domains: [],
  };
  let verifies = 0;
  let saves = 0;
  context.mocks.api(hostContract.siteDomains, ({ respond }) => {
    return respond(200, settings);
  });
  context.mocks.api(hostContract.addSiteDomain, ({ body, respond }) => {
    settings = {
      ...settings,
      domains: [
        {
          id: domainId,
          hostname: body.hostname,
          revision,
          ready: false,
          removing: false,
          records: [
            {
              type: "TXT",
              name: "_okou-challenge.www.customer-example.net",
              value: "okou-verification=demo",
            },
            {
              type: "CNAME",
              name: "www.customer-example.net",
              value: "connect.okou.app",
            },
          ],
          verification: null,
        },
      ],
    };
    return respond(200, settings);
  });
  context.mocks.api(hostContract.verifySiteDomain, ({ respond }) => {
    verifies++;
    settings = {
      ...settings,
      domains: settings.domains.map((domain) => {
        return { ...domain, ready: true };
      }),
    };
    return respond(200, settings);
  });
  context.mocks.api(hostContract.selectSiteDomain, ({ body, respond }) => {
    saves++;
    expect(body.domainId).toBe(domainId);
    settings = {
      ...settings,
      selectedDomainId: domainId,
      effectiveUrl: "https://www.customer-example.net",
    };
    return respond(200, settings);
  });
  const clipboard = context.mocks.browser.clipboardWriteText();
  const preview = await setupHostedSite("launch-site", "okou.app", true);
  const menu = await openHostedSiteShare(preview);
  click(buttonNamed("Customize URL", menu));
  await within(menu).findByLabelText("Website URL");
  expect(
    within(menu).queryByRole("combobox", { name: "Domain" }),
  ).not.toBeInTheDocument();
  expect(tabNamed("Okou URL", menu)).toHaveAttribute("aria-selected", "true");
  click(tabNamed("Custom domain", menu));
  const input = await within(menu).findByPlaceholderText("www.example.com");
  fireEvent.change(input, { target: { value: "www.customer-example.net" } });
  expect(input).toHaveValue("www.customer-example.net");
  expect(buttonNamed("Continue", menu)).toBeEnabled();
  click(buttonNamed("Continue", menu));
  await within(menu).findByText("No verification yet");
  expect(
    within(menu).getByRole("heading", { name: "www.customer-example.net" }),
  ).toBeInTheDocument();
  expect(verifies).toBe(0);
  click(buttonNamed("Verify", menu));
  await within(menu).findByText("Domain verified. Save to use this address.");
  expect(verifies).toBe(1);
  expect(saves).toBe(0);
  expect(within(menu).queryByText("Continue")).not.toBeInTheDocument();
  expect(within(menu).queryByText("Remove")).not.toBeInTheDocument();
  expect(buttonNamed("Cancel", menu)).toBeEnabled();
  click(buttonNamed("Save", menu));
  await waitFor(() => {
    return expect(buttonNamed("Copy link", menu)).toBeEnabled();
  });
  click(buttonNamed("Copy link", menu));
  await waitFor(() => {
    return expect(clipboard.writes.at(-1)).toBe(
      "https://www.customer-example.net",
    );
  });
  expect(saves).toBe(1);
  click(buttonNamed("Customize URL", menu));
  await waitFor(() => {
    expect(tabNamed("Custom domain", menu)).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
  await expect(
    within(menu).findByRole("radio", {
      name: "www.customer-example.net HTTPS ready",
    }),
  ).resolves.toBeChecked();
  expect(buttonNamed("Remove www.customer-example.net", menu)).toBeEnabled();
  click(tabNamed("Okou URL", menu));
  await expect(
    within(menu).findByLabelText("Website URL"),
  ).resolves.toHaveValue("launch-site");
  expect(within(menu).getByText(".okou.app")).toBeInTheDocument();
  click(buttonNamed("Cancel", menu));
  click(
    await waitFor(() => {
      return buttonNamed("Copied", menu);
    }),
  );
  await waitFor(() => {
    expect(clipboard.writes.at(-1)).toBe("https://www.customer-example.net");
  });
  expect(saves).toBe(1);
});

test("pending domains are managed as full hostnames and cannot replace the sharing address", async () => {
  const domainId = "00000000-0000-4000-8000-000000000061";
  const revision = "00000000-0000-4000-8000-000000000062";
  let settings: zInfer<typeof hostedDomainSettingsSchema> = {
    siteId,
    defaultUrl: "https://launch-site.okou.app",
    effectiveUrl: "https://launch-site.okou.app",
    selectedDomainId: null,
    revision,
    allowed: true,
    domains: [
      {
        id: domainId,
        hostname: "pending.customer-example.net",
        revision,
        ready: false,
        removing: false,
        records: [],
        verification: null,
      },
    ],
  };
  context.mocks.api(hostContract.siteDomains, ({ respond }) => {
    return respond(200, settings);
  });
  let removals = 0;
  context.mocks.api(hostContract.removeSiteDomain, ({ respond }) => {
    removals++;
    settings = { ...settings, domains: [] };
    return respond(200, settings);
  });
  const preview = await setupHostedSite("launch-site", "okou.app", true);
  const menu = await openHostedSiteShare(preview);
  click(buttonNamed("Customize URL", menu));
  click(
    await waitFor(() => {
      return tabNamed("Custom domain", menu);
    }),
  );
  await expect(
    within(menu).findByRole("radio", {
      name: "pending.customer-example.net Finish setup",
    }),
  ).resolves.toHaveAttribute("aria-disabled", "true");
  expect(buttonNamed("Save", menu)).toBeDisabled();
  expect(within(menu).queryByRole("combobox")).not.toBeInTheDocument();
  click(buttonNamed("Manage pending.customer-example.net", menu));
  await within(menu).findByRole("heading", {
    name: "pending.customer-example.net",
  });
  expect(within(menu).getByText("No verification yet")).toBeInTheDocument();
  click(buttonNamed("Cancel", menu));
  await expect(
    within(menu).findByRole("radio", {
      name: "pending.customer-example.net Finish setup",
    }),
  ).resolves.toHaveAttribute("aria-disabled", "true");
  click(buttonNamed("Remove pending.customer-example.net", menu));
  let confirmation = await screen.findByRole("dialog", { name: /Remove/ });
  click(buttonNamed("Cancel", confirmation));
  expect(removals).toBe(0);
  click(buttonNamed("Remove pending.customer-example.net", menu));
  confirmation = await screen.findByRole("dialog", { name: /Remove/ });
  click(buttonNamed("Remove", confirmation));
  await waitFor(() => {
    expect(removals).toBe(1);
  });
  await waitFor(() => {
    expect(
      within(menu).queryByText("pending.customer-example.net"),
    ).not.toBeInTheDocument();
  });
  click(tabNamed("Okou URL", menu));
  await expect(
    within(menu).findByLabelText("Website URL"),
  ).resolves.toHaveValue("launch-site");
});

test("a workspace without an active subscription cannot select an existing verified custom domain", async () => {
  const revision = "00000000-0000-4000-8000-000000000072";
  context.mocks.api(hostContract.siteDomains, ({ respond }) => {
    return respond(200, {
      siteId,
      defaultUrl: "https://launch-site.okou.app",
      effectiveUrl: "https://launch-site.okou.app",
      selectedDomainId: null,
      revision,
      allowed: false,
      domains: [
        {
          id: "00000000-0000-4000-8000-000000000071",
          hostname: "verified.customer-example.net",
          revision,
          ready: true,
          removing: false,
          records: [],
          verification: null,
        },
      ],
    });
  });
  const preview = await setupHostedSite("launch-site", "okou.app", true);
  const menu = await openHostedSiteShare(preview);
  click(buttonNamed("Customize URL", menu));
  click(
    await waitFor(() => {
      return tabNamed("Custom domain", menu);
    }),
  );
  await expect(
    within(menu).findByRole("radio", {
      name: "verified.customer-example.net HTTPS ready",
    }),
  ).resolves.toHaveAttribute("aria-disabled", "true");
  expect(buttonNamed("Save", menu)).toBeDisabled();
  expect(
    buttonNamed("Manage verified.customer-example.net", menu),
  ).toBeEnabled();
});
