import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import type { hostedSiteVisibilityStatusSchema } from "@okouai/api-contracts/contracts/hosted-site-access";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import type { infer as zInfer } from "zod";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import {
  artifact,
  findArtifactAction,
  getButtonByName,
  queryButtonByName,
} from "./artifact-catalog-test-helpers.ts";

const context = testContext();
const siteId = "00000000-0000-4000-8000-000000000008";
const site = Object.freeze({
  siteId,
  publicSlug: "weekly-report",
  url: "https://weekly-report.okou.app",
  isActive: true,
});

async function openSite({ sidebar = false, quickActions = true } = {}) {
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
      [FeatureSwitchKey.ArtifactQuickActions]: quickActions,
    },
  });
  click(await findArtifactAction("Weekly report"));
  await screen.findByTestId(
    sidebar ? "artifact-sidebar" : "artifact-dialog-site-frame",
  );
}

beforeEach(() => {
  mockSiteAlias();
  context.mocks.api(hostContract.siteVisibility, ({ respond }) => {
    return respond(200, { siteId, visibility: "public", revision: null });
  });
  context.mocks.api(hostContract.siteBanner, ({ respond }) => {
    return respond(200, { siteId, showBanner: true, revision: null });
  });
});

async function openShare(label = "Share") {
  await waitFor(() => {
    expect(queryButtonByName(label)).toBeDefined();
  });
  click(getButtonByName(label));
  await screen.findByRole("dialog", { name: label });
}

test("opening a site preloads its share URL and shows a skeleton until the current address is ready", async () => {
  const requested = createDeferredPromise<void>(context.signal);
  const response = createDeferredPromise<void>(context.signal);
  const currentSite = {
    ...site,
    publicSlug: "current-report",
    url: "https://current-report.okou.app",
  };
  const clipboard = context.mocks.browser.clipboardWriteText();
  context.mocks.api(hostContract.siteUrl, async ({ respond }) => {
    requested.resolve();
    await response.promise;
    return respond(200, currentSite);
  });

  await openSite();
  await requested.promise;
  await openShare();
  try {
    const menu = await screen.findByRole("dialog", { name: "Share" });
    expect(menu.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  } finally {
    response.resolve();
  }

  await waitFor(() => {
    expect(getButtonByName("Copy link")).toBeEnabled();
  });
  click(getButtonByName("Copy link"));
  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([currentSite.url]);
  });
});

test.each([false, true])(
  "website URL saves honor quick actions (enabled: %s)",
  async (quickActions) => {
    const user = userEvent.setup();
    context.mocks.api(hostContract.siteUrl, ({ respond }) => {
      return respond(200, site);
    });
    context.mocks.api(hostContract.siteUrlAvailability, ({ respond }) => {
      return respond(200, { available: true });
    });
    context.mocks.api(hostContract.updateSiteUrl, ({ body, respond }) => {
      expect(body.expectedPublicSlug).toBe(site.publicSlug);
      return respond(200, {
        ...site,
        publicSlug: body.publicSlug,
        url: `https://${body.publicSlug}.okou.app`,
      });
    });
    await openSite({ quickActions });
    const share = getButtonByName("Share");
    const download = getButtonByName("Download options");
    await user.hover(share);
    await user.hover(download);
    if (quickActions) {
      await screen.findByRole("menu");
    } else {
      await screen.findByText("Download options");
    }
    await waitFor(() => {
      expect(share).toHaveAttribute("aria-expanded", "false");
      expect(download).toHaveAttribute("aria-expanded", String(quickActions));
    });
    if (!quickActions) {
      click(download);
    }
    await screen.findByRole("menu");
    await user.keyboard("{Escape}");
    await openShare();
    await expectPermission("Anyone with the link");
    await expect(
      screen.findByRole("switch", { name: "Show Okou banner" }),
    ).resolves.toBeChecked();
    await waitFor(() => {
      expect(queryButtonByName("Customize URL")).toBeDefined();
    });
    click(getButtonByName("Customize URL"));
    const input = await screen.findByLabelText("Website URL");
    expect(getButtonByName("Save")).toBeDisabled();
    await fill(input, "launch-report");
    await screen.findByText("Available");
    expect(
      screen.getByText(
        "The old URL will stop working. Update any links you have shared.",
      ),
    ).toBeInTheDocument();
    expect(
      fireEvent.keyDown(input, {
        key: "Enter",
        isComposing: false,
        keyCode: 229,
      }),
    ).toBeFalsy();
    expect(input).toHaveValue("launch-report");
    const clipboard = context.mocks.browser.clipboardWriteText();
    click(getButtonByName("Save"));
    await screen.findByText("Website URL updated");
    expect(getButtonByName("Customize URL")).toHaveFocus();
    await waitFor(() => {
      expect(
        screen
          .getByTestId("artifact-dialog-site-frame")
          .querySelector("iframe"),
      ).toHaveAttribute("src", "https://launch-report.okou.app/");
    });
    await waitFor(() => {
      expect(
        queryButtonByName(quickActions ? "Copied" : "Copy link"),
      ).toBeDefined();
    });
    expect(clipboard.writes).toStrictEqual(
      quickActions ? ["https://launch-report.okou.app"] : [],
    );
    if (!quickActions) {
      click(getButtonByName("Copy link"));
    }
    await waitFor(() => {
      expect(queryButtonByName("Copied")).toBeDefined();
    });
    expect(clipboard.writes).toStrictEqual(["https://launch-report.okou.app"]);
  },
);

