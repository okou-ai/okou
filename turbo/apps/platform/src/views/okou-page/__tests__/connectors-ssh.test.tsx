import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { screen, within } from "@testing-library/react";
import { test, expect } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  mockRemoteInventory,
  sshHost,
  vncHost,
  REMOTE_TIMESTAMP,
} from "./connectors-remote-control-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
const context = testContext();
const path = "/connectors?scope=remote-control&type=ssh";
test("connectors-ssh-001 returning to each directory picks up its latest inventory", async () => {
  const host = sshHost(1, "Original SSH host");
  const gateway = {
    id: crypto.randomUUID(),
    name: "Original private network",
    scope: "personal" as const,
    generation: 1,
    revision: 1,
    createdAt: REMOTE_TIMESTAMP,
    updatedAt: REMOTE_TIMESTAMP,
    sshHosts: [],
    vncHosts: [],
  };
  const db = mockRemoteInventory(context, {
    ssh: [host],
    cloudflare: [gateway],
  });
  await setupPage({ context, path });
  await screen.findByText(host.displayName);
  click(await findFastControl("radio", /^Private network/i));
  await screen.findByText(gateway.name);
  for (const [hostName, networkName] of [
    ["Updated SSH host", "Network after SSH change"],
    ["Latest SSH host", "Latest private network"],
  ]) {
    db.ssh = [{ ...host, displayName: hostName }];
    click(await findFastControl("radio", /^Remote control/i));
    await expect(screen.findByText(hostName)).resolves.toBeInTheDocument();
    db.cloudflare = [{ ...gateway, name: networkName }];
    click(await findFastControl("radio", /^Private network/i));
    await expect(screen.findByText(networkName)).resolves.toBeInTheDocument();
  }
});
test("connectors-ssh-005 an in-use SSH gateway explains how to change the dependent VNC route", async () => {
  const gateway = sshHost(1, "VNC gateway");
  mockRemoteInventory(context, {
    ssh: [gateway],
    vnc: [
      vncHost(1, "Desktop", {
        transport: { type: "ssh", connectionId: gateway.id },
      }),
    ],
  });
  context.mocks.api(sshConnectionsContract.delete, ({ respond }) => {
    return respond(409, {
      error: {
        code: "SSH_CONNECTION_IN_USE",
        message: "Private dependency detail",
      },
    });
  });
  await setupPage({ context, path });
  click(
    await findFastControl(
      "link",
      "Manage",
      await screen.findByRole("listitem", { name: "VNC gateway" }),
    ),
  );
  click(await findFastControl("button", "Delete connection"));
  const dialog = await screen.findByRole("dialog");
  click(await findFastControl("button", /Delete/i, dialog));
  await within(dialog).findByText(
    /This SSH host is used by a VNC route.*switch them explicitly to Direct/,
  );
  expect(
    screen.queryByText(/Private dependency detail/),
  ).not.toBeInTheDocument();
  expect(dialog).toBeInTheDocument();
});
