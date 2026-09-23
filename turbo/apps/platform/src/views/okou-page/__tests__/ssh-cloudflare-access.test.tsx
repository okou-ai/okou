import {
  cloudflareAccessContract,
  type ScopedCloudflareAccessConfig,
} from "@okouai/api-contracts/contracts/cloudflare-access";
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
  queryAction,
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

async function page(add = false) {
  await setupPage({
    context,
    path: "/connectors?scope=remote-control&type=ssh",
    auth: {
      user: { id: "access-owner", fullName: "Access Owner" },
      organization: {
        activeOrg: { id: orgId, name: "Engineering" },
        memberships: [{ id: orgId }],
      },
    },
  });
  if (add) {
    click(
      await waitFor(() => {
        return getAction("button", "Add host");
      }),
    );
  }
}
async function selectConfig(dialog: HTMLElement, name = config.name) {
  await userEvent.click(
    await within(dialog).findByLabelText("Cloudflare Access"),
  );
  click(await screen.findByRole("option", { name }));
}
async function selectCredential(dialog: HTMLElement) {
  await userEvent.click(within(dialog).getByLabelText("Credential"));
  click(await screen.findByRole("option", { name: "SSH login · deploy" }));
}
async function tokenFields(dialog: HTMLElement, name = config.name) {
  await fill(within(dialog).getByLabelText("Name"), name);
  await fill(
    within(dialog).getByLabelText("Service Token Client ID"),
    "test-client-id",
  );
  await fill(
    within(dialog).getByLabelText("Service Token Client Secret"),
    "test-client-secret",
  );
}
async function pasteTokenHeaders(
  dialog: HTMLElement,
  label: "Service Token Client ID" | "Service Token Client Secret",
  clipboard: string,
) {
  const user = userEvent.setup();
  await user.click(within(dialog).getByLabelText(label));
  await user.paste(clipboard);
}

test("The new Access host form shows input hints without prefilling tokens", async () => {
  await page(true);
  const dialog = await screen.findByRole("dialog", { name: "Add host" });
  click(getAction("radio", "Cloudflare Access", dialog));
  await within(dialog).findByLabelText("Name");
  const hints = {
    Name: "e.g. Production access",
    "Service Token Client ID": "Paste the Service Token Client ID",
    "Service Token Client Secret": "Paste the Service Token Client Secret",
  };
  for (const [label, hint] of Object.entries(hints)) {
    const field = within(dialog).getByLabelText(label);
    expect(field).toHaveAttribute("placeholder", hint);
    expect(field).toHaveValue("");
    expect(field).toBeInvalid();
  }
  for (const label of [
    "Service Token Client ID",
    "Service Token Client Secret",
  ]) {
    expect(within(dialog).getByLabelText(label)).toHaveAttribute(
      "type",
      "password",
    );
  }
});

test("Resource selectors initialize once for a single saved resource", async () => {
  context.mocks.api(sshCredentialsContract.list, ({ respond }) => {
    return respond(200, {
      credentials: [{ ...credential, name: "Login 1" }],
    });
  });
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [{ ...config, name: "Gateway 1" }] });
  });
  await page(true);
  const dialog = await screen.findByRole("dialog");
  click(getAction("radio", "Cloudflare Access", dialog));
  await waitFor(() => {
    expect(within(dialog).getByLabelText("Credential")).toHaveTextContent(
      "Login 1 · deploy",
    );
    expect(
      within(dialog).getByLabelText("Cloudflare Access"),
    ).toHaveTextContent("Gateway 1");
  });
  expect(within(dialog).queryAllByLabelText("Credential name")).toHaveLength(0);
  context.mocks.ably.trigger("ssh:changed", { orgId });
  await waitFor(() => {
    return expect(getAction("button", "Save", dialog)).toBeEnabled();
  });
  expect(within(dialog).getByLabelText("Credential")).toHaveTextContent(
    "Login 1 · deploy",
  );
  expect(within(dialog).getByLabelText("Cloudflare Access")).toHaveTextContent(
    "Gateway 1",
  );
});

