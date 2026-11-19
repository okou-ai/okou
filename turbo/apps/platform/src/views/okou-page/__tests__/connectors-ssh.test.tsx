import { SSH_ERROR_CODES } from "@okouai/api-contracts/contracts/ssh-errors";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { getConnectorAction } from "./connector-page-test-helpers.ts";
import {
  mockRemoteInventory,
  REMOTE_TIMESTAMP,
  remoteId,
  sshHost,
  vncHost,
} from "./connectors-remote-control-test-helpers.ts";

const context = testContext();

function privateNetwork(name: string) {
  return {
    id: remoteId("c", 1),
    name,
    scope: "personal" as const,
    revision: 1,
    generation: 1,
    createdAt: REMOTE_TIMESTAMP,
    updatedAt: REMOTE_TIMESTAMP,
    sshHosts: [],
    vncHosts: [],
  };
}

function remoteConnections(): HTMLElement {
  return screen.getByRole("list", { name: "Remote connections" });
}

function findAction(role: "button" | "link", name: string) {
  return waitFor(() => {
    return getConnectorAction(role, name);
  });
}

async function openScope(name: RegExp): Promise<void> {
  click(await screen.findByRole("radio", { name }));
}

test("Management scope changes show current data on return", async () => {
  const inventory = mockRemoteInventory(context, {
    ssh: [sshHost(1, "Original SSH host")],
    cloudflare: [privateNetwork("Original private network")],
  });

  await setupPage({ context, path: "/connectors?scope=remote-control" });
  await expect(
    screen.findByRole("listitem", { name: "Original SSH host" }),
  ).resolves.toBeInTheDocument();

  await openScope(/^Private network/u);
  const networks = await screen.findByRole("region", {
    name: "Private networks",
  });
  await expect(
    within(networks).findByText("Original private network"),
  ).resolves.toBeInTheDocument();

  inventory.ssh = [sshHost(1, "Updated SSH host")];
  await openScope(/^Remote control/u);
  await expect(
    screen.findByRole("listitem", { name: "Updated SSH host" }),
  ).resolves.toBeInTheDocument();
  expect(
    within(remoteConnections()).queryByText("Original SSH host"),
  ).toBeNull();

  inventory.cloudflare = [privateNetwork("Network after SSH change")];
  await openScope(/^Private network/u);
  await expect(
    screen.findByText("Network after SSH change"),
  ).resolves.toBeInTheDocument();

  inventory.ssh = [sshHost(1, "Latest SSH host")];
  inventory.cloudflare = [privateNetwork("Latest private network")];
  await openScope(/^Remote control/u);
  await expect(
    screen.findByRole("listitem", { name: "Latest SSH host" }),
  ).resolves.toBeInTheDocument();
  await openScope(/^Private network/u);
  await expect(
    screen.findByText("Latest private network"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText("Network after SSH change")).toBeNull();
});

test("Remote control keeps saved hosts available when SSH diagnostics fail", async () => {
  mockRemoteInventory(context, {
    ssh: [sshHost(1, "Host 1"), sshHost(2, "Host 2")],
  });
  const diagnosticsFailed = context.mocks.deferred<void>();
  context.mocks.api(sshConnectionsContract.observations, ({ respond }) => {
    diagnosticsFailed.resolve();
    return respond(500, {
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Observation store at 10.0.4.7 rejected tenant query",
      },
    });
  });

  await setupPage({ context, path: "/connectors?scope=remote-control" });
  const row = await screen.findByRole("listitem", { name: "Host 2" });
  expect(screen.getByRole("listitem", { name: "Host 1" })).toBeInTheDocument();
  click(getConnectorAction("link", "Manage", row));
  await diagnosticsFailed.promise;

  await waitFor(() => {
    expect(screen.getByRole("heading", { name: "Host 2" })).toBeInTheDocument();
    expect(getConnectorAction("button", "Delete connection")).toBeEnabled();
  });
  expect(screen.queryByText(/Observation store at 10\.0\.4\.7/u)).toBeNull();
});

test("Deleting an SSH host referenced by VNC explains how to resolve the dependency", async () => {
  const gateway = sshHost(1, "VNC gateway");
  mockRemoteInventory(context, {
    ssh: [gateway],
    vnc: [
      vncHost(1, "Studio desktop", {
        transport: { type: "ssh", connectionId: gateway.id },
      }),
    ],
  });
  const deleteAttempts: string[] = [];
  context.mocks.api(sshConnectionsContract.delete, ({ params, respond }) => {
    deleteAttempts.push(params.connectionId);
    return respond(409, {
      error: {
        code: SSH_ERROR_CODES.CONNECTION_IN_USE,
        message: "SSH host is referenced by VNC route vnc-route-9f2c",
      },
    });
  });

  await setupPage({ context, path: "/connectors?scope=remote-control" });
  const row = await screen.findByRole("listitem", { name: "VNC gateway" });
  click(getConnectorAction("link", "Manage", row));
  click(await findAction("button", "Delete connection"));
  const dialog = await screen.findByRole("dialog", {
    name: "Delete connection",
  });
  click(getConnectorAction("button", "Delete connection", dialog));

  await expect(within(dialog).findByRole("alert")).resolves.toHaveTextContent(
    "This SSH host is used by a VNC route. Select another SSH host for those VNC routes, switch them explicitly to Direct, or delete them before deleting this host.",
  );
  expect(deleteAttempts).toStrictEqual([gateway.id]);
  expect(screen.queryByText(/vnc-route-9f2c/u)).toBeNull();
  expect(dialog).toBeInTheDocument();
});
