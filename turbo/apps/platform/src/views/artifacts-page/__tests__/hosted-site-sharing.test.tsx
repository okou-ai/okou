import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import type { HostedSiteVisibility } from "@okouai/api-contracts/contracts/hosted-site-access";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { posthog } from "posthog-js/dist/module.slim";
import { expect, test, vi } from "vitest";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  billingPlanCapabilities,
  defaultBillingStatus,
} from "../../../mocks/handlers/api-billing.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  artifact,
  findArtifactAction,
  getButtonByName,
  queryButtonByName,
} from "./artifact-catalog-test-helpers.ts";

vi.hoisted(() => {
  // Product analytics resolves the deployment environment at module load.
  window.location.href = "https://app.okou.ai/";
});

const context = testContext();
const siteId = "00000000-0000-4000-8000-000000000008";
const site = Object.freeze({
  siteId,
  publicSlug: "weekly-report",
  url: "https://weekly-report.okou.app",
  isActive: true,
});
const temporaryPreview = `https://pv-${"c".repeat(48)}.okou.app/`;
const organizationPreview = `https://pv-${"d".repeat(48)}.okou.app/`;

interface SiteVisibilityStatus {
  readonly siteId: string;
  readonly visibility: HostedSiteVisibility;
  readonly revision: string | null;
}

function mockPublishedSite() {
  context.mocks.api(hostContract.siteUrl, ({ respond }) => {
    return respond(200, site);
  });
  context.mocks.api(hostContract.resolveAlias, ({ respond }) => {
    return respond(200, {
      pointer: {
        version: 1,
        publicBrand: "okou",
        publicSlug: site.publicSlug,
        siteId,
        deploymentId: "00000000-0000-4000-8000-000000000009",
        prefix: "sites/weekly-report/1",
        manifestKey: "sites/weekly-report/1/manifest.json",
        spaFallback: false,
        updatedAt: "2026-01-01T00:00:00Z",
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

function mockFreePlan() {
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, {
      ...defaultBillingStatus(),
      tier: "limited-free-1",
      ...billingPlanCapabilities("limited-free-1"),
    });
  });
}

function mockAvailableAddress() {
  context.mocks.api(hostContract.siteUrlAvailability, ({ respond }) => {
    return respond(200, { available: true });
  });
}

function mockVisibilityChanges(initial: SiteVisibilityStatus) {
  let status = initial;
  context.mocks.api(hostContract.siteVisibility, ({ respond }) => {
    return respond(200, status);
  });
  context.mocks.api(hostContract.updateSiteVisibility, ({ body, respond }) => {
    if (body.expectedRevision !== status.revision) {
      return respond(409, {
        error: { code: "CONFLICT", message: "Website visibility changed" },
      });
    }
    status = {
      siteId,
      visibility: body.visibility,
      revision: crypto.randomUUID(),
    };
    return respond(200, status);
  });
  return {
    current: () => {
      return status;
    },
    changeOnServer: (next: SiteVisibilityStatus) => {
      status = next;
    },
  };
}

async function openSite({
  sidebar = false,
  shareRows = false,
  groupedActions = false,
} = {}) {
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, {
      artifacts: [artifact({ kind: "hosted-site", title: "Weekly report" })],
      nextCursor: null,
    });
  });
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    return respond(200, {
      ...artifact({ kind: "hosted-site", title: "Weekly report" }),
      kind: "hosted-site",
      site: {
        id: siteId,
        slug: site.publicSlug,
        publicSlug: site.publicSlug,
        url: site.url,
        deploymentVersion: 1,
        entrypoint: "/index.html",
        spaFallback: false,
      },
    });
  });
  await setupPage({
    context,
    path: "/artifacts",
    host: "app.okou.ai",
    featureSwitches: {
      [FeatureSwitchKey.ArtifactSidebarPreview]: sidebar,
      [FeatureSwitchKey.HostedSiteShareRows]: shareRows,
      [FeatureSwitchKey.ArtifactPreviewActionGroup]: groupedActions,
    },
  });
  click(await findArtifactAction("Weekly report"));
  return screen.findByTestId(
    sidebar ? "artifact-sidebar" : "artifact-dialog-site-frame",
  );
}

