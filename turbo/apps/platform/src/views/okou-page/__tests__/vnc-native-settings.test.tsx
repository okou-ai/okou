import type { ScopedCloudflareAccessConfig } from "@okouai/api-contracts/contracts/cloudflare-access";
import {
  vncConnectionsContract,
  type CreateVncConnectionRequest,
  type UpdateVncConnectionRequest,
  type VncConnectionResponse,
} from "@okouai/api-contracts/contracts/vnc-connections";
import type { VncCredentialResponse } from "@okouai/api-contracts/contracts/vnc-credentials";
import { VNC_ERROR_CODES } from "@okouai/api-contracts/contracts/vnc-errors";
import { screen, waitFor, within } from "@testing-library/react";
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
  vncHost,
  type RemoteInventory,
} from "./connectors-remote-control-test-helpers.ts";

const context = testContext();
const INNER_CA =
  "-----BEGIN CERTIFICATE-----\nMIIBinner\n-----END CERTIFICATE-----";
const ORIGIN_CA =
  "-----BEGIN CERTIFICATE-----\nMIIBorigin\n-----END CERTIFICATE-----";
const GATEWAY_ID = remoteId("c", 1);
const LOGIN_ID = remoteId("f", 1);

function officeGateway(): ScopedCloudflareAccessConfig {
  return {
    id: GATEWAY_ID,
    name: "Office gateway",
    scope: "personal",
    revision: 1,
    generation: 1,
    createdAt: REMOTE_TIMESTAMP,
    updatedAt: REMOTE_TIMESTAMP,
    sshHosts: [],
    vncHosts: [],
  };
}

function desktopLogin(
  hosts: VncCredentialResponse["hosts"],
): VncCredentialResponse {
  return {
    id: LOGIN_ID,
    name: "Desktop login",
    authMethod: "vnc_password",
    revision: 1,
    createdAt: REMOTE_TIMESTAMP,
    updatedAt: REMOTE_TIMESTAMP,
    hosts,
  };
}

function protectedDesktop(
  transport: VncConnectionResponse["transport"],
): VncConnectionResponse {
  return vncHost(1, "Studio desktop", {
    host: "gateway.example.com",
    port: 443,
    credentialId: LOGIN_ID,
    credentialName: "Desktop login",
    security: {
      type: "x509_vnc",
      trust: { mode: "custom_ca", caBundle: INNER_CA },
      serverName: "desktop.internal",
    },
    transport,
  });
}

function inventoryWith(vnc: VncConnectionResponse[]): RemoteInventory {
  return mockRemoteInventory(context, {
    vnc,
    cloudflare: [officeGateway()],
    vncCredentials: [
      desktopLogin(
        vnc.map((host) => {
          return { id: host.id, displayName: host.displayName };
        }),
      ),
    ],
  });
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

async function editDesktop(desktop: VncConnectionResponse): Promise<void> {
  await setupPage({
    context,
    path: `/connectors?scope=remote-control&remoteResource=vnc:${desktop.id}`,
  });
  await waitFor(() => {
    expect(getConnectorAction("button", "Edit connection")).toBeEnabled();
  });
  click(getConnectorAction("button", "Edit connection"));
  await expect(
    screen.findByRole("heading", { name: "Edit connection" }),
  ).resolves.toBeInTheDocument();
}

function vncChoice(): HTMLElement {
  const choice = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.trim().startsWith("VNC");
  });
  if (!choice) {
    throw new Error("Expected the VNC setup choice");
  }
  return choice;
}

async function startVncSetup(): Promise<void> {
  await setupPage({ context, path: "/connectors?scope=remote-control" });
  await waitFor(() => {
    expect(getConnectorAction("button", "Add connection")).toBeEnabled();
  });
  click(getConnectorAction("button", "Add connection"));
  await waitFor(() => {
    expect(vncChoice()).toBeEnabled();
  });
  click(vncChoice());
  await expect(
    screen.findByRole("heading", { name: "Choose a VNC login method" }),
  ).resolves.toBeInTheDocument();
}

async function continueTo(heading: string): Promise<void> {
  click(getConnectorAction("button", "Continue"));
  await expect(
    screen.findByRole("heading", { name: heading }),
  ).resolves.toBeInTheDocument();
}

