// @vitest-environment-options {"url":"https://app.okou.ai/","settings":{"disableIframePageLoading":true,"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { screen, waitFor } from "@testing-library/react";
import { posthog } from "posthog-js/dist/module.slim";
import { expect, test, vi } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { openSharing, stable } from "./site-access-fixtures.ts";

const context = testContext();
const confirmed = {
  name: "artifact_action_clicked",
  properties: {
    action: "banner_share",
    surface: "dialog",
    target: "hosted_site",
    show_banner: true,
  },
} as const;
test("hosted-site-sharing-004 A free workspace keeps its banner when hiding it opens the plan chooser", async () => {
  const site = await openSharing(context, { free: true });
  const banner = await site.menu.findByRole("switch", {
    name: "Show Okou banner",
  });
  expect(banner).toBeChecked();
  click(banner);
  await expect(
    screen.findByRole("dialog", { name: "Choose a plan" }),
  ).resolves.toBeVisible();
  expect(banner).toBeChecked();
  expect(site.banner()).toBeTruthy();
});
test("hosted-site-sharing-014 The clipboard gets the public site and analytics retains an unknown banner preference", async () => {
  const { button, menu, clipboard, analytics } = await openSharing(context, {
    denyBanner: true,
  });
  await menu.findByText("Unable to load banner settings");
  expect(menu.queryByRole("switch")).toBeNull();
  click(await button("Copy link"));
  await button("Copied");
  expect(clipboard.writes).toStrictEqual([stable]);
  expect(analytics.events).toContainEqual(
    expect.objectContaining({
      ...confirmed,
      properties: { ...confirmed.properties, show_banner: "unknown" },
    }),
  );
  expect(menu.getByText("Unable to load banner settings")).toBeVisible();
});
test("hosted-site-sharing-018 A denied clipboard write reports failure and records the confirmed banner preference", async () => {
  const { button, menu, analytics } = await openSharing(context);
  await expect(menu.findByRole("switch")).resolves.toBeChecked();
  vi.mocked(navigator.clipboard.writeText).mockRejectedValue(
    new Error("Clipboard denied"),
  );
  const copy = await button("Copy link");
  click(copy);
  await expect(screen.findByText("Failed to copy link")).resolves.toBeVisible();
  expect(copy).toBeEnabled();
  expect(analytics.events).toContainEqual(expect.objectContaining(confirmed));
});
test("hosted-site-sharing-019 Copy confirmation survives a failing analytics SDK", async () => {
  const { button, clipboard } = await openSharing(context);
  const error = new Error("Analytics temporarily unavailable");
  const attempted = context.mocks.deferred<void>();
  vi.mocked(posthog.capture).mockImplementation((event) => {
    if (event === "artifact_action_clicked") {
      attempted.resolve();
      throw error;
    }
    return undefined;
  });
  const report = (event: ErrorEvent) => {
    if (event.error === error) {
      event.preventDefault();
    }
  };
  window.addEventListener("error", report);
  try {
    click(await button("Copy link"));
    await attempted.promise;
    await expect(button("Copied")).resolves.toBeVisible();
    expect(clipboard.writes).toStrictEqual([stable]);
  } finally {
    window.removeEventListener("error", report);
  }
});
test("hosted-site-sharing-024 A conflicting banner edit keeps the confirmed on preference for the next copy", async () => {
  const { button, menu, clipboard, analytics, replaceBannerRevision } =
    await openSharing(context);
  const toggle = await menu.findByRole("switch");
  expect(toggle).toBeChecked();
  replaceBannerRevision();
  click(toggle);
  await screen.findByText("Another editor changed the banner");
  await waitFor(() => {
    return expect(toggle).toBeEnabled();
  });
  expect(toggle).toBeChecked();
  click(await button("Copy link"));
  await button("Copied");
  expect(clipboard.writes).toStrictEqual([stable]);
  expect(analytics.events).toContainEqual(expect.objectContaining(confirmed));
});
