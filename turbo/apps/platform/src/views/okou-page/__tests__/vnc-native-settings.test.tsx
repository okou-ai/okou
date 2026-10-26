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
import {
  tailscaleContract,
  type TailscaleConfig,
} from "@okouai/api-contracts/contracts/tailscale";
import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
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
async function page() {
  await setupPage({
    context,
    path: "/connectors?scope=remote-control&type=vnc",
    auth,
    featureSwitches: { [FeatureSwitchKey.VncAccess]: true },
  });
}
async function openAddHostPage() {
  await page();
  click(
    await waitFor(() => {
      return getAction("button", "Add host");
    }),
  );
}
async function choose(dialog: HTMLElement, label: string, name: string) {
  click(await within(dialog).findByLabelText(label));
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

test("Network settings can create a reusable Tailscale configuration for VNC", async () => {
  mockSettings();
  const network = mockNativeNetworks();
  let configs: TailscaleConfig[] = [];
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, { configs });
  });
  context.mocks.api(tailscaleContract.create, ({ body, respond }) => {
    const created: TailscaleConfig = {
      ...network,
      name: body.name,
      scope: body.scope ?? "personal",
      tags: body.tags,
    };
    configs = [created];
    return respond(201, created);
  });
  await setupPage({
    context,
    path: "/connectors?scope=private-network",
    auth,
    featureSwitches: {
      [FeatureSwitchKey.VncAccess]: true,
    },
  });
  const section = await screen.findByRole("region", { name: "Tailscale" });
  click(
    await waitFor(() => {
      return getAction("button", "Add Tailscale", section);
    }),
  );
  const dialog = await screen.findByRole("dialog");
  await fill(within(dialog).getByLabelText("Name"), "VNC network bootstrap");
  await fill(within(dialog).getByLabelText("Registration tags"), "tag:okou");
  await fill(
    within(dialog).getByLabelText("OAuth client ID"),
    "synthetic-client",
  );
  await fill(
    within(dialog).getByLabelText("OAuth client secret"),
    "synthetic-secret",
  );
  click(getAction("button", "Save", dialog));
  await within(section).findByText("VNC network bootstrap");
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

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
  await page();
  click(
    await waitFor(() => {
      return getAction("button", "Edit host");
    }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Edit host" });
  await fill(
    within(dialog).getByLabelText("Display name"),
    "Preserved network draft",
  );
  await fill(
    within(dialog).getByLabelText("RFB destination host"),
    "gateway.example.com",
  );
  await userEvent.click(
    within(dialog).getByRole("checkbox", { name: "Origin TLS" }),
  );
  await fill(
    within(dialog).getByLabelText("Origin TLS server name"),
    "origin.example.com",
  );
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    expect(requests).toHaveLength(1);
  });
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
  await within(dialog).findByRole("alert");
  expect(within(dialog).getByLabelText("Display name")).toHaveValue(
    "Preserved network draft",
  );
  expect(within(dialog).getByLabelText("Origin TLS server name")).toHaveValue(
    "origin.example.com",
  );
  expect(getAction("button", "Save", dialog)).toBeDisabled();
});

