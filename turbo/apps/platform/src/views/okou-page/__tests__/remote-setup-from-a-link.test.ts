import { screen, within, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  mockRemoteInventory,
  sshHost,
} from "./connectors-remote-control-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
const context = testContext();
async function enter(params: string, host?: ReturnType<typeof sshHost>) {
  mockRemoteInventory(context, { ssh: host ? [host] : [] });
  await setupPage({
    context,
    path: "/connectors?scope=remote-control&" + params,
  });
}
const install = "Install and sign in",
  permissions = "Allow access and stay online",
  chat = "Enable it in chat";
test("remote-control-guided-setup-004 The device guide walks forward and back to the parallel SSH setup", async () => {
  await enter("setup=add");
  click(await findFastControl("link", /Computer use/));
  const d = await screen.findByRole("dialog");
  const w = within(d);
  await w.findByText(install);
  click(await findFastControl("button", "Continue", d));
  await w.findByText(permissions);
  click(await findFastControl("button", "Continue", d));
  await w.findByText(chat);
  act(() => {
    return history.back();
  });
  await w.findByText(permissions);
  click(await findFastControl("button", "Previous", d));
  await w.findByText(install);
  await userEvent.setup({ delay: null }).keyboard("{Escape}");
  await waitFor(() => {
    return expect(d).not.toBeInTheDocument();
  });
  const commands = await findFastControl("button", /Run commands/i);
  click(commands);
  await expect(
    screen.findByLabelText(/^SSH username$/i),
  ).resolves.toBeInTheDocument();
});
test("remote-control-guided-setup-005 A direct installation link shows the Mac requirement and restores the setup choices", async () => {
  await enter("setup=computer-use&computerUseStep=install");
  const d = await screen.findByRole("dialog");
  await within(d).findByText(/requires an Apple silicon Mac/i);
  expect(within(d).getByText(install)).toBeInTheDocument();
  expect(d.querySelector("img")).toHaveAttribute(
    "src",
    expect.stringContaining("computer-use-install-sign-in"),
  );
  await userEvent.setup({ delay: null }).keyboard("{Escape}");
  await waitFor(() => {
    return expect(d).not.toBeInTheDocument();
  });
  const link = await findFastControl("link", /Computer use/);
  expect(link).toHaveAttribute(
    "href",
    expect.stringContaining("computerUseStep=install"),
  );
  await expect(
    findFastControl("button", /Run commands/i),
  ).resolves.toBeInTheDocument();
});
test("remote-control-guided-setup-006 A shared final-step URL opens the chat instructions for This Mac", async () => {
  await enter("setup=computer-use&computerUseStep=chat");
  const w = within(await screen.findByRole("dialog"));
  await w.findByText(chat);
  expect(w.getByText("This Mac")).toBeInTheDocument();
});
test("remote-control-guided-setup-009 A password entered on the SSH login step stays in the form", async () => {
  await enter("setup=ssh&step=login");
  const secret = await screen.findByLabelText(/^Password/i, {
    selector: "input",
  });
  await fill(secret, "local-fixture-801");
  expect(secret).toHaveValue("local-fixture-801");
  expect(
    screen.getByLabelText(/^SSH username$/i, { selector: "input" }),
  ).toBeEnabled();
  expect(location.href).not.toContain("local-fixture-801");
});
test("remote-control-guided-setup-010 A saved SSH link opens the named connection and points to its details", async () => {
  const host = sshHost(7, "Staging build station");
  await enter("setup=ssh&step=saved&savedConnection=" + host.id, host);
  await screen.findByText("Connection added");
  expect(screen.getByText(host.displayName)).toBeInTheDocument();
  const target = new URL(
    (await findFastControl("link", "View connection")).getAttribute("href")!,
    location.origin,
  );
  expect(target.pathname).toBe("/connectors");
  expect(target.searchParams.get("scope")).toBe("remote-control");
  expect(target.searchParams.get("remoteResource")).toBe("ssh:" + host.id);
});
test("remote-control-guided-setup-012 An inaccessible saved SSH link explains why the connection cannot be shown", async () => {
  await enter("setup=ssh&step=saved&savedConnection=" + crypto.randomUUID());
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    /configuration is unavailable or you no longer have access/i,
  );
  expect(screen.queryByText("Connection added")).toBeNull();
});
test("remote-control-guided-setup-026 VNC setup returns directly to the connection choices", async () => {
  await enter("setup=add");
  const control = await findFastControl("button", /Control.*screen/i);
  expect(screen.queryByText("Connection method")).toBeNull();
  expect(screen.queryByText(/^Back$/)).toBeNull();
  expect(screen.queryByText("Add a private network")).toBeNull();
  expect(screen.queryByText(/Install Tailscale/)).toBeNull();
  click(control);
  await screen.findByRole("heading", { name: /login method/i });
  await findFastControl("button", "Remote control");
  click(await findFastControl("button", "Back"));
  await expect(
    findFastControl("button", /Control.*screen/i),
  ).resolves.toBeInTheDocument();
});