test("invalid and occupied addresses cannot be saved and cancel discards the draft", async () => {
  context.mocks.api(hostContract.siteUrl, ({ respond }) => {
    return respond(200, site);
  });
  context.mocks.api(hostContract.siteUrlAvailability, ({ respond }) => {
    return respond(200, { available: false });
  });
  await openSite();
  await openShare();
  await waitFor(() => {
    expect(queryButtonByName("Customize URL")).toBeDefined();
  });
  click(getButtonByName("Customize URL"));
  const input = await screen.findByLabelText("Website URL");
  await fill(input, "dpl-reserved");
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(getButtonByName("Save")).toBeDisabled();
  await fill(input, "taken-report");
  await screen.findByText("This address is already taken");
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(getButtonByName("Save")).toBeDisabled();
  click(getButtonByName("Cancel"));
  expect(screen.queryByLabelText("Website URL")).not.toBeInTheDocument();
  expect(getButtonByName("Customize URL")).toHaveFocus();
  const clipboard = context.mocks.browser.clipboardWriteText();
  click(getButtonByName("Copy link"));
  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([site.url]);
  });
});

test("a save conflict keeps the draft and current shared address", async () => {
  context.mocks.api(hostContract.siteUrl, ({ respond }) => {
    return respond(200, site);
  });
  context.mocks.api(hostContract.siteUrlAvailability, ({ respond }) => {
    return respond(200, { available: true });
  });
  context.mocks.api(hostContract.updateSiteUrl, ({ respond }) => {
    return respond(409, {
      error: { code: "CONFLICT", message: "Address taken" },
    });
  });
  await openSite();
  await openShare();
  await waitFor(() => {
    expect(queryButtonByName("Customize URL")).toBeDefined();
  });
  click(getButtonByName("Customize URL"));
  await fill(await screen.findByLabelText("Website URL"), "taken-report");
  await screen.findByText("Available");
  const clipboard = context.mocks.browser.clipboardWriteText();
  click(getButtonByName("Save"));
  await screen.findByText(/Could not save/);
  expect(screen.getByLabelText("Website URL")).toHaveValue("taken-report");
  click(getButtonByName("Cancel"));
  expect(clipboard.writes).toStrictEqual([]);
  click(getButtonByName("Copy link"));
  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([site.url]);
  });
});

