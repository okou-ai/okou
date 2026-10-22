import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import type { hostedSiteVisibilityStatusSchema } from "@okouai/api-contracts/contracts/hosted-site-access";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import type { z } from "zod";
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

async function openSite({
  urlEditing = true,
  visibility = false,
  sidebar = false,
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
      [FeatureSwitchKey.HostedSiteUrlEditing]: urlEditing,
      [FeatureSwitchKey.HostedSiteVisibility]: visibility,
      [FeatureSwitchKey.ArtifactSidebarPreview]: sidebar,
    },
  });
  click(await findArtifactAction("Weekly report"));
  await screen.findByTestId(
    sidebar ? "artifact-sidebar" : "artifact-dialog-site-frame",
  );
}

// The published address is the share menu's title link.
function siteAddress(address: string): HTMLElement | undefined {
  return queryAllByRoleFast("link").find((link) => {
    return link.textContent?.trim() === address;
  });
}

async function openShare(label = "Share") {
  await waitFor(() => {
    expect(queryButtonByName(label)).toBeDefined();
  });
  click(getButtonByName(label));
  await screen.findByText("Published");
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
    expect(queryAllByRoleFast("button", menu)).toHaveLength(0);
  } finally {
    response.resolve();
  }

  await waitFor(() => {
    expect(siteAddress("current-report.okou.app")).toBeInTheDocument();
  });
  expect(getButtonByName("Copy link")).toBeEnabled();
  click(getButtonByName("Copy link"));
  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([currentSite.url]);
  });
});

test("published sites customize their address in Share and copy the saved URL without permission choices", async () => {
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
  await openSite();
  await openShare();
  expect(queryAllByRoleFast("radio")).toHaveLength(0);
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
  click(getButtonByName("Save"));
  await screen.findByText("Website URL updated");
  await waitFor(() => {
    expect(siteAddress("launch-report.okou.app")).toHaveAttribute(
      "href",
      "https://launch-report.okou.app",
    );
  });
  expect(siteAddress("launch-report.okou.app")).toHaveAttribute(
    "target",
    "_blank",
  );
  expect(getButtonByName("Customize URL")).toHaveFocus();
  await waitFor(() => {
    expect(
      screen.getByTestId("artifact-dialog-site-frame").querySelector("iframe"),
    ).toHaveAttribute("src", "https://launch-report.okou.app/");
  });
  const clipboard = context.mocks.browser.clipboardWriteText();
  click(getButtonByName("Copy link"));
  await waitFor(() => {
    expect(queryButtonByName("Copied")).toBeDefined();
  });
  expect(clipboard.writes).toStrictEqual(["https://launch-report.okou.app"]);
});

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
  expect(siteAddress("weekly-report.okou.app")).toBeInTheDocument();
  expect(screen.queryByLabelText("Website URL")).not.toBeInTheDocument();
  expect(getButtonByName("Customize URL")).toHaveFocus();
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
  click(getButtonByName("Save"));
  await screen.findByText(/Could not save/);
  expect(screen.getByLabelText("Website URL")).toHaveValue("taken-report");
  click(getButtonByName("Cancel"));
  expect(siteAddress("weekly-report.okou.app")).toBeInTheDocument();
});

test("an unavailable address check disables saving and a new draft can retry", async () => {
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
  await screen.findByText(
    "Could not check this address. Edit it to try again.",
  );
  expect(getButtonByName("Save")).toBeDisabled();
  expect(input).toHaveValue("launch-report");
  unavailable = false;
  await fill(input, "launch-report-retry");
  await screen.findByText("Available");
  expect(getButtonByName("Save")).toBeEnabled();
});

