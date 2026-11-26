import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import {
  mockRemoteInventory,
  remoteId,
  REMOTE_TIMESTAMP,
  sshHost,
} from "./connectors-remote-control-test-helpers.ts";
const context = testContext(),
  directory = "/connectors?scope=remote-control",
  address = "100.64.0.25";
function networks() {
  const network = {
    id: remoteId("c", 27),
    name: "Home network",
    scope: "personal" as const,
    revision: 1,
    generation: 1,
    createdAt: REMOTE_TIMESTAMP,
    updatedAt: REMOTE_TIMESTAMP,
    sshHosts: [],
    vncHosts: [],
  };
  const office = {
      ...network,
      id: remoteId("c", 30),
      name: "Office network",
      tags: ["tag:office"],
    },
    edge = { ...network, id: remoteId("c", 28), name: "Cloudflare home" };
  return { network, office, edge };
}
async function mount(query: string) {
  const { network, office, edge } = networks();
  const inventory = mockRemoteInventory(context, {
    tailscale: [{ ...network, tags: ["tag:home"] }, office],
    cloudflare: [edge],
  });
  await setupPage({ context, path: directory + "&" + query });
  return inventory;
}
const button = (name: string | RegExp, box?: HTMLElement) => {
  return findFastControl("button", name, box);
};
const press = async (name: string | RegExp, box?: HTMLElement) => {
  return click(await button(name, box));
};
const field = (name: string | RegExp) => {
  return screen.getByLabelText(name, { selector: "input" });
};
async function select(label: string | RegExp, name: string | RegExp) {
  const choose = userEvent.setup({ delay: null });
  await choose.click(await screen.findByRole("combobox", { name: label }));
  await choose.click(await screen.findByRole("option", { name }));
}
async function emptyDirectory() {
  await press("Remote control");
  await screen.findByText("No devices added yet");
}
async function fromVncToShell() {
  await mount("setup=vnc&step=profile");
  await screen.findByText("Choose a VNC login method");
  await press("Back");
  await press(/^SSH/);
  await screen.findByLabelText("SSH username");
}
test.each([
  { id: "remote-control-guided-setup-027", route: "Home network · Tailscale" },
  {
    id: "remote-control-guided-setup-028",
    route: "Cloudflare home · Cloudflare Access",
  },
])(
  "$id Restarting SSH separates the retained network from the discarded login and address",
  async ({ route }) => {
    await fromVncToShell();
    await fill(field("SSH username"), "draft-user");
    await fill(field("Password"), "sample-secret");
    await fill(field("Device address"), address);
    await select("Connection method", route);
    await press("Back");
    await screen.findByText("Add remote connection");
    await press(/^SSH/);
    await screen.findByLabelText("SSH username");
    await expect(
      screen.findByRole("combobox", { name: "Connection method" }),
    ).resolves.toHaveTextContent(route);
    for (const label of ["Device address", "Password", "SSH username"]) {
      expect(field(label)).toHaveValue("");
    }
    await emptyDirectory();
  },
);
test("remote-control-guided-setup-031 Leaving a Cloudflare SSH draft for private networks starts a fresh add-connection page", async () => {
  await mount("setup=ssh&step=login");
  await select("Connection method", "Cloudflare home · Cloudflare Access");
  await press("Connectors");
  click(screen.getByTestId("connectors-scope-private-network"));
  await screen.findByText(networks().edge.name);
  click(screen.getByTestId("connectors-scope-remote-control"));
  await screen.findByText("No devices added yet");
  await press("Add connection");
  await screen.findByText("Add remote connection");
  expect(queryFastControl("button", "Back")).toBeNull();
});
test("remote-control-guided-setup-032 Switching between Cloudflare and Tailscale SSH keeps the route's system username and saves the chosen device", async () => {
  await mount("setup=ssh&step=login");
  const saved = context.mocks.deferred<unknown>();
  const host = sshHost(32, "Home server");
  context.mocks.api(sshConnectionsContract.create, ({ body, respond }) => {
    saved.resolve(body);
    return respond(201, host);
  });
  await fill(field("Device address"), address);
  await select("Connection method", "Home network · Tailscale SSH");
  await fill(field("System username"), "ubuntu");
  await select("Connection method", "Cloudflare home · Cloudflare Access");
  await fill(field("SSH username"), "edge-admin");
  await fill(field("Password"), "Cloud-login-32");
  await select("Connection method", "Home network · Tailscale SSH");
  expect(field("System username")).toHaveValue("ubuntu");
  expect(field("Device address")).toHaveValue(address);
  expect(field("Password")).toBeDisabled();
  expect(field("Port")).toBeDisabled();
  expect(screen.queryByRole("alert")).toBeNull();
  await fill(field("Connection name"), "Home server");
  await userEvent.setup({ delay: null }).click(await button("Add connection"));
  const body = await saved.promise;
  expect(body).toMatchObject({
    host: address,
    port: 22,
    username: "ubuntu",
    transport: { type: "tailscale_ssh", configId: networks().network.id },
  });
  expect(body).not.toHaveProperty("credential");
  await screen.findByText("Connection added");
});
test("remote-control-guided-setup-098 Dismissing the saved-login picker preserves a manual draft and choosing a login resets only the credentials", async () => {
  const credential = {
    id: remoteId("d", 98),
    name: "Build login",
    username: "builder",
    revision: 2,
    authMethod: "password" as const,
    hosts: [],
    createdAt: REMOTE_TIMESTAMP,
    updatedAt: REMOTE_TIMESTAMP,
  };
  mockRemoteInventory(context, { sshCredentials: [credential] });
  await setupPage({ context, path: directory + "&setup=ssh&step=login" });
  await fill(field("Device address"), "build.example.com");
  await fill(field("SSH username"), "manual-user");
  await fill(field("Password"), "sample-secret");
  await press("Choose saved login details");
  await screen.findByRole("dialog");
  await userEvent.setup({ delay: null }).keyboard("{Escape}");
  expect(field("Password")).toHaveValue("sample-secret");
  expect(field("SSH username")).toHaveValue("manual-user");
  await press("Choose saved login details");
  const dialog = await screen.findByRole("dialog");
  click(await within(dialog).findByText("Build login"));
  await screen.findByText("builder · Password");
  expect(screen.getByText("Build login")).toBeVisible();
  expect(screen.getByText("builder · Password")).toBeVisible();
  expect(screen.queryByLabelText("Password", { selector: "input" })).toBeNull();
  expect(queryFastControl("radio", "SSH key")).toBeNull();
  await press("Enter details manually");
  expect(field("SSH username")).toHaveValue("");
  expect(field("Password")).toHaveValue("");
  expect(field("Device address")).toHaveValue("build.example.com");
});
async function appleConnection() {
  await mount("setup=vnc&step=profile");
  await select("Service type", "Apple screen sharing");
  await press("Continue");
  await screen.findByText("Connect a device");
}
test("remote-control-guided-setup-029 Changing the VNC profile retains the selected private route and its device address", async () => {
  await appleConnection();
  await select("Connection method", "Tailscale");
  await select(/Saved network|Tailscale network/, "Home network");
  await fill(field("Device address"), address);
  await press("Back");
  await select("Service type", "Certificate-based VNC");
  await press("Continue");
  await screen.findByText("Connect a device");
  expect(
    screen.getByRole("combobox", { name: /Saved network|Tailscale network/ }),
  ).toHaveTextContent("Home network");
  expect(field("Device address")).toHaveValue(address);
  expect(queryFastControl("button", "Add SSH connection")).toBeNull();
  await emptyDirectory();
});
test("remote-control-guided-setup-044 The VNC network choice gates device fields and retains a nondefault port across steps", async () => {
  await appleConnection();
  const choose = await screen.findByRole("combobox", {
    name: "Connection method",
  });
  await userEvent.setup({ delay: null }).click(choose);
  await userEvent
    .setup({ delay: null })
    .click(await screen.findByRole("option", { name: /SSH/ }));
  const ssh = await screen.findByRole("combobox", { name: /SSH host/ });
  expect(ssh).toBeDisabled();
  await expect(
    screen.findByText(
      /no saved SSH|add an SSH connection first|no SSH connections/i,
    ),
  ).resolves.toBeVisible();
  expect(screen.queryByRole("textbox", { name: "Device address" })).toBeNull();
  expect(screen.queryByText("Advanced options")).toBeNull();
  await select("Connection method", "Tailscale");
  await select(/Saved network|Tailscale network/, "Home network");
  await fill(field("Device address"), address);
  await fill(field("Port"), "5901");
  await press("Back");
  await press("Continue");
  expect(field("Port")).toHaveValue(5901);
  expect(queryFastControl("button", "Add SSH connection")).toBeNull();
});
test("remote-control-guided-setup-046 A Cloudflare VNC route enforces origin TLS and retains the device hostname through address help", async () => {
  await appleConnection();
  await select("Connection method", "Cloudflare Access");
  await select(/Saved network|Cloudflare Access network/, "Cloudflare home");
  await fill(field("Device address"), "desktop.example.com");
  const tls = await screen.findByRole("checkbox", { name: /origin TLS/i });
  expect(tls).toBeChecked();
  expect(tls).toHaveAttribute("aria-disabled", "true");
  await press("Where can I find the device address?");
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getAllByRole("listitem")).toHaveLength(3);
  await userEvent.setup({ delay: null }).keyboard("{Escape}");
  expect(field("Device address")).toHaveValue("desktop.example.com");
  await fill(field(/Origin TLS server name/i), "origin.example.com");
  await press("Continue");
  await screen.findByText("Enter device login information");
});
