import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import type { ScopedCloudflareAccessConfig } from "@okouai/api-contracts/contracts/cloudflare-access";
import {
  sshConnectionsContract,
  type CreateSshConnectionRequest,
  type SshConnectionResponse,
  type UpdateSshConnectionRequest,
} from "@okouai/api-contracts/contracts/ssh-connections";
import type { SshCredentialResponse } from "@okouai/api-contracts/contracts/ssh-credentials";
import type { TailscaleConfig } from "@okouai/api-contracts/contracts/tailscale";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
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

function tailnet(index: number, name: string): TailscaleConfig {
  return {
    id: remoteId("a", index),
    name,
    scope: "personal",
    tags: ["tag:okou"],
    revision: 1,
    generation: 1,
    createdAt: REMOTE_TIMESTAMP,
    updatedAt: REMOTE_TIMESTAMP,
    sshHosts: [],
    vncHosts: [],
  };
}

function accessGateway(
  index: number,
  name: string,
): ScopedCloudflareAccessConfig {
  return {
    id: remoteId("c", index),
    name,
    scope: "personal",
    revision: 1,
    generation: 1,
    createdAt: REMOTE_TIMESTAMP,
    updatedAt: REMOTE_TIMESTAMP,
    sshHosts: [],
    vncHosts: [],
  };
}

function deploymentLogin(
  hosts: SshCredentialResponse["hosts"] = [],
): SshCredentialResponse {
  return {
    id: remoteId("d", 1),
    name: "Deployment login",
    username: "deploy",
    authMethod: "password",
    revision: 1,
    createdAt: REMOTE_TIMESTAMP,
    updatedAt: REMOTE_TIMESTAMP,
    hosts,
  };
}

function resourcePath(kind: "ssh" | "vnc", id: string): string {
  return `/connectors?scope=remote-control&remoteResource=${kind}:${id}`;
}

function choiceButton(
  title: string,
  detail: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.textContent?.trim() === `${title}${detail}`;
  });
  if (!button) {
    throw new Error(`Expected the "${title}" choice`);
  }
  return button;
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

async function openSshSetup(): Promise<void> {
  await setupPage({ context, path: "/connectors?scope=remote-control" });
  await waitFor(() => {
    expect(getConnectorAction("button", "Add connection")).toBeEnabled();
  });
  click(getConnectorAction("button", "Add connection"));
  await waitFor(() => {
    expect(choiceButton("SSH", "Run commands on the device.")).toBeEnabled();
  });
  click(choiceButton("SSH", "Run commands on the device."));
  await expect(
    screen.findByRole("heading", { name: "Connect a computer or server" }),
  ).resolves.toBeInTheDocument();
}

async function openHostEditor(
  connection: SshConnectionResponse,
): Promise<HTMLElement> {
  await setupPage({ context, path: resourcePath("ssh", connection.id) });
  await waitFor(() => {
    expect(getConnectorAction("button", "Edit connection")).toBeEnabled();
  });
  click(getConnectorAction("button", "Edit connection"));
  return await screen.findByLabelText(/^Connection name/);
}