test("a failed save retains the draft and can retry without replacing the current address", async () => {
  let unavailable = true;
  context.mocks.api(hostContract.siteUrl, ({ respond }) => {
    return respond(200, site);
  });
  context.mocks.api(hostContract.siteUrlAvailability, ({ respond }) => {
    return respond(200, { available: true });
  });
  context.mocks.api(hostContract.updateSiteUrl, ({ body, respond }) => {
    return unavailable
      ? respond(500, {
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Website save unavailable",
          },
        })
      : respond(200, {
          ...site,
          publicSlug: body.publicSlug,
          url: `https://${body.publicSlug}.okou.app`,
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
  click(getButtonByName("Save"));
  await screen.findByText("Website save unavailable");
  await screen.findByText(/Could not save/);
  expect(screen.getByLabelText("Website URL")).toHaveValue("launch-report");
  expect(getButtonByName("Save")).toBeEnabled();
  expect(
    screen.getByTestId("artifact-dialog-site-frame").querySelector("iframe"),
  ).toHaveAttribute("src", site.url);
  unavailable = false;
  click(getButtonByName("Save"));
  await screen.findByText("Website URL updated");
  await waitFor(() => {
    expect(siteAddress("launch-report.okou.app")).toBeInTheDocument();
  });
});

test("a settings failure disables copying until Retry resolves the current address", async () => {
  let unavailable = true;
  const clipboard = context.mocks.browser.clipboardWriteText();
  context.mocks.api(hostContract.siteUrl, ({ respond }) => {
    return unavailable
      ? respond(500, {
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Website settings unavailable",
          },
        })
      : respond(200, site);
  });
  await openSite();
  await openShare();
  await screen.findByText("Could not load website settings");
  expect(getButtonByName("Copy link")).toBeDisabled();
  expect(queryButtonByName("Customize URL")).toBeUndefined();
  unavailable = false;
  click(getButtonByName("Retry"));
  await waitFor(() => {
    expect(siteAddress("weekly-report.okou.app")).toBeInTheDocument();
  });
  expect(getButtonByName("Copy link")).toBeEnabled();
  click(getButtonByName("Copy link"));
  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([site.url]);
  });
});

test("other people's sites offer Published and copying without URL editing", async () => {
  context.mocks.api(hostContract.siteUrl, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Website not found" },
    });
  });
  await openSite();
  await openShare();
  await waitFor(() => {
    expect(siteAddress("weekly-report.okou.app")).toBeInTheDocument();
  });
  expect(queryButtonByName("Customize URL")).toBeUndefined();
  expect(queryAllByRoleFast("radio")).toHaveLength(0);
});

test("the disabled switch retains the existing share link", async () => {
  await openSite({ urlEditing: false });
  const share = queryAllByRoleFast("link").find((element) => {
    return element.getAttribute("aria-label") === "Share";
  });
  expect(share).toHaveAttribute("href", site.url);
  expect(queryButtonByName("Customize URL")).toBeUndefined();
});

type SiteVisibilityStatus = z.infer<typeof hostedSiteVisibilityStatusSchema>;

