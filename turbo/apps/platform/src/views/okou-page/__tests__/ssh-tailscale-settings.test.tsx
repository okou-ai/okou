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
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getAction,
  chooseSshConnectionType,
} from "./connector-integrations-test-helpers.ts";

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
  vncHosts: [],
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

async function page(path = "/connectors?scope=remote-control&type=ssh") {
  context.mocks.data.org({
    id: "org_tailscale_ssh",
    name: "Engineering",
    role: "member",
  });
  await setupPage({
    context,
    auth,
    path,
  });
}

async function editHost(connection = host) {
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [connection] });
  });
  await page(`/connectors?scope=remote-control&remoteResource=ssh:${host.id}`);
  await screen.findByRole("heading", { name: host.displayName });
  click(getAction("button", "Edit connection"));
  const username = await screen.findByLabelText("SSH username");
  const form = username.closest("form");
  if (!form) {
    throw new Error("Missing SSH edit form");
  }
  click(within(form).getByText("Connection settings"));
  return form;
}

async function addHost() {
  await page("/connectors?scope=remote-control&setup=ssh&step=login");
  const username = await screen.findByLabelText("SSH username");
  const form = username.closest("form");
  if (!form) {
    throw new Error("Missing SSH connection form");
  }
  click(within(form).getByLabelText("Connection method"));
  click(
    await screen.findByRole("option", { name: `${config.name} · Tailscale` }),
  );
  await fill(within(form).getByLabelText("Device address"), "100.64.0.2");
  click(within(form).getByText("More settings"));
  await fill(within(form).getByLabelText("Port"), "2022");
  return form;
}

test("The connection selector supports keyboard selection and Escape returns focus", async () => {
  const dialog = await editHost();
  const mode = within(dialog).getByRole("combobox", { name: "Connection" });
  await userEvent.click(mode);
  await screen.findByRole("option", { name: "Tailscale SSH" });
  await userEvent.keyboard("{Escape}");
  expect(mode).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("option", { name: "Tailscale SSH" });
  await userEvent.keyboard("{End}{Enter}");
  expect(
    within(dialog).getByRole("textbox", { name: "System username" }),
  ).toBeVisible();
});

test.each(["tailscale_ssh", "tailscale"] as const)(
  "A %s authentication warning explains its own login type",
  async (type) => {
    context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
      const common = {
        id: host.id,
        displayName: "Failed host",
        host: host.host,
        port: 22,
        username: credential.username,
        generation: host.generation,
        learnedHostKey: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      return type === "tailscale_ssh"
        ? respond(200, {
            connections: [
              {
                ...common,
                transport: { type: "tailscale_ssh", configId: config.id },
              },
            ],
          })
        : respond(200, {
            connections: [
              {
                ...common,
                credentialId: credential.id,
                credentialName: credential.name,
                transport: { type: "tailscale", configId: config.id },
              },
            ],
          });
    });
    context.mocks.api(sshConnectionsContract.observations, ({ respond }) => {
      return respond(200, {
        observations: [
          {
            connectionId: host.id,
            connectionCreatedAt: timestamp,
            generation: host.generation,
            observedAt: timestamp,
            failureReason: "authentication_failed",
          },
        ],
      });
    });
    await page(
      `/connectors?scope=remote-control&remoteResource=ssh:${host.id}`,
    );
    const expected =
      type === "tailscale_ssh"
        ? "Tailscale SSH authentication failed. Check the system username, enable Tailscale SSH on the tagged destination and allow this login in the tailnet's SSH accept policy."
        : "SSH authentication failed. Check the selected credential's username, private key or password and the server's authorization. Edit the credential or select another one for this host.";
    await expect(screen.findByText(expected)).resolves.toBeVisible();
  },
);

