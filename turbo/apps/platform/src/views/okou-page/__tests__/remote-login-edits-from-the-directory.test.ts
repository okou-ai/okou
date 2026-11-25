import { screen, within, waitFor } from "@testing-library/react";
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
  sshHost,
  vncHost,
  REMOTE_TIMESTAMP,
} from "./connectors-remote-control-test-helpers.ts";

const context = testContext();
const base = "/connectors?scope=remote-control";
const ssh = sshHost(1, "Workshop shell"),
  vnc = vncHost(1, "Desk screen");
function inventory() {
  const metadata = {
    revision: 3,
    createdAt: REMOTE_TIMESTAMP,
    updatedAt: REMOTE_TIMESTAMP,
  };
  const shell = {
    ...metadata,
    id: remoteId("d", 1),
    name: "Workshop login",
    username: "operator",
    authMethod: "password" as const,
    hosts: [{ id: ssh.id, displayName: ssh.displayName }],
  };
  const screenLogin = {
    ...metadata,
    id: remoteId("f", 1),
    name: "Desktop login",
    username: "designer",
    authMethod: "apple_dh_username_password" as const,
    hosts: [{ id: vnc.id, displayName: vnc.displayName }],
  };
  const network = {
    ...metadata,
    id: remoteId("c", 5),
    name: "Office network",
    scope: "personal" as const,
    generation: 1,
    sshHosts: [],
    vncHosts: [],
    tags: ["tag:studio"],
  };
  return { shell, screenLogin, network };
}
async function start(query: string) {
  const { shell, screenLogin, network } = inventory();
  mockRemoteInventory(context, {
    ssh: [ssh],
    vnc: [vnc],
    sshCredentials: [shell],
    vncCredentials: [screenLogin],
    tailscale: [network],
  });
  await setupPage({ context, path: query });
}
const action = (name: string | RegExp, container?: HTMLElement) => {
  return findFastControl("button", name, container);
};
async function press(name: string | RegExp, container?: HTMLElement) {
  click(await action(name, container));
}
const esc = () => {
  return userEvent.setup({ delay: null }).keyboard("{Escape}");
};
test.each([
  {
    id: "remote-control-guided-setup-086",
    protocol: "ssh",
    account: inventory().shell,
  },
  {
    id: "remote-control-guided-setup-087",
    protocol: "vnc",
    account: inventory().screenLogin,
  },
])(
  "$id A discarded password replacement reopens empty while the saved login remains visible",
  async ({ protocol, account }) => {
    await start(base + "&remoteView=credentials&type=" + protocol);
    await screen.findByText(account.username);
    await press("Edit credential");
    const dialog = await screen.findByRole("dialog");
    const controls = within(dialog);
    const toggle = await controls.findByRole("checkbox", {
      name: "Change login details",
    });
    expect(toggle).not.toBeChecked();
    expect(controls.queryByLabelText(/^Password$/)).toBeNull();
    await userEvent
      .setup({ delay: null })
      .click(controls.getByText("Change login details"));
    const password = await controls.findByLabelText(/^Password$/);
    expect(password).toHaveAttribute("type", "password");
    expect(password).toBeRequired();
    expect(password).toHaveValue("");
    await fill(password, "sample-password");
    await userEvent
      .setup({ delay: null })
      .click(controls.getByText("Change login details"));
    await waitFor(() => {
      return expect(password).not.toBeInTheDocument();
    });
    await userEvent
      .setup({ delay: null })
      .click(controls.getByText("Change login details"));
    const fresh = await controls.findByLabelText(/^Password$/);
    expect(fresh).toHaveValue("");
    expect(fresh).toBeRequired();
    expect(fresh).toHaveAttribute("type", "password");
    await press("Cancel", dialog);
    await waitFor(() => {
      return expect(dialog).not.toBeInTheDocument();
    });
    expect(screen.getByText(account.username)).toBeVisible();
    expect(screen.getByText(account.name)).toBeVisible();
  },
);
test("remote-control-guided-setup-085 Saved logins have their own directory and explain disabled deletion for in-use credentials", async () => {
  await start(base);
  await screen.findByText(ssh.displayName);
  await screen.findByText(vnc.displayName);
  expect(queryFastControl("button", "Edit credential")).toBeNull();
  const manage = screen.getByText("Manage credentials");
  click(manage);
  await screen.findByText(inventory().shell.username);
  await expect(action("Delete credential")).resolves.toBeDisabled();
  await press("Why is deletion unavailable?");
  await screen.findByText(/This credential is still in use/);
  await esc();
  await waitFor(() => {
    return expect(
      screen.queryByText(/This credential is still in use/),
    ).toBeNull();
  });
  click(await screen.findByText("VNC", { selector: '[role="radio"],button' }));
  await screen.findByText(inventory().screenLogin.username);
  await expect(action("Delete credential")).resolves.toBeDisabled();
  await press("Back to remote connections");
  await screen.findByText(ssh.displayName);
  expect(screen.getByText(vnc.displayName)).toBeVisible();
  expect(queryFastControl("button", "Edit credential")).toBeNull();
});
test("remote-control-guided-setup-033 Reopening network settings discards the revealed replacement secret", async () => {
  await start(
    "/connectors?scope=private-network&remoteResource=tailscale:" +
      inventory().network.id,
  );
  await press("Edit settings");
  const replace = await screen.findByRole("checkbox", {
    name: "Replace OAuth credentials",
  });
  expect(replace).not.toBeChecked();
  expect(screen.queryByLabelText("Client Secret")).toBeNull();
  await userEvent
    .setup({ delay: null })
    .click(screen.getByText("Replace OAuth credentials"));
  const secret = await screen.findByLabelText("Client Secret");
  expect(secret).toHaveValue("");
  expect(secret).toHaveAttribute("type", "password");
  expect(secret).toBeRequired();
  await fill(secret, "local-secret");
  const parent = secret.parentElement!;
  await press("Show entered value", parent);
  expect(secret).toHaveAttribute("type", "text");
  expect(secret).toHaveValue("local-secret");
  await press("Back");
  await press("Edit settings");
  const reopened = await screen.findByRole("checkbox", {
    name: "Replace OAuth credentials",
  });
  expect(reopened).not.toBeChecked();
  expect(screen.queryByLabelText("Client Secret")).toBeNull();
  await userEvent
    .setup({ delay: null })
    .click(screen.getByText("Replace OAuth credentials"));
  const fresh = await screen.findByLabelText("Client Secret");
  expect(fresh).toHaveValue("");
  expect(fresh).toHaveAttribute("type", "password");
});
test("remote-control-guided-setup-013 The Tailscale-only preparation guide closes back through the two distinct setup pages", async () => {
  mockRemoteInventory(context);
  await setupPage({ context, path: base + "&setup=computer" });
  await press("Set up Tailscale");
  const dialog = await screen.findByRole("dialog");
  const download = await findFastControl("link", /Download Tailscale/, dialog);
  expect(download).toHaveAttribute(
    "href",
    expect.stringMatching(/^https:\/\/tailscale.com\/download/),
  );
  expect(queryFastControl("button", /^(Back|Previous)$/, dialog)).toBeNull();
  expect(within(dialog).queryByText(/Cloudflare Access/)).toBeNull();
  await press("Close", dialog);
  await waitFor(() => {
    return expect(dialog).not.toBeInTheDocument();
  });
  await press("Back");
  await screen.findByText("Step 1 · Prepare the connection");
  await press("Back");
  await screen.findByText("Add remote connection");
});
test("remote-control-guided-setup-050 Switching to private networks abandons an unfinished SSH login", async () => {
  mockRemoteInventory(context);
  await setupPage({ context, path: base + "&setup=ssh&step=login" });
  const name = await screen.findByLabelText("SSH username");
  await fill(name, "draft-owner");
  await press("Connectors");
  click(screen.getByTestId("connectors-scope-private-network"));
  await screen.findByText("No networks added yet");
  click(screen.getByTestId("connectors-scope-remote-control"));
  await screen.findByText("No devices added yet");
  expect(screen.queryByLabelText("SSH username")).toBeNull();
});
