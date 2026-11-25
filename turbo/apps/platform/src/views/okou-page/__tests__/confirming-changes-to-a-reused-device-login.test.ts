import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { vncCredentialsContract } from "@okouai/api-contracts/contracts/vnc-credentials";
import { screen, within } from "@testing-library/react";
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
  password = "sample93";
async function press(name: string | RegExp, box?: HTMLElement) {
  click(await findFastControl("button", name, box));
}
async function edit(protocol: "vnc" | "ssh", conflict: boolean) {
  const ssh = sshHost(18, "Workshop shell"),
    vnc = vncHost(18, "Workshop screen"),
    other =
      protocol === "ssh"
        ? sshHost(19, "Second workshop")
        : vncHost(19, "Second workshop");
  const host = protocol === "ssh" ? ssh : vnc;
  const metadata = {
    name: "Workshop credential",
    revision: 3,
    createdAt: REMOTE_TIMESTAMP,
    updatedAt: REMOTE_TIMESTAMP,
    hosts: [host, other].map((h) => {
      return { id: h.id, displayName: h.displayName };
    }),
  };
  const inventory = mockRemoteInventory(context, {
    ssh: [ssh],
    vnc: [vnc],
    sshCredentials: [
      {
        ...metadata,
        id: remoteId("d", 1),
        username: "deploy",
        authMethod: "password",
      },
    ],
    vncCredentials: [
      { ...metadata, id: remoteId("f", 1), authMethod: "vnc_password" },
    ],
  });
  const updated = context.mocks.deferred<unknown>(),
    login = context.mocks.deferred<unknown>();
  context.mocks.api(sshConnectionsContract.update, ({ body, respond }) => {
    updated.resolve(body);
    return respond(200, { ...ssh, generation: 2 });
  });
  context.mocks.api(vncConnectionsContract.update, ({ body, respond }) => {
    updated.resolve(body);
    return respond(200, { ...vnc, generation: 2 });
  });
  context.mocks.api(sshCredentialsContract.update, ({ body, respond }) => {
    login.resolve(body);
    return conflict
      ? respond(409, {
          error: {
            code: "SSH_CREDENTIAL_REVISION_CONFLICT",
            message: "Another device shares this login",
          },
        })
      : respond(200, { ...inventory.sshCredentials[0]!, revision: 4 });
  });
  context.mocks.api(vncCredentialsContract.update, ({ body, respond }) => {
    login.resolve(body);
    return respond(409, {
      error: {
        code: "VNC_CREDENTIAL_REVISION_CONFLICT",
        message: "Another device shares this login",
      },
    });
  });
  await setupPage({
    context,
    path:
      "/connectors?scope=remote-control&remoteResource=" +
      protocol +
      ":" +
      host.id,
  });
  await press("Edit connection");
  const secret = await screen.findByLabelText(/^(?:VNC )?Password$/i, {
    selector: "input",
  });
  await fill(secret, password);
  if (conflict) {
    const fresh = {
      id: remoteId(protocol === "ssh" ? "b" : "e", 21),
      displayName: "Late workshop",
    };
    const remote =
      protocol === "ssh"
        ? inventory.sshCredentials[0]!
        : inventory.vncCredentials[0]!;
    remote.hosts = [...remote.hosts, fresh];
    remote.revision = 4;
  }
  return { host, other, secret, updated, login };
}
test("remote-control-guided-setup-096 Cancelling a shared SSH update preserves the draft and confirmation writes the displayed credential revision", async () => {
  const { host, other, secret, updated, login } = await edit("ssh", false);
  await press("Save");
  let dialog = await screen.findByRole("dialog", {
    name: "Update shared login information?",
  });
  await within(dialog).findByText(other.displayName);
  expect(dialog).toHaveTextContent(/shared by 2 connections/);
  await press("Continue editing", dialog);
  expect(secret).toHaveValue(password);
  expect(updated.settled()).toBeFalsy();
  expect(login.settled()).toBeFalsy();
  await press("Save");
  dialog = await screen.findByRole("dialog", {
    name: "Update shared login information?",
  });
  await press("Confirm update", dialog);
  await expect(updated.promise).resolves.toMatchObject({
    displayName: host.displayName,
    expectedGeneration: 1,
  });
  await expect(login.promise).resolves.toMatchObject({
    expectedRevision: 3,
    authentication: { method: "password", password },
  });
  await screen.findByText(host.displayName);
});
test.each([
  { id: "remote-control-guided-setup-101", protocol: "ssh" as const },
  { id: "remote-control-guided-setup-102", protocol: "vnc" as const },
])(
  "$id A credential conflict after the host update leaves the edited password visible for review",
  async ({ protocol }) => {
    const { host, secret, updated, login } = await edit(protocol, true);
    await press("Save");
    const dialog = await screen.findByRole("dialog", {
      name: "Update shared login information?",
    });
    await press("Confirm update", dialog);
    await expect(updated.promise).resolves.toMatchObject({
      displayName: host.displayName,
    });
    await expect(login.promise).resolves.toMatchObject({ expectedRevision: 3 });
    await screen.findByText(
      "Connection settings are saved. Review the login information update before leaving.",
    );
    expect(secret).toHaveValue(password);
    await expect(findFastControl("button", "Save")).resolves.toBeDisabled();
  },
);
