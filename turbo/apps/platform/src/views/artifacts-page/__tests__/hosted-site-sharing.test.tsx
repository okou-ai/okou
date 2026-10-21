import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
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

async function openSite(enabled = true) {
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
    featureSwitches: { [FeatureSwitchKey.HostedSiteUrlEditing]: enabled },
  });
  click(await findArtifactAction("Weekly report"));
  await screen.findByTestId("artifact-dialog-site-frame");
}

// The published address is the share menu's title link.
function siteAddress(address: string): HTMLElement | undefined {
  return queryAllByRoleFast("link").find((link) => {
    return link.textContent?.trim() === address;
  });
}

async function openShare() {
  await waitFor(() => {
    expect(queryButtonByName("Share")).toBeDefined();
  });
  click(getButtonByName("Share"));
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
  await openSite(false);
  const share = queryAllByRoleFast("link").find((element) => {
    return element.getAttribute("aria-label") === "Share";
  });
  expect(share).toHaveAttribute("href", site.url);
  expect(queryButtonByName("Customize URL")).toBeUndefined();
});
