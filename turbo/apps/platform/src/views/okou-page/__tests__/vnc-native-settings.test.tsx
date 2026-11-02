import {
  vncConnectionsContract,
  type VncConnectionResponse,
} from "@okouai/api-contracts/contracts/vnc-connections";
import {
  vncCredentialsContract,
  type VncCredentialResponse,
} from "@okouai/api-contracts/contracts/vnc-credentials";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import { tailscaleContract } from "@okouai/api-contracts/contracts/tailscale";
import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
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
import { getAction } from "./connector-integrations-test-helpers.ts";

const context = testContext();
const auth = Object.freeze({
  user: { id: "native-vnc-owner", fullName: "Native VNC Owner" },
  organization: {
    activeOrg: {
      id: "org_native_vnc_settings",
      name: "Native VNC test organization",
    },
    memberships: [{ id: "org_native_vnc_settings" }],
  },
});
const host = Object.freeze<
  Extract<VncConnectionResponse, { credentialId: string }>
>({
  id: "b0000000-0000-4000-8000-000000000001",
  displayName: "Native workstation",
  host: "desktop.example.com",
  port: 5900,
  credentialId: "d0000000-0000-4000-8000-000000000001",
  credentialName: "Desktop login",
  security: { type: "x509_vnc", trust: { mode: "system" } },
  generation: 4,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
});
const credential = Object.freeze<VncCredentialResponse>({
  id: host.credentialId,
  name: host.credentialName,
  authMethod: "vnc_password",
  revision: 3,
  hosts: [{ id: host.id, displayName: host.displayName }],
  createdAt: host.createdAt,
  updatedAt: host.updatedAt,
});
function mockSettings(
  options: {
    connections?: VncConnectionResponse[];
    credentials?: VncCredentialResponse[];
  } = {},
) {
  const data = {
    connections: options.connections ?? [host],
    credentials: options.credentials ?? [credential],
  };
  context.mocks.api(vncConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: data.connections.length });
  });
  context.mocks.api(vncConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: data.connections });
  });
  context.mocks.api(vncCredentialsContract.list, ({ respond }) => {
    return respond(200, { credentials: data.credentials });
  });
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [] });
  });
  context.mocks.api(
    chatRemoteAccessContract.listHostDefaults,
    ({ respond }) => {
      return respond(200, {
        ssh: [],
        vnc: data.connections.map((connection) => {
          return {
            connectionId: connection.id,
            displayName: connection.displayName,
            defaultEnabled: false,
          };
        }),
      });
    },
  );
  return data;
}
async function page(path = "/connectors?scope=remote-control") {
  await setupPage({ context, path, auth });
}
function getVncForm() {
  const form = screen.getByLabelText(/Connection name/u).closest("form");
  if (!form) {
    throw new Error("Expected the inline VNC connection form");
  }
  return form;
}
async function openAddHostPage() {
  await page("/connectors?scope=remote-control&setup=vnc");
  await screen.findByRole("heading", { name: "Add remote connection" });
  click(
    screen.getByText("Control the device’s screen with a mouse and keyboard."),
  );
  await screen.findByRole("heading", { name: "Choose a VNC login method" });
  return getVncForm();
}
async function openEditHostPage() {
  await page(`/connectors?scope=remote-control&remoteResource=vnc:${host.id}`);
  await screen.findByRole("heading", { name: host.displayName });
  click(getAction("button", "Edit connection"));
  await screen.findByRole("heading", { name: "Edit connection" });
  const form = getVncForm();
  click(within(form).getByText("Connection settings", { selector: "summary" }));
  return form;
}
async function chooseSavedLogin(form: HTMLElement) {
  click(getAction("button", "Choose saved login details", form));
  const picker = await screen.findByRole("dialog", {
    name: "Choose saved login details",
  });
  click(within(picker).getByText(host.displayName));
  await within(form).findByText(host.displayName);
}
async function choose(form: HTMLElement, label: string, name: string) {
  click(within(form).getByLabelText(label));
  const option = await waitFor(() => {
    const matches = queryAllByRoleFast("option").filter((candidate) => {
      return candidate.textContent?.replace(/\s+/gu, " ").trim() === name;
    });
    const [match] = matches;
    if (matches.length !== 1 || !match) {
      throw new Error(`Expected one option named "${name}"`);
    }
    expect(match).toBeVisible();
    expect(match).toHaveAccessibleName(name);
    return match;
  });
  click(option);
  await waitFor(() => {
    expect(within(form).getByLabelText(label)).toHaveTextContent(name);
  });
}

