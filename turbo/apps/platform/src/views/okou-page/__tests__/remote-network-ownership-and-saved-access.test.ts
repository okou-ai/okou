import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import {
  mockRemoteInventory,
  remoteId,
  REMOTE_TIMESTAMP,
  vncHost,
  sshHost,
} from "./connectors-remote-control-test-helpers.ts";
const context = testContext(),
  remote = "/connectors?scope=remote-control",
  privateNetworks = "/connectors?scope=private-network";
async function press(name: string | RegExp, box?: HTMLElement) {
  click(await findFastControl("button", name, box));
}
function network() {
  return {
    id: remoteId("a", 79),
    name: "Office network",
    revision: 1,
    generation: 1,
    scope: "personal" as const,
    createdAt: REMOTE_TIMESTAMP,
    updatedAt: REMOTE_TIMESTAMP,
    sshHosts: [],
    vncHosts: [],
  };
}
function field(name: string | RegExp) {
  return screen.getByLabelText(name, { selector: "input" });
}
async function mac() {
  const net = { ...network(), tags: ["tag:studio"] };
  const device = vncHost(90, "Creative workstation", {
    security: { type: "apple_dh" },
    transport: { type: "tailscale", configId: net.id },
    credentialName: "Mac operator",
  });
  const credential = {
    id: remoteId("f", 1),
    name: "Mac operator",
    authMethod: "apple_dh_username_password" as const,
    username: "operator",
    revision: 3,
    hosts: [{ id: device.id, displayName: device.displayName }],
    createdAt: REMOTE_TIMESTAMP,
    updatedAt: REMOTE_TIMESTAMP,
  };
  mockRemoteInventory(context, {
    vnc: [device],
    vncCredentials: [credential],
    tailscale: [net],
  });
  const changed = context.mocks.deferred<unknown>();
  let enabled = false;
  const item = () => {
    return {
      connectionId: device.id,
      displayName: device.displayName,
      defaultEnabled: enabled,
    };
  };
  context.mocks.api(
    chatRemoteAccessContract.listHostDefaults,
    ({ respond }) => {
      return respond(200, { ssh: [], vnc: [item()] });
    },
  );
  context.mocks.api(
    chatRemoteAccessContract.updateHostDefault,
    ({ params, body, respond }) => {
      changed.resolve({ params, body });
      enabled = body.enabled;
      return respond(200, item());
    },
  );
  await setupPage({
    context,
    path: remote + "&remoteResource=vnc:" + device.id,
  });
  return { changed, device, net };
}
test("remote-control-guided-setup-090 Opening identity and permissions shows one endpoint and network and enables this desktop for chats by default", async () => {
  const { device, net, changed } = await mac();
  await screen.findByText(device.displayName);
  const section = await screen.findByText(
    "Server identity and chat permissions",
    { selector: "summary" },
  );
  click(section);
  expect(screen.getAllByText(net.name)).toHaveLength(1);
  expect(screen.getAllByText(device.host + ":" + device.port)).toHaveLength(1);
  expect(screen.getByText("Mac operator")).toBeVisible();
  await expect(
    screen.findByText(/Mac VNC \(Apple DH\)/),
  ).resolves.toBeVisible();
  expect(document.body).toHaveTextContent(/Authentication method.*Apple DH/s);
  expect(screen.queryByText(/RFB destination/i)).toBeNull();
  const toggle = await screen.findByRole("switch", {
    name: /Enabled by default for chats/,
  });
  expect(toggle).not.toBeChecked();
  await userEvent.setup({ delay: null }).click(toggle);
  await expect(changed.promise).resolves.toMatchObject({
    params: { protocol: "vnc", connectionId: device.id },
    body: { enabled: true },
  });
  await waitFor(() => {
    return expect(toggle).toBeChecked();
  });
});
test("remote-control-guided-setup-095 On-demand login and protocol explanations preserve the Mac editor's optional password", async () => {
  await mac();
  await press("Edit connection");
  await screen.findByLabelText("Username");
  expect(
    screen.getAllByText("Login information", { exact: true }),
  ).toHaveLength(1);
  expect(field("Username")).toHaveValue("operator");
  const secret = field("Password");
  expect(secret).toHaveValue("");
  expect(secret).not.toBeRequired();
  await fill(secret, "local-edit-secret");
  const settings = screen.getByText("Connection settings", {
    selector: "summary",
  });
  click(settings);
  await expect(
    screen.findByRole("combobox", { name: "Service type" }),
  ).resolves.toBeVisible();
  await expect(
    screen.findByRole("combobox", { name: "Login method" }),
  ).resolves.toBeVisible();
  const trigger = await findFastControl(
    "button",
    /Where can I find my username/,
  );
  await userEvent.setup({ delay: null }).click(trigger);
  await screen.findByText(/whoami/);
  await userEvent.setup({ delay: null }).keyboard("{Escape}");
  await waitFor(() => {
    return expect(trigger).toHaveFocus();
  });
  await press("Protocol and security details");
  await screen.findByText(/certificate/i);
  await userEvent.setup({ delay: null }).keyboard("{Escape}");
  click(settings);
  expect(secret).toHaveValue("local-edit-secret");
});
test("remote-control-guided-setup-079 The open network's connections retain the old server while refreshing then display its replacement", async () => {
  const original = sshHost(79, "Previous office server");
  const edge = {
    ...network(),
    sshHosts: [{ id: original.id, displayName: original.displayName }],
  };
  mockRemoteInventory(context, { cloudflare: [edge], ssh: [original] });
  const arrived = context.mocks.deferred<void>(),
    release = context.mocks.deferred<void>();
  let update = false;
  context.mocks.api(cloudflareAccessContract.list, async ({ respond }) => {
    if (!update) {
      return respond(200, { configs: [edge] });
    }
    if (!arrived.settled()) {
      arrived.resolve();
    }
    await release.promise;
    return respond(200, {
      configs: [
        {
          ...edge,
          sshHosts: [{ id: original.id, displayName: "Updated office server" }],
        },
      ],
    });
  });
  try {
    await setupPage({ context, path: privateNetworks });
    const row = await screen.findByText(edge.name);
    await press(/connections?|hosts?/i, row.closest("article") ?? undefined);
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(original.displayName);
    update = true;
    context.mocks.ably.trigger("ssh:changed", { orgId: "org_default" });
    await arrived.promise;
    expect(row).toBeVisible();
    expect(within(dialog).getByText(original.displayName)).toBeVisible();
    release.resolve();
    await within(dialog).findByText("Updated office server");
    expect(within(dialog).queryByText(original.displayName)).toBeNull();
  } finally {
    if (!release.settled()) {
      release.resolve();
    }
  }
});