test("Tailscale host creation uses saved login details with a saved network", async () => {
  const network = tailnet(1, "Home tailnet");
  const login = deploymentLogin();
  const inventory = mockRemoteInventory(context, {
    tailscale: [network],
    sshCredentials: [login],
  });
  const creates: CreateSshConnectionRequest[] = [];
  context.mocks.api(sshConnectionsContract.create, ({ body, respond }) => {
    creates.push(body);
    const created = sshHost(9, body.displayName, {
      id: body.id,
      host: body.host,
      port: body.port,
      transport: { type: "tailscale", configId: network.id },
    });
    inventory.ssh = [created];
    return respond(201, created);
  });
  await openSshSetup();
  await choose("Connection method", "Home tailnet · Tailscale");
  expect(screen.getByLabelText("Password")).toBeInTheDocument();

  click(getConnectorAction("button", "Choose saved login details"));
  const picker = await screen.findByRole("dialog", {
    name: "Choose saved login details",
  });
  click(choiceButton("Deployment login", "deploy · Password", picker));

  await expect(
    screen.findByText("deploy · Password"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();

  await fill(screen.getByLabelText("Device address"), "100.64.0.2");
  click(screen.getByText("More settings"));
  await fill(screen.getByLabelText("Port"), "2022");
  click(getConnectorAction("button", "Add connection"));

  await expect(
    screen.findByRole("heading", { name: "Connection added" }),
  ).resolves.toBeInTheDocument();
  expect(creates).toStrictEqual([
    {
      id: expect.any(String),
      displayName: "100.64.0.2",
      host: "100.64.0.2",
      port: 2022,
      credential: { id: login.id },
      transport: { type: "tailscale", configId: network.id },
    },
  ]);

  click(getConnectorAction("link", "View connection"));

  await expect(
    screen.findByRole("heading", { name: "100.64.0.2", level: 2 }),
  ).resolves.toBeInTheDocument();
});

test("A saved Tailscale host retains its port, credential and learned key during editing", async () => {
  const network = tailnet(1, "Home tailnet");
  const saved = sshHost(1, "Build box", {
    host: "100.64.0.5",
    port: 2022,
    learnedHostKey: {
      algorithm: "ssh-ed25519",
      fingerprint: "SHA256:preserved",
    },
    transport: { type: "tailscale", configId: network.id },
  });
  const login = deploymentLogin([{ id: saved.id, displayName: "Build box" }]);
  const inventory = mockRemoteInventory(context, {
    ssh: [saved],
    sshCredentials: [login],
    tailscale: [network],
  });
  context.mocks.api(
    chatRemoteAccessContract.listHostDefaults,
    ({ respond }) => {
      return respond(200, {
        ssh: inventory.ssh.map((host) => {
          return {
            connectionId: host.id,
            displayName: host.displayName,
            defaultEnabled: true,
          };
        }),
        vnc: [],
      });
    },
  );
  const updates: UpdateSshConnectionRequest[] = [];
  context.mocks.api(sshConnectionsContract.update, ({ body, respond }) => {
    updates.push(body);
    const updated = {
      ...saved,
      displayName: body.displayName ?? saved.displayName,
      generation: 2,
    };
    inventory.ssh = [updated];
    return respond(200, updated);
  });
  const name = await openHostEditor(saved);
  await fill(name, "Release box");

  click(getConnectorAction("button", "Save"));

  await expect(
    screen.findByRole("heading", { name: "Release box", level: 2 }),
  ).resolves.toBeInTheDocument();
  expect(updates).toStrictEqual([
    {
      expectedGeneration: 1,
      displayName: "Release box",
      host: "100.64.0.5",
      port: 2022,
      credential: { id: login.id },
      transport: { type: "tailscale", configId: network.id },
    },
  ]);
  const fingerprint = screen.getByText("SHA256:preserved");
  expect(fingerprint).not.toBeVisible();

  click(screen.getByText("Server identity and chat permissions"));

  expect(fingerprint).toBeVisible();
});

test("Changing carriers preserves endpoint drafts and the independently selected network", async () => {
  const home = tailnet(1, "Home tailnet");
  const saved = sshHost(1, "Build box", {
    host: "100.64.0.5",
    port: 2022,
    transport: { type: "tailscale", configId: home.id },
  });
  mockRemoteInventory(context, {
    ssh: [saved],
    sshCredentials: [
      deploymentLogin([{ id: saved.id, displayName: "Build box" }]),
    ],
    tailscale: [home, tailnet(2, "Lab tailnet")],
  });
  const name = await openHostEditor(saved);
  await fill(name, "Draft box");
  click(screen.getByText("Connection settings"));
  await fill(
    screen.getByLabelText("Tailnet hostname or IP address"),
    "100.64.0.9",
  );
  await choose("Saved network", "Lab tailnet");

  await choose("Connection", "Direct");

  expect(name).toHaveValue("Draft box");
  expect(screen.getByLabelText("Public hostname or IP address")).toHaveValue(
    "100.64.0.9",
  );
  expect(
    screen.queryByRole("combobox", { name: "Saved network" }),
  ).not.toBeInTheDocument();

  await choose("Connection", "Tailscale");

  expect(name).toHaveValue("Draft box");
  expect(screen.getByLabelText("Tailnet hostname or IP address")).toHaveValue(
    "100.64.0.9",
  );
  expect(screen.getByLabelText("Port")).toHaveValue(2022);
  expect(
    screen.getByRole("combobox", { name: "Saved network" }),
  ).toHaveTextContent("Lab tailnet");
});

test("An unconfirmed SSH creation keeps its draft frozen", async () => {
  const network = tailnet(1, "Home tailnet");
  const inventory = mockRemoteInventory(context, { tailscale: [network] });
  context.mocks.api(sshConnectionsContract.create, ({ body, respond }) => {
    // The server stores the host, then fails before answering.
    inventory.ssh = [
      sshHost(9, body.displayName, {
        id: body.id,
        host: body.host,
        transport: { type: "tailscale", configId: network.id },
      }),
    ];
    return respond(500, {
      error: { code: "INTERNAL_SERVER_ERROR", message: "Internal error" },
    });
  });
  await openSshSetup();
  await choose("Connection method", "Home tailnet · Tailscale");
  const address = screen.getByLabelText("Device address");
  await fill(address, "100.64.0.2");
  const username = screen.getByLabelText("SSH username");
  await fill(username, "operator");
  const password = screen.getByLabelText("Password");
  await fill(password, "launch code");

  click(getConnectorAction("button", "Add connection"));

  await expect(screen.findByText("Save failed.")).resolves.toHaveAttribute(
    "role",
    "alert",
  );
  expect(getConnectorAction("button", "Add connection")).toBeDisabled();
  for (const [field, value] of [
    [address, "100.64.0.2"],
    [username, "operator"],
    [password, "launch code"],
  ] as const) {
    expect(field).toHaveValue(value);
    expect(field).toBeDisabled();
  }
});

test.each([
  {
    route: "tailscale",
    host: "100.64.0.7",
    port: 2022,
    shown: {
      "SSH username": "deploy",
      "Tailnet hostname or IP address": "100.64.0.7",
      Port: 2022,
    },
    hidden: [],
    network: { selector: "Saved network", option: "Home tailnet" },
  },
  {
    route: "cloudflare_access",
    host: "ssh.example.com",
    // Access hosts are stored on port 443 and the editor offers no port.
    port: 443,
    shown: {
      "SSH username": "deploy",
      "Published hostname": "ssh.example.com",
    },
    hidden: ["Port"],
    network: { selector: "Cloudflare Access", option: "Office gateway" },
  },
])(
  "A retained $route VNC dependency opens its exact SSH host for rebind",
  async ({ route, host, port, shown, hidden, network }) => {
    const retained = sshHost(1, "Build box", {
      host,
      port,
      transport:
        route === "tailscale"
          ? { type: "tailscale", needsRebind: true }
          : { type: "cloudflare_access", needsRebind: true },
    });
    const desktop = vncHost(1, "Studio desktop", {
      transport: { type: "ssh", connectionId: retained.id },
    });
    mockRemoteInventory(context, {
      ssh: [sshHost(2, "Other box"), retained],
      vnc: [desktop],
      sshCredentials: [
        deploymentLogin([{ id: retained.id, displayName: "Build box" }]),
      ],
      tailscale: [tailnet(1, "Home tailnet")],
      cloudflare: [accessGateway(1, "Office gateway")],
    });
    await setupPage({ context, path: resourcePath("vnc", desktop.id) });
    await waitFor(() => {
      expect(getConnectorAction("button", "Rebind SSH host")).toBeEnabled();
    });

    click(getConnectorAction("button", "Rebind SSH host"));

    const name = await screen.findByLabelText(/^Connection name/);
    expect(name).toHaveValue("Build box");
    for (const [label, value] of Object.entries(shown)) {
      expect(screen.getByLabelText(label)).toHaveValue(value);
    }
    for (const label of hidden) {
      expect(screen.getByLabelText(label)).not.toBeVisible();
    }
    expect(getConnectorAction("button", "Save")).toBeDisabled();

    await choose(network.selector, network.option);

    expect(getConnectorAction("button", "Save")).toBeEnabled();
  },
);