function mockNativeNetworks() {
  const network = {
    id: host.id,
    name: "Shared desktop network",
    scope: "organization" as const,
    revision: 1,
    generation: 1,
    sshHosts: [],
    vncHosts: [],
    createdAt: host.createdAt,
    updatedAt: host.updatedAt,
  };
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [network] });
  });
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, { configs: [{ ...network, tags: ["tag:okou"] }] });
  });
  return network;
}

test("A rejected native configuration preserves the draft and both trust layers", async () => {
  const selected = mockNativeNetworks();
  const original: VncConnectionResponse = {
    ...host,
    port: 443,
    transport: {
      type: "cloudflare_access",
      configId: selected.id,
    },
    security: {
      type: "x509_vnc",
      serverName: "inner.example.com",
      trust: { mode: "custom_ca", caBundle: "INNER_CA_CANARY" },
    },
  };
  mockSettings({ connections: [original] });
  const available = [
    {
      ...selected,
      vncHosts: [
        {
          id: original.id,
          displayName: original.displayName,
          roles: ["rfb" as const],
        },
      ],
    },
  ];
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: available });
  });
  const requests: unknown[] = [];
  context.mocks.api(vncConnectionsContract.update, ({ body, respond }) => {
    requests.push(body);
    return respond(404, {
      error: { code: "VNC_UNAVAILABLE", message: "Network unavailable" },
    });
  });
  const form = await openEditHostPage();
  await fill(
    within(form).getByLabelText(/Connection name/u),
    "Preserved network draft",
  );
  await fill(
    within(form).getByLabelText("Device address"),
    "gateway.example.com",
  );
  click(
    within(form).getByText("Additional network settings", {
      selector: "summary",
    }),
  );
  await userEvent.click(
    within(form).getByRole("checkbox", { name: "Origin TLS" }),
  );
  await fill(
    await within(form).findByLabelText("Origin TLS server name"),
    "origin.example.com",
  );
  click(getAction("button", "Save", form));
  await within(form).findByRole("alert");
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    displayName: "Preserved network draft",
    host: "gateway.example.com",
    port: 443,
    expectedGeneration: original.generation,
    transport: {
      type: "cloudflare_access",
      configId: selected.id,
      originTls: {
        serverName: "origin.example.com",
        trust: { mode: "system" },
      },
    },
    credential: { id: credential.id },
    security: original.security,
  });
  expect(within(form).getByLabelText(/Connection name/u)).toHaveValue(
    "Preserved network draft",
  );
  expect(within(form).getByLabelText("Device address")).toHaveValue(
    "gateway.example.com",
  );
  expect(within(form).getByLabelText("Origin TLS server name")).toHaveValue(
    "origin.example.com",
  );
  expect(within(form).getByLabelText("VNC certificate name")).toHaveValue(
    "inner.example.com",
  );
  expect(within(form).getByLabelText("CA certificates (PEM)")).toHaveValue(
    "INNER_CA_CANARY",
  );
  expect(getAction("button", "Save", form)).toBeDisabled();
});

test("Mac Cloudflare setup requires origin TLS and keeps its protective controls", async () => {
  mockSettings({ connections: [] });
  const network = mockNativeNetworks();
  const form = await openAddHostPage();
  await choose(form, "Service type", "Apple screen sharing");
  await choose(form, "Login method", "Mac VNC (classic VNC password)");
  click(getAction("button", "Continue", form));
  await screen.findByRole("heading", { name: "Connect a device" });
  await choose(form, "Connection method", "Cloudflare Access");
  await choose(form, "Saved network", network.name);
  const origin = within(form).getByRole("checkbox", { name: "Origin TLS" });
  expect(origin).toBeChecked();
  expect(origin).toHaveAttribute("aria-disabled", "true");
  await userEvent.click(origin);
  expect(origin).toBeChecked();
  expect(within(form).getByLabelText("Origin TLS server name")).toBeRequired();
  expect(within(form).queryByLabelText("VNC certificate name")).toBeNull();
  click(getAction("button", "Back"));
  await screen.findByRole("heading", { name: "Choose a VNC login method" });
  click(
    within(form).getByText("Protocol and security details", {
      selector: "summary",
    }),
  );
  expect(within(form).getByText(/other clients from reaching/u)).toBeVisible();
});