test("an unavailable address check disables saving until a new address is validated", async () => {
  let unavailable = true;
  context.mocks.api(hostContract.siteUrl, ({ respond }) => {
    return respond(200, site);
  });
  context.mocks.api(hostContract.siteUrlAvailability, ({ respond }) => {
    return unavailable
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
  await waitFor(() => {
    expect(queryButtonByName("Customize URL")).toBeDefined();
  });
  click(getButtonByName("Customize URL"));
  const input = await screen.findByLabelText("Website URL");
  await fill(input, "launch-report");
  await screen.findByText("Address check unavailable");
  await screen.findByText("Could not check this address.");
  expect(getButtonByName("Save")).toBeDisabled();
  expect(input).toHaveValue("launch-report");
  unavailable = false;
  await fill(input, "launch-report-revised");
  await screen.findByText("Available");
  expect(getButtonByName("Save")).toBeEnabled();
});

test("a failed save retains the draft and the current address", async () => {
  context.mocks.api(hostContract.siteUrl, ({ respond }) => {
    return respond(200, site);
  });
  context.mocks.api(hostContract.siteUrlAvailability, ({ respond }) => {
    return respond(200, { available: true });
  });
  context.mocks.api(hostContract.updateSiteUrl, ({ respond }) => {
    return respond(500, {
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Website save unavailable",
      },
    });
  });
  await openSite();
  await openShare();
  await waitFor(() => {
    expect(queryButtonByName("Customize URL")).toBeDefined();
  });
  click(getButtonByName("Customize URL"));
  await fill(await screen.findByLabelText("Website URL"), "launch-report");
  await screen.findByText("Available");
  const clipboard = context.mocks.browser.clipboardWriteText();
  click(getButtonByName("Save"));
  await screen.findByText("Website save unavailable");
  await screen.findByText(/Could not save/);
  expect(screen.getByLabelText("Website URL")).toHaveValue("launch-report");
  expect(getButtonByName("Save")).toBeEnabled();
  expect(
    screen.getByTestId("artifact-dialog-site-frame").querySelector("iframe"),
  ).toHaveAttribute("src", site.url);
  expect(clipboard.writes).toStrictEqual([]);
});

test("A settings failure disables copying an unknown address", async () => {
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
  await screen.findByText("Could not load website settings");
  expect(getButtonByName("Copy link")).toBeDisabled();
  expect(queryButtonByName("Customize URL")).toBeUndefined();
});

test("restricted Site previews share the stable address", async () => {
  const temporary = `https://pv-${"a".repeat(48)}.okou.app/`;
  context.mocks.api(hostContract.sitePreview, ({ params, query, respond }) => {
    expect(params.publicSlug).toBe(site.publicSlug);
    expect(query.hostname).toBe("weekly-report.okou.app");
    return respond(200, { url: temporary, expiresAt: "2099-01-01T00:00:00Z" });
  });
  context.mocks.api(hostContract.siteUrl, ({ respond }) => {
    return respond(200, site);
  });
  context.mocks.api(hostContract.siteVisibility, ({ respond }) => {
    return respond(200, { siteId, visibility: "private", revision: null });
  });
  const clipboard = context.mocks.browser.clipboardWriteText();
  await openSite();
  await waitFor(() => {
    expect(
      screen.getByTestId("artifact-dialog-site-frame").querySelector("iframe"),
    ).toHaveAttribute("src", temporary);
  });
  await openShare();
  await expectPermission("Only me");
  click(getButtonByName("Copy link"));
  await waitFor(() => {
    return expect(clipboard.writes).toStrictEqual([site.url]);
  });
  expect(
    screen.getByTestId("artifact-dialog-site-frame").querySelector("iframe"),
  ).toHaveAttribute("src", temporary);
});

test("Public Site previews render the anonymous URL", async () => {
  context.mocks.api(hostContract.sitePreview, ({ respond }) => {
    return respond(200, { url: `${site.url}/`, expiresAt: null });
  });
  context.mocks.api(hostContract.siteUrl, ({ respond }) => {
    return respond(200, site);
  });
  await openSite();
  await waitFor(() => {
    expect(
      screen.getByTestId("artifact-dialog-site-frame").querySelector("iframe"),
    ).toHaveAttribute("src", site.url);
  });
});

type SiteVisibilityStatus = zInfer<typeof hostedSiteVisibilityStatusSchema>;

test("Unavailable banner settings do not claim that the banner is hidden", async () => {
  mockSiteAlias();
  context.mocks.api(hostContract.siteVisibility, ({ respond }) => {
    return respond(200, { siteId, visibility: "public", revision: null });
  });
  context.mocks.api(hostContract.siteBanner, ({ respond }) => {
    return respond(500, {
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Banner settings unavailable",
      },
    });
  });
  await openSite();
  await openShare();
  await screen.findByText("Unable to load banner settings");
  expect(
    screen.queryByRole("switch", { name: "Show Okou banner" }),
  ).not.toBeInTheDocument();
});

