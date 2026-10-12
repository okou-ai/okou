import {
  tailscaleContract,
  type TailscaleConfig,
} from "@okouai/api-contracts/contracts/tailscale";
import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import {
  sshConnectionsContract,
  type SshConnectionResponse,
} from "@okouai/api-contracts/contracts/ssh-connections";
import {
  sshCredentialsContract,
  type SshCredentialResponse,
} from "@okouai/api-contracts/contracts/ssh-credentials";
import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import { vncCredentialsContract } from "@okouai/api-contracts/contracts/vnc-credentials";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { getAction } from "./connector-integrations-test-helpers.ts";

const context = testContext();
const auth = Object.freeze({
  user: { id: "tailscale-ssh-owner", fullName: "SSH Owner" },
  organization: {
    activeOrg: { id: "org_tailscale_ssh", name: "Engineering" },
    memberships: [{ id: "org_tailscale_ssh" }],
  },
});
const timestamp = "2026-10-12T00:00:00.000Z";
const config: TailscaleConfig = Object.freeze({
  id: "a0000000-0000-4000-8000-000000000001",
  name: "Development network",
  scope: "personal",
  tags: ["tag:okou"],
  revision: 1,
  generation: 1,
  sshHosts: [],
  createdAt: timestamp,
  updatedAt: timestamp,
});
const credential: SshCredentialResponse = Object.freeze({
  id: "b0000000-0000-4000-8000-000000000001",
  name: "SSH login",
  username: "deploy",
  authMethod: "password",
  revision: 1,
  hosts: [],
  createdAt: timestamp,
  updatedAt: timestamp,
});
const host: SshConnectionResponse = Object.freeze({
  id: "c0000000-0000-4000-8000-000000000001",
  displayName: "Private server",
  host: "server.tailnet.example",
  port: 2022,
  username: credential.username,
  credentialId: credential.id,
  credentialName: credential.name,
  generation: 3,
  learnedHostKey: { algorithm: "ssh-ed25519", fingerprint: "SHA256:preserved" },
  transport: { type: "tailscale", configId: config.id },
  createdAt: timestamp,
  updatedAt: timestamp,
});

beforeEach(() => {
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, { configs: [config] });
  });
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [] });
  });
  context.mocks.api(sshCredentialsContract.list, ({ respond }) => {
    return respond(200, { credentials: [credential] });
  });
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [] });
  });
  context.mocks.api(sshConnectionsContract.observations, ({ respond }) => {
    return respond(200, { observations: [] });
  });
});

async function page(
  enabled = true,
  path = "/connectors?scope=remote-control&type=ssh",
) {
  context.mocks.data.org({
    id: "org_tailscale_ssh",
    name: "Engineering",
    role: "member",
  });
  await setupPage({
    context,
    auth,
    path,
    featureSwitches: {
      [FeatureSwitchKey.TailscaleAccess]: enabled,
      [FeatureSwitchKey.VncAccess]: true,
    },
  });
}

async function addHost() {
  click(
    await waitFor(() => {
      return getAction("button", "Add host");
    }),
  );
  const dialog = await screen.findByRole("dialog");
  click(getAction("radio", "Tailscale", dialog));
  await within(dialog).findByLabelText("Tailscale");
  await fill(within(dialog).getByLabelText("Display name"), "New private host");
  await fill(
    within(dialog).getByLabelText("Tailnet hostname or IP address"),
    "100.64.0.2",
  );
  await fill(within(dialog).getByLabelText("Port"), "2022");
  return dialog;
}