test("Mac Cloudflare setup requires independently named origin TLS and keeps the RFB authentication profile", async () => {
  const data = mockSettings({ connections: [] });
  const selected = mockNativeNetworks();
  const requests: unknown[] = [];
  context.mocks.api(vncConnectionsContract.create, ({ body, respond }) => {
    requests.push(body);
    const created: VncConnectionResponse = {
      ...host,
      id: body.id,
      displayName: body.displayName,
      host: body.host,
      port: body.port,
      security: { type: "apple_vnc_password" },
      transport: {
        type: "cloudflare_access",
        configId: selected.id,
        originTls: {
          serverName: "mac-origin.example.com",
          trust: { mode: "system" },
        },
      },
    };
    data.connections = [created];
    return respond(201, created);
  });
  const form = await openAddHostPage();
  await choose(form, "Service type", "Apple screen sharing");
  await choose(form, "Login method", "Mac VNC (classic VNC password)");
  click(getAction("button", "Continue", form));
  await screen.findByRole("heading", { name: "Connect a device" });
  await choose(form, "Connection method", "Cloudflare Access");
  await within(form).findByLabelText("Saved network");
  await choose(form, "Saved network", selected.name);
  await fill(
    within(form).getByLabelText("Origin TLS server name"),
    "mac-origin.example.com",
  );
  await fill(
    within(form).getByLabelText("Device address"),
    "mac-gateway.example.com",
  );
  click(getAction("button", "Back"));
  await screen.findByRole("heading", { name: "Choose a VNC login method" });
  await choose(form, "Service type", "Certificate-based VNC");
  click(getAction("button", "Continue", form));
  await screen.findByRole("heading", { name: "Connect a device" });
  click(
    within(form).getByText("Additional network settings", {
      selector: "summary",
    }),
  );
  expect(
    within(form).getByRole("checkbox", { name: "Origin TLS" }),
  ).toBeChecked();
  expect(within(form).getByLabelText("Origin TLS server name")).toHaveValue(
    "mac-origin.example.com",
  );
  click(getAction("button", "Back"));
  await screen.findByRole("heading", { name: "Choose a VNC login method" });
  await choose(form, "Service type", "Apple screen sharing");
  await choose(form, "Login method", "Mac VNC (classic VNC password)");
  click(getAction("button", "Continue", form));
  await screen.findByRole("heading", { name: "Connect a device" });
  expect(within(form).getByLabelText("Device address")).toHaveValue(
    "mac-gateway.example.com",
  );
  expect(within(form).getByLabelText("Origin TLS server name")).toHaveValue(
    "mac-origin.example.com",
  );
  click(getAction("button", "Continue", form));
  await screen.findByRole("heading", {
    name: "Enter device login information",
  });
  await fill(within(form).getByLabelText(/Connection name/u), "Native Mac");
  await chooseSavedLogin(form);
  click(getAction("button", "Continue", form));
  await screen.findByRole("heading", { name: "Review and save" });
  expect(getAction("button", "Save", form)).toBeEnabled();
  click(getAction("button", "Save", form));
  await screen.findByRole("heading", { name: "Connection added" });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    host: "mac-gateway.example.com",
    port: 443,
    credential: { id: credential.id },
    security: { type: "apple_vnc_password" },
    transport: {
      type: "cloudflare_access",
      configId: selected.id,
      originTls: {
        serverName: "mac-origin.example.com",
        trust: { mode: "system" },
      },
    },
  });
  expect(screen.getByText("Native Mac")).toBeInTheDocument();
});