test("A rejected native configuration preserves the draft and both trust layers", async () => {
  const desktop = protectedDesktop({
    type: "cloudflare_access",
    configId: GATEWAY_ID,
    originTls: { serverName: "origin.example.com", trust: { mode: "system" } },
  });
  inventoryWith([desktop]);
  const update: { body?: UpdateVncConnectionRequest } = {};
  context.mocks.api(vncConnectionsContract.update, ({ body, respond }) => {
    update.body = body;
    return respond(404, {
      error: {
        code: VNC_ERROR_CODES.CONNECTION_NOT_FOUND,
        message: "VNC connection not found",
      },
    });
  });
  await editDesktop(desktop);
  const name = screen.getByLabelText(/^Connection name/);
  await fill(name, "Studio desktop 2");
  const address = screen.getByLabelText("Device address");
  await fill(address, "desk.example.com");
  const originName = screen.getByLabelText("Origin TLS server name");
  await fill(originName, "origin2.example.com");

  click(getConnectorAction("button", "Save"));

  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "This host is no longer available.",
  );
  expect(getConnectorAction("button", "Save")).toBeDisabled();
  expect(name).toHaveValue("Studio desktop 2");
  expect(address).toHaveValue("desk.example.com");
  expect(originName).toHaveValue("origin2.example.com");
  expect(
    screen.getByRole("combobox", { name: "Origin TLS certificate trust" }),
  ).toHaveTextContent("System certificate authorities");
  expect(
    screen.getByRole("combobox", { name: "Server certificate trust" }),
  ).toHaveTextContent("Custom certificate authorities");
  expect(screen.getByLabelText("CA certificates (PEM)")).toHaveValue(INNER_CA);
  expect(update.body).toMatchObject({
    displayName: "Studio desktop 2",
    host: "desk.example.com",
    security: {
      type: "x509_vnc",
      trust: { mode: "custom_ca", caBundle: INNER_CA },
      serverName: "desktop.internal",
    },
    transport: {
      type: "cloudflare_access",
      configId: GATEWAY_ID,
      originTls: {
        serverName: "origin2.example.com",
        trust: { mode: "system" },
      },
    },
  });
});

test("Mac Cloudflare setup requires origin TLS and keeps its protective controls", async () => {
  inventoryWith([]);
  const user = userEvent.setup({ delay: null });
  await startVncSetup();
  await choose("Service type", "Apple screen sharing");
  await choose("Login method", "Mac VNC (classic VNC password)");
  await continueTo("Connect a device");
  await choose("Connection method", "Cloudflare Access");
  await choose("Saved network", "Office gateway");
  const originTls = screen.getByRole("checkbox", { name: "Origin TLS" });
  expect(originTls).toHaveAttribute("aria-checked", "true");

  await user.click(originTls);

  expect(originTls).toHaveAttribute("aria-checked", "true");
  expect(originTls).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByLabelText("Origin TLS server name")).toBeRequired();
  expect(screen.queryByLabelText("VNC certificate name")).toBeNull();

  click(getConnectorAction("button", "Back"));

  await expect(
    screen.findByRole("heading", { name: "Choose a VNC login method" }),
  ).resolves.toBeInTheDocument();
  const details = screen
    .getByText("Protocol and security details", { selector: "summary" })
    .closest("details");
  if (!details) {
    throw new Error("Expected the protocol and security details");
  }
  click(within(details).getByText("Protocol and security details"));
  expect(details).toHaveTextContent(
    "Protecting this connection does not prevent other clients from reaching the Mac's VNC listener.",
  );
});

