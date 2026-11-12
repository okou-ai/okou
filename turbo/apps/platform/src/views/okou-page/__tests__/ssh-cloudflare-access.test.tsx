import {
  cloudflareAccessContract,
  type ScopedCloudflareAccessConfig,
} from "@okouai/api-contracts/contracts/cloudflare-access";
import { tailscaleContract } from "@okouai/api-contracts/contracts/tailscale";
import {
  sshConnectionsContract,
  type SshConnectionResponse,
} from "@okouai/api-contracts/contracts/ssh-connections";
import {
  sshCredentialsContract,
  type SshCredentialResponse,
} from "@okouai/api-contracts/contracts/ssh-credentials";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getAction,
  chooseSshConnectionType,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();
const orgId = "org_access_ui";
const timestamp = "2026-09-15T00:00:00.000Z";
const config: ScopedCloudflareAccessConfig = Object.freeze({
  id: "a0000000-0000-4000-8000-000000000001",
  name: "Engineering gateway",
  scope: "personal",
  revision: 1,
  generation: 1,
  sshHosts: [],
  vncHosts: [],
  createdAt: timestamp,
  updatedAt: timestamp,
});
const credential: SshCredentialResponse = Object.freeze({
  id: "b0000000-0000-4000-8000-000000000001",
  name: "SSH login",
  username: "deploy",
  authMethod: "private_key",
  revision: 1,
  hosts: [],
  createdAt: timestamp,
  updatedAt: timestamp,
});
const directHost: SshConnectionResponse = Object.freeze({
  id: "c0000000-0000-4000-8000-000000000001",
  displayName: "Development",
  host: "ssh.example.com",
  port: 443,
  username: credential.username,
  credentialId: credential.id,
  credentialName: credential.name,
  generation: 1,
  learnedHostKey: null,
  createdAt: timestamp,
  updatedAt: timestamp,
});
const host: SshConnectionResponse = Object.freeze({
  ...directHost,
  transport: { type: "cloudflare_access" as const, configId: config.id },
});
const retainedHost: SshConnectionResponse = Object.freeze({
  ...host,
  generation: 3,
  learnedHostKey: { algorithm: "ssh-ed25519", fingerprint: "SHA256:retained" },
  transport: { type: "cloudflare_access" as const, needsRebind: true as const },
});

beforeEach(() => {
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [] });
  });
  context.mocks.api(sshCredentialsContract.list, ({ respond }) => {
    return respond(200, { credentials: [credential] });
  });
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [] });
  });
});

async function page(connectionId = host.id) {
  await setupPage({
    context,
    path: `/connectors?scope=remote-control&remoteResource=ssh:${connectionId}`,
    auth: {
      user: { id: "access-owner", fullName: "Access Owner" },
      organization: {
        activeOrg: { id: orgId, name: "Engineering" },
        memberships: [{ id: orgId }],
      },
    },
  });
}

async function editHost() {
  click(getAction("button", "Edit connection"));
  const field = await screen.findByLabelText("SSH username");
  const form = field.closest("form");
  if (!form) {
    throw new Error("Missing SSH edit form");
  }
  click(within(form).getByText("Connection settings"));
  return form;
}
async function selectConfig(dialog: HTMLElement, name = config.name) {
  await userEvent.click(
    await within(dialog).findByLabelText("Cloudflare Access"),
  );
  click(await screen.findByRole("option", { name }));
}
test("A retained protected host requires explicit shared Access selection before saving", async () => {
  const shared = { ...config, scope: "organization" as const };
  const requests: unknown[] = [];
  context.mocks.api(cloudflareAccessContract.list, ({ query, respond }) => {
    expect(query).toStrictEqual({
      view: "scoped",
      includeCustomConnectors: "true",
    });
    return respond(200, { configs: [shared] });
  });
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [retainedHost] });
  });
  context.mocks.api(sshConnectionsContract.update, ({ body, respond }) => {
    requests.push(body);
    return respond(200, {
      ...retainedHost,
      generation: 4,
      transport: { type: "cloudflare_access", configId: shared.id },
    });
  });
  await page();
  await expect(
    screen.findByText(/needs a new Cloudflare Access configuration/u),
  ).resolves.toHaveAttribute("role", "alert");
  const dialog = await editHost();
  expect(within(dialog).getByRole("alert")).toHaveTextContent(
    "Choose a permitted Cloudflare Access configuration or Direct",
  );
  expect(getAction("button", "Save", dialog)).toBeDisabled();
  await selectConfig(dialog, shared.name);
  await waitFor(() => {
    expect(getAction("button", "Save", dialog)).toBeEnabled();
  });
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    expect(requests).toHaveLength(1);
  });
  expect(requests[0]).toMatchObject({
    expectedGeneration: 3,
    host: retainedHost.host,
    credential: { id: retainedHost.credentialId },
    transport: { type: "cloudflare_access", configId: shared.id },
  });
});

