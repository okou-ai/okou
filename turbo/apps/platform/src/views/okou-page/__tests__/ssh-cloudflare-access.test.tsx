import type { ScopedCloudflareAccessConfig } from "@okouai/api-contracts/contracts/cloudflare-access";
import { SSH_ERROR_CODES } from "@okouai/api-contracts/contracts/ssh-errors";
import {
  sshConnectionsContract,
  type SshConnectionResponse,
  type UpdateSshConnectionRequest,
} from "@okouai/api-contracts/contracts/ssh-connections";
import type { SshCredentialResponse } from "@okouai/api-contracts/contracts/ssh-credentials";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { getConnectorAction } from "./connector-page-test-helpers.ts";
import {
  mockRemoteInventory,
  REMOTE_TIMESTAMP,
  remoteId,
  sshHost,
  type RemoteInventory,
} from "./connectors-remote-control-test-helpers.ts";

const context = testContext();

function gateway(
  index: number,
  name: string,
  scope: ScopedCloudflareAccessConfig["scope"] = "personal",
): ScopedCloudflareAccessConfig {
  return {
    id: remoteId("c", index),
    name,
    scope,
    revision: 1,
    generation: 1,
    createdAt: REMOTE_TIMESTAMP,
    updatedAt: REMOTE_TIMESTAMP,
    sshHosts: [],
    vncHosts: [],
  };
}

function deploymentLogin(hostId: string): SshCredentialResponse {
  return {
    id: remoteId("d", 1),
    name: "Deployment login",
    username: "deploy",
    authMethod: "private_key",
    revision: 1,
    createdAt: REMOTE_TIMESTAMP,
    updatedAt: REMOTE_TIMESTAMP,
    hosts: [{ id: hostId, displayName: "Build box" }],
  };
}

function inventoryFor(
  host: SshConnectionResponse,
  gateways: ScopedCloudflareAccessConfig[],
): RemoteInventory {
  return mockRemoteInventory(context, {
    ssh: [host],
    sshCredentials: [deploymentLogin(host.id)],
    cloudflare: gateways,
  });
}

function recordUpdates(
  inventory: RemoteInventory,
  outcome: "saved" | "changed" = "saved",
): UpdateSshConnectionRequest[] {
  const updates: UpdateSshConnectionRequest[] = [];
  context.mocks.api(
    sshConnectionsContract.update,
    ({ params, body, respond }) => {
      updates.push(body);
      if (outcome === "changed") {
        return respond(409, {
          error: {
            code: SSH_ERROR_CODES.GENERATION_CONFLICT,
            message: "SSH connection was modified by another request",
          },
        });
      }
      const saved = sshHost(1, body.displayName ?? "Build box", {
        id: params.connectionId,
        host: body.host,
        port: body.port,
        generation: body.expectedGeneration + 1,
        ...(body.transport?.type === "cloudflare_access" &&
        "configId" in body.transport
          ? {
              transport: {
                type: "cloudflare_access" as const,
                configId: body.transport.configId,
              },
            }
          : {}),
      });
      inventory.ssh = [saved];
      return respond(200, saved);
    },
  );
  return updates;
}

async function choose(combobox: string, option: string): Promise<void> {
  const user = userEvent.setup({ delay: null });
  const trigger = screen.getByRole("combobox", { name: combobox });
  await user.click(trigger);
  click(await screen.findByRole("option", { name: option }));
  await waitFor(() => {
    expect(trigger).toHaveTextContent(option);
  });
}

const REBIND_GUIDANCE =
  "This host needs a new Cloudflare Access configuration. Edit it to rebind or choose Direct. It will not connect until you do.";

async function openHost(host: SshConnectionResponse): Promise<void> {
  await setupPage({
    context,
    path: `/connectors?scope=remote-control&remoteResource=ssh:${host.id}`,
  });
  await waitFor(() => {
    expect(getConnectorAction("button", "Edit connection")).toBeEnabled();
  });
}

async function openEditor(host: SshConnectionResponse): Promise<void> {
  await openHost(host);
  await editOpenHost();
}

async function editOpenHost(): Promise<void> {
  click(getConnectorAction("button", "Edit connection"));
  await expect(
    screen.findByRole("heading", { name: "Edit connection" }),
  ).resolves.toBeInTheDocument();
  click(screen.getByText("Connection settings"));
}

async function saveAndReturn(): Promise<void> {
  click(getConnectorAction("button", "Save"));
  await waitFor(() => {
    expect(getConnectorAction("button", "Edit connection")).toBeEnabled();
  });
}