test.each([false, true])(
  "owners hide the default banner from the Site share settings (sidebar: %s)",
  async (sidebar) => {
    mockSiteAlias();
    const visibility: SiteVisibilityStatus = {
      siteId,
      visibility: "public",
      revision: null,
    };
    context.mocks.api(hostContract.siteVisibility, ({ respond }) => {
      return respond(200, visibility);
    });
    let banner = { siteId, showBanner: true, revision: null as string | null };
    context.mocks.api(hostContract.siteBanner, ({ respond }) => {
      return respond(200, banner);
    });
    context.mocks.api(hostContract.updateSiteBanner, ({ body, respond }) => {
      expect(body.expectedRevision).toBe(banner.revision);
      banner = {
        siteId,
        showBanner: body.showBanner,
        revision: crypto.randomUUID(),
      };
      return respond(200, banner);
    });
    await openSite({ sidebar });
    await openShare(sidebar ? "Share artifact" : "Share");
    const toggle = await screen.findByRole("switch", {
      name: "Show Okou banner",
    });
    expect(toggle).toBeChecked();
    click(toggle);
    await waitFor(() => {
      return expect(toggle).not.toBeChecked();
    });
    await screen.findByText("Banner updated");
    await expectPermission("Anyone with the link");
    click(toggle);
    await waitFor(() => {
      return expect(toggle).toBeChecked();
    });
  },
);

test("a stale banner edit preserves the last confirmed preference", async () => {
  mockSiteAlias();
  context.mocks.api(hostContract.siteVisibility, ({ respond }) => {
    return respond(200, { siteId, visibility: "public", revision: null });
  });
  const banner = { siteId, showBanner: true, revision: null };
  context.mocks.api(hostContract.siteBanner, ({ respond }) => {
    return respond(200, banner);
  });
  context.mocks.api(hostContract.updateSiteBanner, ({ respond }) => {
    return respond(409, {
      error: {
        code: "CONFLICT",
        message: "Website banner changed; reload before editing",
      },
    });
  });
  await openSite();
  await openShare();
  const toggle = await screen.findByRole("switch", {
    name: "Show Okou banner",
  });
  click(toggle);
  await screen.findByText("Website banner changed; reload before editing");
  await waitFor(() => {
    return expect(toggle).not.toHaveAttribute("aria-disabled", "true");
  });
  expect(toggle).toBeChecked();
});

function mockSiteAlias() {
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
}