test("Direct recovery is an explicit choice and does not replace the saved credential", async () => {
  const requests: unknown[] = [];
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [] });
  });
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [retainedHost] });
  });
  context.mocks.api(sshConnectionsContract.update, ({ body, respond }) => {
    requests.push(body);
    return respond(200, {
      ...directHost,
      generation: 4,
      learnedHostKey: retainedHost.learnedHostKey,
      port: body.port ?? 443,
    });
  });
  await page();
  await screen.findByText(retainedHost.displayName);
  const dialog = await editHost();
  expect(getAction("button", "Save", dialog)).toBeDisabled();
  await chooseSshConnectionType(dialog, "Direct");
  await waitFor(() => {
    expect(getAction("button", "Save", dialog)).toBeEnabled();
  });
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    expect(requests).toHaveLength(1);
  });
  expect(requests[0]).toMatchObject({
    expectedGeneration: 3,
    host: retainedHost.host,
    credential: { id: retainedHost.credentialId },
    transport: { type: "direct" },
  });
});

test("Direct and protected mode retain their port and configuration drafts but submit only active fields", async () => {
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [config] });
  });
  const requests: unknown[] = [];
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [{ ...directHost, port: 22 }] });
  });
  context.mocks.api(sshConnectionsContract.update, ({ body, respond }) => {
    requests.push(body);
    return respond(200, host);
  });
  await page();
  await screen.findByRole("heading", { name: host.displayName });
  const dialog = await editHost();
  await fill(within(dialog).getByLabelText("Port"), "2222");
  await chooseSshConnectionType(dialog, "Cloudflare Access");
  await within(dialog).findByLabelText("Cloudflare Access");
  const publishedHost = within(dialog).getByLabelText("Published hostname");
  expect(publishedHost).toHaveAttribute("placeholder", "e.g. ssh.example.com");
  expect(publishedHost).toHaveValue("ssh.example.com");
  expect(within(dialog).getByLabelText("Port")).not.toBeVisible();
  await selectConfig(dialog);
  await chooseSshConnectionType(dialog, "Direct");
  expect(within(dialog).getByLabelText("Port")).toHaveValue(2222);
  await chooseSshConnectionType(dialog, "Cloudflare Access");
  await expect(
    within(dialog).findByLabelText("Cloudflare Access"),
  ).resolves.toHaveTextContent(config.name);
  click(getAction("button", "Save", dialog));
  await screen.findByRole("heading", { name: host.displayName });
  expect(requests).toStrictEqual([
    {
      expectedGeneration: 1,
      displayName: "Development",
      host: "ssh.example.com",
      port: 443,
      credential: { id: credential.id },
      transport: { type: "cloudflare_access", configId: config.id },
    },
  ]);
});

test("Access API unavailability blocks protected mutations without silently changing transport", async () => {
  const direct = {
    ...directHost,
    id: "c0000000-0000-4000-8000-000000000002",
    displayName: "Direct host",
  };
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, {
      connections: [
        {
          ...host,
          learnedHostKey: {
            algorithm: "ssh-ed25519",
            fingerprint: "SHA256:test",
          },
        },
        direct,
      ],
    });
  });
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(404, {
      error: {
        code: "CLOUDFLARE_ACCESS_UNAVAILABLE",
        message: "not user copy",
      },
    });
  });
  const requests: unknown[] = [];
  context.mocks.api(sshConnectionsContract.update, ({ body, respond }) => {
    requests.push(body);
    return respond(200, direct);
  });
  await page();
  await screen.findByRole("heading", { name: host.displayName });
  await waitFor(() => {
    expect(getAction("button", "Edit connection")).toBeDisabled();
  });
  expect(getAction("button", "Reset host key")).toBeDisabled();
  expect(getAction("button", "Delete connection")).toBeDisabled();
  click(getAction("button", "Back to remote connections"));
  const row = await screen.findByRole("listitem", { name: direct.displayName });
  click(getAction("link", "Manage", row));
  await screen.findByRole("heading", { name: direct.displayName });
  const dialog = await editHost();
  expect(
    within(dialog).getByLabelText("Public hostname or IP address"),
  ).toHaveValue(direct.host);
  expect(within(dialog).getByLabelText("Port")).toHaveValue(443);
  click(getAction("button", "Save", dialog));
  await screen.findByRole("heading", { name: direct.displayName });
  expect(requests).toStrictEqual([
    {
      expectedGeneration: 1,
      displayName: direct.displayName,
      host: direct.host,
      port: 443,
      credential: { id: credential.id },
      transport: { type: "direct" },
    },
  ]);
});

