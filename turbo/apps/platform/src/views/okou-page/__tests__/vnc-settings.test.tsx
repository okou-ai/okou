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
import { VNC_RSA_AES_SECURITY_TYPES } from "@okouai/api-contracts/contracts/vnc-rsa-aes";
import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import { tailscaleContract } from "@okouai/api-contracts/contracts/tailscale";
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
import { mockNow } from "../../../lib/time.ts";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { getAction } from "./connector-integrations-test-helpers.ts";

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
const sshHost = Object.freeze({
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
} satisfies SshConnectionResponse);
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
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [] });
  });
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, { configs: [] });
  });
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

const credentialsPath =
  "/connectors?scope=remote-control&remoteView=credentials&type=vnc";

function resourcePath(connection: { id: string } = host) {
  return `/connectors?scope=remote-control&remoteResource=vnc:${connection.id}`;
}

async function page(path = credentialsPath) {
  await setupPage({ context, path, auth });
}

function connectionForm() {
  const name = screen.getByLabelText(/Connection name/u);
  const form = name.closest("form");
  if (!form) {
    throw new Error("Expected the remote connection form");
  }
  return form;
}

async function openAddHostPage(
  profile = "Encrypted VNC (X509Vnc)",
  inspectProfile?: () => void,
) {
  await page("/connectors?scope=remote-control&setup=vnc");
  await screen.findByRole("heading", { name: "Add remote connection" });
  click(
    screen.getByText("Control the device’s screen with a mouse and keyboard."),
  );
  await screen.findByLabelText("Login method");
  const group = profile.startsWith("Mac VNC")
    ? "Apple screen sharing"
    : profile.startsWith("RA2")
      ? "RSA-AES"
      : profile.startsWith("Kerberos") || profile.startsWith("QEMU")
        ? "QEMU or enterprise authentication"
        : "Certificate-based VNC";
  await choose(document.body, "Service type", group);
  await choose(document.body, "Login method", profile);
  if (inspectProfile) {
    click(
      screen.getByText("Protocol and security details", {
        selector: "summary",
      }),
    );
    inspectProfile();
  }
  click(getAction("button", "Continue"));
  await screen.findByRole("heading", { name: "Connect a device" });
  return connectionForm();
}

async function enterLogin(form: HTMLElement, name = "Second desktop") {
  click(getAction("button", "Continue", form));
  await screen.findByRole("heading", {
    name: "Enter device login information",
  });
  await fill(within(form).getByLabelText(/Connection name/u), name);
}

async function reviewConnection(form: HTMLElement) {
  click(getAction("button", "Continue", form));
  await screen.findByRole("heading", { name: "Review and save" });
}

async function editHost() {
  click(getAction("button", "Edit connection"));
  await screen.findByRole("heading", { name: "Edit connection" });
  const form = connectionForm();
  click(within(form).getByText("Connection settings", { selector: "summary" }));
  click(within(form).getByText("More settings", { selector: "summary" }));
  return form;
}

function showIdentity() {
  click(
    screen.getByText("Server identity and chat permissions", {
      selector: "summary",
    }),
  );
}

async function reuseCredential(form: HTMLElement, name: string) {
  click(getAction("button", "Choose saved login details", form));
  const picker = await screen.findByRole("dialog", {
    name: "Choose saved login details",
  });
  click(within(picker).getByText(name));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
}

test.each(["cloudflare_access", "direct"] as const)(
  "Native %s RFB and detached KDC routes preserve identity and open an explicit rebind editor",
  async (rfbTransport) => {
    const native: VncConnectionResponse = {
      ...host,
      displayName: "Native desktop",
      transport:
        rfbTransport === "direct"
          ? { type: "direct" }
          : {
              type: "cloudflare_access",
              configId: host.id,
              originTls: {
                serverName: "origin.example.com",
                trust: { mode: "custom_ca", caBundle: "ORIGIN_CA" },
              },
            },
      kerberosAuthentication: "qemu_kerberos_password",
      security: {
        type: "qemu_x509_gssapi",
        serverName: "rfb.example.com",
        trust: { mode: "system" },
        service: { realm: "EXAMPLE.COM", components: ["vnc", "desktop"] },
        kdc: {
          host: "kdc.tailnet",
          port: 88,
          transport: { type: "tailscale", needsRebind: true },
          ticketLifetimeSeconds: 1200,
          renewableLifetimeSeconds: 7200,
        },
      },
    };
    mockSettings({ connections: [native] });
    await page(resourcePath(native));
    const title = await screen.findByRole("heading", {
      name: "Native desktop",
    });
    const card = title.closest("article");
    expect(card).not.toBeNull();
    if (!card) {
      throw new Error("Missing host card");
    }
    expect(within(card).queryAllByText("Cloudflare Access")).toHaveLength(
      rfbTransport === "cloudflare_access" ? 1 : 0,
    );
    expect(
      within(card).queryAllByText(/Origin TLS: origin.example.com/),
    ).toHaveLength(rfbTransport === "cloudflare_access" ? 1 : 0);
    expect(within(card).queryAllByText("Direct from Runner")).toHaveLength(
      rfbTransport === "direct" ? 1 : 0,
    );
    expect(within(card).getByText("Tailscale")).toBeInTheDocument();
    showIdentity();
    expect(within(card).getByText("rfb.example.com")).toBeInTheDocument();
    expect(
      within(card).getByText(/needs a new configuration/),
    ).toBeInTheDocument();
    expect(getAction("button", "Edit connection", card)).toBeEnabled();
    expect(getAction("button", "Delete connection", card)).toBeEnabled();
    const dialog = await editHost();
    expect(
      within(dialog).getByLabelText("Separate KDC route"),
    ).toHaveTextContent("Tailscale");
    expect(
      within(dialog).getByLabelText("Connection method"),
    ).toHaveTextContent(
      rfbTransport === "direct" ? "Direct connection" : "Cloudflare Access",
    );
    expect(getAction("button", "Save", dialog)).toBeDisabled();
  },
);

