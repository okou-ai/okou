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
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
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
const host = Object.freeze<VncConnectionResponse>({
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
const plainHost = Object.freeze<VncConnectionResponse>({
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
const tunneledHost = Object.freeze<VncConnectionResponse>({
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
  return data;
}

function page(path = "/connectors/vnc") {
  return setupPage({
    context,
    path,
    auth,
    featureSwitches: { [FeatureSwitchKey.VncAccess]: true },
  });
}

async function choose(dialog: HTMLElement, label: string, name: string) {
  await userEvent.click(within(dialog).getByLabelText(label));
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

test("The VNC connector page omits the redundant refresh action", async () => {
  mockSettings();
  await page();
  await screen.findByText(host.displayName);
  expect(
    screen.getByRole("heading", { name: "VNC remote access" }),
  ).toBeInTheDocument();
  expect(
    screen.getByText("Let your agents view and control remote desktops."),
  ).toBeInTheDocument();
  expect(queryAction("button", "Refresh")).toBeNull();
  expect(getAction("radio", "Hosts")).toHaveAttribute("aria-checked", "true");
  expect(getAction("radio", "Credentials")).toBeInTheDocument();
});

test("An owner reuses a VNC credential without exposing its password", async () => {
  mockSettings({ connections: [] });
  const requests: unknown[] = [];
  context.mocks.api(vncConnectionsContract.create, ({ body, respond }) => {
    requests.push(body);
    return respond(201, host);
  });
  await page("/connectors/vnc?add=1");
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

test("An owner creates an SSH-backed route with a distinct RFB destination and certificate identity", async () => {
  mockSettings({ connections: [], sshConnections: [sshHost] });
  const requests: unknown[] = [];
  context.mocks.api(vncConnectionsContract.create, ({ body, respond }) => {
    requests.push(body);
    return respond(201, tunneledHost);
  });
  await page("/connectors/vnc?add=1");
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
  expect(within(dialog).getByLabelText("SSH host")).toHaveTextContent(
    "Desktop gateway",
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
        host: tunneledHost.host,
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
  expect(within(dialog).getByLabelText("Connection route")).toHaveTextContent(
    "Through saved SSH host",
  );
  expect(
    within(dialog).getByText(/The selected SSH host is no longer available/u),
  ).toBeInTheDocument();
  expect(getAction("button", "Save", dialog)).toBeDisabled();
  await choose(dialog, "Connection route", "Direct from Runner");
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
        host: tunneledHost.host,
        port: tunneledHost.port,
        transport: { type: "direct" },
        credential: { id: tunneledHost.credentialId },
        security: tunneledHost.security,
      },
    },
  ]);
});

test("Inline password creation preserves spaces and sends the selected custom certificate trust", async () => {
  mockSettings({ connections: [] });
  const requests: unknown[] = [];
  context.mocks.api(vncConnectionsContract.create, ({ body, respond }) => {
    requests.push(body);
    return respond(201, host);
  });
  await page("/connectors/vnc?add=1");
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
  await page("/connectors/vnc?add=1");
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

test("Profile selection filters credentials and clears incompatible choices", async () => {
  mockSettings({
    connections: [],
    credentials: [credential, plainCredential],
  });
  await page("/connectors/vnc?add=1");
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

test("Apple DH host editor requires SSH loopback and omits X509 trust", async () => {
  mockSettings({ connections: [], credentials: [], sshConnections: [sshHost] });
  const requests: unknown[] = [];
  const appleHost: VncConnectionResponse = {
    ...host,
    host: "127.0.0.1",
    credentialName: "Mac login",
    security: { type: "apple_dh" },
    transport: { type: "ssh", connectionId: sshHost.id },
  };
  context.mocks.api(vncConnectionsContract.create, ({ body, respond }) => {
    requests.push(body);
    return respond(201, appleHost);
  });
  await page("/connectors/vnc?add=1");
  const dialog = await screen.findByRole("dialog", { name: "Add host" });
  await choose(dialog, "Security profile", "Mac Screen Sharing (Apple DH)");
  expect(
    within(dialog).queryByLabelText("TLS certificate identity"),
  ).toBeNull();
  expect(
    within(dialog).queryByLabelText("Server certificate trust"),
  ).toBeNull();
  expect(within(dialog).getByLabelText("Connection route")).toHaveTextContent(
    "Through saved SSH host",
  );
  await userEvent.click(within(dialog).getByLabelText("Connection route"));
  expect(
    screen.queryByRole("option", { name: "Direct from Runner" }),
  ).toBeNull();
  await userEvent.keyboard("{Escape}");
  await choose(dialog, "SSH host", "Desktop gateway · gateway.example.com:22");
  await fill(
    within(dialog).getByLabelText("Display name"),
    "Mac Screen Sharing",
  );
  await fill(
    within(dialog).getByLabelText("RFB destination host"),
    "127.0.0.1",
  );
  await choose(dialog, "Credential", "Create new credential");
  await fill(within(dialog).getByLabelText("Credential name"), "Mac login");
  await fill(within(dialog).getByLabelText("Username"), "operator");
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
            method: "apple_dh_username_password",
            username: "operator",
            password: "secret",
          },
        },
      },
      security: { type: "apple_dh" },
    },
  ]);
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
  await page("/connectors/vnc?add=1");
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

test("A disabled VNC deep link shows unavailability without accessing saved configuration", async () => {
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
    path: "/connectors/vnc?add=1",
    auth,
    featureSwitches: { [FeatureSwitchKey.VncAccess]: false },
  });
  await screen.findByText("VNC is not available in this workspace.");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(queryAction("button", "Add host")).toBeNull();
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