test.each(["cloudflare_access", "tailscale"] as const)(
  "Native %s creation selects a scoped network without an SSH dependency",
  async (type) => {
    const data = mockSettings({ connections: [] });
    const network = mockNativeNetworks();
    const requests: unknown[] = [];
    context.mocks.api(vncConnectionsContract.create, ({ body, respond }) => {
      requests.push(body);
      const created: VncConnectionResponse = {
        ...host,
        id: body.id,
        displayName: body.displayName,
        host: body.host,
        port: body.port,
        transport:
          type === "cloudflare_access"
            ? { type: "cloudflare_access", configId: network.id }
            : { type: "tailscale", configId: network.id },
        security: {
          type: "x509_vnc",
          serverName: "inner.example.com",
          trust: { mode: "system" },
        },
      };
      data.connections = [created];
      return respond(201, created);
    });
    const form = await openAddHostPage();
    click(getAction("button", "Continue", form));
    await screen.findByRole("heading", { name: "Connect a device" });
    const provider =
      type === "cloudflare_access" ? "Cloudflare Access" : "Tailscale";
    await choose(form, "Connection method", provider);
    expect(getAction("button", "Continue", form)).toBeDisabled();
    await within(form).findByLabelText("Saved network");
    await choose(form, "Saved network", network.name);
    await fill(
      within(form).getByLabelText("Device address"),
      type === "cloudflare_access" ? "gateway.example.com" : "100.100.10.2",
    );
    expect(within(form).queryByLabelText("SSH host")).toBeNull();
    click(within(form).getByText("More settings", { selector: "summary" }));
    expect(within(form).getByLabelText("Port")).toHaveValue(
      type === "cloudflare_access" ? 443 : 5900,
    );
    click(getAction("button", "Continue", form));
    await screen.findByRole("heading", {
      name: "Enter device login information",
    });
    await fill(
      within(form).getByLabelText(/Connection name/u),
      "Native desktop",
    );
    await chooseSavedLogin(form);
    click(getAction("button", "Continue", form));
    await screen.findByRole("heading", { name: "Review and save" });
    await fill(
      within(form).getByLabelText("VNC certificate name"),
      "inner.example.com",
    );
    expect(
      within(form).getByText(`${provider} · ${network.name}`, {
        selector: "dd",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText(network.id)).not.toBeInTheDocument();
    click(getAction("button", "Save", form));
    await screen.findByRole("heading", { name: "Connection added" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      transport: { type, configId: network.id },
      credential: { id: credential.id },
      displayName: "Native desktop",
      host:
        type === "cloudflare_access" ? "gateway.example.com" : "100.100.10.2",
      port: type === "cloudflare_access" ? 443 : 5900,
      security: {
        type: "x509_vnc",
        serverName: "inner.example.com",
        trust: { mode: "system" },
      },
    });
    expect(screen.getByText("Native desktop")).toBeInTheDocument();
  },
);

test("Detached native editing preserves both trust layers and requires explicit rebind", async () => {
  const detached: VncConnectionResponse = {
    ...host,
    host: "gateway.example.com",
    port: 443,
    transport: {
      type: "cloudflare_access",
      needsRebind: true,
      originTls: {
        serverName: "origin.example.com",
        trust: { mode: "custom_ca", caBundle: "ORIGIN_CA_CANARY" },
      },
    },
    security: {
      type: "x509_vnc",
      serverName: "inner.example.com",
      trust: { mode: "custom_ca", caBundle: "INNER_CA_CANARY" },
    },
  };
  const data = mockSettings({ connections: [detached] });
  const network = mockNativeNetworks();
  const requests: unknown[] = [];
  context.mocks.api(vncConnectionsContract.update, ({ body, respond }) => {
    requests.push(body);
    const updated: VncConnectionResponse = {
      ...detached,
      generation: detached.generation + 1,
      transport: {
        type: "cloudflare_access",
        configId: network.id,
        originTls: {
          serverName: "origin.example.com",
          trust: { mode: "custom_ca", caBundle: "ORIGIN_CA_CANARY" },
        },
      },
    };
    data.connections = [updated];
    return respond(200, updated);
  });
  const form = await openEditHostPage();
  expect(within(form).getByLabelText("Connection method")).toHaveTextContent(
    "Cloudflare Access",
  );
  click(
    within(form).getByText("Additional network settings", {
      selector: "summary",
    }),
  );
  expect(within(form).getByLabelText("Origin TLS server name")).toHaveValue(
    "origin.example.com",
  );
  expect(within(form).getByLabelText("VNC certificate name")).toHaveValue(
    "inner.example.com",
  );
  expect(within(form).getByLabelText("Origin TLS CA certificates")).toHaveValue(
    "ORIGIN_CA_CANARY",
  );
  expect(within(form).getByLabelText("CA certificates (PEM)")).toHaveValue(
    "INNER_CA_CANARY",
  );
  expect(getAction("button", "Save", form)).toBeDisabled();
  await choose(form, "Saved network", network.name);
  click(getAction("button", "Save", form));
  await screen.findByRole("heading", { name: detached.displayName });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    expectedGeneration: detached.generation,
    transport: {
      type: "cloudflare_access",
      configId: network.id,
      originTls: {
        serverName: "origin.example.com",
        trust: { mode: "custom_ca", caBundle: "ORIGIN_CA_CANARY" },
      },
    },
    credential: { id: credential.id },
    security: detached.security,
  });
  expect(screen.queryByRole("heading", { name: "Edit connection" })).toBeNull();
  expect(screen.queryByText(/needs a new configuration/u)).toBeNull();
});