function mockSiteAlias() {
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
  { sidebar: false, urlEditing: false },
  { sidebar: true, urlEditing: false },
  { sidebar: false, urlEditing: true },
])(
  "owners change website visibility in the preview ($sidebar sidebar, $urlEditing URL editing)",
  async ({ sidebar, urlEditing }) => {
    mockSiteAlias();
    if (urlEditing) {
      context.mocks.api(hostContract.siteUrl, ({ respond }) => {
        return respond(200, site);
      });
    }
    let status: SiteVisibilityStatus = {
      siteId,
      visibility: "private",
      revision: null,
    };
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
    await openSite({ urlEditing, visibility: true, sidebar });
    await openShare(sidebar ? "Share artifact" : "Share");
    await expectPermission("Only me");
    const menu = await screen.findByRole("dialog", {
      name: sidebar ? "Share artifact" : "Share",
    });
    expect(!!queryButtonByName("Customize URL", menu)).toBe(urlEditing);
    expect(siteAddress("weekly-report.okou.app")).toBeInTheDocument();
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
      expect(getButtonByName("Copy link", menu)).toBeEnabled();
    }
    expect(clipboard.writes).toStrictEqual([site.url]);
    click(getButtonByName("Copy link", menu));
    await waitFor(() => {
      expect(clipboard.writes).toStrictEqual([site.url, site.url]);
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
  await openSite({ urlEditing: false, visibility: true });
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

test("a closed server rollout leaves permissions unavailable until Retry succeeds", async () => {
  mockSiteAlias();
  let unavailable = true;
  context.mocks.api(hostContract.siteVisibility, ({ respond }) => {
    return unavailable
      ? respond(403, {
          error: {
            code: "FORBIDDEN",
            message: "Website visibility management is not available",
          },
        })
      : respond(200, {
          siteId,
          visibility: "organization",
          revision: crypto.randomUUID(),
        });
  });
  await openSite({ urlEditing: false, visibility: true });
  await openShare();
  await screen.findByText("Unable to load permissions");
  for (const row of queryAllByRoleFast("radio")) {
    expect(row).toHaveAttribute("aria-checked", "false");
    expect(row).toBeDisabled();
  }
  expect(getButtonByName("Copy link")).toBeEnabled();
  unavailable = false;
  click(getButtonByName("Retry"));
  await expectPermission("Anyone at Default Org");
});

test("a conflicting change reloads the current revision before the owner retries", async () => {
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
  await openSite({ urlEditing: false, visibility: true });
  await openShare();
  await expectPermission("Anyone with the link");
  status = {
    siteId,
    visibility: "organization",
    revision: crypto.randomUUID(),
  };
  click(permission("Only me"));
  await screen.findByText("Website visibility changed");
  await expectPermission("Anyone at Default Org");
  click(permission("Only me"));
  await expectPermission("Only me");
  await expect(
    screen.findByText("Access updated"),
  ).resolves.toBeInTheDocument();
});

test("a failed visibility save restores the server audience and can be retried", async () => {
  mockSiteAlias();
  let unavailable = true;
  let status: SiteVisibilityStatus = {
    siteId,
    visibility: "private",
    revision: null,
  };
  context.mocks.api(hostContract.siteVisibility, ({ respond }) => {
    return respond(200, status);
  });
  context.mocks.api(hostContract.updateSiteVisibility, ({ body, respond }) => {
    if (unavailable) {
      return respond(500, {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Website visibility save unavailable",
        },
      });
    }
    status = {
      siteId,
      visibility: body.visibility,
      revision: crypto.randomUUID(),
    };
    return respond(200, status);
  });
  await openSite({ urlEditing: false, visibility: true });
  await openShare();
  await expectPermission("Only me");
  click(permission("Anyone with the link"));
  await screen.findByText("Website visibility save unavailable");
  await expectPermission("Only me");
  unavailable = false;
  click(permission("Anyone with the link"));
  await expectPermission("Anyone with the link");
  await expect(
    screen.findByText("Access updated"),
  ).resolves.toBeInTheDocument();
});

test("non-owners can copy a website link without permission controls", async () => {
  mockSiteAlias();
  const clipboard = context.mocks.browser.clipboardWriteText();
  context.mocks.api(hostContract.siteVisibility, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Published website not found" },
    });
  });
  await openSite({ urlEditing: false, visibility: true });
  await openShare();
  const menu = await screen.findByRole("dialog", { name: "Share" });
  await waitFor(() => {
    expect(within(menu).queryByText("Who can access")).not.toBeInTheDocument();
  });
  expect(queryAllByRoleFast("radio", menu)).toHaveLength(0);
  click(getButtonByName("Copy link", menu));
  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([site.url]);
  });
});

test("rapid permission choices settle on the latest audience using the refreshed revision", async () => {
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
  await openSite({ urlEditing: false, visibility: true });
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
  await screen.findByText("Access updated");
});
