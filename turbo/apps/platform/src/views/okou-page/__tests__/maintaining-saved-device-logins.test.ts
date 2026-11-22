import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { vncCredentialsContract } from "@okouai/api-contracts/contracts/vnc-credentials";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import {
  mockRemoteInventory,
  remoteId,
  REMOTE_TIMESTAMP,
  sshHost,
  vncHost,
} from "./connectors-remote-control-test-helpers.ts";
const context = testContext(),
  directory = "/connectors?scope=remote-control";
const button = (name: string | RegExp, box?: HTMLElement) => {
  return findFastControl("button", name, box);
};
async function press(name: string | RegExp, box?: HTMLElement) {
  click(await button(name, box));
}
function field(name: string | RegExp, box: HTMLElement = document.body) {
  return within(box).getByLabelText(name, { selector: "input" });
}
function identity() {
  return {
    id: remoteId("d", 88),
    name: "Reusable login",
    revision: 1,
    hosts: [],
    createdAt: REMOTE_TIMESTAMP,
    updatedAt: REMOTE_TIMESTAMP,
  };
}
test.each([
  { id: "remote-control-guided-setup-088", protocol: "ssh" },
  { id: "remote-control-guided-setup-089", protocol: "vnc" },
])(
  "$id A saved password login can be created, renamed and removed from the credentials directory",
  async ({ protocol }) => {
    const inventory = mockRemoteInventory(context);
    context.mocks.api(sshCredentialsContract.create, ({ body, respond }) => {
      const saved = {
        ...identity(),
        id: body.id,
        name: body.name,
        username: body.username,
        authMethod: "password" as const,
      };
      inventory.sshCredentials.push(saved);
      return respond(201, saved);
    });
    context.mocks.api(vncCredentialsContract.create, ({ body, respond }) => {
      const saved = {
        ...identity(),
        id: body.id,
        name: body.name,
        authMethod: "vnc_password" as const,
      };
      inventory.vncCredentials.push(saved);
      return respond(201, saved);
    });
    context.mocks.api(sshCredentialsContract.update, ({ body, respond }) => {
      const saved = inventory.sshCredentials[0]!;
      saved.name = body.name ?? saved.name;
      return respond(200, saved);
    });
    context.mocks.api(vncCredentialsContract.update, ({ body, respond }) => {
      const saved = inventory.vncCredentials[0]!;
      saved.name = body.name ?? saved.name;
      return respond(200, saved);
    });
    context.mocks.api(sshCredentialsContract.delete, ({ respond }) => {
      inventory.sshCredentials = [];
      return respond(204);
    });
    context.mocks.api(vncCredentialsContract.delete, ({ respond }) => {
      inventory.vncCredentials = [];
      return respond(204);
    });
    await setupPage({
      context,
      path: directory + "&remoteView=credentials&type=" + protocol,
    });
    await press("Add credential");
    let dialog = await screen.findByRole("dialog");
    await fill(field("Credential name", dialog), "Reusable login");
    if (protocol === "ssh") {
      await fill(field("SSH username", dialog), "operator");
      await userEvent
        .setup({ delay: null })
        .click(within(dialog).getByText("Password", { exact: true }));
    }
    await fill(field(/^(?:VNC )?Password$/i, dialog), "secret28");
    await press("Save", dialog);
    await screen.findByRole("heading", { name: "Reusable login" });
    await press("Edit credential");
    dialog = await screen.findByRole("dialog");
    await fill(field("Credential name", dialog), "Renamed login");
    await press("Save", dialog);
    await screen.findByRole("heading", { name: "Renamed login" });
    expect(screen.queryByText("Reusable login")).toBeNull();
    await press("Delete credential");
    dialog = await screen.findByRole("dialog");
    await press(/^(?:Delete|Delete credential)$/, dialog);
    await waitFor(() => {
      return expect(screen.queryByText("Renamed login")).toBeNull();
    });
    await expect(
      screen.findByText(/^0 credentials configured$/),
    ).resolves.toBeVisible();
    await expect(button("Add credential")).resolves.toBeEnabled();
  },
);
test("remote-control-guided-setup-074 A delayed credential lookup keeps Edit busy and reports its failure on the connection", async () => {
  const host = sshHost(74, "Build machine");
  mockRemoteInventory(context, { ssh: [host] });
  const held = context.mocks.deferred<void>(),
    arrived = context.mocks.deferred<void>();
  context.mocks.api(sshCredentialsContract.list, async ({ respond }) => {
    arrived.resolve();
    await held.promise;
    return respond(500, {
      error: { code: "INTERNAL_ERROR", message: "Inventory offline" },
    });
  });
  try {
    await setupPage({
      context,
      path: directory + "&remoteResource=ssh:" + host.id,
    });
    await screen.findByText(host.displayName);
    const edit = await button("Edit connection");
    click(edit);
    await arrived.promise;
    expect(edit).toBeDisabled();
    expect(edit).toHaveAttribute("aria-busy", "true");
    held.resolve();
    await screen.findByText("Could not load SSH settings.");
  } finally {
    if (!held.settled()) {
      held.resolve();
    }
  }
});
test("remote-control-guided-setup-071 A refreshed connection keeps the pending removal locked until the unavailable detail replaces it", async () => {
  const host = sshHost(71, "Pending removal");
  const inventory = mockRemoteInventory(context, { ssh: [host] });
  const held = context.mocks.deferred<void>(),
    arrived = context.mocks.deferred<void>();
  context.mocks.api(sshConnectionsContract.delete, async ({ respond }) => {
    arrived.resolve();
    await held.promise;
    inventory.ssh = [];
    return respond(204);
  });
  try {
    await setupPage({
      context,
      path: directory + "&remoteResource=ssh:" + host.id,
    });
    await screen.findByText(host.displayName);
    await press("Delete connection");
    const dialog = await screen.findByRole("dialog");
    await press(/^Delete(?: connection)?$/, dialog);
    await arrived.promise;
    inventory.ssh = [{ ...host, displayName: "Refreshed machine" }];
    context.mocks.ably.trigger("ssh:changed", { orgId: "org_default" });
    await screen.findByText("Refreshed machine");
    expect(dialog).toBeVisible();
    await expect(button("Cancel", dialog)).resolves.toBeDisabled();
    held.resolve();
    await screen.findByText(/unavailable|no longer have access/i);
    expect(screen.queryByRole("dialog")).toBeNull();
  } finally {
    if (!held.settled()) {
      held.resolve();
    }
  }
});
test("vnc-settings-012 Returning from Connectors displays the newly named desktop and discards the old name", async () => {
  const host = vncHost(12, "Studio before rename");
  const inventory = mockRemoteInventory(context, { vnc: [host] });
  await setupPage({ context, path: directory });
  await screen.findByText(host.displayName);
  click(await findFastControl("link", /^Connectors/));
  await screen.findByTestId("connectors-scope-remote-control");
  inventory.vnc = [
    { ...host, displayName: "Studio after rename", generation: 2 },
  ];
  click(screen.getByTestId("connectors-scope-remote-control"));
  await screen.findByText("Studio after rename");
  expect(screen.queryByText(host.displayName)).toBeNull();
});
test("vnc-settings-003 A competing generation prevents another save and keeps the owner's new name in the editor", async () => {
  const credentialId = remoteId("f", 3);
  const host = vncHost(3, "Design room", { credentialId });
  mockRemoteInventory(context, {
    vnc: [host],
    vncCredentials: [
      {
        ...identity(),
        id: credentialId,
        name: "Desktop login",
        authMethod: "vnc_password",
      },
    ],
  });
  const request = context.mocks.deferred<unknown>();
  context.mocks.api(vncConnectionsContract.update, ({ body, respond }) => {
    request.resolve(body);
    return respond(409, {
      error: {
        code: "VNC_GENERATION_CONFLICT",
        message: "Concurrent generation",
      },
    });
  });
  await setupPage({
    context,
    path: directory + "&remoteResource=vnc:" + host.id,
  });
  await press("Edit connection");
  const name = await screen.findByLabelText(/^Connection name/, {
    selector: "input",
  });
  await fill(name, "Edited studio");
  await press("Save");
  await expect(request.promise).resolves.toMatchObject({
    expectedGeneration: host.generation,
    displayName: "Edited studio",
  });
  await screen.findByText("This host changed since you opened it.");
  expect(name).toHaveValue("Edited studio");
  await expect(button("Save")).resolves.toBeDisabled();
});