async function openShare(label = "Share") {
  await waitFor(() => {
    expect(queryButtonByName(label)).toBeDefined();
  });
  click(getButtonByName(label));
  return screen.findByRole("dialog", { name: label });
}

async function openAddressEditor() {
  await waitFor(() => {
    expect(queryButtonByName("Customize URL")).toBeDefined();
  });
  click(getButtonByName("Customize URL"));
  return screen.findByLabelText("Website URL");
}

function previewFrame(preview: HTMLElement) {
  return preview.querySelector("iframe");
}

function permission(name: string): HTMLElement {
  const row = queryAllByRoleFast("radio").find((element) => {
    return element.getAttribute("aria-label") === name;
  });
  if (!row) {
    throw new Error(`Expected permission named "${name}"`);
  }
  return row;
}

async function expectPermission(name: string) {
  await waitFor(() => {
    expect(permission(name)).toHaveAttribute("aria-checked", "true");
    expect(permission(name)).toHaveAttribute("aria-busy", "false");
  });
}

function bannerShares(telemetry: ReturnType<typeof context.mocks.posthog>) {
  return telemetry.events
    .filter((event) => {
      return event.name === "artifact_action_clicked";
    })
    .map((event) => {
      return event.properties;
    });
}

test("Share waits for the current site address before copying it", async () => {
  mockPublishedSite();
  const requested = context.mocks.deferred<void>();
  const response = context.mocks.deferred<void>();
  const current = {
    ...site,
    publicSlug: "current-report",
    url: "https://current-report.okou.app",
  };
  context.mocks.api(hostContract.siteUrl, async ({ respond }) => {
    requested.resolve();
    await response.promise;
    return respond(200, current);
  });
  const clipboard = context.mocks.browser.clipboardWriteText();

  await openSite();
  await requested.promise;
  const menu = await openShare();
  expect(menu.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  expect(queryButtonByName("Copy link", menu)).toBeUndefined();

  response.resolve();
  await waitFor(() => {
    expect(getButtonByName("Copy link", menu)).toBeEnabled();
  });
  click(getButtonByName("Copy link", menu));
  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([current.url]);
  });
});

test("A customized site address updates the preview and is copied only on request", async () => {
  mockPublishedSite();
  mockAvailableAddress();
  context.mocks.api(hostContract.updateSiteUrl, ({ body, respond }) => {
    return respond(200, {
      ...site,
      publicSlug: body.publicSlug,
      url: `https://${body.publicSlug}.okou.app`,
    });
  });
  const preview = await openSite();
  await openShare();

  await fill(await openAddressEditor(), "launch-report");
  await screen.findByText("Available");
  expect(
    screen.getByText(
      "The old URL will stop working. Update any links you have shared.",
    ),
  ).toBeInTheDocument();
  // Typing installs user-event's clipboard; it must still be empty here.
  await expect(navigator.clipboard.readText()).resolves.toBe("");
  const clipboard = context.mocks.browser.clipboardWriteText();
  click(getButtonByName("Save"));

  await expect(
    screen.findByText("Website URL updated"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(previewFrame(preview)).toHaveAttribute(
      "src",
      "https://launch-report.okou.app/",
    );
  });
  expect(clipboard.writes).toStrictEqual([]);
  click(getButtonByName("Copy link"));
  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual(["https://launch-report.okou.app"]);
  });
});

