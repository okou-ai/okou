import {
  vncConnectionsContract,
  type VncConnectionResponse,
} from "@okouai/api-contracts/contracts/vnc-connections";
import {
  sshConnectionsContract,
  type SshConnectionResponse,
} from "@okouai/api-contracts/contracts/ssh-connections";
import {
  vncCredentialsContract,
  type VncCredentialResponse,
} from "@okouai/api-contracts/contracts/vnc-credentials";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { VNC_RSA_AES_SECURITY_TYPES } from "@okouai/api-contracts/contracts/vnc-rsa-aes";
import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { mockNow } from "../../../lib/time.ts";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getAction,
  queryAction,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();
const auth = Object.freeze({
  user: { id: "vnc-owner", fullName: "VNC Owner" },
  organization: {
    activeOrg: { id: "org_vnc_settings", name: "VNC test organization" },
    memberships: [{ id: "org_vnc_settings" }],
  },
});
type CredentialedVncConnection = Extract<
  VncConnectionResponse,
  { credentialId: string }
>;
const host = Object.freeze<CredentialedVncConnection>({
  id: "b0000000-0000-4000-8000-000000000001",
  displayName: "Design workstation",
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
type PlainCredential = Extract<
  VncCredentialResponse,
  { authMethod: "username_password" }
>;
const plainHost = Object.freeze<CredentialedVncConnection>({
  ...host,
  id: "b0000000-0000-4000-8000-000000000002",
  displayName: "Plain workstation",
  host: "plain.example.com",
  credentialId: "d0000000-0000-4000-8000-000000000002",
  credentialName: "Plain login",
  security: { type: "x509_plain", trust: { mode: "system" } },
});
const plainCredential = Object.freeze<PlainCredential>({
  id: plainHost.credentialId,
  name: plainHost.credentialName,
  authMethod: "username_password",
  username: "operator",
  revision: 2,
  hosts: [{ id: plainHost.id, displayName: plainHost.displayName }],
  createdAt: plainHost.createdAt,
  updatedAt: plainHost.updatedAt,
});
type QemuScramCredential = Extract<
  VncCredentialResponse,
  { authMethod: "qemu_scram_sha256" }
>;
const qemuHost = Object.freeze<CredentialedVncConnection>({
  ...plainHost,
  id: "b0000000-0000-4000-8000-000000000009",
  displayName: "QEMU workstation",
  credentialId: "d0000000-0000-4000-8000-000000000009",
  credentialName: "QEMU SCRAM login",
  security: { type: "qemu_x509_sasl", trust: { mode: "system" } },
});
const qemuCredential = Object.freeze<QemuScramCredential>({
  id: qemuHost.credentialId,
  name: qemuHost.credentialName,
  authMethod: "qemu_scram_sha256",
  username: "operator",
  revision: 1,
  hosts: [{ id: qemuHost.id, displayName: qemuHost.displayName }],
  createdAt: qemuHost.createdAt,
  updatedAt: qemuHost.updatedAt,
});
const caBundle =
  "-----BEGIN CERTIFICATE-----\nTEST-CA-CERTIFICATE\n-----END CERTIFICATE-----\n";
const sshHost = Object.freeze<SshConnectionResponse>({
  id: "a0000000-0000-4000-8000-000000000001",
  displayName: "Desktop gateway",
  host: "gateway.example.com",
  port: 22,
  username: "deploy",
  credentialId: "c0000000-0000-4000-8000-000000000001",
  credentialName: "Gateway login",
  generation: 2,
  learnedHostKey: null,
  createdAt: host.createdAt,
  updatedAt: host.updatedAt,
});
const tunneledHost = Object.freeze<CredentialedVncConnection>({
  ...host,
  id: "b0000000-0000-4000-8000-000000000003",
  displayName: "Private desktop",
  host: "127.0.0.1",
  port: 5901,
  security: {
    type: "x509_vnc",
    trust: { mode: "system" },
    serverName: "desktop.internal.example.com",
  },
  transport: { type: "ssh", connectionId: sshHost.id },
});

function mockSettings(
  options: {
    connections?: VncConnectionResponse[];
    credentials?: VncCredentialResponse[];
    sshConnections?: SshConnectionResponse[];
  } = {},
) {
  const data = {
    connections: options.connections ?? [host],
    credentials: options.credentials ?? [credential],
    sshConnections: options.sshConnections ?? [],
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
    return respond(200, { connections: data.sshConnections });
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

async function page(path = "/connectors?scope=remote-control&type=vnc") {
  await setupPage({
    context,
    path,
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

test("VNC host settings update the chat remote access default", async () => {
  mockSettings();
  let enabled = false;
  context.mocks.api(
    chatRemoteAccessContract.listHostDefaults,
    ({ respond }) => {
      return respond(200, {
        ssh: [],
        vnc: [
          {
            connectionId: host.id,
            displayName: host.displayName,
            defaultEnabled: enabled,
          },
        ],
      });
    },
  );
  context.mocks.api(
    chatRemoteAccessContract.updateHostDefault,
    ({ params, body, respond }) => {
      expect(params.protocol).toBe("vnc");
      expect(params.connectionId).toBe(host.id);
      enabled = body.enabled;
      return respond(200, {
        connectionId: host.id,
        displayName: host.displayName,
        defaultEnabled: enabled,
      });
    },
  );
  await setupPage({
    context,
    path: "/connectors?scope=remote-control&type=vnc",
    auth,
    featureSwitches: {
      [FeatureSwitchKey.VncAccess]: true,
    },
  });
  const toggle = await screen.findByRole("switch", {
    name: "Enabled by default for chats",
  });
  await waitFor(() => {
    expect(toggle).not.toBeDisabled();
  });
  await userEvent.click(toggle);
  await waitFor(() => {
    expect(enabled).toBeTruthy();
    expect(
      screen.getByRole("switch", { name: "Enabled by default for chats" }),
    ).toBeChecked();
  });
});

async function choose(dialog: HTMLElement, label: string, name: string) {
  if (label === "Connection route") {
    click(
      getAction(
        "radio",
        name,
        within(dialog).getByRole("radiogroup", { name: label }),
      ),
    );
    return;
  }
  await userEvent.click(await within(dialog).findByLabelText(label));
  await userEvent.click(await screen.findByRole("option", { name }));
}

async function addCredential() {
  click(getAction("radio", "Credentials"));
  const add = await waitFor(() => {
    return getAction("button", "Add credential");
  });
  click(add);
  return screen.findByRole("dialog", { name: "Add credential" });
}

async function fillHost(dialog: HTMLElement) {
  await fill(within(dialog).getByLabelText("Display name"), "Second desktop");
  await fill(
    within(dialog).getByLabelText("RFB destination host"),
    "second.example.com",
  );
}

test("VNC management omits the redundant refresh action", async () => {
  mockSettings();
  await page();
  await screen.findByText(host.displayName);
  expect(screen.getByRole("heading", { name: "VNC" })).toBeInTheDocument();
  expect(queryAction("button", "Refresh")).toBeNull();
  expect(getAction("radio", "Connections")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  expect(getAction("radio", "Credentials")).toBeInTheDocument();
});

test("Returning to Connectors refreshes VNC hosts changed elsewhere", async () => {
  const data = mockSettings();
  await page();
  await screen.findByText(host.displayName);

  data.connections = [{ ...host, displayName: "Updated workstation" }];
  click(
    getAction(
      "link",
      "Connectors",
      screen.getByRole("navigation", { name: "Sidebar" }),
    ),
  );
  await waitFor(() => {
    expect(window.location.search).toBe("");
  });
  click(screen.getByTestId("connectors-scope-remote-control"));
  await screen.findByText("Updated workstation");
  expect(screen.queryByText(host.displayName)).toBeNull();
});

test("Returning to Remote control does not reopen an abandoned VNC dialog", async () => {
  mockSettings({ connections: [], credentials: [] });
  await page("/connectors");
  click(screen.getByTestId("connectors-scope-remote-control"));
  const section = await screen.findByRole("region", { name: "VNC" });
  click(getAction("button", "Add host", section));
  await screen.findByRole("dialog", { name: "Add host" });

  window.history.back();
  await waitFor(() => {
    expect(window.location.search).toBe("");
  });
  click(screen.getByTestId("connectors-scope-remote-control"));
  await waitFor(() => {
    expect(window.location.search).toBe("?scope=remote-control");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

test("An owner reuses a VNC credential without exposing its password", async () => {
  mockSettings({ connections: [] });
  const requests: unknown[] = [];
  context.mocks.api(vncConnectionsContract.create, ({ body, respond }) => {
    requests.push(body);
    return respond(201, host);
  });
  await openAddHostPage();
  const dialog = await screen.findByRole("dialog", { name: "Add host" });
  await fillHost(dialog);
  expect(within(dialog).getByLabelText("RFB destination port")).toHaveValue(
    5900,
  );
  await choose(dialog, "Credential", "Desktop login");
  expect(within(dialog).queryByLabelText("VNC password")).toBeNull();
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(requests).toStrictEqual([
    {
      id: expect.any(String),
      displayName: "Second desktop",
      host: "second.example.com",
      port: 5900,
      transport: { type: "direct" },
      credential: { id: credential.id },
      security: { type: "x509_vnc", trust: { mode: "system" } },
    },
  ]);
});

test("X509None is an explicit credentialless choice with persistent client-authentication warning", async () => {
  const noneHost: VncConnectionResponse = {
    id: "b0000000-0000-4000-8000-000000000010",
    displayName: "Owner selected no VNC password",
    host: "desktop.example.com",
    port: 5900,
    security: { type: "x509_none", trust: { mode: "system" } },
    credential: { type: "none" },
    generation: 1,
    createdAt: host.createdAt,
    updatedAt: host.updatedAt,
  };
  mockSettings({ connections: [noneHost], credentials: [] });
  const requests: unknown[] = [];
  context.mocks.api(vncConnectionsContract.create, ({ body, respond }) => {
    requests.push(body);
    return respond(201, { ...noneHost, id: body.id });
  });
  await page();
  await screen.findByText(noneHost.displayName);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "does not authenticate you to the VNC server",
  );
  click(getAction("button", "Add host"));
  const dialog = await screen.findByRole("dialog", { name: "Add host" });
  await fillHost(dialog);
  await choose(
    dialog,
    "Security profile",
    "Encrypted without a VNC password (X509None)",
  );
  expect(within(dialog).getByRole("alert")).toHaveTextContent(
    "Anyone else who can reach that server",
  );
  expect(within(dialog).queryByLabelText("Credential")).toBeNull();
  expect(getAction("button", "Save", dialog)).toBeEnabled();
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(requests).toStrictEqual([
    {
      id: expect.any(String),
      displayName: "Second desktop",
      host: "second.example.com",
      port: 5900,
      transport: { type: "direct" },
      credential: { type: "none" },
      security: { type: "x509_none", trust: { mode: "system" } },
    },
  ]);
});

test.each([
  [
    "Client certificate without VNC password (X509None)",
    "client_certificate",
    "x509_none",
    false,
  ],
  [
    "Client certificate with VNC password (X509Vnc)",
    "client_certificate_vnc_password",
    "x509_vnc",
    true,
  ],
] as const)(
  "Owner explicitly selects %s without leaking the key to metadata",
  async (label, method, type, passwordRequired) => {
    mockSettings({ connections: [], credentials: [] });
    const requests: unknown[] = [];
    const certHost: CredentialedVncConnection = {
      ...host,
      credentialId: "d0000000-0000-4000-8000-000000000050",
      credentialName: "QEMU identity",
      security: { type, trust: { mode: "system" } },
      clientCertificateAuthentication: method,
    };
    context.mocks.api(vncConnectionsContract.create, ({ body, respond }) => {
      requests.push(body);
      return respond(201, { ...certHost, id: body.id });
    });
    await openAddHostPage();
    const dialog = await screen.findByRole("dialog", { name: "Add host" });
    await fillHost(dialog);
    await choose(dialog, "Security profile", label);
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "does not prove that the VNC server checks it",
    );
    await choose(dialog, "Credential", "Create new credential");
    await fill(
      within(dialog).getByLabelText("Credential name"),
      "QEMU identity",
    );
    await fill(
      within(dialog).getByLabelText("Client certificate chain (PEM)"),
      "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----",
    );
    await fill(
      within(dialog).getByLabelText("Unencrypted PKCS#8 private key (PEM)"),
      "-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----",
    );
    expect(within(dialog).queryByLabelText("VNC password") === null).toBe(
      !passwordRequired,
    );
    if (passwordRequired) {
      await fill(within(dialog).getByLabelText("VNC password"), "secret");
    }
    click(getAction("button", "Save", dialog));
    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    expect(requests[0]).toMatchObject({
      credential: {
        create: {
          authentication: {
            method,
            certificateChain: expect.stringContaining("BEGIN CERTIFICATE"),
            privateKey: expect.stringContaining("BEGIN PRIVATE KEY"),
            ...(passwordRequired ? { password: "secret" } : {}),
          },
        },
      },
      security: { type },
    });
  },
);

test("An owner creates an SSH-backed route with a distinct RFB destination and certificate identity", async () => {
  mockSettings({ connections: [], sshConnections: [sshHost] });
  const requests: unknown[] = [];
  context.mocks.api(vncConnectionsContract.create, ({ body, respond }) => {
    requests.push(body);
    return respond(201, tunneledHost);
  });
  await openAddHostPage();
  const dialog = await screen.findByRole("dialog", { name: "Add host" });
  await fillHost(dialog);
  await choose(dialog, "Connection route", "Through saved SSH host");
  await choose(dialog, "SSH host", "Desktop gateway · gateway.example.com:22");
  await fill(
    within(dialog).getByLabelText("TLS certificate identity"),
    "desktop.internal.example.com",
  );
  await choose(dialog, "Credential", "Desktop login");

  await choose(dialog, "Connection route", "Direct from Runner");
  expect(within(dialog).getByLabelText("RFB destination host")).toHaveValue(
    "second.example.com",
  );
  expect(within(dialog).getByLabelText("TLS certificate identity")).toHaveValue(
    "desktop.internal.example.com",
  );
  await choose(dialog, "Connection route", "Through saved SSH host");
  await expect(
    within(dialog).findByLabelText("SSH host"),
  ).resolves.toHaveTextContent("Desktop gateway");
  expect(getAction("button", "Save", dialog)).toBeEnabled();
  expect(within(dialog).getByLabelText("Display name")).toHaveValue(
    "Second desktop",
  );

  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(requests).toStrictEqual([
    {
      id: expect.any(String),
      displayName: "Second desktop",
      host: "second.example.com",
      port: 5900,
      transport: { type: "ssh", connectionId: sshHost.id },
      credential: { id: credential.id },
      security: {
        type: "x509_vnc",
        trust: { mode: "system" },
        serverName: "desktop.internal.example.com",
      },
    },
  ]);
});

test.each<{
  type: "cloudflare_access" | "tailscale";
  port: number;
  destination: string;
  warning: string;
}>([
  {
    type: "cloudflare_access",
    port: 443,
    destination: "gateway.example.com",
    warning: "Rebind it or explicitly choose Direct in SSH settings",
  },
  {
    type: "tailscale",
    port: 22,
    destination: "100.100.10.2",
    warning:
      "The SSH host for this VNC connection needs a new Tailscale configuration. Tailscale setup and rebinding are not available here yet.",
  },
])(
  "A VNC host explains its retained $type SSH carrier and recovers after SSH refresh",
  async ({ type, port, destination, warning }) => {
    const retained: SshConnectionResponse = {
      ...sshHost,
      host: destination,
      port,
      learnedHostKey: {
        algorithm: "ssh-ed25519",
        fingerprint: "SHA256:retained",
      },
      transport:
        type === "tailscale"
          ? { type: "tailscale", needsRebind: true }
          : { type: "cloudflare_access", needsRebind: true },
    };
    const settings = mockSettings({
      connections: [host, tunneledHost],
      sshConnections: [retained],
    });
    await page();
    const card = await screen.findByRole("heading", {
      name: tunneledHost.displayName,
    });
    const blocked = card.closest("article");
    expect(blocked).not.toBeNull();
    const details = within(blocked!);
    expect(details.getByText("SSH needs rebind")).toBeInTheDocument();
    expect(details.getByRole("alert")).toHaveTextContent(warning);
    expect(details.getByText(/SSH host: Desktop gateway/u)).toBeInTheDocument();
    expect(
      details.getByText("RFB destination: 127.0.0.1:5901"),
    ).toBeInTheDocument();
    expect(details.getByText("Desktop login")).toBeInTheDocument();
    expect(
      details.getByText(
        "TLS certificate identity: desktop.internal.example.com",
      ),
    ).toBeInTheDocument();
    const direct = screen.getByRole("heading", { name: host.displayName });
    expect(
      within(direct.closest("article")!).getByText("Configured"),
    ).toBeInTheDocument();
    expect(within(direct.closest("article")!).queryByRole("alert")).toBeNull();

    settings.sshConnections = [
      {
        ...retained,
        generation: retained.generation + 1,
        transport:
          type === "tailscale"
            ? {
                type: "tailscale",
                configId: "f0000000-0000-4000-8000-000000000001",
              }
            : {
                type: "cloudflare_access",
                configId: "f0000000-0000-4000-8000-000000000001",
              },
      },
    ];
    context.mocks.ably.trigger("ssh:changed", {
      orgId: auth.organization.activeOrg.id,
    });
    await waitFor(() => {
      expect(details.getByText("Configured")).toBeInTheDocument();
    });
    expect(details.queryByRole("alert")).toBeNull();
    expect(details.getByText(/SSH host: Desktop gateway/u)).toBeInTheDocument();
    expect(
      details.getByText("RFB destination: 127.0.0.1:5901"),
    ).toBeInTheDocument();
    expect(details.getByText("Desktop login")).toBeInTheDocument();
  },
);

test("An SSH-backed card shows topology and a missing saved SSH host blocks edits", async () => {
  mockSettings({ connections: [tunneledHost], sshConnections: [] });
  const requests: unknown[] = [];
  context.mocks.api(
    vncConnectionsContract.update,
    ({ body, params, respond }) => {
      requests.push({ body, connectionId: params.connectionId });
      return respond(200, {
        ...host,
        id: tunneledHost.id,
        displayName: tunneledHost.displayName,
        host: "desktop.example.com",
        port: tunneledHost.port,
        security: tunneledHost.security,
        generation: tunneledHost.generation + 1,
      });
    },
  );
  await page();
  await screen.findByText(tunneledHost.displayName);
  expect(screen.getByText("Through saved SSH host")).toBeInTheDocument();
  expect(
    screen.getByText(/RFB destination: 127\.0\.0\.1:5901/u),
  ).toBeInTheDocument();
  expect(
    screen.getByText(
      /TLS certificate identity: desktop\.internal\.example\.com/u,
    ),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/The selected SSH host is no longer available/u),
  ).toBeInTheDocument();

  click(getAction("button", "Edit host"));
  const dialog = await screen.findByRole("dialog", { name: "Edit host" });
  expect(getAction("radio", "Through saved SSH host", dialog)).toBeChecked();
  expect(
    within(dialog).getByText(/The selected SSH host is no longer available/u),
  ).toBeInTheDocument();
  expect(getAction("button", "Save", dialog)).toBeDisabled();
  await choose(dialog, "Connection route", "Direct from Runner");
  expect(getAction("button", "Save", dialog)).toBeDisabled();
  expect(within(dialog).getByRole("alert")).toHaveTextContent(
    "Private and loopback IP addresses require a saved SSH host",
  );
  await fill(
    within(dialog).getByLabelText("RFB destination host"),
    "desktop.example.com",
  );
  expect(getAction("button", "Save", dialog)).toBeEnabled();
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(requests).toStrictEqual([
    {
      connectionId: tunneledHost.id,
      body: {
        expectedGeneration: tunneledHost.generation,
        displayName: tunneledHost.displayName,
        host: "desktop.example.com",
        port: tunneledHost.port,
        transport: { type: "direct" },
        credential: { id: tunneledHost.credentialId },
        security: tunneledHost.security,
      },
    },
  ]);
});

test("Editing an Apple IPv6 loopback host preserves its SSH route and custom port", async () => {
  const appleHost: VncConnectionResponse = {
    ...host,
    displayName: "Mac IPv6 desktop",
    host: "::1",
    port: 5905,
    security: { type: "apple_dh" },
    transport: { type: "ssh", connectionId: sshHost.id },
  };
  const appleCredential: VncCredentialResponse = {
    ...credential,
    authMethod: "apple_dh_username_password",
    username: "operator",
    hosts: [{ id: appleHost.id, displayName: appleHost.displayName }],
  };
  mockSettings({
    connections: [appleHost],
    credentials: [appleCredential],
    sshConnections: [sshHost],
  });
  const requests: unknown[] = [];
  context.mocks.api(vncConnectionsContract.update, ({ body, respond }) => {
    requests.push(body);
    return respond(200, { ...appleHost, generation: appleHost.generation + 1 });
  });
  await page();
  await screen.findByText(appleHost.displayName);
  click(getAction("button", "Edit host"));
  const dialog = await screen.findByRole("dialog", { name: "Edit host" });
  expect(within(dialog).getByLabelText("Display name")).toHaveValue(
    "Mac IPv6 desktop",
  );
  expect(
    within(dialog).getByLabelText("RFB destination host"),
  ).toHaveTextContent("::1");
  expect(within(dialog).getByLabelText("RFB destination port")).toHaveValue(
    5905,
  );
  await expect(
    within(dialog).findByLabelText("SSH host"),
  ).resolves.toHaveTextContent(sshHost.displayName);
  await waitFor(() => {
    expect(getAction("button", "Save", dialog)).toBeEnabled();
  });
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(requests).toStrictEqual([
    {
      expectedGeneration: appleHost.generation,
      displayName: "Mac IPv6 desktop",
      host: "::1",
      port: 5905,
      transport: { type: "ssh", connectionId: sshHost.id },
      credential: { id: appleCredential.id },
      security: { type: "apple_dh" },
    },
  ]);
});

test("Direct route explains canonical IPv6 loopback and private mapped literals", async () => {
  mockSettings({ connections: [], credentials: [credential] });
  await openAddHostPage();
  const dialog = await screen.findByRole("dialog", { name: "Add host" });
  await fillHost(dialog);
  await waitFor(() => {
    expect(getAction("button", "Save", dialog)).toBeEnabled();
  });
  const destination = within(dialog).getByLabelText("RFB destination host");
  for (const address of [
    "127.0.0.1.",
    "0:0:0:0:0:0:0:1",
    "::1.",
    "::ffff:127.0.0.1",
    "::ffff:10.2.3.4",
    "fc00::1",
    "febf::1",
  ]) {
    await fill(destination, address);
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Private and loopback IP addresses require a saved SSH host",
    );
    expect(getAction("button", "Save", dialog)).toBeDisabled();
  }
  await fill(destination, "::ffff:8.8.8.8");
  expect(within(dialog).queryByRole("alert")).toBeNull();
  expect(getAction("button", "Save", dialog)).toBeEnabled();
});

test("Inline password creation preserves spaces and sends the selected custom certificate trust", async () => {
  mockSettings({ connections: [] });
  const requests: unknown[] = [];
  context.mocks.api(vncConnectionsContract.create, ({ body, respond }) => {
    requests.push(body);
    return respond(201, host);
  });
  await openAddHostPage();
  const dialog = await screen.findByRole("dialog", { name: "Add host" });
  await fillHost(dialog);
  const credentialFields = within(dialog).getByRole("group", {
    name: "Credential",
  });
  await choose(credentialFields, "Credential", "Create new credential");
  await fill(
    within(credentialFields).getByLabelText("Credential name"),
    "New login",
  );
  const secret = within(credentialFields).getByLabelText("VNC password");
  expect(secret).toHaveAttribute("type", "password");
  expect(secret).toHaveValue("");
  await fill(secret, " pwd  ");
  await choose(
    dialog,
    "Server certificate trust",
    "Custom certificate authorities",
  );
  await fill(within(dialog).getByLabelText("CA certificates (PEM)"), caBundle);
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(requests).toStrictEqual([
    {
      id: expect.any(String),
      displayName: "Second desktop",
      host: "second.example.com",
      port: 5900,
      transport: { type: "direct" },
      credential: {
        create: {
          name: "New login",
          authentication: { method: "vnc_password", password: " pwd  " },
        },
      },
      security: {
        type: "x509_vnc",
        trust: { mode: "custom_ca", caBundle },
      },
    },
  ]);
  expect(secret).toHaveValue("");
});

test("Inline X509Plain creation sends exact username/password and custom_ca trust", async () => {
  mockSettings({ connections: [], credentials: [] });
  const requests: unknown[] = [];
  context.mocks.api(vncConnectionsContract.create, ({ body, respond }) => {
    requests.push(body);
    return respond(201, plainHost);
  });
  await openAddHostPage();
  const dialog = await screen.findByRole("dialog", { name: "Add host" });
  await fillHost(dialog);
  await choose(
    dialog,
    "Security profile",
    "Encrypted username and password (X509Plain)",
  );
  await choose(dialog, "Credential", "Create new credential");
  await fill(within(dialog).getByLabelText("Credential name"), "Plain login");
  await fill(within(dialog).getByLabelText("Username"), " operator ");
  const secret = within(dialog).getByLabelText("Password");
  expect(secret).toHaveAttribute("type", "password");
  expect(secret).toHaveValue("");
  await fill(secret, " 密码 with spaces ");
  await choose(
    dialog,
    "Server certificate trust",
    "Custom certificate authorities",
  );
  await fill(within(dialog).getByLabelText("CA certificates (PEM)"), caBundle);
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(requests).toStrictEqual([
    {
      id: expect.any(String),
      displayName: "Second desktop",
      host: "second.example.com",
      port: 5900,
      transport: { type: "direct" },
      credential: {
        create: {
          name: "Plain login",
          authentication: {
            method: "username_password",
            username: " operator ",
            password: " 密码 with spaces ",
          },
        },
      },
      security: {
        type: "x509_plain",
        trust: { mode: "custom_ca", caBundle },
      },
    },
  ]);
  expect(secret).toHaveValue("");
});

test("QEMU SCRAM creates only its explicit X509SASL pair and keeps its password out of state", async () => {
  mockSettings({ connections: [], credentials: [] });
  const requests: unknown[] = [];
  context.mocks.api(vncConnectionsContract.create, ({ body, respond }) => {
    requests.push(body);
    return respond(201, qemuHost);
  });
  await openAddHostPage();
  const dialog = await screen.findByRole("dialog", { name: "Add host" });
  await fillHost(dialog);
  await choose(dialog, "Security profile", "QEMU SCRAM-SHA-256 (X509SASL)");
  expect(within(dialog).getByText(/subtype 263 only/u)).toBeInTheDocument();
  await choose(dialog, "Credential", "Create new credential");
  await fill(
    within(dialog).getByLabelText("Credential name"),
    "QEMU SCRAM login",
  );
  const username = within(dialog).getByLabelText("Username");
  const password = within(dialog).getByLabelText("Password");
  expect(username).toHaveAttribute("pattern", "(?!.*[,=])[!-~]{1,255}");
  expect(password).toHaveAttribute("pattern", "[ -~]{1,1023}");
  await fill(username, "operator");
  await fill(password, " secret ");
  await choose(
    dialog,
    "Server certificate trust",
    "Custom certificate authorities",
  );
  await fill(within(dialog).getByLabelText("CA certificates (PEM)"), caBundle);
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(requests).toStrictEqual([
    {
      id: expect.any(String),
      displayName: "Second desktop",
      host: "second.example.com",
      port: 5900,
      transport: { type: "direct" },
      credential: {
        create: {
          name: "QEMU SCRAM login",
          authentication: {
            method: "qemu_scram_sha256",
            username: "operator",
            password: " secret ",
          },
        },
      },
      security: {
        type: "qemu_x509_sasl",
        trust: { mode: "custom_ca", caBundle },
      },
    },
  ]);
  expect(password).toHaveValue("");
  expect(document.body.textContent).not.toContain(" secret ");
});

test("acknowledged Kerberos password saves independent explicit identities and KDC policy", async () => {
  mockSettings({ connections: [], credentials: [] });
  context.mocks.api(vncConnectionsContract.list, ({ respond }) => {
    return {
      ...respond(200, { connections: [] }),
      headers: { "X-VNC-Profile-Version": "kerberos-v1" },
    };
  });
  const initiator = { realm: "EXAMPLE.INVALID", components: ["Alice"] };
  const security = {
    type: "qemu_x509_gssapi" as const,
    trust: { mode: "system" as const },
    service: {
      realm: initiator.realm,
      components: ["vnc", "desktop.identity.invalid"],
    },
    kdc: {
      host: "kdc.example.com",
      port: 88,
      transport: { type: "direct" as const },
      ticketLifetimeSeconds: 1200,
      renewableLifetimeSeconds: 7200,
    },
  };
  const requests: unknown[] = [];
  context.mocks.api(vncConnectionsContract.create, ({ body, respond }) => {
    requests.push(body);
    return respond(201, {
      ...qemuHost,
      kerberosAuthentication: "qemu_kerberos_password",
      security,
    });
  });
  await openAddHostPage();
  const dialog = await screen.findByRole("dialog", { name: "Add host" });
  await fillHost(dialog);
  await choose(dialog, "Security profile", "Kerberos · password");
  await choose(dialog, "Credential", "Create new credential");
  await fill(
    within(dialog).getByLabelText("Credential name"),
    "Explicit identity",
  );
  await fill(within(dialog).getByLabelText("Initiator realm"), initiator.realm);
  await fill(within(dialog).getByLabelText("Initiator components"), "Alice");
  await fill(
    within(dialog).getByLabelText("VNC service realm"),
    initiator.realm,
  );
  await fill(
    within(dialog).getByLabelText("VNC service instance"),
    "desktop.identity.invalid",
  );
  await fill(within(dialog).getByLabelText("KDC host"), "kdc.example.com");
  const password = within(dialog).getByLabelText("Password");
  await fill(password, " exact kerb ");
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(requests).toStrictEqual([
    {
      id: expect.any(String),
      displayName: "Second desktop",
      host: "second.example.com",
      port: 5900,
      transport: { type: "direct" },
      security,
      credential: {
        create: {
          name: "Explicit identity",
          authentication: {
            method: "qemu_kerberos_password",
            initiator,
            password: " exact kerb ",
          },
        },
      },
    },
  ]);
  expect(password).toHaveValue("");
});

test("Kerberos profiles remain hidden without an API version acknowledgement", async () => {
  mockSettings({ connections: [], credentials: [] });
  await openAddHostPage();
  const dialog = await screen.findByRole("dialog", { name: "Add host" });
  await userEvent.click(
    await within(dialog).findByLabelText("Security profile"),
  );
  expect(
    screen.queryByRole("option", { name: "Kerberos · password" }),
  ).toBeNull();
  expect(
    screen.queryByRole("option", { name: "Kerberos · keytab" }),
  ).toBeNull();
  expect(
    screen.queryByRole("option", { name: "Kerberos · service ticket" }),
  ).toBeNull();
});

const keytabHex =
  "05020000004b0001000f4558414d504c452e494e56414c49440005616c69636500000001000000000200120020535353535353535353535353535353535353535353535353535353535353535300000002";
function keytabBytes(lastKeyByte = 0x53) {
  const bytes = Uint8Array.from(keytabHex.match(/../gu) ?? [], (pair) => {
    return Number.parseInt(pair, 16);
  });
  bytes[bytes.length - 5] = lastKeyByte;
  return bytes;
}
function keytabFile(name: string, lastKeyByte = 0x53) {
  return new File([keytabBytes(lastKeyByte).buffer], name);
}
function mockKerberosImport(
  method:
    "qemu_kerberos_keytab" | "qemu_kerberos_ticket" = "qemu_kerberos_keytab",
) {
  mockSettings({ connections: [], credentials: [] });
  context.mocks.api(vncConnectionsContract.list, ({ respond }) => {
    return {
      ...respond(200, { connections: [] }),
      headers: { "X-VNC-Profile-Version": "kerberos-v1" },
    };
  });
  const requests: unknown[] = [];
  context.mocks.api(vncCredentialsContract.create, ({ body, respond }) => {
    requests.push(body);
    const metadata = {
      ...credential,
      name: body.name,
      initiator: { realm: "EXAMPLE.INVALID", components: ["alice"] },
      hosts: [],
    };
    return method === "qemu_kerberos_ticket"
      ? respond(201, {
          ...metadata,
          authMethod: method,
          service: {
            realm: "EXAMPLE.INVALID",
            components: ["vnc", "host.example.invalid"],
          },
          declaredExpiresAt: 1000,
        })
      : respond(201, { ...metadata, authMethod: method });
  });
  return requests;
}
async function openKeytabDialog() {
  const dialog = await addCredential();
  await choose(dialog, "Authentication method", "Kerberos · keytab");
  await fill(
    within(dialog).getByLabelText("Credential name"),
    "Imported keytab",
  );
  await fill(
    within(dialog).getByLabelText("Initiator realm"),
    "EXAMPLE.INVALID",
  );
  await fill(within(dialog).getByLabelText("Initiator components"), "alice");
  return dialog;
}
function pendingFileRead(file: File) {
  const started = context.mocks.deferred<void>();
  const read = context.mocks.deferred<ArrayBuffer>();
  vi.spyOn(file, "arrayBuffer").mockImplementationOnce(() => {
    started.resolve();
    return read.promise;
  });
  return { started, read };
}

// Public K1 service vector; its ticket bytes are synthetic, not a real credential.
const ticketHex =
  "0504000000000001000000010000000f4558414d504c452e494e56414c494400000005616c69636500000001000000010000000f4558414d504c452e494e56414c494400000005616c69636500000002000000020000000f4558414d504c452e494e56414c494400000003766e6300000014686f73742e6578616d706c652e696e76616c696400120000002037373737373737373737373737373737373737373737373737373737373737370000006400000064000003e800000000004000000000000000000000000000001b53594e5448455449435f4e4f545f415f5245414c5f5449434b455400000000";
function ticketFile(name: string) {
  const bytes = Uint8Array.from(ticketHex.match(/../gu) ?? [], (pair) => {
    return Number.parseInt(pair, 16);
  });
  return new File([bytes.buffer], name);
}
async function openTicketDialog() {
  const dialog = await addCredential();
  await choose(dialog, "Authentication method", "Kerberos · service ticket");
  await fill(
    within(dialog).getByLabelText("Credential name"),
    "Offline ticket",
  );
  await fill(
    within(dialog).getByLabelText("Initiator realm"),
    "EXAMPLE.INVALID",
  );
  await fill(within(dialog).getByLabelText("Initiator components"), "alice");
  await fill(
    within(dialog).getByLabelText("VNC service realm"),
    "EXAMPLE.INVALID",
  );
  await fill(
    within(dialog).getByLabelText("VNC service instance"),
    "host.example.invalid",
  );
  return dialog;
}

test("A supplied service ticket is imported without saving and retains its exact service on Save", async () => {
  mockNow(200_000, context.signal);
  const requests = mockKerberosImport("qemu_kerberos_ticket");
  await page();
  const dialog = await openTicketDialog();
  await userEvent.upload(
    within(dialog).getByLabelText("Service ticket file (.ccache)"),
    ticketFile("service.ccache"),
  );
  expect(requests).toStrictEqual([]);
  expect(within(dialog).queryByLabelText("KDC host")).toBeNull();
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(requests).toStrictEqual([
    {
      id: expect.any(String),
      name: "Offline ticket",
      authentication: {
        method: "qemu_kerberos_ticket",
        initiator: { realm: "EXAMPLE.INVALID", components: ["alice"] },
        service: {
          realm: "EXAMPLE.INVALID",
          components: ["vnc", "host.example.invalid"],
        },
        ticketCache: btoa(
          String.fromCharCode(
            ...new Uint8Array(
              await ticketFile("expected.ccache").arrayBuffer(),
            ),
          ),
        ),
      },
    },
  ]);
});

test("Changing a ticket's service away and back invalidates its pending import", async () => {
  mockNow(200_000, context.signal);
  const requests = mockKerberosImport("qemu_kerberos_ticket");
  await page();
  const dialog = await openTicketDialog();
  const file = ticketFile("prior-service.ccache");
  const pending = pendingFileRead(file);
  const input = within(dialog).getByLabelText("Service ticket file (.ccache)");
  await userEvent.upload(input, file);
  await pending.started.promise;
  const instance = within(dialog).getByLabelText("VNC service instance");
  await fill(instance, "other.example.invalid");
  await fill(instance, "host.example.invalid");
  await act(async () => {
    pending.read.resolve(await ticketFile("late.ccache").arrayBuffer());
    await pending.read.promise;
  });
  click(getAction("button", "Save", dialog));
  await within(dialog).findByRole("alert");
  expect(requests).toStrictEqual([]);
  expect(dialog).toBeInTheDocument();
  await userEvent.upload(input, ticketFile("current-service.ccache"));
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(requests).toHaveLength(1);
});

test("A replacement keytab is saved without a late file overwriting it", async () => {
  const requests = mockKerberosImport();
  await page();
  const dialog = await openKeytabDialog();
  const oldFile = keytabFile("old.keytab");
  const pending = pendingFileRead(oldFile);
  const input = within(dialog).getByLabelText("Keytab file (.keytab)");
  await userEvent.upload(input, oldFile);
  await pending.started.promise;
  await userEvent.upload(input, keytabFile("replacement.keytab", 0x54));
  await act(async () => {
    pending.read.resolve(keytabBytes().buffer);
    await pending.read.promise;
  });
  expect(dialog).toBeInTheDocument();
  expect(requests).toStrictEqual([]);
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(requests).toStrictEqual([
    {
      id: expect.any(String),
      name: "Imported keytab",
      authentication: {
        method: "qemu_kerberos_keytab",
        initiator: { realm: "EXAMPLE.INVALID", components: ["alice"] },
        keytab: btoa(String.fromCharCode(...keytabBytes(0x54))),
      },
    },
  ]);
});

test("Changing an initiator away and back invalidates a pending keytab import", async () => {
  const requests = mockKerberosImport();
  await page();
  const dialog = await openKeytabDialog();
  const file = keytabFile("prior-identity.keytab");
  const pending = pendingFileRead(file);
  await userEvent.upload(
    within(dialog).getByLabelText("Keytab file (.keytab)"),
    file,
  );
  await pending.started.promise;
  const realm = within(dialog).getByLabelText("Initiator realm");
  await fill(realm, "OTHER.INVALID");
  await fill(realm, "EXAMPLE.INVALID");
  await act(async () => {
    pending.read.resolve(keytabBytes().buffer);
    await pending.read.promise;
  });
  click(getAction("button", "Save", dialog));
  await within(dialog).findByRole("alert");
  expect(requests).toStrictEqual([]);
  expect(dialog).toBeInTheDocument();
  await userEvent.upload(
    within(dialog).getByLabelText("Keytab file (.keytab)"),
    keytabFile("current-identity.keytab"),
  );
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(requests).toHaveLength(1);
});

test("A closed dialog cannot deliver its pending keytab into a new dialog", async () => {
  const requests = mockKerberosImport();
  await page();
  const prior = await openKeytabDialog();
  const file = keytabFile("abandoned.keytab");
  const pending = pendingFileRead(file);
  await userEvent.upload(
    within(prior).getByLabelText("Keytab file (.keytab)"),
    file,
  );
  await pending.started.promise;
  click(getAction("button", "Cancel", prior));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  const current = await openKeytabDialog();
  await act(async () => {
    pending.read.resolve(keytabBytes().buffer);
    await pending.read.promise;
  });
  click(getAction("button", "Save", current));
  await within(current).findByRole("alert");
  expect(requests).toStrictEqual([]);
  expect(current).toBeInTheDocument();
});

test("A keytab read failure is reported and a newly selected file can be saved", async () => {
  const requests = mockKerberosImport();
  await page();
  const dialog = await openKeytabDialog();
  const file = keytabFile("unreadable.keytab");
  vi.spyOn(file, "arrayBuffer").mockRejectedValueOnce(
    new DOMException("Synthetic file failure", "NotReadableError"),
  );
  await userEvent.upload(
    within(dialog).getByLabelText("Keytab file (.keytab)"),
    file,
  );
  await within(dialog).findByRole("alert");
  expect(requests).toStrictEqual([]);
  await userEvent.upload(
    within(dialog).getByLabelText("Keytab file (.keytab)"),
    keytabFile("readable.keytab"),
  );
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(requests).toHaveLength(1);
});

test("Switching authentication profiles away and back discards a pending keytab", async () => {
  const requests = mockKerberosImport();
  await page();
  const dialog = await openKeytabDialog();
  const file = keytabFile("old-profile.keytab");
  const pending = pendingFileRead(file);
  await userEvent.upload(
    within(dialog).getByLabelText("Keytab file (.keytab)"),
    file,
  );
  await pending.started.promise;
  await choose(dialog, "Authentication method", "Kerberos · password");
  await within(dialog).findByLabelText("Password");
  await choose(dialog, "Authentication method", "Kerberos · keytab");
  await fill(
    within(dialog).getByLabelText("Initiator realm"),
    "EXAMPLE.INVALID",
  );
  await fill(within(dialog).getByLabelText("Initiator components"), "alice");
  await act(async () => {
    pending.read.resolve(keytabBytes().buffer);
    await pending.read.promise;
  });
  click(getAction("button", "Save", dialog));
  await within(dialog).findByRole("alert");
  expect(requests).toStrictEqual([]);
});

test("Changing owners discards a pending keytab even after the original owner returns", async () => {
  const requests = mockKerberosImport();
  await page();
  const original = await openKeytabDialog();
  const file = keytabFile("old-owner.keytab");
  const pending = pendingFileRead(file);
  await userEvent.upload(
    within(original).getByLabelText("Keytab file (.keytab)"),
    file,
  );
  await pending.started.promise;
  const clerk = context.mocks.clerk();
  act(() => {
    clerk.user(
      { id: "different-kerberos-owner", fullName: "Other Owner" },
      { token: "other-token" },
    );
    clerk.stateChanged();
  });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  act(() => {
    clerk.user(auth.user, { token: "returned-token" });
    clerk.stateChanged();
  });
  const current = await openKeytabDialog();
  await act(async () => {
    pending.read.resolve(keytabBytes().buffer);
    await pending.read.promise;
  });
  click(getAction("button", "Save", current));
  await within(current).findByRole("alert");
  expect(requests).toStrictEqual([]);
});

test("Profile selection filters credentials and clears incompatible choices", async () => {
  mockSettings({
    connections: [],
    credentials: [credential, plainCredential],
  });
  await openAddHostPage();
  const dialog = await screen.findByRole("dialog", { name: "Add host" });
  await waitFor(() => {
    expect(within(dialog).getByLabelText("Credential")).toHaveTextContent(
      credential.name,
    );
  });
  await choose(
    dialog,
    "Security profile",
    "Encrypted username and password (X509Plain)",
  );
  expect(getAction("button", "Save", dialog)).toBeDisabled();
  await userEvent.click(within(dialog).getByLabelText("Credential"));
  await expect(
    screen.findByRole("option", { name: plainCredential.name }),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByRole("option", { name: credential.name })).toBeNull();
  await userEvent.click(
    screen.getByRole("option", { name: plainCredential.name }),
  );
  expect(within(dialog).getByLabelText("Credential")).toHaveTextContent(
    plainCredential.name,
  );
  await choose(dialog, "Security profile", "Encrypted VNC (X509Vnc)");
  expect(getAction("button", "Save", dialog)).toBeDisabled();
  expect(within(dialog).getByLabelText("Credential")).not.toHaveTextContent(
    plainCredential.name,
  );
});

test("Name stays first and a later profile choice never rewrites the earlier draft", async () => {
  mockSettings({ connections: [], credentials: [], sshConnections: [sshHost] });
  await openAddHostPage();
  const dialog = await screen.findByRole("dialog", { name: "Add host" });
  expect(within(dialog).getAllByRole("textbox")[0]).toHaveAccessibleName(
    "Display name",
  );
  await fill(within(dialog).getByLabelText("Display name"), "Office desktop");
  await fill(
    within(dialog).getByLabelText("RFB destination host"),
    "desktop.example.com",
  );
  await choose(dialog, "Security profile", "Mac VNC (Apple DH)");
  expect(
    within(dialog).getByText(
      /Standalone macOS Screen Sharing remains unverified/u,
    ),
  ).toBeInTheDocument();
  expect(within(dialog).getByLabelText("Display name")).toHaveValue(
    "Office desktop",
  );
  expect(queryAction("radio", "Direct from Runner", dialog)).toBeNull();
  expect(
    within(dialog).getByLabelText("RFB destination host"),
  ).toHaveTextContent("127.0.0.1");
  await choose(dialog, "Security profile", "Encrypted VNC (X509Vnc)");
  expect(within(dialog).getByLabelText("Display name")).toHaveValue(
    "Office desktop",
  );
  expect(within(dialog).getByLabelText("RFB destination host")).toHaveValue(
    "desktop.example.com",
  );
  expect(getAction("radio", "Through saved SSH host", dialog)).toBeChecked();
});

test("Mac classic password is an explicit SSH-only profile with risk disclosure and bounded password", async () => {
  mockSettings({
    connections: [],
    credentials: [],
    sshConnections: [sshHost],
  });
  const requests: unknown[] = [];
  context.mocks.api(vncConnectionsContract.create, ({ body, respond }) => {
    requests.push(body);
    return respond(201, {
      ...host,
      host: "127.0.0.1",
      credentialName: "Mac classic password",
      security: { type: "apple_vnc_password" },
      transport: { type: "ssh", connectionId: sshHost.id },
    });
  });
  await openAddHostPage();
  const dialog = await screen.findByRole("dialog", { name: "Add host" });
  await choose(dialog, "Security profile", "Mac VNC (classic VNC password)");
  expect(
    within(dialog).getByText(/other clients may reach port 5900/u),
  ).toBeInTheDocument();
  expect(
    within(dialog).queryByLabelText("TLS certificate identity"),
  ).toBeNull();
  expect(
    within(dialog).queryByLabelText("Server certificate trust"),
  ).toBeNull();
  expect(
    within(dialog).queryByRole("radiogroup", { name: "Connection route" }),
  ).toBeNull();
  expect(queryAction("radio", "Direct from Runner", dialog)).toBeNull();
  await choose(dialog, "SSH host", "Desktop gateway · gateway.example.com:22");
  await fill(within(dialog).getByLabelText("Display name"), "Mac classic VNC");
  const destination = within(dialog).getByLabelText("RFB destination host");
  expect(destination).toHaveTextContent("127.0.0.1");
  await userEvent.click(destination);
  expect(screen.queryByRole("option", { name: "localhost" })).toBeNull();
  await userEvent.keyboard("{Escape}");
  await choose(dialog, "Credential", "Create new credential");
  await fill(
    within(dialog).getByLabelText("Credential name"),
    "Mac classic password",
  );
  expect(within(dialog).queryByLabelText("Username")).toBeNull();
  const password = within(dialog).getByLabelText("VNC password");
  await fill(password, "ninebytes");
  expect(password).toBeInvalid();
  await fill(password, "secret");
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(requests).toStrictEqual([
    {
      id: expect.any(String),
      displayName: "Mac classic VNC",
      host: "127.0.0.1",
      port: 5900,
      transport: { type: "ssh", connectionId: sshHost.id },
      credential: {
        create: {
          name: "Mac classic password",
          authentication: { method: "vnc_password", password: "secret" },
        },
      },
      security: { type: "apple_vnc_password" },
    },
  ]);
});

test.each([
  {
    profile: "apple_dh" as const,
    method: "apple_dh_username_password" as const,
    label: "Mac VNC (Apple DH)",
    usernameMaxLength: 63,
    usernameHelp: /1–63 UTF-8 bytes/u,
  },
  {
    profile: "apple_srp" as const,
    method: "apple_srp_username_password" as const,
    label: "Mac VNC (Apple Direct SRP)",
    usernameMaxLength: 255,
    usernameHelp: /1–255 UTF-8 bytes/u,
  },
  {
    profile: "apple_rsa_srp" as const,
    method: "apple_rsa_srp_username_password" as const,
    label: "Mac VNC (Apple RSA/SRP)",
    usernameMaxLength: 234,
    usernameHelp: /1–234 UTF-8 bytes/u,
  },
])(
  "$label host editor requires SSH loopback and omits X509 trust",
  async ({ profile, method, label, usernameMaxLength, usernameHelp }) => {
    mockSettings({
      connections: [],
      credentials: [],
      sshConnections: [sshHost],
    });
    const requests: unknown[] = [];
    const appleHost: CredentialedVncConnection = {
      ...host,
      host: "127.0.0.1",
      credentialName: "Mac login",
      security: { type: profile },
      transport: { type: "ssh", connectionId: sshHost.id },
    };
    context.mocks.api(vncConnectionsContract.create, ({ body, respond }) => {
      requests.push(body);
      return respond(201, appleHost);
    });
    await openAddHostPage();
    const dialog = await screen.findByRole("dialog", { name: "Add host" });
    await choose(dialog, "Security profile", label);
    expect(
      within(dialog).queryByLabelText("TLS certificate identity"),
    ).toBeNull();
    expect(
      within(dialog).queryByLabelText("Server certificate trust"),
    ).toBeNull();
    expect(
      within(dialog).queryByRole("radiogroup", { name: "Connection route" }),
    ).toBeNull();
    expect(queryAction("radio", "Direct from Runner", dialog)).toBeNull();
    await choose(
      dialog,
      "SSH host",
      "Desktop gateway · gateway.example.com:22",
    );
    await fill(
      within(dialog).getByLabelText("Display name"),
      "Mac Screen Sharing",
    );
    const destination = within(dialog).getByLabelText("RFB destination host");
    expect(destination).toHaveTextContent("127.0.0.1");
    await choose(dialog, "RFB destination host", "::1");
    expect(destination).toHaveTextContent("::1");
    await choose(dialog, "RFB destination host", "127.0.0.1");
    await choose(dialog, "Credential", "Create new credential");
    await fill(within(dialog).getByLabelText("Credential name"), "Mac login");
    const usernameField = within(dialog).getByLabelText("Username");
    expect(usernameField).toHaveAttribute(
      "maxLength",
      String(usernameMaxLength),
    );
    expect(
      within(dialog).getByText(usernameHelp, {
        selector: "#vnc-username-help",
      }),
    ).toBeInTheDocument();
    await fill(usernameField, "operator");
    await fill(within(dialog).getByLabelText("Password"), "secret");
    click(getAction("button", "Save", dialog));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(requests).toStrictEqual([
      {
        id: expect.any(String),
        displayName: "Mac Screen Sharing",
        host: "127.0.0.1",
        port: 5900,
        transport: { type: "ssh", connectionId: sshHost.id },
        credential: {
          create: {
            name: "Mac login",
            authentication: {
              method,
              username: "operator",
              password: "secret",
            },
          },
        },
        security: { type: profile },
      },
    ]);
  },
);

test("QEMU SCRAM credential rotation preserves its exact profile without revealing secrets", async () => {
  const data = mockSettings({
    connections: [qemuHost],
    credentials: [qemuCredential],
  });
  const requests: unknown[] = [];
  context.mocks.api(vncCredentialsContract.update, ({ body, respond }) => {
    requests.push(body);
    const updated = {
      ...qemuCredential,
      revision: 2,
      username:
        body.authentication?.method === "qemu_scram_sha256"
          ? body.authentication.username
          : qemuCredential.username,
    };
    data.credentials = [updated];
    return respond(200, updated);
  });
  await page();
  await screen.findByText(qemuHost.displayName);
  expect(
    screen.getByText(
      "QEMU SCRAM-SHA-256 (X509SASL) · QEMU SCRAM-SHA-256 (X509SASL) · System certificate authorities",
    ),
  ).toBeInTheDocument();
  click(getAction("radio", "Credentials"));
  await screen.findByText(qemuCredential.name);
  click(getAction("button", "Edit credential"));
  const dialog = await screen.findByRole("dialog", { name: "Edit credential" });
  expect(within(dialog).queryByLabelText("Password")).toBeNull();
  await userEvent.click(
    within(dialog).getByRole("checkbox", { name: "Replace authentication" }),
  );
  expect(within(dialog).getByLabelText("Username")).toHaveValue("operator");
  const password = within(dialog).getByLabelText("Password");
  expect(password).toHaveValue("");
  await fill(password, "new-secret");
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(requests).toStrictEqual([
    {
      expectedRevision: 1,
      name: qemuCredential.name,
      authentication: {
        method: "qemu_scram_sha256",
        username: "operator",
        password: "new-secret",
      },
    },
  ]);
  expect(password).toHaveValue("");
  expect(document.body.textContent).not.toContain("new-secret");
});

test("Plain credential cards and edits expose only password-free metadata", async () => {
  const data = mockSettings({
    connections: [plainHost],
    credentials: [plainCredential],
  });
  const requests: unknown[] = [];
  let current = plainCredential;
  context.mocks.api(vncCredentialsContract.update, ({ body, respond }) => {
    requests.push(body);
    current = {
      ...current,
      name: body.name ?? current.name,
      username:
        body.authentication?.method === "username_password"
          ? body.authentication.username
          : current.username,
      revision: current.revision + 1,
    };
    data.credentials = [current];
    return respond(200, current);
  });
  await page();
  await screen.findByText(plainHost.displayName);
  expect(
    screen.getByText(
      "Encrypted username and password (X509Plain) · Username and password · System certificate authorities",
    ),
  ).toBeInTheDocument();
  click(getAction("radio", "Credentials"));
  await screen.findByText(plainCredential.name);
  expect(screen.getByText(plainCredential.username)).toBeInTheDocument();
  click(getAction("button", "Edit credential"));
  const rename = await screen.findByRole("dialog", {
    name: "Edit credential",
  });
  expect(within(rename).getByText("Username and password")).toBeInTheDocument();
  expect(within(rename).queryByLabelText("Username")).toBeNull();
  expect(within(rename).queryByLabelText("Password")).toBeNull();
  await fill(within(rename).getByLabelText("Credential name"), "Renamed Plain");
  click(getAction("button", "Save", rename));
  await screen.findByText("Renamed Plain");
  expect(requests).toStrictEqual([
    { expectedRevision: 2, name: "Renamed Plain" },
  ]);

  click(getAction("button", "Edit credential"));
  const replace = await screen.findByRole("dialog", {
    name: "Edit credential",
  });
  await userEvent.click(
    within(replace).getByRole("checkbox", { name: "Replace authentication" }),
  );
  expect(within(replace).getByLabelText("Username")).toHaveValue("operator");
  await fill(within(replace).getByLabelText("Username"), "new operator");
  const secret = within(replace).getByLabelText("Password");
  expect(secret).toHaveValue("");
  await fill(secret, " new private password ");
  click(getAction("button", "Save", replace));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(requests).toStrictEqual([
    { expectedRevision: 2, name: "Renamed Plain" },
    {
      expectedRevision: 3,
      name: "Renamed Plain",
      authentication: {
        method: "username_password",
        username: "new operator",
        password: " new private password ",
      },
    },
  ]);
  expect(secret).toHaveValue("");
  expect(document.body.textContent).not.toContain("new private password");
});

test.each([
  ["oversized UTF-8 password", "Password", "界".repeat(342)],
] as const)(
  "Plain %s validation fails before an API write",
  async (_case, label, invalidValue) => {
    mockSettings({ connections: [], credentials: [] });
    const requests: unknown[] = [];
    context.mocks.api(vncCredentialsContract.create, ({ body, respond }) => {
      requests.push(body);
      return respond(201, { ...plainCredential, id: body.id, hosts: [] });
    });
    await page();
    const dialog = await addCredential();
    await choose(dialog, "Authentication method", "Username and password");
    await fill(within(dialog).getByLabelText("Credential name"), "Plain login");
    await fill(within(dialog).getByLabelText("Username"), "operator");
    await fill(within(dialog).getByLabelText("Password"), "valid password");
    fireEvent.input(within(dialog).getByLabelText(label), {
      target: { value: invalidValue },
    });
    click(getAction("button", "Save", dialog));
    await within(dialog).findByText(
      "Check the VNC configuration and try again.",
    );
    expect(requests).toStrictEqual([]);
  },
);

test("An X509Plain host edit preserves its exact profile and compatible credential", async () => {
  const data = mockSettings({
    connections: [plainHost],
    credentials: [plainCredential],
  });
  const requests: unknown[] = [];
  context.mocks.api(
    vncConnectionsContract.update,
    ({ body, params, respond }) => {
      requests.push({ id: params.connectionId, body });
      const updated = {
        ...plainHost,
        displayName: "Reviewed Plain workstation",
        generation: 5,
      };
      data.connections = [updated];
      return respond(200, updated);
    },
  );
  await page();
  await screen.findByText(plainHost.displayName);
  click(getAction("button", "Edit host"));
  const dialog = await screen.findByRole("dialog", { name: "Edit host" });
  expect(within(dialog).getByLabelText("Security profile")).toHaveTextContent(
    "Encrypted username and password (X509Plain)",
  );
  expect(within(dialog).getByLabelText("Credential")).toHaveTextContent(
    plainCredential.name,
  );
  await fill(
    within(dialog).getByLabelText("Display name"),
    "Reviewed Plain workstation",
  );
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(requests).toStrictEqual([
    {
      id: plainHost.id,
      body: expect.objectContaining({
        expectedGeneration: 4,
        displayName: "Reviewed Plain workstation",
        credential: { id: plainCredential.id },
        security: { type: "x509_plain", trust: { mode: "system" } },
      }),
    },
  ]);
});

test("Host edits send the reviewed generation and explicit certificate trust changes", async () => {
  const data = mockSettings({
    connections: [
      {
        ...host,
        security: { type: "x509_vnc", trust: { mode: "custom_ca", caBundle } },
      },
    ],
  });
  const requests: unknown[] = [];
  context.mocks.api(
    vncConnectionsContract.update,
    ({ body, params, respond }) => {
      requests.push({ id: params.connectionId, body });
      const updated = { ...host, generation: 5 };
      data.connections = [updated];
      return respond(200, updated);
    },
  );
  await page();
  await screen.findByText(host.displayName);
  click(getAction("button", "Edit host"));
  const dialog = await screen.findByRole("dialog", { name: "Edit host" });
  expect(within(dialog).getByLabelText("CA certificates (PEM)")).toHaveValue(
    caBundle,
  );
  await choose(
    dialog,
    "Server certificate trust",
    "System certificate authorities",
  );
  expect(within(dialog).queryByLabelText("CA certificates (PEM)")).toBeNull();
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(requests).toStrictEqual([
    {
      id: host.id,
      body: expect.objectContaining({
        expectedGeneration: 4,
        security: { type: "x509_vnc", trust: { mode: "system" } },
      }),
    },
  ]);
});

test("Deleting a host requires confirmation and uses its displayed generation", async () => {
  const data = mockSettings();
  const requests: unknown[] = [];
  context.mocks.api(
    vncConnectionsContract.delete,
    ({ body, params, respond }) => {
      requests.push({ id: params.connectionId, body });
      data.connections = [];
      return respond(204);
    },
  );
  await page();
  await screen.findByText(host.displayName);
  click(getAction("button", "Delete host"));
  const dialog = await screen.findByRole("dialog", { name: "Delete host" });
  expect(within(dialog).getByText(host.displayName)).toBeInTheDocument();
  expect(requests).toStrictEqual([]);
  click(getAction("button", "Delete host", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
  await waitFor(() => {
    return expect(screen.queryByText(host.displayName)).toBeNull();
  });
  expect(requests).toStrictEqual([
    { id: host.id, body: { expectedGeneration: 4 } },
  ]);
});

test("A reusable credential explains bound-host impact and only replaces its password explicitly", async () => {
  const data = mockSettings({
    credentials: [
      {
        ...credential,
        hosts: [
          ...credential.hosts,
          {
            id: "b0000000-0000-4000-8000-000000000002",
            displayName: "Second desktop",
          },
        ],
      },
    ],
  });
  const requests: unknown[] = [];
  context.mocks.api(
    vncCredentialsContract.update,
    ({ body, params, respond }) => {
      requests.push({ id: params.credentialId, body });
      const updated = { ...credential, revision: 4 };
      data.credentials = [updated];
      return respond(200, updated);
    },
  );
  await page();
  click(getAction("radio", "Credentials"));
  await screen.findByText(credential.name);
  expect(getAction("button", "Delete credential")).toBeDisabled();
  click(getAction("button", "Edit credential"));
  const dialog = await screen.findByRole("dialog", { name: "Edit credential" });
  expect(within(dialog).getByText("Second desktop")).toBeInTheDocument();
  expect(within(dialog).queryByLabelText("VNC password")).toBeNull();
  await userEvent.click(
    within(dialog).getByRole("checkbox", { name: "Replace authentication" }),
  );
  const secret = within(dialog).getByLabelText("VNC password");
  expect(secret).toHaveValue("");
  await fill(secret, "new pwd");
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(requests).toStrictEqual([
    {
      id: credential.id,
      body: expect.objectContaining({
        expectedRevision: 3,
        authentication: { method: "vnc_password", password: "new pwd" },
      }),
    },
  ]);
  expect(secret).toHaveValue("");
});

test("Renaming a credential keeps its stored password without sending authentication", async () => {
  mockSettings();
  const requests: unknown[] = [];
  context.mocks.api(vncCredentialsContract.update, ({ body, respond }) => {
    requests.push(body);
    return respond(200, { ...credential, name: "Renamed login", revision: 4 });
  });
  await page();
  click(getAction("radio", "Credentials"));
  await screen.findByText(credential.name);
  click(getAction("button", "Edit credential"));
  const dialog = await screen.findByRole("dialog", { name: "Edit credential" });
  await fill(within(dialog).getByLabelText("Credential name"), "Renamed login");
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(requests).toStrictEqual([
    { expectedRevision: 3, name: "Renamed login" },
  ]);
});

test("Deleting an unused credential sends the reviewed revision after confirmation", async () => {
  const data = mockSettings({
    connections: [],
    credentials: [{ ...credential, hosts: [] }],
  });
  const requests: unknown[] = [];
  context.mocks.api(
    vncCredentialsContract.delete,
    ({ body, params, respond }) => {
      requests.push({ id: params.credentialId, body });
      data.credentials = [];
      return respond(204);
    },
  );
  await page();
  click(getAction("radio", "Credentials"));
  await screen.findByText(credential.name);
  click(getAction("button", "Delete credential"));
  const dialog = await screen.findByRole("dialog", {
    name: "Delete credential",
  });
  expect(within(dialog).getByText(credential.name)).toBeInTheDocument();
  click(getAction("button", "Delete credential", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
  await waitFor(() => {
    return expect(screen.queryByText(credential.name)).toBeNull();
  });
  expect(requests).toStrictEqual([
    { id: credential.id, body: { expectedRevision: 3 } },
  ]);
});

test("A host conflict requires closing and reviewing the refreshed host before another save", async () => {
  const data = mockSettings();
  const requests: unknown[] = [];
  context.mocks.api(vncConnectionsContract.update, ({ body, respond }) => {
    requests.push(body);
    if (body.expectedGeneration === 4) {
      data.connections = [
        { ...host, displayName: "Changed elsewhere", generation: 5 },
      ];
      return respond(409, {
        error: {
          code: "VNC_GENERATION_CONFLICT",
          message: "private host conflict",
        },
      });
    }
    const updated = {
      ...host,
      displayName: body.displayName ?? host.displayName,
      generation: 6,
    };
    data.connections = [updated];
    return respond(200, updated);
  });
  await page();
  await screen.findByText(host.displayName);
  click(getAction("button", "Edit host"));
  const dialog = await screen.findByRole("dialog", { name: "Edit host" });
  await fill(within(dialog).getByLabelText("Display name"), "My edit");
  click(getAction("button", "Save", dialog));
  await within(dialog).findByText(
    /Close this dialog and review the current details/u,
  );
  expect(getAction("button", "Save", dialog)).toBeDisabled();
  expect(queryAction("button", "Retry", dialog)).toBeNull();
  expect(requests).toStrictEqual([
    expect.objectContaining({ expectedGeneration: 4, displayName: "My edit" }),
  ]);
  expect(document.body.textContent).not.toContain("private host conflict");
  click(getAction("button", "Close", dialog));
  await screen.findByText("Changed elsewhere");
  click(getAction("button", "Edit host"));
  const reopened = await screen.findByRole("dialog", { name: "Edit host" });
  expect(within(reopened).getByLabelText("Display name")).toHaveValue(
    "Changed elsewhere",
  );
  await fill(within(reopened).getByLabelText("Display name"), "Reviewed edit");
  click(getAction("button", "Save", reopened));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
  await screen.findByText("Reviewed edit");
  expect(requests).toStrictEqual([
    expect.objectContaining({ expectedGeneration: 4, displayName: "My edit" }),
    expect.objectContaining({
      expectedGeneration: 5,
      displayName: "Reviewed edit",
    }),
  ]);
});

test("A credential conflict never rotates a password against an unseen revision", async () => {
  const data = mockSettings();
  const requests: unknown[] = [];
  context.mocks.api(vncCredentialsContract.update, ({ body, respond }) => {
    requests.push(body);
    data.credentials = [{ ...credential, name: "Updated login", revision: 4 }];
    return respond(409, {
      error: {
        code: "VNC_CREDENTIAL_REVISION_CONFLICT",
        message: "private credential conflict",
      },
    });
  });
  await page();
  click(getAction("radio", "Credentials"));
  await screen.findByText(credential.name);
  click(getAction("button", "Edit credential"));
  const dialog = await screen.findByRole("dialog", { name: "Edit credential" });
  await fill(within(dialog).getByLabelText("Credential name"), "My login");
  await userEvent.click(
    within(dialog).getByRole("checkbox", { name: "Replace authentication" }),
  );
  const secret = within(dialog).getByLabelText("VNC password");
  await fill(secret, "new-pass");
  click(getAction("button", "Save", dialog));
  await within(dialog).findByText(
    /Close this dialog and review the current details/u,
  );
  expect(getAction("button", "Save", dialog)).toBeDisabled();
  expect(requests).toStrictEqual([
    {
      expectedRevision: 3,
      name: "My login",
      authentication: { method: "vnc_password", password: "new-pass" },
    },
  ]);
  expect(document.body.textContent).not.toContain(
    "private credential conflict",
  );
  click(getAction("button", "Close", dialog));
  expect(secret).toHaveValue("");
  await screen.findByText("Updated login");
  click(getAction("button", "Edit credential"));
  const reopened = await screen.findByRole("dialog", {
    name: "Edit credential",
  });
  expect(within(reopened).getByLabelText("Credential name")).toHaveValue(
    "Updated login",
  );
  expect(within(reopened).queryByLabelText("VNC password")).toBeNull();
});

test("An uncertain host creation freezes its draft and explicitly retries the same UUID and password", async () => {
  const data = mockSettings({ connections: [], credentials: [] });
  const requests: unknown[] = [];
  let acknowledge = false;
  // A lost response has no contract status; intercept the transport boundary.
  context.mocks.http.post("*/api/vnc/connections", async ({ request }) => {
    const body: unknown = await request.json();
    requests.push(vncConnectionsContract.create.body.parse(body));
    data.connections = [host];
    return acknowledge
      ? new HttpResponse(null, { status: 204 })
      : HttpResponse.error();
  });
  await openAddHostPage();
  const dialog = await screen.findByRole("dialog", { name: "Add host" });
  await fillHost(dialog);
  await fill(within(dialog).getByLabelText("Credential name"), "Retry login");
  const secret = within(dialog).getByLabelText("VNC password");
  await fill(secret, " retry ");
  click(getAction("button", "Save", dialog));
  await within(dialog).findByText(/The save result is unknown/u);
  expect(secret).toHaveValue(" retry ");
  expect(secret).toBeDisabled();
  expect(within(dialog).getByLabelText("Credential name")).toBeDisabled();
  expect(getAction("button", "Retry", dialog)).toBeEnabled();
  acknowledge = true;
  click(getAction("button", "Retry", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
  const newCredential = {
    name: "Retry login",
    authentication: { method: "vnc_password", password: " retry " },
  };
  const creationId = expect.any(String);
  const expected = {
    id: creationId,
    displayName: "Second desktop",
    host: "second.example.com",
    port: 5900,
    transport: { type: "direct" },
    credential: { create: newCredential },
    security: { type: "x509_vnc", trust: { mode: "system" } },
  };
  expect(requests).toStrictEqual([expected, expected]);
  expect(requests[1]).toStrictEqual(requests[0]);
  expect(secret).toHaveValue("");
});

test.each(["密码"])(
  "An unsupported password %s remains intact and cannot be saved",
  async (password) => {
    mockSettings({ connections: [], credentials: [] });
    const requests: unknown[] = [];
    context.mocks.api(vncCredentialsContract.create, ({ body, respond }) => {
      requests.push(body);
      return respond(201, credential);
    });
    await page();
    const dialog = await addCredential();
    await fill(
      within(dialog).getByLabelText("Credential name"),
      "Desktop login",
    );
    const secret = within(dialog).getByLabelText("VNC password");
    await userEvent.type(secret, password);
    expect(secret).toHaveValue(password);
    expect(secret).toBeInvalid();
    click(getAction("button", "Save", dialog));
    expect(requests).toStrictEqual([]);
    expect(dialog).toBeInTheDocument();
  },
);

test("A known invalid credential response retains an editable draft without leaking server details", async () => {
  mockSettings({ connections: [], credentials: [] });
  context.mocks.api(vncCredentialsContract.create, ({ respond }) => {
    return respond(400, {
      error: {
        code: "VNC_INVALID_INPUT",
        message: "private invalid credential details",
      },
    });
  });
  await page();
  const dialog = await addCredential();
  await fill(within(dialog).getByLabelText("Credential name"), "Desktop login");
  const secret = within(dialog).getByLabelText("VNC password");
  await fill(secret, "retained");
  click(getAction("button", "Save", dialog));
  await within(dialog).findByRole("alert");
  expect(secret).toHaveValue("retained");
  expect(secret).toBeEnabled();
  expect(getAction("button", "Save", dialog)).toBeEnabled();
  expect(queryAction("button", "Retry", dialog)).toBeNull();
  expect(document.body.textContent).not.toContain(
    "private invalid credential details",
  );
});

test("A disabled VNC scope hides VNC without accessing saved configuration", async () => {
  const requests: string[] = [];
  context.mocks.http.get("*/api/vnc/*", ({ request }) => {
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
    return HttpResponse.json(
      { error: { code: "FORBIDDEN", message: "VNC disabled" } },
      { status: 403 },
    );
  });
  await setupPage({
    context,
    path: "/connectors?scope=remote-control&type=vnc",
    auth,
    featureSwitches: { [FeatureSwitchKey.VncAccess]: false },
  });
  await screen.findByRole("radio", { name: "Connections" });
  expect(screen.queryByRole("heading", { name: "VNC" })).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(requests).toStrictEqual([]);
});

test("Changing owner while token acquisition is pending cancels the save and clears the secret", async () => {
  mockSettings({ connections: [], credentials: [] });
  const requests: unknown[] = [];
  context.mocks.api(vncConnectionsContract.create, ({ body, respond }) => {
    requests.push(body);
    return respond(201, host);
  });
  await page();
  await screen.findByText("Add a VNC host to get started.");
  click(getAction("button", "Add host"));
  const dialog = await screen.findByRole("dialog", { name: "Add host" });
  await fillHost(dialog);
  await fill(within(dialog).getByLabelText("Credential name"), "Old login");
  const secret = within(dialog).getByLabelText("VNC password");
  await fill(secret, "old-pass");
  const token = context.mocks.deferred<string>();
  const started = context.mocks.deferred<void>();
  mockedClerk.sessionGetToken.mockImplementationOnce(() => {
    started.resolve();
    return token.promise;
  });
  click(getAction("button", "Save", dialog));
  await started.promise;
  const clerk = context.mocks.clerk();
  act(() => {
    clerk.user(
      { id: "other-vnc-owner", fullName: "Other Owner" },
      { token: "other-token" },
    );
    clerk.stateChanged();
  });
  await act(async () => {
    token.resolve("old-owner-token");
    await token.promise;
  });
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(secret).toHaveValue("");
  expect(requests).toStrictEqual([]);
});

test.each(
  VNC_RSA_AES_SECURITY_TYPES.flatMap((type) => {
    return ["rsa_aes_password", "rsa_aes_username_password"].map((method) => {
      return { type, method } as const;
    });
  }),
)(
  "RSA-AES $type/$method saves an independent pin and exact route",
  async ({ type, method }) => {
    mockSettings({
      connections: [],
      credentials: [],
      sshConnections: [sshHost],
    });
    const ne = type.includes("ra2ne");
    const mode =
      type === "rsa_aes_ra2"
        ? "RA2 · AES-128"
        : type === "rsa_aes_ra2_256"
          ? "RA2_256 · AES-256"
          : type === "rsa_aes_ra2ne"
            ? "RA2ne · authentication only"
            : "RA2ne_256 · authentication only";
    const user = method === "rsa_aes_username_password";
    const requests: unknown[] = [];
    context.mocks.api(vncConnectionsContract.create, ({ body, respond }) => {
      requests.push(body);
      return respond(201, {
        ...host,
        rsaAesAuthentication: user
          ? "rsa_aes_username_password"
          : "rsa_aes_password",
        security: { type, serverKeySha256: "ab".repeat(32) },
        ...(ne
          ? {
              transport: { type: "ssh", connectionId: sshHost.id },
              host: "127.0.0.1",
            }
          : {}),
      });
    });
    await openAddHostPage();
    const dialog = await screen.findByRole("dialog", { name: "Add host" });
    await choose(
      dialog,
      "Security profile",
      `${mode} · ${user ? "username/password" : "password"}`,
    );
    expect(
      within(dialog).queryByLabelText("TLS certificate identity"),
    ).toBeNull();
    expect(
      within(dialog).queryByLabelText("Server certificate trust"),
    ).toBeNull();
    await fill(within(dialog).getByLabelText("Display name"), "RSA desktop");
    expect(queryAction("radio", "Direct from Runner", dialog) === null).toBe(
      ne,
    );
    expect(
      within(dialog).queryByText(/SSH protects only its hop/u) !== null,
    ).toBe(ne);
    if (ne) {
      await choose(
        dialog,
        "SSH host",
        "Desktop gateway · gateway.example.com:22",
      );
    } else {
      await fill(
        within(dialog).getByLabelText("RFB destination host"),
        "rsa.example.com",
      );
    }
    await fill(
      within(dialog).getByLabelText("Server RSA wire-key SHA256"),
      "ab".repeat(32),
    );
    await choose(dialog, "Credential", "Create new credential");
    await fill(within(dialog).getByLabelText("Credential name"), "RSA login");
    expect(within(dialog).queryByLabelText("Username") !== null).toBe(user);
    if (user) {
      await fill(within(dialog).getByLabelText("Username"), "用户名");
    }
    const password = within(dialog).getByLabelText("Password");
    expect(password).toHaveAttribute("maxlength", "255");
    await fill(password, "界".repeat(85));
    click(getAction("button", "Save", dialog));
    await waitFor(() => {
      return expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(requests).toStrictEqual([
      {
        id: expect.any(String),
        displayName: "RSA desktop",
        host: ne ? "127.0.0.1" : "rsa.example.com",
        port: 5900,
        transport: ne
          ? { type: "ssh", connectionId: sshHost.id }
          : { type: "direct" },
        security: { type, serverKeySha256: "ab".repeat(32) },
        credential: {
          create: {
            name: "RSA login",
            authentication: user
              ? { method, username: "用户名", password: "界".repeat(85) }
              : { method, password: "界".repeat(85) },
          },
        },
      },
    ]);
    expect(password).toHaveValue("");
  },
);

test("Trusted RSA public-key import only fills the pin and does not save or establish provenance", async () => {
  mockSettings({ connections: [], credentials: [] });
  const requests: unknown[] = [];
  context.mocks.api(
    vncConnectionsContract.inspectRsaKey,
    ({ body, respond }) => {
      requests.push(body);
      return respond(200, {
        serverKeySha256: "cd".repeat(32),
        modulusBits: 2048,
      });
    },
  );
  await openAddHostPage();
  const dialog = await screen.findByRole("dialog", { name: "Add host" });
  await choose(dialog, "Security profile", "RA2 · AES-128 · password");
  await fill(
    within(dialog).getByLabelText(
      "Independently trusted RSA public PEM (optional)",
    ),
    "synthetic-trusted-public-pem",
  );
  click(getAction("button", "Import trusted public key", dialog));
  await waitFor(() => {
    return expect(
      within(dialog).getByLabelText("Server RSA wire-key SHA256"),
    ).toHaveValue("cd".repeat(32));
  });
  expect(
    within(dialog).getByText("Imported public-key size: 2048 bits"),
  ).toBeInTheDocument();
  expect(
    within(dialog).getByText(/Conversion does not establish identity or save/u),
  ).toBeInTheDocument();
  expect(requests).toStrictEqual([
    { publicKeyPem: "synthetic-trusted-public-pem" },
  ]);
  expect(dialog).toBeInTheDocument();
});

test("A late RSA import cannot associate its old pin with a newer public-key draft", async () => {
  mockSettings({ connections: [], credentials: [] });
  const started = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  context.mocks.api(
    vncConnectionsContract.inspectRsaKey,
    async ({ respond }) => {
      started.resolve();
      await release.promise;
      return respond(200, {
        serverKeySha256: "cd".repeat(32),
        modulusBits: 2048,
      });
    },
  );
  await openAddHostPage();
  const dialog = await screen.findByRole("dialog", { name: "Add host" });
  await choose(dialog, "Security profile", "RA2 · AES-128 · password");
  const pin = within(dialog).getByLabelText("Server RSA wire-key SHA256");
  const pem = within(dialog).getByLabelText(
    "Independently trusted RSA public PEM (optional)",
  );
  await fill(pin, "ab".repeat(32));
  await fill(pem, "old-public-pem");
  click(getAction("button", "Import trusted public key", dialog));
  await started.promise;
  await fill(pem, "new-public-pem");
  release.resolve();
  await within(dialog).findByRole("alert");
  expect(pin).toHaveValue("ab".repeat(32));
  expect(pem).toHaveValue("new-public-pem");
  expect(
    within(dialog).queryByText("Imported public-key size: 2048 bits"),
  ).toBeNull();
});
