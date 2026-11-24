// @vitest-environment-options {"url":"https://app.okou.ai/","settings":{"disableIframePageLoading":true,"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { queryFastControl } from "../../okou-page/__tests__/chat-message-experience-test-helpers.ts";
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