test("On the free plan, turning off the banner opens the plans and keeps it shown", async () => {
  mockPublishedSite();
  mockFreePlan();
  const updates: boolean[] = [];
  context.mocks.api(hostContract.updateSiteBanner, ({ body, respond }) => {
    updates.push(body.showBanner);
    return respond(200, { siteId, showBanner: false, revision: null });
  });
  await openSite();
  await openShare();
  const banner = await screen.findByRole("switch", {
    name: "Show Okou banner",
  });
  await waitFor(() => {
    expect(banner).toBeEnabled();
  });

  click(banner);

  await expect(
    screen.findByRole("dialog", { name: "Choose a plan" }),
  ).resolves.toBeInTheDocument();
  expect(updates).toStrictEqual([]);
  expect(banner).toBeInTheDocument();
  expect(banner).toBeChecked();
});

test("A conflicting address save keeps the draft and the current shared address", async () => {
  mockPublishedSite();
  mockAvailableAddress();
  context.mocks.api(hostContract.updateSiteUrl, ({ respond }) => {
    return respond(409, {
      error: { code: "CONFLICT", message: "Address taken" },
    });
  });
  await openSite();
  await openShare();
  await fill(await openAddressEditor(), "taken-report");
  await screen.findByText("Available");

  click(getButtonByName("Save"));

  await expect(
    screen.findByText(/Could not save/u),
  ).resolves.toBeInTheDocument();
  expect(screen.getByLabelText("Website URL")).toHaveValue("taken-report");
  click(getButtonByName("Cancel"));
  const clipboard = context.mocks.browser.clipboardWriteText();
  click(getButtonByName("Copy link"));
  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([site.url]);
  });
});

test("A failed address check keeps Save disabled until a revised address is available", async () => {
  mockPublishedSite();
  let checkFails = true;
  context.mocks.api(hostContract.siteUrlAvailability, ({ respond }) => {
    return checkFails
      ? respond(500, {
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Address check unavailable",
          },
        })
      : respond(200, { available: true });
  });
  await openSite();
  await openShare();
  const input = await openAddressEditor();

  await fill(input, "launch-report");
  await expect(
    screen.findByText("Could not check this address."),
  ).resolves.toBeInTheDocument();
  expect(getButtonByName("Save")).toBeDisabled();

  checkFails = false;
  await fill(input, "launch-report-revised");
  await screen.findByText("Available");
  expect(getButtonByName("Save")).toBeEnabled();
});

test("A failed address save keeps the draft and the current preview", async () => {
  mockPublishedSite();
  mockAvailableAddress();
  context.mocks.api(hostContract.updateSiteUrl, ({ respond }) => {
    return respond(500, {
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Website save unavailable",
      },
    });
  });
  const preview = await openSite();
  await openShare();
  await fill(await openAddressEditor(), "launch-report");
  await screen.findByText("Available");

  click(getButtonByName("Save"));

  await expect(
    screen.findByText(/Could not save/u),
  ).resolves.toBeInTheDocument();
  expect(screen.getByLabelText("Website URL")).toHaveValue("launch-report");
  expect(getButtonByName("Save")).toBeEnabled();
  expect(previewFrame(preview)).toHaveAttribute("src", site.url);
});

test("The Customize URL row shows and copies the current address and opens the editor", async () => {
  mockPublishedSite();
  const clipboard = context.mocks.browser.clipboardWriteText();
  await openSite({ shareRows: true });
  await openShare();
  await waitFor(() => {
    expect(queryButtonByName("Customize URL")).toBeDefined();
  });
  const row = getButtonByName("Customize URL");
  expect(row).toHaveTextContent("weekly-report.okou.app");

  click(getButtonByName("Copy link"));
  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([site.url]);
  });
  click(row);

  await expect(
    screen.findByLabelText("Website URL"),
  ).resolves.toBeInTheDocument();
});

test("A website settings failure disables copying an unknown address", async () => {
  mockPublishedSite();
  context.mocks.api(hostContract.siteUrl, ({ respond }) => {
    return respond(500, {
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Website settings unavailable",
      },
    });
  });
  await openSite();
  await openShare();

  await expect(
    screen.findByText("Could not load website settings"),
  ).resolves.toBeInTheDocument();
  expect(getButtonByName("Copy link")).toBeDisabled();
  expect(queryButtonByName("Customize URL")).toBeUndefined();
});