test.each(["saved", "new"] as const)(
  "Tailscale host creation uses %s login details with a saved network",
  async (login) => {
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
    const form = await addHost();
    if (login === "saved") {
      click(getAction("button", "Choose saved login details", form));
      const picker = await screen.findByRole("dialog", {
        name: "Choose saved login details",
      });
      click(within(picker).getByText(credential.name));
    } else {
      await fill(within(form).getByLabelText("SSH username"), "operator");
      await fill(within(form).getByLabelText("Password"), "ssh-secret-canary");
    }
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    click(getAction("button", "Add connection", form));
    await screen.findByRole("heading", { name: "Connection added" });
    expect(requests).toStrictEqual([
      {
        id: expect.any(String),
        displayName: "100.64.0.2",
        host: "100.64.0.2",
        port: 2022,
        transport: { type: "tailscale", configId: config.id },
        credential:
          login === "saved"
            ? { id: credential.id }
            : {
                create: {
                  name: "100.64.0.2",
                  username: "operator",
                  authentication: {
                    method: "password",
                    password: "ssh-secret-canary",
                  },
                },
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
  const dialog = await editHost();
  expect(within(dialog).getByLabelText("Port")).toHaveValue(2022);
  expect(within(dialog).getByLabelText("SSH username")).toHaveValue("deploy");
  expect(within(dialog).getByLabelText("Saved network")).toHaveTextContent(
    config.name,
  );
  expect(within(dialog).queryByLabelText("OAuth client secret")).toBeNull();
  await fill(
    within(dialog).getByLabelText(/Connection name/u),
    "Renamed private host",
  );
  click(getAction("button", "Save", dialog));
  await screen.findByRole("heading", { name: host.displayName });
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
  click(screen.getByText("Server identity and chat permissions"));
  expect(document.body.textContent).toContain("SHA256:preserved");
});

test("A retained Tailscale host requires an explicit network selection to rebind", async () => {
  const dialog = await editHost({
    ...host,
    transport: { type: "tailscale", needsRebind: true },
  });
  expect(within(dialog).getByLabelText("Port")).toHaveValue(2022);
  expect(getAction("button", "Save", dialog)).toBeDisabled();
  await userEvent.click(within(dialog).getByLabelText("Saved network"));
  await userEvent.click(
    await screen.findByRole("option", { name: config.name }),
  );
  expect(getAction("button", "Save", dialog)).toBeEnabled();
  expect(
    within(dialog).getByLabelText("Tailnet hostname or IP address"),
  ).toHaveValue(host.host);
});

test("Changing carriers preserves endpoint drafts and the independently selected network", async () => {
  const dialog = await editHost();
  await chooseSshConnectionType(dialog, "Direct");
  expect(within(dialog).getByLabelText(/Connection name/u)).toHaveValue(
    host.displayName,
  );
  expect(
    within(dialog).getByLabelText("Public hostname or IP address"),
  ).toHaveValue(host.host);
  await chooseSshConnectionType(dialog, "Tailscale");
  expect(
    within(dialog).getByLabelText("Tailnet hostname or IP address"),
  ).toHaveValue(host.host);
  expect(within(dialog).getByLabelText("Port")).toHaveValue(2022);
  await expect(
    within(dialog).findByLabelText("Saved network"),
  ).resolves.toHaveTextContent(config.name);
});

test("An unconfirmed SSH creation keeps its draft frozen", async () => {
  let created: SshConnectionResponse | null = null;
  const requests: unknown[] = [];
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: created ? [created] : [] });
  });
  context.mocks.api(sshConnectionsContract.create, ({ body, respond }) => {
    requests.push(body);
    if (created) {
      return respond(204);
    }
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
  const dialog = await addHost();
  await fill(within(dialog).getByLabelText("SSH username"), "operator");
  await fill(within(dialog).getByLabelText("Password"), "ssh-secret-canary");
  click(getAction("button", "Add connection", dialog));
  await within(dialog).findByRole("alert");
  expect(getAction("button", "Add connection", dialog)).toBeDisabled();
});

test.each(["tailscale", "cloudflare_access"] as const)(
  "A retained %s VNC dependency opens its exact SSH host for rebind",
  async (type) => {
    context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
      return respond(200, {
        connections: [
          {
            ...host,
            id: "f0000000-0000-4000-8000-000000000001",
            displayName: "Unrelated server",
            host: "other.tailnet.example",
          },
          {
            ...host,
            port: type === "tailscale" ? 2022 : 443,
            transport:
              type === "tailscale"
                ? { type: "tailscale", needsRebind: true }
                : { type: "cloudflare_access", needsRebind: true },
          },
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
    await page(
      "/connectors?scope=remote-control&remoteResource=vnc:d0000000-0000-4000-8000-000000000001",
    );
    const heading = await screen.findByRole("heading", {
      name: "Private desktop",
    });
    const card = heading.closest("article");
    expect(card).not.toBeNull();
    click(getAction("button", "Rebind SSH host", card!));
    const name = await screen.findByLabelText(/Connection name/u);
    const dialog = name.closest("form");
    if (!dialog) {
      throw new Error("Missing SSH rebind form");
    }
    expect(name).toHaveValue(host.displayName);
    click(within(dialog).getByText("Connection settings"));
    expect(within(dialog).getByLabelText("SSH username")).toHaveValue("deploy");
    expect(
      within(dialog).getByLabelText(
        type === "tailscale"
          ? "Tailnet hostname or IP address"
          : "Published hostname",
      ),
    ).toHaveValue(host.host);
    expect(getAction("button", "Save", dialog)).toBeDisabled();
  },
);