test.each([
  { inlineNetwork: false, newCredential: false },
  { inlineNetwork: true, newCredential: false },
  { inlineNetwork: false, newCredential: true },
  { inlineNetwork: true, newCredential: true },
])(
  "Tailscale host creation supports inline=$inlineNetwork and new credential=$newCredential independently",
  async ({ inlineNetwork, newCredential }) => {
    const requests: unknown[] = [];
    context.mocks.api(sshConnectionsContract.create, ({ body, respond }) => {
      requests.push(body);
      return respond(201, {
        ...host,
        id: body.id,
        displayName: body.displayName,
        host: body.host,
        port: body.port,
      });
    });
    await page();
    const dialog = await addHost();
    await waitFor(() => {
      return expect(
        within(dialog).getByLabelText("Tailscale"),
      ).toHaveTextContent(config.name);
    });
    if (inlineNetwork) {
      await userEvent.click(within(dialog).getByLabelText("Tailscale"));
      await userEvent.click(
        await screen.findByRole("option", {
          name: "Create new Tailscale network",
        }),
      );
      await fill(within(dialog).getByLabelText("Name"), "Inline network");
      await fill(
        within(dialog).getByLabelText("Registration tags"),
        "tag:okou",
      );
      await fill(
        within(dialog).getByLabelText("OAuth client ID"),
        "client-id-canary",
      );
      await fill(
        within(dialog).getByLabelText("OAuth client secret"),
        "oauth-secret-canary",
      );
    }
    if (newCredential) {
      await userEvent.click(within(dialog).getByLabelText("Credential"));
      await userEvent.click(
        await screen.findByRole("option", { name: "Create new credential" }),
      );
      await fill(within(dialog).getByLabelText("Credential name"), "New login");
      await fill(within(dialog).getByLabelText("SSH username"), "operator");
      click(getAction("radio", "Password", dialog));
      await fill(
        within(dialog).getByLabelText("Password"),
        "ssh-secret-canary",
      );
    }
    click(getAction("button", "Save", dialog));
    await waitFor(() => {
      return expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(requests).toStrictEqual([
      {
        id: expect.any(String),
        displayName: "New private host",
        host: "100.64.0.2",
        port: 2022,
        credential: newCredential
          ? {
              create: {
                name: "New login",
                username: "operator",
                authentication: {
                  method: "password",
                  password: "ssh-secret-canary",
                },
              },
            }
          : { id: credential.id },
        transport: {
          type: "tailscale",
          ...(inlineNetwork
            ? {
                create: {
                  name: "Inline network",
                  tags: ["tag:okou"],
                  credentials: {
                    clientId: "client-id-canary",
                    clientSecret: "oauth-secret-canary",
                  },
                },
              }
            : { configId: config.id }),
        },
      },
    ]);
    expect(document.body.textContent).not.toContain("secret-canary");
  },
);

test("A saved Tailscale host retains its port, credential and learned key during editing", async () => {
  const requests: unknown[] = [];
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [host] });
  });
  context.mocks.api(sshConnectionsContract.update, ({ body, respond }) => {
    requests.push(body);
    return respond(200, {
      ...host,
      displayName: body.displayName ?? host.displayName,
      generation: 4,
    });
  });
  await page();
  await screen.findByRole("heading", { name: host.displayName });
  click(getAction("button", "Edit host"));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByLabelText("Port")).toHaveValue(2022);
  expect(within(dialog).getByLabelText("Credential")).toHaveTextContent(
    "SSH login · deploy",
  );
  expect(within(dialog).getByLabelText("Tailscale")).toHaveTextContent(
    config.name,
  );
  expect(within(dialog).queryByLabelText("OAuth client secret")).toBeNull();
  await fill(
    within(dialog).getByLabelText("Display name"),
    "Renamed private host",
  );
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(requests).toStrictEqual([
    {
      expectedGeneration: 3,
      displayName: "Renamed private host",
      host: host.host,
      port: 2022,
      credential: { id: credential.id },
      transport: { type: "tailscale", configId: config.id },
    },
  ]);
  expect(document.body.textContent).toContain("SHA256:preserved");
});

test("A retained Tailscale host requires an explicit network selection to rebind", async () => {
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, {
      connections: [
        { ...host, transport: { type: "tailscale", needsRebind: true } },
      ],
    });
  });
  await page();
  await screen.findByRole("heading", { name: host.displayName });
  click(getAction("button", "Edit host"));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByLabelText("Port")).toHaveValue(2022);
  expect(getAction("button", "Save", dialog)).toBeDisabled();
  await userEvent.click(within(dialog).getByLabelText("Tailscale"));
  await userEvent.click(
    await screen.findByRole("option", { name: config.name }),
  );
  expect(getAction("button", "Save", dialog)).toBeEnabled();
  expect(
    within(dialog).getByLabelText("Tailnet hostname or IP address"),
  ).toHaveValue(host.host);
});

