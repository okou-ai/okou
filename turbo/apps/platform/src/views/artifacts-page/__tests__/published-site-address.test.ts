import {
  findFastControl,
  queryFastControl,
} from "../../okou-page/__tests__/chat-message-experience-test-helpers.ts";
import {
  getButtonByName,
  artifact,
  findArtifactAction,
} from "./artifact-catalog-test-helpers.ts";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { hostedSiteArtifactDetail } from "../../okou-page/__tests__/chat-navigation-artifact-test-helpers.ts";

const context = testContext();
const siteId = "947bde62-1f8c-4879-a5db-ab15dbe67f8d";
const link = (slug: string) => {
  return `https://${slug}.sites.vm7.io`;
};
async function openSite(
  options: {
    gate?: Promise<void>;
    bannerGate?: Promise<void>;
    failRead?: boolean;
    rejectSave?: 409 | 500;
    failCheckName?: string;
  } = {},
) {
  const published = artifact({ kind: "hosted-site", title: "Planning board" });
  const last = options.gate ? "previous-board" : "planning-board";
  const current = "planning-board";
  const data = hostedSiteArtifactDetail(published, {
    siteId,
    slug: last,
    url: link(last),
  });
  const clipboard = context.mocks.browser.clipboardWriteText();
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [published], nextCursor: null });
  });
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    return respond(200, data);
  });
  context.mocks.api(hostContract.siteUrl, async ({ respond }) => {
    await options.gate;
    if (options.failRead) {
      throw new Error("Unavailable site origin");
    }
    return respond(200, {
      siteId,
      publicSlug: current,
      url: link(current),
      isActive: true,
    });
  });
  context.mocks.api(hostContract.siteVisibility, ({ respond }) => {
    return respond(200, { siteId, visibility: "public", revision: null });
  });
  context.mocks.api(hostContract.siteBanner, async ({ respond }) => {
    await options.bannerGate;
    return respond(200, { siteId, showBanner: false, revision: null });
  });
  context.mocks.api(hostContract.siteUrlAvailability, ({ query, respond }) => {
    return query.publicSlug === options.failCheckName
      ? respond(400, {
          error: { code: "CHECK_FAILED", message: "Check unavailable" },
        })
      : respond(200, { available: true });
  });
  context.mocks.api(hostContract.updateSiteUrl, ({ body, respond }) => {
    if (options.rejectSave === 409) {
      return respond(409, { error: { code: "CONFLICT", message: "Conflict" } });
    }
    if (options.rejectSave) {
      throw new Error("Publication service unavailable");
    }
    return respond(200, {
      siteId,
      publicSlug: body.publicSlug,
      url: link(body.publicSlug),
      isActive: true,
    });
  });
  await setupPage({
    context,
    path: "/artifacts",
    featureSwitches: { [FeatureSwitchKey.HostedSiteShareRows]: true },
  });
  click(await findArtifactAction("Planning board"));
  click(await findFastControl("button", "Share"));
  return clipboard;
}
const shareDialog = () => {
  return screen.getByRole("dialog", { name: "Share" });
};
const menu = () => {
  return within(screen.getByRole("dialog", { name: "Share" }));
};
const button = (name: string) => {
  return getButtonByName(name, shareDialog());
};
function currentAddressRow() {
  return waitFor(() => {
    const row = getButtonByName("Customize URL", shareDialog());
    expect(row).toHaveTextContent("planning-board.sites.vm7.io");
    return row;
  });
}
async function customize() {
  click(await currentAddressRow());
  return screen.findByRole("textbox");
}
async function verifyCopy(writes: readonly string[], url: string) {
  click(button("Copy link"));
  await waitFor(() => {
    return expect(writes).toStrictEqual([url]);
  });
}
test("hosted-site-sharing-001 Copy waits for the current published address and ignores the stale preview address", async () => {
  const gate = context.mocks.deferred<void>();
  const clip = await openSite({ gate: gate.promise });
  expect(queryFastControl("button", "Copy link", shareDialog())).toBeNull();
  await waitFor(() => {
    expect(shareDialog().querySelector('[aria-busy="true"]')).toBeVisible();
  });
  expect(queryFastControl("button", "Customize URL", shareDialog())).toBeNull();
  gate.resolve();
  await waitFor(() => {
    return expect(button("Copy link")).toBeEnabled();
  });
  await verifyCopy(clip.writes, link("planning-board"));
});
test("hosted-site-sharing-010 The share row and clipboard both expose the current site URL before editing", async () => {
  const clip = await openSite();
  const row = await currentAddressRow();
  await waitFor(() => {
    return expect(row).toHaveTextContent(/planning-board/);
  });
  await verifyCopy(clip.writes, link("planning-board"));
  click(row);
  await expect(screen.findByRole("textbox")).resolves.toHaveValue(
    "planning-board",
  );
});
test("hosted-site-sharing-011 Unavailable site settings disable copying and hide address customization", async () => {
  await openSite({ failRead: true });
  await screen.findByText("Could not load website settings");
  expect(button("Copy link")).toBeDisabled();
  expect(queryFastControl("button", /Customize URL/)).toBeNull();
});
test("hosted-site-sharing-008 An address check error keeps Save disabled until a revised address is available", async () => {
  await openSite({ failCheckName: "first-attempt" });
  const input = await customize();
  await fill(input, "first-attempt");
  await screen.findByText("Could not check this address.");
  expect(button("Save")).toBeDisabled();
  await fill(input, "second-attempt");
  await screen.findByText("Available");
  expect(button("Save")).toBeEnabled();
});
test("hosted-site-sharing-007 Cancelling a conflicting address change keeps the original copy destination", async () => {
  const clip = await openSite({ rejectSave: 409 });
  const input = await customize();
  await fill(input, "conflicting-title");
  await screen.findByText("Available");
  click(button("Save"));
  await screen.findByText(
    "Could not save. The address may be taken or changed.",
  );
  expect(input).toHaveValue("conflicting-title");
  click(button("Cancel"));
  await verifyCopy(clip.writes, link("planning-board"));
});
test("hosted-site-sharing-002 Saving the validated address updates the preview without copying until requested", async () => {
  const clip = await openSite();
  const input = await customize();
  await fill(input, "launch-report");
  await screen.findByText("Available");
  expect(screen.getByText(/The old URL will stop working/)).toBeVisible();
  click(button("Save"));
  await screen.findByText("Website URL updated");
  await waitFor(() => {
    return expect(document.querySelector("iframe")?.src).toContain(
      "launch-report.sites.vm7.io",
    );
  });
  expect(clip.writes).toStrictEqual([]);
  await verifyCopy(clip.writes, link("launch-report"));
});

test("hosted-site-sharing-009 A failed save keeps the validated name editable and the original preview visible", async () => {
  await openSite({ rejectSave: 500 });
  const input = await customize();
  await fill(input, "summer-report");
  await screen.findByText("Available");
  click(button("Save"));
  await screen.findByText(
    "Could not save. The address may be taken or changed.",
  );
  expect(input).toHaveValue("summer-report");
  expect(button("Save")).toBeEnabled();
  expect(document.querySelector("iframe")?.src).toContain(
    "planning-board.sites.vm7.io",
  );
});
test("hosted-site-sharing-015 The dialog allows copying while banner preferences are still loading", async () => {
  const gate = context.mocks.deferred<void>();
  const clip = await openSite({ bannerGate: gate.promise });
  await currentAddressRow();
  expect(getButtonByName("Close")).toBeVisible();
  expect(getButtonByName("Share")).toBeVisible();
  expect(menu().queryByRole("status", { name: /loading/i })).toBeNull();
  await verifyCopy(clip.writes, link("planning-board"));
  gate.resolve();
  const banner = await menu().findByRole("switch", {
    name: "Show Okou banner",
  });
  expect(banner).not.toBeChecked();
});