test("A conflicting VNC edit preserves the draft and blocks saving", async () => {
  const data = mockSettings();
  const requests: unknown[] = [];
  context.mocks.api(vncConnectionsContract.update, ({ body, respond }) => {
    requests.push(body);
    data.connections = [
      {
        ...host,
        generation: 5,
        transport: { type: "tailscale", configId: host.id },
      },
    ];
    return respond(409, {
      error: { code: "VNC_GENERATION_CONFLICT", message: "Changed route" },
    });
  });
  await page(resourcePath());
  await screen.findByRole("heading", { name: host.displayName });
  const dialog = await editHost();
  await fill(
    within(dialog).getByLabelText(/Connection name/u),
    "Preserved draft",
  );
  click(getAction("button", "Save", dialog));
  await within(dialog).findByRole("alert");
  expect(getAction("button", "Save", dialog)).toBeDisabled();
  expect(within(dialog).getByLabelText(/Connection name/u)).toHaveValue(
    "Preserved draft",
  );
  expect(requests).toHaveLength(1);
});

test("VNC settings show a current-generation failure and its observation time", async () => {
  mockSettings();
  let failed = true;
  context.mocks.api(vncConnectionsContract.observations, ({ respond }) => {
    return respond(200, {
      observations: [
        {
          connectionId: host.id,
          connectionCreatedAt: host.createdAt,
          generation: host.generation,
          observedAt: "2026-10-14T00:00:00.000Z",
          failureReason: failed ? "authentication_failed" : null,
        },
      ],
    });
  });
  await page(resourcePath());
  const failure = await screen.findByText(
    "Authentication or server identity verification failed.",
  );
  expect(failure).toBeInTheDocument();
  const card = failure.closest("article");
  if (!card) {
    throw new Error("Expected a VNC host card");
  }
  expect(within(card).getByText(/^Observed /)).toHaveAttribute(
    "datetime",
    "2026-10-14T00:00:00.000Z",
  );
  expect(getAction("button", "Edit connection", card)).toBeEnabled();
  failed = false;
  context.mocks.ably.trigger("vnc:observations-changed", {
    orgId: "another-org",
  });
  expect(failure).toBeInTheDocument();
  context.mocks.ably.trigger("vnc:observations-changed", {
    orgId: auth.organization.activeOrg.id,
  });
  await waitFor(() => {
    expect(
      screen.queryByText(
        "Authentication or server identity verification failed.",
      ),
    ).not.toBeInTheDocument();
  });
  expect(within(card).getByText(host.displayName)).toBeInTheDocument();
});

test.each([
  {
    name: "generation",
    generation: host.generation - 1,
    createdAt: host.createdAt,
  },
  {
    name: "creation instance",
    generation: host.generation,
    createdAt: "2026-08-01T00:00:00.000Z",
  },
])(
  "VNC settings do not render a previous $name's failure as current",
  async ({ generation, createdAt }) => {
    mockSettings({
      connections: [host, plainHost],
      credentials: [credential, plainCredential],
    });
    context.mocks.api(vncConnectionsContract.observations, ({ respond }) => {
      return respond(200, {
        observations: [
          {
            connectionId: host.id,
            connectionCreatedAt: createdAt,
            generation,
            observedAt: "2026-10-14T00:00:00.000Z",
            failureReason: "authentication_failed",
          },
          {
            connectionId: plainHost.id,
            connectionCreatedAt: plainHost.createdAt,
            generation: plainHost.generation,
            observedAt: "2026-10-14T00:00:00.000Z",
            failureReason: "network_failure",
          },
        ],
      });
    });
    await page(resourcePath(plainHost));
    await screen.findByText("The connection transport failed.");
    click(getAction("button", "Back to remote connections"));
    const row = await screen.findByRole("listitem", { name: host.displayName });
    click(getAction("link", "Manage", row));
    await screen.findByRole("heading", { name: host.displayName });
    expect(getAction("button", "Edit connection")).toBeEnabled();
    expect(
      screen.queryByText(
        "Authentication or server identity verification failed.",
      ),
    ).not.toBeInTheDocument();
  },
);

test("VNC settings refresh observations when their SSH carrier changes", async () => {
  const data = mockSettings({
    connections: [tunneledHost],
    sshConnections: [sshHost],
  });
  let currentCarrier = true;
  const started = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  context.mocks.api(
    vncConnectionsContract.observations,
    async ({ respond }) => {
      if (!currentCarrier) {
        started.resolve();
        await release.promise;
      }
      return respond(200, {
        observations: currentCarrier
          ? [
              {
                connectionId: tunneledHost.id,
                connectionCreatedAt: tunneledHost.createdAt,
                generation: tunneledHost.generation,
                observedAt: "2026-10-14T00:00:00.000Z",
                failureReason: "authentication_failed",
              },
            ]
          : [],
      });
    },
  );
  await page(resourcePath(tunneledHost));
  await expect(
    screen.findByText("Authentication or server identity verification failed."),
  ).resolves.toBeInTheDocument();
  currentCarrier = false;
  data.sshConnections = [{ ...sshHost, generation: sshHost.generation + 1 }];
  context.mocks.ably.trigger("ssh:changed", {
    orgId: auth.organization.activeOrg.id,
  });
  await started.promise;
  expect(
    screen.queryByText(
      "Authentication or server identity verification failed.",
    ),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: tunneledHost.displayName }),
  ).toBeInTheDocument();
  release.resolve();
});