test("Unavailable banner settings stay unknown when copying the site link", async () => {
  mockPublishedSite();
  context.mocks.api(hostContract.siteBanner, ({ respond }) => {
    return respond(500, {
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Banner settings unavailable",
      },
    });
  });
  const telemetry = context.mocks.posthog();
  const clipboard = context.mocks.browser.clipboardWriteText();
  await openSite();
  await openShare();

  await expect(
    screen.findByText("Unable to load banner settings"),
  ).resolves.toBeInTheDocument();
  expect(
    screen.queryByRole("switch", { name: "Show Okou banner" }),
  ).not.toBeInTheDocument();
  click(getButtonByName("Copy link"));
  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([site.url]);
  });
  expect(bannerShares(telemetry)).toMatchObject([
    {
      action: "banner_share",
      target: "hosted_site",
      show_banner: "unknown",
    },
  ]);
});

test("The grouped dialog toolbar shares the link before banner settings load", async () => {
  mockPublishedSite();
  const banner = context.mocks.deferred<void>();
  context.mocks.api(hostContract.siteBanner, async ({ respond }) => {
    await banner.promise;
    return respond(200, { siteId, showBanner: false, revision: null });
  });
  const clipboard = context.mocks.browser.clipboardWriteText();
  await openSite({ groupedActions: true });
  const preview = await screen.findByTestId("attachment-lightbox");

  await waitFor(() => {
    expect(getButtonByName("Share", preview)).toBeVisible();
  });
  expect(getButtonByName("Share", preview)).toBeEnabled();
  expect(getButtonByName("Close", preview)).toBeEnabled();
  expect(within(preview).queryByRole("status")).not.toBeInTheDocument();
  await openShare();
  click(getButtonByName("Copy link"));
  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([site.url]);
  });

  banner.resolve();
  await expect(
    screen.findByRole("switch", { name: "Show Okou banner" }),
  ).resolves.not.toBeChecked();
});

test("A failed clipboard write still records the confirmed banner preference", async () => {
  mockPublishedSite();
  const telemetry = context.mocks.posthog();
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
    new DOMException("Clipboard unavailable", "NotAllowedError"),
  );
  await openSite();
  await openShare();
  await expect(
    screen.findByRole("switch", { name: "Show Okou banner" }),
  ).resolves.toBeChecked();

  click(getButtonByName("Copy link"));

  await expect(
    screen.findByText("Failed to copy link"),
  ).resolves.toBeInTheDocument();
  expect(getButtonByName("Copy link")).toBeEnabled();
  expect(bannerShares(telemetry)).toMatchObject([
    {
      action: "banner_share",
      target: "hosted_site",
      show_banner: true,
    },
  ]);
});

test("Copy link succeeds when the analytics SDK throws", async () => {
  mockPublishedSite();
  context.mocks.posthog();
  const clipboard = context.mocks.browser.clipboardWriteText();
  const analyticsError = new Error("Analytics unavailable");
  window.addEventListener(
    "error",
    (event) => {
      if (event.error === analyticsError) {
        event.preventDefault();
      }
    },
    { signal: context.signal },
  );
  await openSite();
  await openShare();
  await waitFor(() => {
    expect(getButtonByName("Copy link")).toBeEnabled();
  });
  vi.spyOn(posthog, "capture").mockImplementationOnce(() => {
    throw analyticsError;
  });

  click(getButtonByName("Copy link"));

  await waitFor(() => {
    expect(getButtonByName("Copied")).toBeInTheDocument();
  });
  expect(clipboard.writes).toStrictEqual([site.url]);
});