test("The default-off UI preserves existing Tailscale metadata and its reader-only edit restriction", async () => {
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [host] });
  });
  await page(false);
  await screen.findByRole("heading", { name: host.displayName });
  expect(getAction("button", "Edit host")).toBeDisabled();
  click(getAction("button", "Add host"));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).queryByRole("radio", { name: "Tailscale" })).toBeNull();
});

test("Changing carriers preserves endpoint drafts and the independently selected network", async () => {
  await page();
  const dialog = await addHost();
  await waitFor(() => {
    return expect(within(dialog).getByLabelText("Tailscale")).toHaveTextContent(
      config.name,
    );
  });
  click(getAction("radio", "Direct", dialog));
  expect(within(dialog).getByLabelText("Display name")).toHaveValue(
    "New private host",
  );
  expect(
    within(dialog).getByLabelText("Public hostname or IP address"),
  ).toHaveValue("100.64.0.2");
  click(getAction("radio", "Tailscale", dialog));
  await expect(
    within(dialog).findByLabelText("Tailnet hostname or IP address"),
  ).resolves.toHaveValue("100.64.0.2");
  expect(within(dialog).getByLabelText("Port")).toHaveValue(2022);
  await expect(
    within(dialog).findByLabelText("Tailscale"),
  ).resolves.toHaveTextContent(config.name);
});

test("An uncertain host create reads saved hosts and avoids a duplicate write", async () => {
  let created: SshConnectionResponse | null = null;
  const requests: unknown[] = [];
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: created ? [created] : [] });
  });
  context.mocks.api(sshConnectionsContract.create, ({ body, respond }) => {
    requests.push(body);
    created = {
      ...host,
      id: body.id,
      displayName: body.displayName,
      host: body.host,
      port: body.port,
    };
    return respond(500, {
      error: { code: "INTERNAL_ERROR", message: "provider-secret-canary" },
    });
  });
  await page();
  const dialog = await addHost();
  click(getAction("button", "Save", dialog));
  await within(dialog).findByRole("alert");
  click(getAction("button", "Retry", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
  await expect(
    screen.findByRole("heading", { name: "New private host" }),
  ).resolves.toBeVisible();
  expect(requests).toHaveLength(1);
  expect(document.body.textContent).not.toContain("provider-secret-canary");
});

test("A retained Tailscale VNC dependency opens its exact SSH host for rebind", async () => {
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, {
      connections: [
        { ...host, transport: { type: "tailscale", needsRebind: true } },
      ],
    });
  });
  context.mocks.api(vncConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 1 });
  });
  context.mocks.api(vncConnectionsContract.list, ({ respond }) => {
    return respond(200, {
      connections: [
        {
          id: "d0000000-0000-4000-8000-000000000001",
          displayName: "Private desktop",
          host: "127.0.0.1",
          port: 5901,
          credentialId: "e0000000-0000-4000-8000-000000000001",
          credentialName: "Desktop login",
          security: { type: "x509_vnc", trust: { mode: "system" } },
          transport: { type: "ssh", connectionId: host.id },
          generation: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    });
  });
  context.mocks.api(vncCredentialsContract.list, ({ respond }) => {
    return respond(200, { credentials: [] });
  });
  await page(true, "/connectors?scope=remote-control&type=vnc");
  const heading = await screen.findByRole("heading", {
    name: "Private desktop",
  });
  const card = heading.closest("article");
  expect(card).not.toBeNull();
  click(getAction("button", "Rebind SSH host", card!));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByLabelText("Display name")).toHaveValue(
    host.displayName,
  );
  expect(
    within(dialog).getByLabelText("Tailnet hostname or IP address"),
  ).toHaveValue(host.host);
  expect(within(dialog).getByLabelText("Port")).toHaveValue(2022);
  expect(getAction("button", "Save", dialog)).toBeDisabled();
});