test("A local SSH carrier reset invalidates retained VNC diagnostics before realtime delivery", async () => {
  const data = mockSettings({
    connections: [tunneledHost],
    sshConnections: [
      {
        ...sshHost,
        learnedHostKey: {
          algorithm: "ssh-ed25519",
          fingerprint: "SHA256:fixture",
        },
      },
    ],
  });
  let currentCarrier = true;
  const started = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  context.mocks.api(
    vncConnectionsContract.observations,
    async ({ respond }) => {
      if (!currentCarrier) {
        started.resolve();
        await release.promise;
      }
      return respond(200, {
        observations: currentCarrier
          ? [
              {
                connectionId: tunneledHost.id,
                connectionCreatedAt: tunneledHost.createdAt,
                generation: tunneledHost.generation,
                observedAt: "2026-10-14T00:00:00.000Z",
                failureReason: "authentication_failed",
              },
            ]
          : [],
      });
    },
  );
  context.mocks.api(sshConnectionsContract.resetHostKey, ({ respond }) => {
    currentCarrier = false;
    const updated = { ...sshHost, generation: sshHost.generation + 1 };
    data.sshConnections = [updated];
    return respond(200, updated);
  });
  await page(resourcePath(tunneledHost));
  await screen.findByText(
    "Authentication or server identity verification failed.",
  );
  click(getAction("button", "Back to remote connections"));
  const sshRow = await screen.findByRole("listitem", {
    name: sshHost.displayName,
  });
  click(getAction("link", "Manage", sshRow));
  await screen.findByRole("heading", { name: sshHost.displayName });
  click(getAction("button", "Reset host key"));
  const dialog = await screen.findByRole("dialog", { name: "Reset host key" });
  click(getAction("button", "Reset host key", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  click(getAction("button", "Back to remote connections"));
  const vncRow = await screen.findByRole("listitem", {
    name: tunneledHost.displayName,
  });
  click(getAction("link", "Manage", vncRow));
  await screen.findByRole("heading", { name: tunneledHost.displayName });
  await started.promise;
  expect(
    screen.queryByText(
      "Authentication or server identity verification failed.",
    ),
  ).toBeNull();
  release.resolve();
});

test("VNC settings distinguish successful and unobserved hosts from failed hosts", async () => {
  const failedHost = {
    ...host,
    id: "b0000000-0000-4000-8000-000000000005",
    displayName: "Failed workstation",
  };
  mockSettings({
    connections: [host, plainHost, failedHost],
    credentials: [credential, plainCredential],
  });
  context.mocks.api(vncConnectionsContract.observations, ({ respond }) => {
    return respond(200, {
      observations: [
        {
          connectionId: host.id,
          connectionCreatedAt: host.createdAt,
          generation: host.generation,
          observedAt: "2026-10-14T00:00:00.000Z",
          failureReason: null,
        },
        {
          connectionId: failedHost.id,
          connectionCreatedAt: failedHost.createdAt,
          generation: failedHost.generation,
          observedAt: "2026-10-14T00:00:00.000Z",
          failureReason: "network_failure",
        },
      ],
    });
  });
  await page(resourcePath(failedHost));
  const failure = await screen.findByText("The connection transport failed.");
  const failedCard = failure.closest("article");
  if (!failedCard) {
    throw new Error("Expected a VNC host card");
  }
  expect(
    within(failedCard).getByText(failedHost.displayName),
  ).toBeInTheDocument();
  for (const connection of [host, plainHost]) {
    click(getAction("button", "Back to remote connections"));
    const row = await screen.findByRole("listitem", {
      name: connection.displayName,
    });
    click(getAction("link", "Manage", row));
    await screen.findByRole("heading", { name: connection.displayName });
    const card = screen.getByRole("article");
    if (!card) {
      throw new Error("Expected a VNC host card");
    }
    expect(within(card).queryByRole("status")).toBeNull();
    expect(within(card).getByText(connection.displayName)).toBeInTheDocument();
  }
});

test("VNC settings retain the current owner's warning while observations refresh", async () => {
  mockSettings();
  let refreshing = false;
  const started = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  context.mocks.api(
    vncConnectionsContract.observations,
    async ({ respond }) => {
      if (refreshing) {
        started.resolve();
        await release.promise;
      }
      return respond(200, {
        observations: [
          {
            connectionId: host.id,
            connectionCreatedAt: host.createdAt,
            generation: host.generation,
            observedAt: "2026-10-14T00:00:00.000Z",
            failureReason: refreshing ? null : "authentication_failed",
          },
        ],
      });
    },
  );
  await page(resourcePath());
  const failure = await screen.findByText(
    "Authentication or server identity verification failed.",
  );
  refreshing = true;
  context.mocks.ably.trigger("vnc:observations-changed", {
    orgId: auth.organization.activeOrg.id,
  });
  await started.promise;
  expect(failure).toBeInTheDocument();
  release.resolve();
  await waitFor(() => {
    expect(
      screen.queryByText(
        "Authentication or server identity verification failed.",
      ),
    ).not.toBeInTheDocument();
  });
  expect(
    screen.getByRole("heading", { name: host.displayName }),
  ).toBeInTheDocument();
});

test("VNC settings never retain the previous owner's diagnostic warning", async () => {
  const data = mockSettings();
  let changedOwner = false;
  const started = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  context.mocks.api(
    vncConnectionsContract.observations,
    async ({ respond }) => {
      if (changedOwner) {
        started.resolve();
        await release.promise;
        return respond(200, { observations: [] });
      }
      return respond(200, {
        observations: [
          {
            connectionId: host.id,
            connectionCreatedAt: host.createdAt,
            generation: host.generation,
            observedAt: "2026-10-14T00:00:00.000Z",
            failureReason: "authentication_failed",
          },
        ],
      });
    },
  );
  await page(resourcePath());
  await screen.findByText(
    "Authentication or server identity verification failed.",
  );
  changedOwner = true;
  data.connections = [{ ...host, displayName: "Other owner's workstation" }];
  const clerk = context.mocks.clerk();
  act(() => {
    clerk.user(
      { id: "other-vnc-owner", fullName: "Other Owner" },
      { token: "other-token" },
    );
    clerk.stateChanged();
  });
  await started.promise;
  await waitFor(() => {
    expect(
      screen.queryByText(
        "Authentication or server identity verification failed.",
      ),
    ).not.toBeInTheDocument();
  });
  release.resolve();
  await screen.findByRole("heading", { name: "Other owner's workstation" });
});

async function choose(dialog: HTMLElement, label: string, name: string) {
  click(await within(dialog).findByLabelText(label));
  const listbox = await screen.findByRole("listbox");
  click(await within(listbox).findByRole("option", { name }));
  await waitFor(() => {
    expect(within(dialog).getByLabelText(label)).toHaveTextContent(name);
  });
}

async function inspectProtectiveRoutes(dialog: HTMLElement) {
  const trigger = within(dialog).getByLabelText("Connection method");
  trigger.focus();
  await userEvent.keyboard("{ArrowDown}");
  await expect(
    screen.findByRole("option", { name: "Direct connection" }),
  ).resolves.toHaveAttribute("aria-disabled", "true");
  expect(
    screen.getByRole("option", { name: "Cloudflare Access" }),
  ).toBeVisible();
  expect(screen.getByRole("option", { name: "Tailscale" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(trigger).toHaveFocus();
  });
}

async function addCredential() {
  const add = await waitFor(() => {
    return getAction("button", "Add credential");
  });
  click(add);
  return screen.findByRole("dialog", { name: "Add credential" });
}

async function fillHost(form: HTMLElement) {
  await fill(
    within(form).getByLabelText("Device address"),
    "second.example.com",
  );
}

test("Returning to Connectors refreshes VNC hosts changed elsewhere", async () => {
  const data = mockSettings();
  await page("/connectors?scope=remote-control");
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
  await page(resourcePath(noneHost));
  await screen.findByRole("heading", { name: noneHost.displayName });
  showIdentity();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "does not authenticate you to the VNC server",
  );
  click(getAction("button", "Back to remote connections"));
  await screen.findByRole("listitem", { name: noneHost.displayName });
  click(getAction("button", "Add connection"));
  await screen.findByRole("heading", { name: "Add remote connection" });
  click(
    screen.getByText("Control the device’s screen with a mouse and keyboard."),
  );
  await choose(
    document.body,
    "Login method",
    "Encrypted without a VNC password (X509None)",
  );
  click(
    screen.getByText("Protocol and security details", { selector: "summary" }),
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Anyone else who can reach that server",
  );
  click(getAction("button", "Continue"));
  await screen.findByRole("heading", { name: "Connect a device" });
  const dialog = connectionForm();
  await fillHost(dialog);
  await enterLogin(dialog);
  await reviewConnection(dialog);
  expect(getAction("button", "Save", dialog)).toBeEnabled();
  click(getAction("button", "Save", dialog));
  await screen.findByRole("heading", { name: "Connection added" });
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
    const dialog = await openAddHostPage(label, () => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "does not prove that the VNC server checks it",
      );
    });
    await fillHost(dialog);
    await enterLogin(dialog);
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
    await reviewConnection(dialog);
    click(getAction("button", "Save", dialog));
    await screen.findByRole("heading", { name: "Connection added" });
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
  const dialog = await openAddHostPage();
  await fillHost(dialog);
  await choose(dialog, "Connection method", "Through saved SSH host");
  await choose(dialog, "SSH host", "Desktop gateway · gateway.example.com:22");
  await choose(dialog, "Connection method", "Direct connection");
  expect(within(dialog).getByLabelText("Device address")).toHaveValue(
    "second.example.com",
  );
  await choose(dialog, "Connection method", "Through saved SSH host");
  await expect(
    within(dialog).findByLabelText("SSH host"),
  ).resolves.toHaveTextContent("Desktop gateway");
  await enterLogin(dialog);
  await reuseCredential(dialog, host.displayName);
  await reviewConnection(dialog);
  await fill(
    within(dialog).getByLabelText("VNC certificate name"),
    "desktop.internal.example.com",
  );
  click(getAction("button", "Save", dialog));
  await screen.findByRole("heading", { name: "Connection added" });
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
      "Rebind this saved SSH host to a Tailscale network before using VNC.",
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
    await page(resourcePath(tunneledHost));
    const card = await screen.findByRole("heading", {
      name: tunneledHost.displayName,
    });
    const blocked = card.closest("article");
    expect(blocked).not.toBeNull();
    const details = within(blocked!);
    expect(details.getByRole("alert")).toHaveTextContent(warning);
    expect(details.getByText(/SSH host: Desktop gateway/u)).toBeInTheDocument();
    expect(details.getByText("127.0.0.1:5901")).toBeInTheDocument();
    showIdentity();
    expect(details.getByText("Desktop login")).toBeInTheDocument();
    expect(
      details.getByText("desktop.internal.example.com"),
    ).toBeInTheDocument();

    settings.sshConnections = [
      {
        ...sshHost,
        host: retained.host,
        port: retained.port,
        learnedHostKey: retained.learnedHostKey,
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
      expect(details.queryByRole("alert")).toBeNull();
    });
    expect(details.getByText(/SSH host: Desktop gateway/u)).toBeInTheDocument();
    expect(details.getByText("127.0.0.1:5901")).toBeInTheDocument();
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
  await page(resourcePath(tunneledHost));
  await screen.findByRole("heading", { name: tunneledHost.displayName });
  expect(screen.getByText("Through saved SSH host")).toBeInTheDocument();
  expect(screen.getByText("127.0.0.1:5901")).toBeInTheDocument();
  showIdentity();
  expect(screen.getByText("desktop.internal.example.com")).toBeInTheDocument();
  expect(
    screen.getByText(/The selected SSH host is no longer available/u),
  ).toBeInTheDocument();

  const dialog = await editHost();
  expect(within(dialog).getByLabelText("Connection method")).toHaveTextContent(
    "Through saved SSH host",
  );
  expect(
    within(dialog).getByText(/The selected SSH host is no longer available/u),
  ).toBeInTheDocument();
  expect(getAction("button", "Save", dialog)).toBeDisabled();
  await choose(dialog, "Connection method", "Direct connection");
  expect(getAction("button", "Save", dialog)).toBeDisabled();
  expect(within(dialog).getByRole("alert")).toHaveTextContent(
    "Private IP addresses require a supported private-network route or saved SSH host",
  );
  await fill(
    within(dialog).getByLabelText("Device address"),
    "desktop.example.com",
  );
  expect(getAction("button", "Save", dialog)).toBeEnabled();
  click(getAction("button", "Save", dialog));
  await screen.findByRole("heading", { name: tunneledHost.displayName });
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
  await page(resourcePath(appleHost));
  await screen.findByRole("heading", { name: appleHost.displayName });
  const dialog = await editHost();
  expect(within(dialog).getByLabelText(/Connection name/u)).toHaveValue(
    "Mac IPv6 desktop",
  );
  expect(within(dialog).getByLabelText("Device address")).toHaveTextContent(
    "::1",
  );
  expect(within(dialog).getByLabelText("Port")).toHaveValue(5905);
  await expect(
    within(dialog).findByLabelText("SSH host"),
  ).resolves.toHaveTextContent(sshHost.displayName);
  await waitFor(() => {
    expect(getAction("button", "Save", dialog)).toBeEnabled();
  });
  click(getAction("button", "Save", dialog));
  await screen.findByRole("heading", { name: appleHost.displayName });
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
  const dialog = await openAddHostPage();
  await fillHost(dialog);
  await waitFor(() => {
    expect(getAction("button", "Continue", dialog)).toBeEnabled();
  });
  const destination = within(dialog).getByLabelText("Device address");
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
      "Private IP addresses require a supported private-network route or saved SSH host",
    );
    expect(getAction("button", "Continue", dialog)).toBeDisabled();
  }
  await fill(destination, "::ffff:8.8.8.8");
  expect(within(dialog).queryByRole("alert")).toBeNull();
  expect(getAction("button", "Continue", dialog)).toBeEnabled();
});