test("Mac Cloudflare setup requires origin TLS and keeps its protective controls", async () => {
  mockSettings({ connections: [] });
  mockNativeNetworks();
  await openAddHostPage();
  const dialog = await screen.findByRole("dialog", { name: "Add host" });
  await choose(dialog, "Security profile", "Mac VNC (classic VNC password)");
  await choose(dialog, "Connection route", "Cloudflare Access");
  const origin = within(dialog).getByRole("checkbox", { name: "Origin TLS" });
  expect(origin).toBeChecked();
  expect(origin).toHaveAttribute("aria-disabled", "true");
  click(origin);
  expect(origin).toBeChecked();
  expect(
    within(dialog).getByLabelText("Origin TLS server name"),
  ).toBeRequired();
  expect(
    within(dialog).queryByLabelText("TLS certificate identity"),
  ).toBeNull();
  expect(
    within(dialog).getByText(/other clients from reaching/u),
  ).toBeVisible();
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
  await openAddHostPage();
  const dialog = await screen.findByRole("dialog", { name: "Add host" });
  await choose(dialog, "Connection route", "Cloudflare Access");
  await choose(dialog, "Security profile", "Mac VNC (classic VNC password)");
  await choose(dialog, "Network configuration", selected.name);
  await fill(
    within(dialog).getByLabelText("Origin TLS server name"),
    "mac-origin.example.com",
  );
  await choose(dialog, "Security profile", "Encrypted VNC (X509Vnc)");
  expect(
    within(dialog).getByRole("checkbox", { name: "Origin TLS" }),
  ).toBeChecked();
  expect(within(dialog).getByLabelText("Origin TLS server name")).toHaveValue(
    "mac-origin.example.com",
  );
  await choose(dialog, "Security profile", "Mac VNC (classic VNC password)");
  expect(getAction("button", "Save", dialog)).toBeDisabled();
  await choose(dialog, "Credential", credential.name);
  expect(getAction("button", "Save", dialog)).toBeEnabled();
  await fill(within(dialog).getByLabelText("Display name"), "Native Mac");
  await fill(
    within(dialog).getByLabelText("RFB destination host"),
    "mac-gateway.example.com",
  );
  expect(within(dialog).getByLabelText("Origin TLS server name")).toHaveValue(
    "mac-origin.example.com",
  );
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    expect(requests).toHaveLength(1);
  });
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
  await screen.findByRole("heading", { name: "Native Mac" });
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
    await openAddHostPage();
    const dialog = await screen.findByRole("dialog", { name: "Add host" });
    await fill(within(dialog).getByLabelText("Display name"), "Native desktop");
    await choose(
      dialog,
      "Connection route",
      type === "cloudflare_access" ? "Cloudflare Access" : "Tailscale",
    );
    expect(getAction("button", "Save", dialog)).toBeDisabled();
    await choose(dialog, "Network configuration", network.name);
    await fill(
      within(dialog).getByLabelText("RFB destination host"),
      type === "cloudflare_access" ? "gateway.example.com" : "100.100.10.2",
    );
    await fill(
      within(dialog).getByLabelText("TLS certificate identity"),
      "inner.example.com",
    );
    expect(within(dialog).queryByLabelText("SSH host")).toBeNull();
    expect(within(dialog).getByLabelText("RFB destination port")).toHaveValue(
      type === "cloudflare_access" ? 443 : 5900,
    );
    click(getAction("button", "Save", dialog));
    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    expect(requests[0]).toMatchObject({
      transport: { type, configId: network.id },
      credential: { id: credential.id },
      security: { serverName: "inner.example.com" },
    });
    await screen.findByRole("heading", { name: "Native desktop" });
    await expect(screen.findByText(network.name)).resolves.toBeVisible();
    expect(screen.queryByText(network.id)).not.toBeInTheDocument();
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
  await page();
  click(
    await waitFor(() => {
      return getAction("button", "Edit host");
    }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Edit host" });
  expect(within(dialog).getByLabelText("Connection route")).toHaveTextContent(
    "Cloudflare Access",
  );
  expect(within(dialog).getByLabelText("Origin TLS server name")).toHaveValue(
    "origin.example.com",
  );
  expect(within(dialog).getByLabelText("TLS certificate identity")).toHaveValue(
    "inner.example.com",
  );
  expect(getAction("button", "Save", dialog)).toBeDisabled();
  await choose(dialog, "Network configuration", network.name);
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    expect(requests).toHaveLength(1);
  });
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
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Edit host" })).toBeNull();
    expect(screen.queryByText(/needs a new configuration/u)).toBeNull();
  });
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
  await page();
  click(
    await waitFor(() => {
      return getAction("button", "Edit host");
    }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Edit host" });
  expect(within(dialog).getByLabelText("Connection route")).toHaveTextContent(
    "Direct from Runner",
  );
  expect(within(dialog).getByLabelText("Separate KDC route")).toHaveTextContent(
    "Tailscale",
  );
  expect(getAction("button", "Save", dialog)).toBeDisabled();
  await choose(dialog, "Network configuration", network.name);
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    expect(requests).toHaveLength(1);
  });
  expect(requests[0]).toMatchObject({
    transport: { type: "direct" },
    credential: { id: credential.id },
    security: {
      type: "qemu_x509_gssapi",
      service: {
        realm: initiator.realm,
        components: ["vnc", "desktop.example.com"],
      },
      kdc: {
        host: "kdc.tailnet",
        port: 88,
        transport: { type: "tailscale", configId: network.id },
      },
    },
  });
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Edit host" })).toBeNull();
    expect(screen.queryByText(/needs a new configuration/u)).toBeNull();
  });
});