test("SSH keeps Cloudflare Access in the host form without a management tab", async () => {
  await page();
  await screen.findByText("0 hosts configured");
  expect(getAction("radio", "Connections")).toBeInTheDocument();
  expect(getAction("radio", "Credentials")).toBeInTheDocument();
  expect(queryAction("radio", "Cloudflare Access")).not.toBeInTheDocument();
  expect(
    queryAction("button", "Add Cloudflare Access"),
  ).not.toBeInTheDocument();

  click(getAction("button", "Add host"));
  const dialog = await screen.findByRole("dialog", { name: "Add host" });
  click(getAction("radio", "Cloudflare Access", dialog));
  await within(dialog).findByLabelText("Cloudflare Access");
  expect(within(dialog).getByLabelText("Name")).toBeInTheDocument();
});

test("A retained protected host requires explicit shared Access selection before saving", async () => {
  const shared = { ...config, scope: "organization" as const };
  const requests: unknown[] = [];
  context.mocks.api(cloudflareAccessContract.list, ({ query, respond }) => {
    expect(query).toStrictEqual({ view: "scoped" });
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
  expect(
    await screen.findByText(/needs a new Cloudflare Access configuration/u),
  ).toHaveAttribute("role", "alert");
  click(getAction("button", "Edit host"));
  const dialog = await screen.findByRole("dialog");
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
  click(getAction("button", "Edit host"));
  const dialog = await screen.findByRole("dialog");
  expect(getAction("button", "Save", dialog)).toBeDisabled();
  click(getAction("radio", "Direct", dialog));
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
  context.mocks.api(sshConnectionsContract.create, ({ body, respond }) => {
    requests.push(body);
    return respond(201, host);
  });
  await page(true);
  const dialog = await screen.findByRole("dialog", { name: "Add host" });
  await fill(within(dialog).getByLabelText("Display name"), "Development");
  await fill(
    within(dialog).getByLabelText("Public hostname or IP address"),
    "ssh.example.com",
  );
  await fill(within(dialog).getByLabelText("Port"), "2222");
  click(getAction("radio", "Cloudflare Access", dialog));
  await within(dialog).findByLabelText("Cloudflare Access");
  const publishedHost = within(dialog).getByLabelText("Published hostname");
  expect(publishedHost).toHaveAttribute("placeholder", "e.g. ssh.example.com");
  expect(publishedHost).toHaveValue("ssh.example.com");
  expect(within(dialog).getByLabelText("Port")).not.toBeVisible();
  await selectConfig(dialog);
  click(getAction("radio", "Direct", dialog));
  expect(within(dialog).getByLabelText("Port")).toHaveValue(2222);
  click(getAction("radio", "Cloudflare Access", dialog));
  await expect(
    within(dialog).findByLabelText("Cloudflare Access"),
  ).resolves.toHaveTextContent(config.name);
  await selectCredential(dialog);
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(requests).toStrictEqual([
    {
      id: expect.any(String),
      displayName: "Development",
      host: "ssh.example.com",
      port: 443,
      credential: { id: credential.id },
      transport: { type: "cloudflare_access", configId: config.id },
    },
  ]);
});

test.each([
  { mode: "create", newAccess: true, newCredential: true },
  { mode: "edit", newAccess: false, newCredential: false },
] as const)(
  "A $mode host atomically saves resources (new Access: $newAccess, new credential: $newCredential)",
  async ({ mode, newAccess, newCredential }) => {
    context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
      return respond(200, { connections: mode === "edit" ? [host] : [] });
    });
    context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
      return respond(200, { configs: [config] });
    });
    const requests: unknown[] = [];
    context.mocks.api(sshConnectionsContract.create, ({ body, respond }) => {
      requests.push(body);
      return respond(201, host);
    });
    context.mocks.api(sshConnectionsContract.update, ({ body, respond }) => {
      requests.push(body);
      return respond(200, host);
    });
    await page();
    click(
      await waitFor(() => {
        return getAction(
          "button",
          mode === "create" ? "Add host" : "Edit host",
        );
      }),
    );
    const dialog = await screen.findByRole("dialog");
    if (mode === "create") {
      await fill(
        within(dialog).getByLabelText("Display name"),
        host.displayName,
      );
      await fill(
        within(dialog).getByLabelText("Public hostname or IP address"),
        host.host,
      );
      click(getAction("radio", "Cloudflare Access", dialog));
    }
    await within(dialog).findByLabelText("Cloudflare Access");
    if (newAccess) {
      await selectConfig(dialog, "Create new Cloudflare Access");
      await tokenFields(dialog);
    }
    if (newCredential) {
      await userEvent.click(await within(dialog).findByLabelText("Credential"));
      click(
        await screen.findByRole("option", {
          name: "Create new credential",
        }),
      );
      await fill(
        within(dialog).getByLabelText("Credential name"),
        "New SSH login",
      );
      await fill(within(dialog).getByLabelText("SSH username"), "deploy");
      click(getAction("radio", "Password", dialog));
      await fill(within(dialog).getByLabelText("Password"), "password-canary");
    }
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    click(getAction("button", "Save", dialog));
    await waitFor(() => {
      return expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    const generatedId = expect.any(String);
    expect(requests.at(-1)).toStrictEqual({
      ...(mode === "edit" ? { expectedGeneration: 1 } : { id: generatedId }),
      displayName: host.displayName,
      host: host.host,
      port: 443,
      transport: {
        type: "cloudflare_access",
        ...(newAccess
          ? {
              create: {
                name: config.name,
                credentials: {
                  clientId: "test-client-id",
                  clientSecret: "test-client-secret",
                },
              },
            }
          : { configId: config.id }),
      },
      credential: newCredential
        ? {
            create: {
              name: "New SSH login",
              username: "deploy",
              authentication: {
                method: "password",
                password: "password-canary",
              },
            },
          }
        : { id: credential.id },
    });
    expect(requests).toHaveLength(1);
  },
);