function permission(name: string): HTMLElement {
  const row = queryAllByRoleFast("radio").find((element) => {
    return element.textContent?.trim() === name;
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

test.each([
  { sidebar: false, quickActions: false },
  { sidebar: true, quickActions: false },
  { sidebar: false, quickActions: true },
  { sidebar: true, quickActions: true },
])(
  "owners change website visibility (sidebar: $sidebar, quick actions: $quickActions)",
  async ({ sidebar, quickActions }) => {
    mockSiteAlias();
    let status: SiteVisibilityStatus = {
      siteId,
      visibility: "private",
      revision: null,
    };
    const temporary = `https://pv-${"c".repeat(48)}.okou.app/`;
    context.mocks.api(hostContract.sitePreview, ({ respond }) => {
      return respond(
        200,
        status.visibility === "public"
          ? { url: site.url, expiresAt: null }
          : { url: temporary, expiresAt: "2099-01-01T00:00:00Z" },
      );
    });
    const clipboard = context.mocks.browser.clipboardWriteText();
    context.mocks.api(hostContract.siteVisibility, ({ respond }) => {
      return respond(200, status);
    });
    context.mocks.api(
      hostContract.updateSiteVisibility,
      ({ body, respond }) => {
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
    await openSite({ sidebar, quickActions });
    await openShare(sidebar ? "Share artifact" : "Share");
    await expectPermission("Only me");
    const menu = await screen.findByRole("dialog", {
      name: sidebar ? "Share artifact" : "Share",
    });
    expect(getButtonByName("Customize URL", menu)).toBeInTheDocument();
    expect(within(menu).getByText("Who can access")).toBeInTheDocument();
    expect(clipboard.writes).toStrictEqual([]);
    click(getButtonByName("Copy link", menu));
    await waitFor(() => {
      expect(queryButtonByName("Copied", menu)).toBeDefined();
    });

    for (const name of [
      "Anyone at Default Org",
      "Anyone with the link",
      "Only me",
    ]) {
      click(permission(name));
      await expectPermission(name);
      await waitFor(() => {
        expect(
          screen
            .getByTestId(
              sidebar ? "artifact-sidebar" : "artifact-dialog-site-frame",
            )
            .querySelector("iframe"),
        ).toHaveAttribute(
          "src",
          name === "Anyone with the link" ? site.url : temporary,
        );
      });
      expect(
        getButtonByName(quickActions ? "Copied" : "Copy link", menu),
      ).toBeEnabled();
    }
    expect(clipboard.writes).toStrictEqual(
      Array.from({ length: quickActions ? 4 : 1 }, () => {
        return site.url;
      }),
    );
    click(getButtonByName(quickActions ? "Copied" : "Copy link", menu));
    await waitFor(() => {
      expect(clipboard.writes).toStrictEqual(
        Array.from({ length: quickActions ? 5 : 2 }, () => {
          return site.url;
        }),
      );
    });
  },
);

test("permissions preload without claiming public access while their read is pending", async () => {
  mockSiteAlias();
  const requested = createDeferredPromise<void>(context.signal);
  const response = createDeferredPromise<void>(context.signal);
  context.mocks.api(hostContract.siteVisibility, async ({ respond }) => {
    requested.resolve();
    await response.promise;
    return respond(200, { siteId, visibility: "private", revision: null });
  });
  await openSite();
  await requested.promise;
  await openShare();
  try {
    await screen.findByRole("status", { name: "Loading permissions" });
    expect(queryAllByRoleFast("radio")).toHaveLength(0);
    expect(screen.queryByText("Anyone with the link")).not.toBeInTheDocument();
  } finally {
    response.resolve();
  }
  await expectPermission("Only me");
});

test("Unavailable visibility settings keep permission choices disabled", async () => {
  mockSiteAlias();
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
  await screen.findByText("Unable to load permissions");
  for (const row of queryAllByRoleFast("radio")) {
    expect(row).toHaveAttribute("aria-checked", "false");
    expect(row).toBeDisabled();
  }
  expect(getButtonByName("Copy link")).toBeEnabled();
});

test("a conflicting permission change preserves the last confirmed audience", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  mockSiteAlias();
  let status: SiteVisibilityStatus = {
    siteId,
    visibility: "public",
    revision: null,
  };
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
  await openSite();
  await openShare();
  await expectPermission("Anyone with the link");
  status = {
    siteId,
    visibility: "organization",
    revision: crypto.randomUUID(),
  };
  click(permission("Only me"));
  await expect(
    screen.findByText("Website visibility changed"),
  ).resolves.toBeInTheDocument();
  await expectPermission("Anyone with the link");
  expect(clipboard.writes).toStrictEqual([]);
});

test("a failed visibility save preserves the last confirmed audience", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  mockSiteAlias();
  const status: SiteVisibilityStatus = {
    siteId,
    visibility: "private",
    revision: null,
  };
  context.mocks.api(hostContract.siteVisibility, ({ respond }) => {
    return respond(200, status);
  });
  context.mocks.api(hostContract.updateSiteVisibility, ({ respond }) => {
    return respond(500, {
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Website visibility save unavailable",
      },
    });
  });
  await openSite();
  await openShare();
  await expectPermission("Only me");
  click(permission("Anyone with the link"));
  await expect(
    screen.findByText("Website visibility save unavailable"),
  ).resolves.toBeInTheDocument();
  await expectPermission("Only me");
  expect(clipboard.writes).toStrictEqual([]);
});

test.each([false, true])(
  "Share directly copies non-owners' website links without a settings popover (sidebar: %s)",
  async (sidebar) => {
    mockSiteAlias();
    context.mocks.api(hostContract.siteUrl, ({ respond }) => {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Published website not found" },
      });
    });
    const clipboard = context.mocks.browser.clipboardWriteText();
    context.mocks.api(hostContract.siteVisibility, ({ respond }) => {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Published website not found" },
      });
    });
    await openSite({ sidebar });
    const label = sidebar ? "Share artifact" : "Share";
    click(getButtonByName(label));
    await screen.findByText("Link copied");
    expect(clipboard.writes).toStrictEqual([site.url]);
    expect(
      screen.queryByRole("dialog", { name: label }),
    ).not.toBeInTheDocument();
  },
);

test("a pending Share copies the link once permissions resolve without owner settings", async () => {
  mockSiteAlias();
  context.mocks.api(hostContract.siteUrl, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Published website not found" },
    });
  });
  const requested = createDeferredPromise<void>(context.signal);
  const response = createDeferredPromise<void>(context.signal);
  const clipboard = context.mocks.browser.clipboardWriteText();
  context.mocks.api(hostContract.siteVisibility, async ({ respond }) => {
    requested.resolve();
    await response.promise;
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Published website not found" },
    });
  });
  await openSite();
  await requested.promise;
  await openShare();
  await screen.findByRole("status", { name: "Loading permissions" });
  response.resolve();
  await screen.findByText("Link copied");
  expect(clipboard.writes).toStrictEqual([site.url]);
  expect(
    screen.queryByRole("dialog", { name: "Share" }),
  ).not.toBeInTheDocument();
});