test("Independent native KDC rebinding keeps the Direct desktop route and Kerberos credential", async () => {
  const initiator = { realm: "EXAMPLE.COM", components: ["operator"] };
  const savedCredential: VncCredentialResponse = {
    ...credential,
    authMethod: "qemu_kerberos_password",
    initiator,
  };
  const original: VncConnectionResponse = {
    ...host,
    kerberosAuthentication: "qemu_kerberos_password",
    security: {
      type: "qemu_x509_gssapi",
      trust: { mode: "system" },
      service: {
        realm: initiator.realm,
        components: ["vnc", "desktop.example.com"],
      },
      kdc: {
        host: "kdc.tailnet",
        port: 88,
        transport: { type: "tailscale", needsRebind: true },
        ticketLifetimeSeconds: 1200,
        renewableLifetimeSeconds: 7200,
      },
    },
  };
  const data = mockSettings({
    connections: [original],
    credentials: [savedCredential],
  });
  const network = mockNativeNetworks();
  const requests: unknown[] = [];
  context.mocks.api(vncConnectionsContract.update, ({ body, respond }) => {
    requests.push(body);
    if (body.security?.type !== "qemu_x509_gssapi") {
      throw new Error("Expected a Kerberos draft");
    }
    const updated: VncConnectionResponse = {
      ...original,
      generation: 5,
      security: body.security,
    };
    data.connections = [updated];
    return respond(200, updated);
  });
  const form = await openEditHostPage();
  expect(within(form).getByLabelText("Connection method")).toHaveTextContent(
    "Direct connection",
  );
  expect(within(form).getByLabelText("Separate KDC route")).toHaveTextContent(
    "Tailscale",
  );
  expect(getAction("button", "Save", form)).toBeDisabled();
  await choose(form, "Saved network", network.name);
  click(getAction("button", "Save", form));
  await screen.findByRole("heading", { name: original.displayName });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    transport: { type: "direct" },
    credential: { id: credential.id },
    security: {
      type: "qemu_x509_gssapi",
      service: {
        realm: initiator.realm,
        components: ["vnc", "desktop.example.com"],
      },
      trust: { mode: "system" },
      kdc: {
        host: "kdc.tailnet",
        port: 88,
        transport: { type: "tailscale", configId: network.id },
        ticketLifetimeSeconds: 1200,
        renewableLifetimeSeconds: 7200,
      },
    },
  });
  expect(screen.queryByRole("heading", { name: "Edit connection" })).toBeNull();
  expect(screen.queryByText(/needs a new configuration/u)).toBeNull();
});