test("A conflicting banner edit keeps the confirmed preference for copying", async () => {
  mockPublishedSite();
  context.mocks.api(hostContract.updateSiteBanner, ({ respond }) => {
    return respond(409, {
      error: {
        code: "CONFLICT",
        message: "Website banner changed; reload before editing",
      },
    });
  });
  const telemetry = context.mocks.posthog();
  const clipboard = context.mocks.browser.clipboardWriteText();
  await openSite();
  await openShare();
  const toggle = await screen.findByRole("switch", {
    name: "Show Okou banner",
  });
  click(toggle);
  await screen.findByText("Website banner changed; reload before editing");
  await waitFor(() => {
    expect(toggle).not.toHaveAttribute("aria-disabled", "true");
  });

  click(getButtonByName("Copy link"));

  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([site.url]);
  });
  expect(toggle).toBeChecked();
  expect(bannerShares(telemetry)).toMatchObject([
    {
      action: "banner_share",
      target: "hosted_site",
      show_banner: true,
    },
  ]);
});

test.each([
  { sidebar: false, layout: "dialog", label: "Share" },
  { sidebar: true, layout: "sidebar", label: "Share artifact" },
])(
  "Owners change visibility in the $layout preview and copy the stable address",
  async ({ sidebar, label }) => {
    mockPublishedSite();
    const visibility = mockVisibilityChanges({
      siteId,
      visibility: "private",
      revision: null,
    });
    const previews = {
      public: site.url,
      organization: organizationPreview,
      private: temporaryPreview,
    } as const;
    context.mocks.api(hostContract.sitePreview, ({ respond }) => {
      const current = visibility.current().visibility;
      return respond(
        200,
        current === "public"
          ? { url: site.url, expiresAt: null }
          : { url: previews[current], expiresAt: "2099-01-01T00:00:00Z" },
      );
    });
    const clipboard = context.mocks.browser.clipboardWriteText();
    const preview = await openSite({ sidebar });
    const menu = await openShare(label);
    await expectPermission("Only me");

    for (const [name, address] of [
      ["Anyone at Default Org", organizationPreview],
      ["Anyone with the link", site.url],
      ["Only me", temporaryPreview],
    ] as const) {
      click(permission(name));
      await expectPermission(name);
      await waitFor(() => {
        expect(previewFrame(preview)).toHaveAttribute("src", address);
      });
      expect(getButtonByName("Copy link", menu)).toBeEnabled();
    }

    click(getButtonByName("Copy link", menu));
    await waitFor(() => {
      expect(clipboard.writes).toStrictEqual([site.url]);
    });
  },
);

test("Grouped Share stays open while a visibility change refreshes the preview", async () => {
  mockPublishedSite();
  const visibility = mockVisibilityChanges({
    siteId,
    visibility: "private",
    revision: null,
  });
  const refreshRequested = context.mocks.deferred<void>();
  const refresh = context.mocks.deferred<void>();
  context.mocks.api(hostContract.sitePreview, async ({ respond }) => {
    if (visibility.current().revision === null) {
      return respond(200, {
        url: temporaryPreview,
        expiresAt: "2099-01-01T00:00:00Z",
      });
    }
    refreshRequested.resolve();
    await refresh.promise;
    return respond(200, { url: site.url, expiresAt: null });
  });
  const clipboard = context.mocks.browser.clipboardWriteText();
  const preview = await openSite({ groupedActions: true });
  const menu = await openShare();
  await expectPermission("Only me");
  await waitFor(() => {
    expect(previewFrame(preview)).toHaveAttribute("src", temporaryPreview);
  });

  click(permission("Anyone with the link"));
  await refreshRequested.promise;
  await expectPermission("Anyone with the link");
  expect(getButtonByName("Share")).toBeVisible();
  expect(getButtonByName("Share")).toHaveAttribute("aria-expanded", "true");
  expect(menu).toBeVisible();
  expect(getButtonByName("Copy link", menu)).toBeEnabled();

  refresh.resolve();
  await waitFor(() => {
    expect(previewFrame(preview)).toHaveAttribute("src", site.url);
  });
  click(getButtonByName("Copy link", menu));
  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([site.url]);
  });
});