test("rapid permission choices settle on the latest audience using the refreshed revision", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  mockSiteAlias();
  const requested = createDeferredPromise<void>(context.signal);
  const response = createDeferredPromise<void>(context.signal);
  let status: SiteVisibilityStatus = {
    siteId,
    visibility: "private",
    revision: null,
  };
  context.mocks.api(hostContract.siteVisibility, ({ respond }) => {
    return respond(200, status);
  });
  context.mocks.api(
    hostContract.updateSiteVisibility,
    async ({ body, respond }) => {
      if (!requested.settled()) {
        requested.resolve();
        await response.promise;
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
  await requested.promise;
  try {
    await waitFor(() => {
      expect(permission("Only me")).toHaveAttribute("aria-busy", "true");
    });
    click(permission("Anyone with the link"));
    click(permission("Only me"));
    expect(permission("Only me")).toHaveAttribute("aria-checked", "false");
  } finally {
    response.resolve();
  }
  await expectPermission("Only me");
  expect(getButtonByName("Copied")).toBeEnabled();
  expect(clipboard.writes).toStrictEqual([site.url, site.url]);
});

test.each([false, true])(
  "Share and Download open on hover and retain keyboard dismissal (sidebar: %s)",
  async (sidebar) => {
    const user = userEvent.setup();
    const clipboard = context.mocks.browser.clipboardWriteText();
    await openSite({ sidebar });
    const shareLabel = sidebar ? "Share artifact" : "Share";
    const share = getButtonByName(shareLabel);
    await user.hover(share);
    const menu = await screen.findByRole("dialog", { name: shareLabel });
    await user.hover(getButtonByName("Copy link", menu));
    expect(share).toHaveAttribute("aria-expanded", "true");
    expect(clipboard.writes).toStrictEqual([]);
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(share).toHaveAttribute("aria-expanded", "false");
    });
    expect(share).toBeInTheDocument();
    const download = getButtonByName(
      sidebar ? "Download artifact" : "Download options",
    );
    await user.hover(download);
    const downloadMenu = await screen.findByRole("menu");
    expect(within(downloadMenu).getByText("Download")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(download).toHaveAttribute("aria-expanded", "false");
    });
    // Keyboard users still open the same menu without a mouse.
    download.focus();
    await user.keyboard("{ArrowDown}");
    await screen.findByRole("menu");
  },
);

test("hovering Share while recipient access resolves never copies; clicking still does", async () => {
  const user = userEvent.setup();
  const clipboard = context.mocks.browser.clipboardWriteText();
  const response = createDeferredPromise<void>(context.signal);
  context.mocks.api(hostContract.siteUrl, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Published website not found" },
    });
  });
  context.mocks.api(hostContract.siteVisibility, async ({ respond }) => {
    await response.promise;
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Published website not found" },
    });
  });
  await openSite();
  const share = getButtonByName("Share");
  await user.hover(share);
  await screen.findByRole("status", { name: "Loading permissions" });
  response.resolve();
  await waitFor(() => {
    expect(share).toHaveAttribute("aria-expanded", "false");
  });
  expect(clipboard.writes).toStrictEqual([]);
  await user.click(share);
  await screen.findByText("Link copied");
  expect(clipboard.writes).toStrictEqual([site.url]);
});

test("a clipboard failure preserves the saved access and offers manual copy", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(
    new DOMException("Clipboard denied", "NotAllowedError"),
  );
  let status: SiteVisibilityStatus = {
    siteId,
    visibility: "private",
    revision: null,
  };
  context.mocks.api(hostContract.siteVisibility, ({ respond }) => {
    return respond(200, status);
  });
  context.mocks.api(hostContract.updateSiteVisibility, ({ body, respond }) => {
    status = {
      siteId,
      visibility: body.visibility,
      revision: crypto.randomUUID(),
    };
    return respond(200, status);
  });
  await openSite();
  await openShare();
  await expectPermission("Only me");
  click(permission("Anyone with the link"));
  await screen.findByText("Failed to copy link");
  await expectPermission("Anyone with the link");
  expect(queryButtonByName("Copied")).toBeUndefined();
  click(getButtonByName("Copy link"));
  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([site.url]);
  });
});