test("Native cloudflare_access creation selects a scoped network without an SSH dependency", async () => {
  const inventory = inventoryWith([]);
  const created: { body?: CreateVncConnectionRequest } = {};
  context.mocks.api(vncConnectionsContract.create, ({ body, respond }) => {
    created.body = body;
    const connection = vncHost(1, body.displayName, {
      id: body.id,
      host: body.host,
      port: body.port,
      credentialId: LOGIN_ID,
      credentialName: "Desktop login",
      security: {
        type: "x509_vnc",
        trust: { mode: "system" },
        serverName: "gateway.example.com",
      },
      transport: { type: "cloudflare_access", configId: GATEWAY_ID },
    });
    inventory.vnc = [connection];
    return respond(201, connection);
  });
  await startVncSetup();
  await continueTo("Connect a device");

  await choose("Connection method", "Cloudflare Access");

  expect(getConnectorAction("button", "Continue")).toBeDisabled();
  expect(screen.queryByRole("combobox", { name: "SSH host" })).toBeNull();
  expect(screen.getByLabelText("Port")).toHaveValue(443);

  await choose("Saved network", "Office gateway");
  await fill(screen.getByLabelText("Device address"), "gateway.example.com");
  await continueTo("Enter device login information");
  click(getConnectorAction("button", "Choose saved login details"));
  const chooser = await screen.findByRole("dialog", {
    name: "Choose saved login details",
  });
  const savedLogin = queryAllByRoleFast("button", chooser).find((choice) => {
    return choice.textContent?.trim().startsWith("Desktop login");
  });
  if (!savedLogin) {
    throw new Error("Expected the saved desktop login");
  }
  click(savedLogin);
  await fill(screen.getByLabelText(/^Connection name/), "Gateway desktop");
  await continueTo("Review and save");

  expect(
    screen.getByText("Cloudflare Access · Office gateway"),
  ).toBeInTheDocument();
  expect(document.querySelector("main")).not.toHaveTextContent(GATEWAY_ID);

  await fill(
    screen.getByLabelText("VNC certificate name"),
    "gateway.example.com",
  );
  click(getConnectorAction("button", "Save"));

  await expect(
    screen.findByRole("heading", { name: "Connection added" }),
  ).resolves.toBeInTheDocument();
  expect(created.body).toMatchObject({
    displayName: "Gateway desktop",
    host: "gateway.example.com",
    port: 443,
    credential: { id: LOGIN_ID },
    security: {
      type: "x509_vnc",
      trust: { mode: "system" },
      serverName: "gateway.example.com",
    },
    transport: { type: "cloudflare_access", configId: GATEWAY_ID },
  });
});

test("Detached native editing preserves both trust layers and requires explicit rebind", async () => {
  const detached = protectedDesktop({
    type: "cloudflare_access",
    needsRebind: true,
    originTls: {
      serverName: "origin.example.com",
      trust: { mode: "custom_ca", caBundle: ORIGIN_CA },
    },
  });
  const inventory = inventoryWith([detached]);
  const update: { body?: UpdateVncConnectionRequest } = {};
  context.mocks.api(
    vncConnectionsContract.update,
    ({ params, body, respond }) => {
      update.body = body;
      const rebound = protectedDesktop({
        type: "cloudflare_access",
        configId: GATEWAY_ID,
        originTls: {
          serverName: "origin.example.com",
          trust: { mode: "custom_ca", caBundle: ORIGIN_CA },
        },
      });
      const saved = { ...rebound, id: params.connectionId, generation: 2 };
      inventory.vnc = [saved];
      return respond(200, saved);
    },
  );
  await editDesktop(detached);

  expect(screen.getByLabelText("Origin TLS server name")).toHaveValue(
    "origin.example.com",
  );
  expect(screen.getByLabelText(/^Origin TLS CA certificates/)).toHaveValue(
    ORIGIN_CA,
  );
  expect(screen.getByLabelText("VNC certificate name")).toHaveValue(
    "desktop.internal",
  );
  expect(screen.getByLabelText("CA certificates (PEM)")).toHaveValue(INNER_CA);
  expect(getConnectorAction("button", "Save")).toBeDisabled();

  await choose("Saved network", "Office gateway");

  expect(getConnectorAction("button", "Save")).toBeEnabled();

  click(getConnectorAction("button", "Save"));

  await waitFor(() => {
    expect(getConnectorAction("button", "Edit connection")).toBeEnabled();
  });
  expect(
    screen.queryByRole("heading", { name: "Edit connection" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText(
      "This private-network route needs a new configuration. It cannot connect until it is rebound.",
    ),
  ).not.toBeInTheDocument();
  expect(update.body).toMatchObject({
    credential: { id: LOGIN_ID },
    security: {
      type: "x509_vnc",
      trust: { mode: "custom_ca", caBundle: INNER_CA },
      serverName: "desktop.internal",
    },
    transport: {
      type: "cloudflare_access",
      configId: GATEWAY_ID,
      originTls: {
        serverName: "origin.example.com",
        trust: { mode: "custom_ca", caBundle: ORIGIN_CA },
      },
    },
  });
});