test("Pasted Access headers submit raw credentials with inline SSH creation", async () => {
  const requests: unknown[] = [];
  context.mocks.api(sshConnectionsContract.create, ({ body, respond }) => {
    requests.push(body);
    return respond(201, host);
  });
  await page(true);
  const dialog = await screen.findByRole("dialog", { name: "Add host" });
  await fill(within(dialog).getByLabelText("Display name"), host.displayName);
  await fill(
    within(dialog).getByLabelText("Public hostname or IP address"),
    host.host,
  );
  click(getAction("radio", "Cloudflare Access", dialog));
  await fill(await within(dialog).findByLabelText("Name"), config.name);
  await pasteTokenHeaders(
    dialog,
    "Service Token Client ID",
    "CF-Access-Client-Id: inline-id\nCF-Access-Client-Secret: inline-secret",
  );
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(requests).toStrictEqual([
    {
      id: expect.any(String),
      displayName: host.displayName,
      host: host.host,
      port: 443,
      transport: {
        type: "cloudflare_access",
        create: {
          name: config.name,
          credentials: {
            clientId: "inline-id",
            clientSecret: "inline-secret",
          },
        },
      },
      credential: { id: credential.id },
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
  const protectedCard = (await screen.findByText(host.displayName)).closest(
    "article",
  );
  expect(protectedCard).not.toBeNull();
  await within(protectedCard!).findByText(
    "Cloudflare Access is not available for this account.",
  );
  expect(getAction("button", "Edit host", protectedCard!)).toBeDisabled();
  expect(getAction("button", "Reset host key", protectedCard!)).toBeDisabled();
  expect(getAction("button", "Delete host", protectedCard!)).toBeDisabled();
  const directCard = (await screen.findByText(direct.displayName)).closest(
    "article",
  );
  click(getAction("button", "Edit host", directCard!));
  const dialog = await screen.findByRole("dialog");
  expect(
    within(dialog).getByLabelText("Public hostname or IP address"),
  ).toHaveValue(direct.host);
  expect(within(dialog).getByLabelText("Port")).toHaveValue(443);
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
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
  click(getAction("button", "Edit host"));
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByLabelText("Cloudflare Access");
  click(getAction("radio", "Direct", dialog));
  expect(within(dialog).getByLabelText("Port")).toHaveValue(22);
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  await screen.findByText("deploy@ssh.example.com:22");
  click(getAction("button", "Edit host"));
  const saved = await screen.findByRole("dialog");
  expect(getAction("radio", "Direct", saved)).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("Rebinding a host after a concurrent update requires review and preserves its draft", async () => {
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
    if (body.expectedGeneration === 1) {
      current = { ...host, displayName: "Updated elsewhere", generation: 2 };
      return respond(409, {
        error: { code: "SSH_GENERATION_CONFLICT", message: "not user copy" },
      });
    }
    current = {
      ...current,
      displayName: body.displayName ?? current.displayName,
      transport: { type: "cloudflare_access", configId: alternate.id },
      generation: 3,
    };
    return respond(200, current);
  });
  await page();
  await screen.findByText(host.displayName);
  click(getAction("button", "Edit host"));
  const dialog = await screen.findByRole("dialog");
  await fill(within(dialog).getByLabelText("Display name"), "My host draft");
  await selectConfig(dialog, alternate.name);
  click(getAction("button", "Save", dialog));
  await within(dialog).findByText("Updated elsewhere");
  expect(getAction("button", "Save", dialog)).toBeDisabled();
  expect(within(dialog).getByLabelText("Display name")).toHaveValue(
    "My host draft",
  );
  click(getAction("button", "Keep my changes with this version", dialog));
  await waitFor(() => {
    return expect(getAction("button", "Save", dialog)).toBeEnabled();
  });
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(requests).toStrictEqual(
    [1, 2].map((expectedGeneration) => {
      return {
        expectedGeneration,
        displayName: "My host draft",
        host: host.host,
        port: 443,
        credential: { id: credential.id },
        transport: { type: "cloudflare_access", configId: alternate.id },
      };
    }),
  );
});

test("Pending Access Save is cancelled and secrets cleared on owner loss", async () => {
  const pending = context.mocks.deferred<void>();
  const reached = context.mocks.deferred<AbortSignal>();
  context.mocks.api(
    sshConnectionsContract.create,
    async ({ signal, respond }) => {
      reached.resolve(signal);
      await pending.promise;
      return respond(201, host);
    },
  );
  await page(true);
  const dialog = await screen.findByRole("dialog");
  await fill(within(dialog).getByLabelText("Display name"), "Unsaved host");
  await fill(
    within(dialog).getByLabelText("Public hostname or IP address"),
    host.host,
  );
  await userEvent.click(await within(dialog).findByLabelText("Credential"));
  click(await screen.findByRole("option", { name: "Create new credential" }));
  await fill(within(dialog).getByLabelText("Credential name"), "Login");
  await fill(within(dialog).getByLabelText("SSH username"), "deploy");
  await fill(within(dialog).getByLabelText("Private key"), "ssh-draft-canary");
  const privateKey = within(dialog).getByLabelText("Private key");
  click(getAction("radio", "Cloudflare Access", dialog));
  await within(dialog).findByLabelText("Name");
  await tokenFields(dialog);
  const secret = within(dialog).getByLabelText("Service Token Client Secret");
  click(getAction("button", "Save", dialog));
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
    return expect(requestSignal.aborted).toBeTruthy();
  });
  expect(secret).toHaveValue("");
  expect(privateKey).toHaveValue("");
  pending.resolve();
  await waitFor(() => {
    return expect(
      screen.queryByRole("dialog", { name: "Add host" }),
    ).not.toBeInTheDocument();
  });
  expect(document.body.textContent).not.toContain(config.name);
});
