import { holdResponseField } from "./browser-response-fixture.ts";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { screen, within, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  mockRemoteInventory,
  remoteId,
  sshHost,
  vncHost,
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

test.each([
  [
    "remote-control-guided-setup-067 Returning to device management after a pending SSH login read",
    true,
  ],
  [
    "Withholding the saved SSH login after returning to device management",
    false,
  ],
] as const)("%s", async (_name, deliver) => {
  const credentialId = remoteId("d", 67);
  const host = sshHost(67, "Field recorder", { credentialId });
  mockRemoteInventory(context, { ssh: [host] });
  const login = "Recorder operator";
  const boundary = holdResponseField(
    context,
    (url, value) => {
      return (
        url.pathname.endsWith("/api/ssh/credentials") &&
        Array.isArray(value) &&
        value.some((item) => {
          return item?.name === login;
        })
      );
    },
    "credentials",
  );
  context.mocks.api(sshCredentialsContract.list, ({ respond }) => {
    return respond(200, {
      credentials: [
        {
          id: credentialId,
          name: login,
          username: "recorder",
          authMethod: "password",
          revision: 1,
          createdAt: host.createdAt,
          updatedAt: host.updatedAt,
          hosts: [],
        },
      ],
    });
  });
  await setupPage({
    context,
    path: "/connectors?scope=remote-control&setup=ssh&step=login",
  });
  await boundary.received.promise;
  await screen.findByLabelText(/^SSH username$/i);
  click(await findFastControl("button", "Back"));
  click(await screen.findByTestId("connectors-scope-private-network"));
  await screen.findByText("No networks added yet");
  expect(screen.queryByRole("dialog")).toBeNull();
  if (deliver) {
    await act(async () => {
      boundary.release.resolve();
      await boundary.consumed.promise;
    });
  }
  click(await screen.findByTestId("connectors-scope-remote-control"));
  await screen.findByText(host.displayName);
  expect(screen.queryByLabelText(/^SSH username$/i)).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("Opening Remote control lists newly configured devices while the selector shows its previous count", async () => {
  const original = vncHost(91, "Night desk");
  const inventory = mockRemoteInventory(context, { vnc: [original] });
  await setupPage({ context, path: "/connectors?scope=connected" });
  const control = await screen.findByTestId("connectors-scope-remote-control");
  await waitFor(() => {
    expect(control).toHaveTextContent(/Remote control\s*1/);
  });
  inventory.vnc.push(vncHost(92, "Day desk"));
  click(control);
  await screen.findByText("Day desk");
  expect(screen.getByText("Night desk")).toBeVisible();
  expect(control).toHaveAttribute("aria-checked", "true");
  expect(control).toHaveTextContent(/Remote control\s*1/);
  click(await findFastControl("link", "Workflows"));
  await screen.findByRole("heading", { name: "Workflows" });
  click(await findFastControl("link", "Connectors"));
  const returned = await screen.findByTestId("connectors-scope-remote-control");
  await waitFor(() => {
    expect(returned).toHaveTextContent(/Remote control\s*2/);
  });
  click(returned);
  await screen.findByText("Night desk");
  expect(screen.getByText("Day desk")).toBeVisible();
});
