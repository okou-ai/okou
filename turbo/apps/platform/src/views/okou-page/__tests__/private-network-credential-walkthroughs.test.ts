import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  click,
  fill,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { mockRemoteInventory } from "./connectors-remote-control-test-helpers.ts";
const context = testContext(),
  base = "/connectors?scope=private-network";
const button = (name: string | RegExp, box?: HTMLElement) => {
  return findFastControl("button", name, box);
};
async function press(name: string | RegExp, box?: HTMLElement) {
  click(await button(name, box));
}
function field(label: string) {
  return screen.getByLabelText(label, { selector: "input" });
}
const escape = () => {
  return userEvent.setup({ delay: null }).keyboard("{Escape}");
};
async function add(provider: "tailscale" | "cloudflare") {
  mockRemoteInventory(context);
  await setupPage({ context, path: base + "&network=add" });
  await press(provider === "tailscale" ? /Tailscale/ : /Cloudflare/);
  const first = await screen.findByRole("dialog");
  await press("Enter existing credentials", first);
  await screen.findByLabelText("Network name");
}
async function reopen() {
  await press("How do I get connection credentials?");
  return await screen.findByRole("dialog");
}
test("remote-control-guided-setup-111 The three Cloudflare steps and dashboard link can be revisited without losing the secret draft", async () => {
  await add("cloudflare");
  await fill(field("Network name"), "Service network");
  const secret = field("Client Secret");
  await fill(secret, "local-cf-secret");
  let dialog = await reopen();
  expect(within(dialog).getByText("1 / 3")).toBeVisible();
  await expect(
    findFastControl("link", "Open Cloudflare dashboard", dialog),
  ).resolves.toHaveAttribute(
    "href",
    expect.stringContaining("dash.cloudflare.com"),
  );
  await press("Continue", dialog);
  await within(dialog).findByText("Allow access to the target application");
  await escape();
  expect(secret).toHaveValue("local-cf-secret");
  dialog = await reopen();
  await within(dialog).findByText("2 / 3");
  await press("Previous", dialog);
  await within(dialog).findByText("Create a Service Token");
  await press("Continue", dialog);
  await press("Continue", dialog);
  await within(dialog).findByText("Enter connection credentials");
  await press("Return to form", dialog);
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(field("Network name")).toHaveValue("Service network");
  expect(secret).toHaveValue("local-cf-secret");
  const wrapper = secret.parentElement!;
  await press("Show entered value", wrapper);
  expect(secret).toHaveAttribute("type", "text");
  await press("Hide entered value", wrapper);
  expect(secret).toHaveAttribute("type", "password");
  await expect(button("Save network")).resolves.toBeVisible();
});
test("remote-control-guided-setup-112 The Tailscale guide copies the drafted tags and Write permission and preserves the network draft", async () => {
  await add("tailscale");
  const tags = "tag:studio, tag:design";
  await fill(field("Network name"), "Design network");
  await fill(field("Allowed tags"), tags);
  await fill(field("Client Secret"), "local-ts-secret");
  let guide = await reopen();
  await press("Installed, continue", guide);
  await press("Continue", guide);
  await within(guide).findByText("Set permissions and tags");
  const value = await within(guide).findByText(tags);
  expect(value).toBeVisible();
  const clipboard = context.mocks.browser.clipboardWriteText();
  await press("Copy Tags", guide);
  await waitFor(() => {
    return expect(clipboard.writes).toContain(tags);
  });
  await press(/Copy Keys|Copy Permissions|Copy Action/, guide);
  await waitFor(() => {
    return expect(clipboard.writes).toContainEqual(
      expect.stringContaining("Write"),
    );
  });
  click(await within(guide).findByText(/Can.t find the tag/));
  await expect(
    within(guide).findByText(/Definitions.*Tags/),
  ).resolves.toBeVisible();
  await escape();
  if (screen.queryByRole("dialog")) {
    await escape();
  }
  expect(field("Client Secret")).toHaveValue("local-ts-secret");
  guide = await reopen();
  await within(guide).findByText("3 / 4");
  await press("Continue", guide);
  await press("Return to form", guide);
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(field("Network name")).toHaveValue("Design network");
  expect(field("Allowed tags")).toHaveValue(tags);
  expect(field("Client Secret")).toHaveValue("local-ts-secret");
  await expect(button("Save network")).resolves.toBeVisible();
});
test("remote-control-guided-setup-113 Entering existing credentials from either provider returns directly through the network directory", async () => {
  mockRemoteInventory(context);
  const created = context.mocks.deferred<unknown>();
  context.mocks.api(cloudflareAccessContract.create, ({ body, respond }) => {
    created.resolve(body);
    return respond(204);
  });
  await setupPage({ context, path: base });
  await button("Add network");
  expect(
    queryAllByRoleFast("button").filter((b) => {
      return b.textContent === "Add network";
    }),
  ).toHaveLength(1);
  await press("Add network");
  await screen.findByText("Choose the network your device uses.");
  await press(/Tailscale/);
  let guide = await screen.findByRole("dialog");
  await within(guide).findByText("1 / 4");
  await expect(
    button("Enter existing credentials", guide),
  ).resolves.toBeVisible();
  await escape();
  await press("Private network");
  await press("Add network");
  await press(/Cloudflare/);
  guide = await screen.findByRole("dialog");
  await within(guide).findByText("1 / 3");
  await escape();
  guide = await reopen();
  await press("Enter existing credentials", guide);
  await fill(field("Network name"), "Studio Access");
  await fill(field("Client ID"), "studio.access");
  await fill(field("Client Secret"), "local-access-secret");
  await press("Save network");
  await created.promise;
  await button("Add network");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByLabelText("Network name")).toBeNull();
  expect(screen.queryByText("Studio Access")).toBeNull();
});