test("A retained protected host requires explicit shared Access selection before saving", async () => {
  const retained = sshHost(1, "Build box", {
    host: "ssh.example.com",
    port: 443,
    generation: 3,
    transport: { type: "cloudflare_access", needsRebind: true },
  });
  const shared = gateway(1, "Team gateway", "organization");
  const inventory = inventoryFor(retained, [shared]);
  const updates = recordUpdates(inventory);
  await openHost(retained);
  expect(screen.getByText(REBIND_GUIDANCE)).toBeInTheDocument();
  await editOpenHost();
  expect(getConnectorAction("button", "Save")).toBeDisabled();

  await choose("Cloudflare Access", "Team gateway");

  expect(getConnectorAction("button", "Save")).toBeEnabled();

  await saveAndReturn();

  expect(screen.queryByText(REBIND_GUIDANCE)).not.toBeInTheDocument();
  expect(updates).toStrictEqual([
    {
      expectedGeneration: 3,
      displayName: "Build box",
      host: "ssh.example.com",
      port: 443,
      credential: { id: remoteId("d", 1) },
      transport: { type: "cloudflare_access", configId: shared.id },
    },
  ]);
});

test("Direct and protected mode retain their port and configuration drafts but submit only active fields", async () => {
  const direct = sshHost(1, "Build box", { port: 22 });
  const office = gateway(1, "Office gateway");
  const inventory = inventoryFor(direct, [office]);
  const updates = recordUpdates(inventory);
  await openEditor(direct);
  await fill(screen.getByLabelText("Port"), "2222");
  await choose("Connection", "Cloudflare Access");
  await fill(screen.getByLabelText("Published hostname"), "ssh.example.com");
  await choose("Cloudflare Access", "Office gateway");

  await choose("Connection", "Direct");

  expect(screen.getByLabelText("Port")).toHaveValue(2222);

  await choose("Connection", "Cloudflare Access");

  expect(
    screen.getByRole("combobox", { name: "Cloudflare Access" }),
  ).toHaveTextContent("Office gateway");

  await saveAndReturn();

  expect(updates).toStrictEqual([
    expect.objectContaining({
      host: "ssh.example.com",
      port: 443,
      transport: { type: "cloudflare_access", configId: office.id },
    }),
  ]);
});

test("An eligible protected host can explicitly change to Direct", async () => {
  const office = gateway(1, "Office gateway");
  const protectedHost = sshHost(1, "Build box", {
    host: "ssh.example.com",
    port: 443,
    transport: { type: "cloudflare_access", configId: office.id },
  });
  const inventory = inventoryFor(protectedHost, [office]);
  recordUpdates(inventory);
  await openEditor(protectedHost);

  await choose("Connection", "Direct");

  expect(screen.getByLabelText("Port")).toHaveValue(22);

  await saveAndReturn();
  await editOpenHost();

  expect(
    screen.getByRole("combobox", { name: "Connection" }),
  ).toHaveTextContent("Direct");
  expect(screen.getByLabelText("Port")).toHaveValue(22);
});

test("A concurrent host update preserves the binding draft and blocks stale saving", async () => {
  const office = gateway(1, "Office gateway");
  const lab = gateway(2, "Lab gateway");
  const protectedHost = sshHost(1, "Build box", {
    host: "ssh.example.com",
    port: 443,
    transport: { type: "cloudflare_access", configId: office.id },
  });
  const inventory = inventoryFor(protectedHost, [office, lab]);
  const updates = recordUpdates(inventory, "changed");
  await openEditor(protectedHost);
  const name = screen.getByLabelText(/^Connection name/);
  await fill(name, "Release box");
  await choose("Cloudflare Access", "Lab gateway");

  click(getConnectorAction("button", "Save"));

  await expect(
    screen.findByText(
      "This host changed while you were editing. Your changes were not saved; your draft is preserved.",
    ),
  ).resolves.toHaveAttribute("role", "alert");
  expect(name).toHaveValue("Release box");
  expect(
    screen.getByRole("combobox", { name: "Cloudflare Access" }),
  ).toHaveTextContent("Lab gateway");
  expect(getConnectorAction("button", "Save")).toBeDisabled();
  expect(updates).toStrictEqual([
    expect.objectContaining({
      expectedGeneration: 1,
      displayName: "Release box",
      transport: { type: "cloudflare_access", configId: lab.id },
    }),
  ]);
});
