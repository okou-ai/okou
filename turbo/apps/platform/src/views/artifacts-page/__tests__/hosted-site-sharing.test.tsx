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

async function openShare() {
  await waitFor(() => {
    expect(queryButtonByName("Share")).toBeDefined();
  });
  click(getButtonByName("Share"));
  await screen.findByText("Published");
}

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
    fireEvent.keyDown(input, {
      key: "Enter",
      isComposing: false,
      keyCode: 229,
    }),
  ).toBeFalsy();
  expect(input).toHaveValue("launch-report");
  click(getButtonByName("Save"));
  await screen.findByText("Website URL updated");
  await screen.findByText("launch-report.okou.app");
  expect(getButtonByName("Customize URL")).toHaveFocus();
  await waitFor(() => {
    expect(
      screen.getByTestId("artifact-dialog-site-frame").querySelector("iframe"),
    ).toHaveAttribute("src", "https://launch-report.okou.app/");
  });
  const clipboard = context.mocks.browser.clipboardWriteText();
  click(getButtonByName("Copy link"));
  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual(["https://launch-report.okou.app"]);
  });
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
  expect(getButtonByName("Save")).toBeDisabled();
  click(getButtonByName("Cancel"));
  expect(screen.getByText("weekly-report.okou.app")).toBeInTheDocument();
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
  expect(screen.getByText("weekly-report.okou.app")).toBeInTheDocument();
});

test("other people's sites offer Published and copying without URL editing", async () => {
  context.mocks.api(hostContract.siteUrl, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Website not found" },
    });
  });
  await openSite();
  await openShare();
  await screen.findByText("weekly-report.okou.app");
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
