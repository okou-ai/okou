// @vitest-environment-options {"url":"https://app.okou.ai/","settings":{"disableIframePageLoading":true,"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { queryFastControl } from "../../okou-page/__tests__/chat-message-experience-test-helpers.ts";
import { screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { openSharing, stable, temporary } from "./site-access-fixtures.ts";
import { posthog } from "posthog-js/dist/module.slim";

const context = testContext();

const publicChoice = "Anyone with the link";
const privateChoice = "Only me";
const orgChoice = "Anyone at Default Org";
async function preview(url: string) {
  await waitFor(() => {
    return expect(document.querySelector("iframe")?.src).toBe(url);
  });
}
test("hosted-site-sharing-026 The sidebar retains the private owner preview across audience changes and copies the permanent address", async () => {
  const { button, menu, clipboard } = await openSharing(context, {
    audience: "private",
  });
  await preview(temporary);
  for (const name of [orgChoice, publicChoice, privateChoice]) {
    const radio = await menu.findByRole("radio", { name });
    click(radio);
    await waitFor(() => {
      return expect(radio).toBeChecked();
    });
    await preview(temporary);
  }
  const copy = await button("Copy link");
  expect(copy).toBeEnabled();
  click(copy);
  await button("Copied");
  expect(clipboard.writes).toStrictEqual([stable]);
});
test.each(["private", "public"] as const)(
  "hosted-site-sharing-027 An owner who opens a %s site can still share and copy after changing its audience",
  async (initial) => {
    const { button, menu, clipboard } = await openSharing(context, {
      audience: initial,
      preserveTemporaryPreview: true,
    });
    await preview(temporary);
    const previous = await menu.findByRole("radio", {
      name: initial === "public" ? publicChoice : privateChoice,
    });
    expect(previous).toBeChecked();
    const changed = await menu.findByRole("radio", {
      name: initial === "public" ? privateChoice : publicChoice,
    });
    click(changed);
    await waitFor(() => {
      return expect(changed).toBeChecked();
    });
    expect(queryFastControl("button", "Share artifact")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await preview(temporary);
    const copy = await button("Copy link");
    expect(copy).toBeEnabled();
    click(copy);
    await button("Copied");
    expect(clipboard.writes).toStrictEqual([stable]);
  },
);

test("Sharing stays unavailable until the private audience is known", async () => {
  const release = context.mocks.deferred<void>();
  const opening = openSharing(context, {
    audience: "private",
    visibilityRead: release.promise,
  });
  await screen.findByTestId("artifact-sidebar");
  expect(screen.queryByRole("dialog", { name: "Share artifact" })).toBeNull();
  expect(queryFastControl("button", "Share artifact")).toBeNull();
  release.resolve();
  const { menu } = await opening;
  await expect(
    menu.findByRole("radio", { name: privateChoice }),
  ).resolves.toBeChecked();
});
test("hosted-site-sharing-034 Forbidden permission settings disable every audience while keeping Copy available", async () => {
  const { button, menu } = await openSharing(context, { denyVisibility: true });
  await menu.findByText("Unable to load permissions");
  for (const name of [privateChoice, orgChoice, publicChoice]) {
    const audience = menu.getByRole("radio", { name });
    expect(audience).toBeDisabled();
    expect(audience).not.toBeChecked();
  }
  await expect(button("Copy link")).resolves.toBeEnabled();
});
test("hosted-site-sharing-035 A conflicting private edit preserves the confirmed public audience", async () => {
  const { menu, moveToOrg } = await openSharing(context);
  const old = await menu.findByRole("radio", { name: publicChoice });
  expect(old).toBeChecked();
  moveToOrg();
  click(menu.getByRole("radio", { name: privateChoice }));
  await screen.findByText("Another editor changed the audience");
  await waitFor(() => {
    return expect(old).toBeChecked();
  });
  expect(menu.getByRole("radio", { name: privateChoice })).not.toBeChecked();
});
test("hosted-site-sharing-040 Three rapid choices finish on Only me after the pending save settles", async () => {
  const held = context.mocks.deferred<void>(),
    release = context.mocks.deferred<void>();
  const { button, menu } = await openSharing(context, {
    audience: "private",
    beforeWrite: async (choice) => {
      if (choice === "organization") {
        held.resolve();
        await release.promise;
      }
    },
  });
  const initial = await menu.findByRole("radio", { name: privateChoice });
  expect(initial).toBeChecked();
  click(menu.getByRole("radio", { name: orgChoice }));
  await held.promise;
  const group = menu.getByRole("radiogroup");
  expect(group).toHaveAttribute("aria-busy", "true");
  click(menu.getByRole("radio", { name: publicChoice }));
  click(initial);
  release.resolve();
  await waitFor(() => {
    return expect(group).toHaveAttribute("aria-busy", "false");
  });
  expect(initial).toBeChecked();
  await expect(button("Copy link")).resolves.toBeEnabled();
});

const confirmed = {
  name: "artifact_action_clicked",
  properties: {
    action: "banner_share",
    surface: "sidebar",
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