test("An eligible protected host can explicitly change to Direct", async () => {
  let current = host;
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [config] });
  });
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [current] });
  });
  context.mocks.api(sshConnectionsContract.update, ({ body, respond }) => {
    current = {
      ...(body.transport?.type === "direct" ? directHost : current),
      port: body.port ?? current.port,
      generation: 2,
    };
    return respond(200, current);
  });
  await page();
  await screen.findByText(host.displayName);
  const dialog = await editHost();
  await within(dialog).findByLabelText("Cloudflare Access");
  await chooseSshConnectionType(dialog, "Direct");
  expect(within(dialog).getByLabelText("Port")).toHaveValue(22);
  click(getAction("button", "Save", dialog));
  await screen.findByRole("heading", { name: host.displayName });
  const saved = await editHost();
  expect(
    within(saved).getByRole("combobox", { name: "Connection" }),
  ).toHaveTextContent("Direct");
});

test("A concurrent host update preserves the binding draft and blocks stale saving", async () => {
  const alternate = {
    ...config,
    id: "a0000000-0000-4000-8000-000000000002",
    name: "Alternate gateway",
  };
  let current = host;
  const requests: unknown[] = [];
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [config, alternate] });
  });
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [current] });
  });
  context.mocks.api(sshConnectionsContract.update, ({ body, respond }) => {
    requests.push(body);
    current = { ...host, displayName: "Updated elsewhere", generation: 2 };
    context.mocks.ably.trigger("ssh:changed", { orgId });
    return respond(409, {
      error: { code: "SSH_GENERATION_CONFLICT", message: "not user copy" },
    });
  });
  await page();
  await screen.findByText(host.displayName);
  const dialog = await editHost();
  await fill(
    within(dialog).getByLabelText(/Connection name/u),
    "My host draft",
  );
  await selectConfig(dialog, alternate.name);
  click(getAction("button", "Save", dialog));
  await within(dialog).findByText(/This host changed/u);
  expect(getAction("button", "Save", dialog)).toBeDisabled();
  expect(within(dialog).getByLabelText(/Connection name/u)).toHaveValue(
    "My host draft",
  );
  expect(requests).toStrictEqual([
    {
      expectedGeneration: 1,
      displayName: "My host draft",
      host: host.host,
      port: 443,
      credential: { id: credential.id },
      transport: { type: "cloudflare_access", configId: alternate.id },
    },
  ]);
});

test("Pending protected host save is cancelled and its private key cleared on owner loss", async () => {
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, { configs: [] });
  });
  context.mocks.api(sshCredentialsContract.list, ({ respond }) => {
    return respond(200, { credentials: [] });
  });
  const pending = context.mocks.deferred<void>();
  const reached = context.mocks.deferred<AbortSignal>();
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [config] });
  });
  context.mocks.api(
    sshConnectionsContract.create,
    async ({ signal, respond }) => {
      reached.resolve(signal);
      await pending.promise;
      return respond(201, host);
    },
  );
  await setupPage({
    context,
    path: "/connectors?scope=remote-control&setup=ssh&step=login",
  });
  await screen.findByLabelText("SSH username");
  click(screen.getByLabelText("Connection method"));
  click(
    await screen.findByRole("option", {
      name: `${config.name} · Cloudflare Access`,
    }),
  );
  click(getAction("radio", "SSH key"));
  await fill(screen.getByLabelText("Device address"), host.host);
  await fill(screen.getByLabelText("SSH username"), "deploy");
  const privateKey = screen.getByLabelText("Private key");
  await fill(privateKey, "ssh-draft-canary");
  click(getAction("button", "Add connection"));
  const requestSignal = await reached.promise;
  act(() => {
    const clerk = context.mocks.clerk();
    clerk.user(
      { id: "next-owner", fullName: "Next Owner" },
      { token: "next-owner-token" },
    );
    clerk.stateChanged();
  });
  await waitFor(() => {
    expect(requestSignal.aborted).toBeTruthy();
  });
  expect(privateKey).toHaveValue("");
  pending.resolve();
  await waitFor(() => {
    expect(
      screen.queryByDisplayValue("ssh-draft-canary"),
    ).not.toBeInTheDocument();
  });
});