test("Pending permissions do not claim public access before reporting Only me", async () => {
  mockPublishedSite();
  const requested = context.mocks.deferred<void>();
  const response = context.mocks.deferred<void>();
  context.mocks.api(hostContract.siteVisibility, async ({ respond }) => {
    requested.resolve();
    await response.promise;
    return respond(200, { siteId, visibility: "private", revision: null });
  });
  await openSite();
  await requested.promise;
  await openShare();

  await expect(
    screen.findByRole("status", { name: "Loading permissions" }),
  ).resolves.toBeInTheDocument();
  expect(queryAllByRoleFast("radio")).toHaveLength(0);
  expect(screen.queryByText("Anyone with the link")).not.toBeInTheDocument();

  response.resolve();
  await expectPermission("Only me");
});

test("Unavailable visibility settings keep every audience choice disabled", async () => {
  mockPublishedSite();
  context.mocks.api(hostContract.siteVisibility, ({ respond }) => {
    return respond(403, {
      error: {
        code: "FORBIDDEN",
        message: "Website permissions unavailable",
      },
    });
  });
  await openSite();
  await openShare();

  await expect(
    screen.findByText("Unable to load permissions"),
  ).resolves.toBeInTheDocument();
  const choices = queryAllByRoleFast("radio");
  expect(choices).toHaveLength(3);
  for (const choice of choices) {
    expect(choice).toHaveAttribute("aria-checked", "false");
    expect(choice).toBeDisabled();
  }
  expect(getButtonByName("Copy link")).toBeEnabled();
});

test("A conflicting visibility change keeps the last confirmed audience", async () => {
  mockPublishedSite();
  const visibility = mockVisibilityChanges({
    siteId,
    visibility: "public",
    revision: null,
  });
  await openSite();
  await openShare();
  await expectPermission("Anyone with the link");
  visibility.changeOnServer({
    siteId,
    visibility: "organization",
    revision: crypto.randomUUID(),
  });

  click(permission("Only me"));

  await expect(
    screen.findByText("Website visibility changed"),
  ).resolves.toBeInTheDocument();
  await expectPermission("Anyone with the link");
});

test("Rapid audience choices settle on the latest one", async () => {
  mockPublishedSite();
  let status: SiteVisibilityStatus = {
    siteId,
    visibility: "private",
    revision: null,
  };
  context.mocks.api(hostContract.siteVisibility, ({ respond }) => {
    return respond(200, status);
  });
  const firstSaveStarted = context.mocks.deferred<void>();
  const firstSave = context.mocks.deferred<void>();
  let saves = 0;
  context.mocks.api(
    hostContract.updateSiteVisibility,
    async ({ body, respond }) => {
      saves += 1;
      if (saves === 1) {
        firstSaveStarted.resolve();
        await firstSave.promise;
      }
      if (body.expectedRevision !== status.revision) {
        return respond(409, {
          error: { code: "CONFLICT", message: "Website visibility changed" },
        });
      }
      status = {
        siteId,
        visibility: body.visibility,
        revision: crypto.randomUUID(),
      };
      return respond(200, status);
    },
  );
  await openSite();
  await openShare();
  await expectPermission("Only me");

  click(permission("Anyone at Default Org"));
  await firstSaveStarted.promise;
  await waitFor(() => {
    expect(permission("Only me")).toHaveAttribute("aria-busy", "true");
  });
  click(permission("Anyone with the link"));
  click(permission("Only me"));
  firstSave.resolve();

  await expectPermission("Only me");
  await waitFor(() => {
    expect(getButtonByName("Copy link")).toBeEnabled();
  });
  expect(status.visibility).toBe("private");
  expect(status.revision).not.toBeNull();
});
