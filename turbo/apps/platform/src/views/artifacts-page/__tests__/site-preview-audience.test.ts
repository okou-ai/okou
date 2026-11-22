// @vitest-environment-options {"url":"https://app.okou.ai/","settings":{"disableIframePageLoading":true,"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { openSharing, stable, temporary } from "./site-access-fixtures.ts";
const context = testContext();
const publicChoice = "Anyone with the link";
const privateChoice = "Only me";
const orgChoice = "Anyone at Default Org";
async function preview(url: string) {
  await waitFor(() => {
    return expect(document.querySelector("iframe")?.src).toBe(url);
  });
}
const layouts = [
  { id: "hosted-site-sharing-025", layout: "dialog", sidebar: false },
  { id: "hosted-site-sharing-026", layout: "sidebar", sidebar: true },
] as const;
test.each(layouts)(
  "$id The $layout preview follows audience changes and copies the permanent site address",
  async ({ sidebar }) => {
    const { button, menu, clipboard } = await openSharing(context, {
      audience: "private",
      sidebar,
    });
    await preview(temporary);
    for (const [name, url] of [
      [orgChoice, temporary],
      [publicChoice, stable],
      [privateChoice, temporary],
    ] as const) {
      const radio = await menu.findByRole("radio", { name });
      click(radio);
      await waitFor(() => {
        return expect(radio).toBeChecked();
      });
      await preview(url);
    }
    const copy = await button("Copy link");
    expect(copy).toBeEnabled();
    click(copy);
    await button("Copied");
    expect(clipboard.writes).toStrictEqual([stable]);
  },
);
test("hosted-site-sharing-027 Share and Copy remain usable throughout a held preview refresh", async () => {
  const refreshing = context.mocks.deferred<void>(),
    release = context.mocks.deferred<void>();
  const { button, menu, trigger, dialog, clipboard } = await openSharing(
    context,
    {
      audience: "private",
      refreshPreview: () => {
        refreshing.resolve();
        return release.promise;
      },
    },
  );
  await preview(temporary);
  click(await menu.findByRole("radio", { name: publicChoice }));
  await refreshing.promise;
  expect(trigger).toBeVisible();
  expect(dialog).toBeVisible();
  await expect(button("Copy link")).resolves.toBeEnabled();
  release.resolve();
  await preview(stable);
  click(await button("Copy link"));
  await button("Copied");
  expect(clipboard.writes).toStrictEqual([stable]);
});
test("hosted-site-sharing-033 Pending permissions expose no audience until Only me is confirmed", async () => {
  const release = context.mocks.deferred<void>();
  const { menu } = await openSharing(context, {
    audience: "private",
    visibilityRead: release.promise,
  });
  await expect(
    menu.findByRole("status", { name: "Loading permissions" }),
  ).resolves.toBeVisible();
  expect(menu.queryAllByRole("radio")).toHaveLength(0);
  expect(menu.queryByText(publicChoice)).toBeNull();
  release.resolve();
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