test("Inline password creation preserves spaces and sends the selected custom certificate trust", async () => {
  mockSettings({ connections: [] });
  const requests: unknown[] = [];
  context.mocks.api(vncConnectionsContract.create, ({ body, respond }) => {
    requests.push(body);
    return respond(201, host);
  });
  const dialog = await openAddHostPage();
  await fillHost(dialog);
  await enterLogin(dialog);
  const secret = within(dialog).getByLabelText("VNC password");
  expect(secret).toHaveAttribute("type", "password");
  expect(secret).toHaveValue("");
  await fill(secret, " pwd  ");
  await reviewConnection(dialog);
  await choose(
    dialog,
    "Server certificate trust",
    "Custom certificate authorities",
  );
  await fill(within(dialog).getByLabelText("CA certificates (PEM)"), caBundle);
  click(getAction("button", "Save", dialog));
  await screen.findByRole("heading", { name: "Connection added" });
  expect(requests).toStrictEqual([
    {
      id: expect.any(String),
      displayName: "Second desktop",
      host: "second.example.com",
      port: 5900,
      transport: { type: "direct" },
      credential: {
        create: {
          name: "Second desktop",
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
  const dialog = await openAddHostPage(
    "Encrypted username and password (X509Plain)",
  );
  await fillHost(dialog);
  await enterLogin(dialog);
  await fill(within(dialog).getByLabelText("Username"), " operator ");
  const secret = within(dialog).getByLabelText("Password");
  expect(secret).toHaveAttribute("type", "password");
  expect(secret).toHaveValue("");
  await fill(secret, " 密码 with spaces ");
  await reviewConnection(dialog);
  await choose(
    dialog,
    "Server certificate trust",
    "Custom certificate authorities",
  );
  await fill(within(dialog).getByLabelText("CA certificates (PEM)"), caBundle);
  click(getAction("button", "Save", dialog));
  await screen.findByRole("heading", { name: "Connection added" });
  expect(requests).toStrictEqual([
    {
      id: expect.any(String),
      displayName: "Second desktop",
      host: "second.example.com",
      port: 5900,
      transport: { type: "direct" },
      credential: {
        create: {
          name: "Second desktop",
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
  const dialog = await openAddHostPage("QEMU SCRAM-SHA-256 (X509SASL)", () => {
    expect(screen.getByText(/subtype 263 only/u)).toBeInTheDocument();
  });
  await fillHost(dialog);
  await enterLogin(dialog);
  const username = within(dialog).getByLabelText("Username");
  const password = within(dialog).getByLabelText("Password");
  expect(username).toHaveAttribute("pattern", "(?!.*[,=])[!-~]{1,255}");
  expect(password).toHaveAttribute("pattern", "[ -~]{1,1023}");
  await fill(username, "operator");
  await fill(password, " secret ");
  await reviewConnection(dialog);
  await choose(
    dialog,
    "Server certificate trust",
    "Custom certificate authorities",
  );
  await fill(within(dialog).getByLabelText("CA certificates (PEM)"), caBundle);
  click(getAction("button", "Save", dialog));
  await screen.findByRole("heading", { name: "Connection added" });
  expect(requests).toStrictEqual([
    {
      id: expect.any(String),
      displayName: "Second desktop",
      host: "second.example.com",
      port: 5900,
      transport: { type: "direct" },
      credential: {
        create: {
          name: "Second desktop",
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

test("Kerberos password saves independent explicit identities and KDC policy", async () => {
  mockSettings({ connections: [], credentials: [] });
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
  const dialog = await openAddHostPage("Kerberos · password");
  await fillHost(dialog);
  await fill(
    within(dialog).getByLabelText("VNC service realm"),
    initiator.realm,
  );
  await fill(
    within(dialog).getByLabelText("VNC service instance"),
    "desktop.identity.invalid",
  );
  await fill(within(dialog).getByLabelText("KDC host"), "kdc.example.com");
  await enterLogin(dialog);
  await fill(within(dialog).getByLabelText("Initiator realm"), initiator.realm);
  await fill(within(dialog).getByLabelText("Initiator components"), "Alice");
  const password = within(dialog).getByLabelText("Password");
  await fill(password, " exact kerb ");
  await reviewConnection(dialog);
  click(getAction("button", "Save", dialog));
  await screen.findByRole("heading", { name: "Connection added" });
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
          name: "Second desktop",
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

test("Kerberos metadata can be read and its stored password replaced without revealing it", async () => {
  const initiator = { realm: "EXAMPLE.INVALID", components: ["Alice"] };
  const saved: VncCredentialResponse = {
    ...credential,
    name: "Kerberos login",
    authMethod: "qemu_kerberos_password",
    initiator,
    revision: 5,
    hosts: [],
  };
  const data = mockSettings({ connections: [], credentials: [saved] });
  const requests: unknown[] = [];
  context.mocks.api(vncCredentialsContract.update, ({ body, respond }) => {
    requests.push(body);
    const updated = { ...saved, revision: 6 };
    data.credentials = [updated];
    return respond(200, updated);
  });
  await page();
  await screen.findByText(saved.name);
  click(getAction("button", "Edit credential"));
  const dialog = await screen.findByRole("dialog", { name: "Edit credential" });
  expect(within(dialog).queryByLabelText("Password")).toBeNull();
  await userEvent.click(
    within(dialog).getByRole("checkbox", { name: "Change login details" }),
  );
  await expect(
    within(dialog).findByLabelText("Initiator realm"),
  ).resolves.toHaveValue(initiator.realm);
  expect(within(dialog).getByLabelText("Initiator realm")).toHaveAttribute(
    "readonly",
  );
  expect(within(dialog).getByLabelText("Initiator components")).toHaveValue(
    "Alice",
  );
  const password = within(dialog).getByLabelText("Password");
  expect(password).toHaveValue("");
  await fill(password, "new-kerberos-secret");
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(requests).toStrictEqual([
    {
      expectedRevision: 5,
      name: saved.name,
      authentication: {
        method: "qemu_kerberos_password",
        initiator,
        password: "new-kerberos-secret",
      },
    },
  ]);
  expect(password).toHaveValue("");
  expect(document.body.textContent).not.toContain("new-kerberos-secret");
});

test("Mac classic password defaults to SSH loopback with risk disclosure and bounded password", async () => {
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
  const dialog = await openAddHostPage("Mac VNC (classic VNC password)");
  expect(within(dialog).queryByLabelText("VNC certificate name")).toBeNull();
  expect(
    within(dialog).queryByLabelText("Server certificate trust"),
  ).toBeNull();
  await inspectProtectiveRoutes(dialog);
  await choose(dialog, "SSH host", "Desktop gateway · gateway.example.com:22");
  const destination = within(dialog).getByLabelText("Device address");
  expect(destination).toHaveTextContent("127.0.0.1");
  await userEvent.click(destination);
  expect(screen.queryByRole("option", { name: "localhost" })).toBeNull();
  await userEvent.keyboard("{Escape}");
  await enterLogin(dialog, "Mac classic VNC");
  expect(within(dialog).queryByLabelText("Username")).toBeNull();
  const password = within(dialog).getByLabelText("VNC password");
  await fill(password, "ninebytes");
  expect(password).toBeInvalid();
  await fill(password, "secret");
  await reviewConnection(dialog);
  click(getAction("button", "Save", dialog));
  await screen.findByRole("heading", { name: "Connection added" });
  expect(requests).toStrictEqual([
    {
      id: expect.any(String),
      displayName: "Mac classic VNC",
      host: "127.0.0.1",
      port: 5900,
      transport: { type: "ssh", connectionId: sshHost.id },
      credential: {
        create: {
          name: "Mac classic VNC",
          authentication: { method: "vnc_password", password: "secret" },
        },
      },
      security: { type: "apple_vnc_password" },
    },
  ]);
});

const appleHostProfiles = [
  {
    profile: "apple_dh" as const,
    method: "apple_dh_username_password" as const,
    label: "Mac VNC (Apple DH)",
    usernameMaxLength: 63,
  },
  {
    profile: "apple_srp" as const,
    method: "apple_srp_username_password" as const,
    label: "Mac VNC (Apple Direct SRP)",
    usernameMaxLength: 255,
  },
  {
    profile: "apple_rsa_srp" as const,
    method: "apple_rsa_srp_username_password" as const,
    label: "Mac VNC (Apple RSA/SRP)",
    usernameMaxLength: 234,
  },
] as const;

test.each(appleHostProfiles)(
  "$label saves SSH loopback selection without X509 trust",
  async ({ profile, method, label }) => {
    const appleCredential: VncCredentialResponse = {
      ...credential,
      name: "Mac login",
      authMethod: method,
      username: "operator",
      hosts: [],
    };
    mockSettings({
      connections: [],
      credentials: [appleCredential],
      sshConnections: [sshHost],
    });
    const requests: unknown[] = [];
    const appleHost: CredentialedVncConnection = {
      ...host,
      host: "127.0.0.1",
      credentialId: appleCredential.id,
      credentialName: appleCredential.name,
      security: { type: profile },
      transport: { type: "ssh", connectionId: sshHost.id },
    };
    context.mocks.api(vncConnectionsContract.create, ({ body, respond }) => {
      requests.push(body);
      return respond(201, appleHost);
    });
    const dialog = await openAddHostPage(label);
    expect(within(dialog).queryByLabelText("VNC certificate name")).toBeNull();
    expect(
      within(dialog).queryByLabelText("Server certificate trust"),
    ).toBeNull();
    await inspectProtectiveRoutes(dialog);
    await choose(
      dialog,
      "SSH host",
      "Desktop gateway · gateway.example.com:22",
    );
    const destination = within(dialog).getByLabelText("Device address");
    expect(destination).toHaveTextContent("127.0.0.1");
    await choose(dialog, "Device address", "::1");
    expect(destination).toHaveTextContent("::1");
    await choose(dialog, "Device address", "127.0.0.1");
    expect(destination).toHaveTextContent("127.0.0.1");
    await enterLogin(dialog, "Mac Screen Sharing");
    await reuseCredential(dialog, appleCredential.name);
    await reviewConnection(dialog);
    click(getAction("button", "Save", dialog));
    await screen.findByRole("heading", { name: "Connection added" });
    expect(requests).toStrictEqual([
      {
        id: expect.any(String),
        displayName: "Mac Screen Sharing",
        host: "127.0.0.1",
        port: 5900,
        transport: { type: "ssh", connectionId: sshHost.id },
        credential: { id: appleCredential.id },
        security: { type: profile },
      },
    ]);
  },
);

test.each(appleHostProfiles)(
  "$label creates credentials with its username limits",
  async ({ profile, method, label, usernameMaxLength }) => {
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
    const dialog = await openAddHostPage(label);
    await choose(
      dialog,
      "SSH host",
      "Desktop gateway · gateway.example.com:22",
    );
    expect(within(dialog).getByLabelText("Device address")).toHaveTextContent(
      "127.0.0.1",
    );
    await enterLogin(dialog, "Mac Screen Sharing");
    const usernameField = within(dialog).getByLabelText("Username");
    expect(usernameField).toHaveAttribute(
      "maxLength",
      String(usernameMaxLength),
    );
    await fill(usernameField, "operator");
    await fill(within(dialog).getByLabelText("Password"), "secret");
    await reviewConnection(dialog);
    click(getAction("button", "Save", dialog));
    await screen.findByRole("heading", { name: "Connection added" });
    expect(requests).toStrictEqual([
      {
        id: expect.any(String),
        displayName: "Mac Screen Sharing",
        host: "127.0.0.1",
        port: 5900,
        transport: { type: "ssh", connectionId: sshHost.id },
        credential: {
          create: {
            name: "Mac Screen Sharing",
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
  await screen.findByRole("heading", { name: qemuCredential.name });
  expect(screen.getByText("QEMU SCRAM-SHA-256 (X509SASL)")).toBeInTheDocument();
  click(getAction("button", "Edit credential"));
  const dialog = await screen.findByRole("dialog", { name: "Edit credential" });
  expect(within(dialog).queryByLabelText("Password")).toBeNull();
  await userEvent.click(
    within(dialog).getByRole("checkbox", { name: "Change login details" }),
  );
  await expect(within(dialog).findByLabelText("Username")).resolves.toHaveValue(
    "operator",
  );
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
  const title = await screen.findByRole("heading", {
    name: plainCredential.name,
  });
  const card = title.closest("article");
  if (!card) {
    throw new Error("Expected the Plain credential card");
  }
  expect(within(card).getByText(plainCredential.username)).toBeInTheDocument();
  expect(within(card).getByText("Username and password")).toBeInTheDocument();
  click(getAction("button", "Edit credential", card));
  const rename = await screen.findByRole("dialog", {
    name: "Edit credential",
  });
  expect(
    within(rename).getByText("Leave this off to keep the saved login details."),
  ).toBeInTheDocument();
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
    within(replace).getByRole("checkbox", { name: "Change login details" }),
  );
  await expect(
    within(replace).findByLabelText("Username"),
  ).resolves.toHaveValue("operator");
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
  await page(resourcePath(plainHost));
  await screen.findByRole("heading", { name: plainHost.displayName });
  const dialog = await editHost();
  expect(within(dialog).getByLabelText("Login method")).toHaveTextContent(
    "Encrypted username and password (X509Plain)",
  );
  expect(within(dialog).getByLabelText("Username")).toHaveValue(
    plainCredential.username,
  );
  expect(within(dialog).getByLabelText("Password")).toHaveValue("");
  await fill(
    within(dialog).getByLabelText(/Connection name/u),
    "Reviewed Plain workstation",
  );
  click(getAction("button", "Save", dialog));
  await screen.findByRole("heading", { name: "Reviewed Plain workstation" });
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
  await page(resourcePath());
  await screen.findByRole("heading", { name: host.displayName });
  const dialog = await editHost();
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
  await screen.findByRole("heading", { name: host.displayName });
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
  await page(resourcePath());
  await screen.findByRole("heading", { name: host.displayName });
  click(getAction("button", "Delete connection"));
  const dialog = await screen.findByRole("dialog", {
    name: "Delete connection",
  });
  expect(within(dialog).getByText(host.displayName)).toBeInTheDocument();
  expect(requests).toStrictEqual([]);
  click(getAction("button", "Delete connection", dialog));
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
  await screen.findByText(credential.name);
  expect(getAction("button", "Delete credential")).toBeDisabled();
  click(getAction("button", "Edit credential"));
  const dialog = await screen.findByRole("dialog", { name: "Edit credential" });
  expect(within(dialog).getByText("Second desktop")).toBeInTheDocument();
  expect(within(dialog).queryByLabelText("VNC password")).toBeNull();
  await userEvent.click(
    within(dialog).getByRole("checkbox", { name: "Change login details" }),
  );
  const secret = await within(dialog).findByLabelText("VNC password");
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

test("An uncertain host creation preserves its frozen draft", async () => {
  const data = mockSettings({ connections: [], credentials: [] });
  const requests: unknown[] = [];
  // A lost response has no contract status; intercept the transport boundary.
  context.mocks.http.post("*/api/vnc/connections", async ({ request }) => {
    const body: unknown = await request.json();
    requests.push(vncConnectionsContract.create.body.parse(body));
    data.connections = [host];
    return HttpResponse.error();
  });
  const dialog = await openAddHostPage();
  await fillHost(dialog);
  await enterLogin(dialog);
  const secret = within(dialog).getByLabelText("VNC password");
  await fill(secret, " secret ");
  await reviewConnection(dialog);
  click(getAction("button", "Save", dialog));
  await within(dialog).findByText("Save failed.");
  expect(secret).toHaveValue(" secret ");
  expect(secret).toBeDisabled();
  expect(within(dialog).getByLabelText(/Connection name/u)).toBeDisabled();
  expect(getAction("button", "Save", dialog)).toBeDisabled();
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
  expect(document.body.textContent).not.toContain(
    "private invalid credential details",
  );
});

test("Changing owner while token acquisition is pending cancels the save and clears the secret", async () => {
  mockSettings({ connections: [], credentials: [] });
  const requests: unknown[] = [];
  context.mocks.api(vncConnectionsContract.create, ({ body, respond }) => {
    requests.push(body);
    return respond(201, host);
  });
  const dialog = await openAddHostPage();
  await fillHost(dialog);
  await enterLogin(dialog);
  const secret = within(dialog).getByLabelText("VNC password");
  await fill(secret, "old-pass");
  await reviewConnection(dialog);
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
    expect(dialog).not.toBeInTheDocument();
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
    const dialog = await openAddHostPage(
      `${mode} · ${user ? "username/password" : "password"}`,
      () => {
        expect(screen.queryByText(/SSH protects only its hop/u) !== null).toBe(
          ne,
        );
      },
    );
    expect(within(dialog).queryByLabelText("VNC certificate name")).toBeNull();
    expect(
      within(dialog).queryByLabelText("Server certificate trust"),
    ).toBeNull();
    expect(
      within(dialog).getByLabelText("Connection method"),
    ).toHaveTextContent(ne ? "Through saved SSH host" : "Direct connection");
    if (ne) {
      await choose(
        dialog,
        "SSH host",
        "Desktop gateway · gateway.example.com:22",
      );
    } else {
      await fill(
        within(dialog).getByLabelText("Device address"),
        "rsa.example.com",
      );
    }
    await enterLogin(dialog, "RSA desktop");
    expect(within(dialog).queryByLabelText("Username") !== null).toBe(user);
    if (user) {
      await fill(within(dialog).getByLabelText("Username"), "用户名");
    }
    const password = within(dialog).getByLabelText("Password");
    expect(password).toHaveAttribute("maxlength", "255");
    await fill(password, "界".repeat(85));
    await reviewConnection(dialog);
    await fill(
      within(dialog).getByLabelText("Server RSA wire-key SHA256"),
      "ab".repeat(32),
    );
    click(getAction("button", "Save", dialog));
    await screen.findByRole("heading", { name: "Connection added" });
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
            name: "RSA desktop",
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
  const dialog = await openAddHostPage("RA2 · AES-128 · password");
  await fillHost(dialog);
  await enterLogin(dialog);
  await fill(within(dialog).getByLabelText("Password"), "secret");
  await reviewConnection(dialog);
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
  const dialog = await openAddHostPage("RA2 · AES-128 · password");
  await fillHost(dialog);
  await enterLogin(dialog);
  await fill(within(dialog).getByLabelText("Password"), "secret");
  await reviewConnection(dialog);
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
