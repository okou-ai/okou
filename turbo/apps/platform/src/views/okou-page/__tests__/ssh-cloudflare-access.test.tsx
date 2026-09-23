import {
  cloudflareAccessContract,
  type CloudflareAccessConfig,
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
const config: CloudflareAccessConfig = Object.freeze({
  id: "a0000000-0000-4000-8000-000000000001",
  name: "Engineering gateway",
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
    path: `/connectors/ssh${add ? "?add=1" : ""}`,
    auth: {
      user: { id: "access-owner", fullName: "Access Owner" },
      organization: {
        activeOrg: { id: orgId, name: "Engineering" },
        memberships: [{ id: orgId }],
      },
    },
  });
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

test.each([0, 1, 2])(
  "Resource selectors initialize once for %i saved resources",
  async (count) => {
    const savedCredentials = Array.from({ length: count }, (_, index) => {
      return {
        ...credential,
        id: `b0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        name: `Login ${index + 1}`,
      };
    });
    const savedConfigs = Array.from({ length: count }, (_, index) => {
      return {
        ...config,
        id: `a0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        name: `Gateway ${index + 1}`,
      };
    });
    context.mocks.api(sshCredentialsContract.list, ({ respond }) => {
      return respond(200, { credentials: savedCredentials });
    });
    context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
      return respond(200, { configs: savedConfigs });
    });
    await page(true);
    const dialog = await screen.findByRole("dialog");
    click(getAction("radio", "Cloudflare Access", dialog));
    await waitFor(() => {
      expect(within(dialog).getByLabelText("Credential")).toHaveTextContent(
        count === 0
          ? "Create new credential"
          : count === 1
            ? "Login 1 · deploy"
            : "Select a credential",
      );
      expect(
        within(dialog).getByLabelText("Cloudflare Access"),
      ).toHaveTextContent(
        count === 0
          ? "Create new Cloudflare Access"
          : count === 1
            ? "Gateway 1"
            : "Select Cloudflare Access",
      );
    });
    expect(within(dialog).queryAllByLabelText("Credential name")).toHaveLength(
      count === 0 ? 1 : 0,
    );
    expect(getAction("button", "Save", dialog).hasAttribute("disabled")).toBe(
      count === 2,
    );
    if (count === 2) {
      await selectConfig(dialog, "Gateway 2");
      await userEvent.click(within(dialog).getByLabelText("Credential"));
      click(await screen.findByRole("option", { name: "Login 2 · deploy" }));
    }
    context.mocks.ably.trigger("ssh:changed", { orgId });
    await waitFor(() => {
      return expect(getAction("button", "Save", dialog)).toBeEnabled();
    });
    expect(within(dialog).getByLabelText("Credential")).toHaveTextContent(
      count === 0 ? "Create new credential" : `Login ${count} · deploy`,
    );
    expect(
      within(dialog).getByLabelText("Cloudflare Access"),
    ).toHaveTextContent(
      count === 0 ? "Create new Cloudflare Access" : `Gateway ${count}`,
    );
    click(getAction("button", "Cancel", dialog));
    await waitFor(() => {
      return expect(screen.queryByRole("dialog")).toBeNull();
    });
  },
);

test("SSH keeps Cloudflare Access in the host form without a management tab", async () => {
  await page();
  await screen.findByText("0 hosts configured");
  expect(getAction("radio", "Hosts")).toBeInTheDocument();
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

test("Unknown lists are not empty, Direct does not wait for Access, and Retry initializes a failed list", async () => {
  const pendingAccess = context.mocks.deferred<void>();
  let failCredential = true;
  context.mocks.api(sshCredentialsContract.list, ({ respond }) => {
    return failCredential
      ? respond(500, {
          error: { code: "INTERNAL_ERROR", message: "list failure" },
        })
      : respond(200, { credentials: [credential] });
  });
  context.mocks.api(cloudflareAccessContract.list, async ({ respond }) => {
    await pendingAccess.promise;
    return respond(200, { configs: [] });
  });
  await page(true);
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText("Could not load SSH settings. Try again.");
  expect(within(dialog).queryByLabelText("Credential name")).toBeNull();
  expect(getAction("button", "Save", dialog)).toBeDisabled();
  failCredential = false;
  click(getAction("button", "Retry", dialog));
  await waitFor(() => {
    return expect(
      within(dialog).getByLabelText("Credential"),
    ).toHaveTextContent("SSH login · deploy");
  });
  expect(getAction("button", "Save", dialog)).toBeEnabled();
  click(getAction("radio", "Cloudflare Access", dialog));
  expect(within(dialog).queryByLabelText("Name")).toBeNull();
  expect(getAction("button", "Save", dialog)).toBeDisabled();
  pendingAccess.resolve();
  await within(dialog).findByLabelText("Name");
});

test("Deactivating inline Access fields clears tokens without discarding the SSH draft", async () => {
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [config] });
  });
  context.mocks.api(sshCredentialsContract.list, ({ respond }) => {
    return respond(200, { credentials: [] });
  });
  await page(true);
  const dialog = await screen.findByRole("dialog");
  await fill(await within(dialog).findByLabelText("Private key"), "ssh-draft");
  click(getAction("radio", "Cloudflare Access", dialog));
  await selectConfig(dialog, "Create new Cloudflare Access");
  await tokenFields(dialog);
  context.mocks.ably.trigger("ssh:changed", { orgId });
  await waitFor(() => {
    return expect(getAction("button", "Save", dialog)).toBeEnabled();
  });
  expect(
    within(dialog).getByLabelText("Service Token Client Secret"),
  ).toHaveValue("test-client-secret");
  expect(within(dialog).getByLabelText("Private key")).toHaveValue("ssh-draft");
  await selectConfig(dialog);
  expect(
    within(dialog).queryByLabelText("Service Token Client Secret"),
  ).toBeNull();
  await selectConfig(dialog, "Create new Cloudflare Access");
  expect(
    within(dialog).getByLabelText("Service Token Client Secret"),
  ).toHaveValue("");
  await tokenFields(dialog);
  click(getAction("radio", "Direct", dialog));
  expect(
    within(dialog).queryByLabelText("Service Token Client Secret"),
  ).toBeNull();
  click(getAction("radio", "Cloudflare Access", dialog));
  expect(
    within(dialog).getByLabelText("Service Token Client Secret"),
  ).toHaveValue("");
  expect(within(dialog).getByLabelText("Private key")).toHaveValue("ssh-draft");
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

test.each(
  (["create", "edit"] as const).flatMap((mode) => {
    return [false, true].flatMap((newAccess) => {
      return [false, true].map((newCredential) => {
        return { mode, newAccess, newCredential };
      });
    });
  }),
)(
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

test("A failed host save retains inline Access input for manual retry without a separate resource save", async () => {
  const hosts: unknown[] = [];
  let failing = true;
  const reached = context.mocks.deferred<void>();
  const ready = context.mocks.deferred<void>();
  context.mocks.api(
    sshConnectionsContract.create,
    async ({ body, respond }) => {
      hosts.push(body);
      if (failing) {
        reached.resolve();
      }
      await ready.promise;
      return failing
        ? respond(500, {
            error: { code: "INTERNAL_ERROR", message: "Save failed" },
          })
        : respond(201, host);
    },
  );
  await page(true);
  const dialog = await screen.findByRole("dialog");
  await fill(within(dialog).getByLabelText("Display name"), "Development");
  await fill(
    within(dialog).getByLabelText("Public hostname or IP address"),
    "ssh.example.com",
  );
  click(getAction("radio", "Cloudflare Access", dialog));
  await within(dialog).findByLabelText("Name");
  await tokenFields(dialog);
  click(getAction("button", "Save", dialog));
  await reached.promise;
  const secret = within(dialog).getByLabelText("Service Token Client Secret");
  expect(secret).toHaveValue("test-client-secret");
  expect(secret).toBeDisabled();
  ready.resolve();
  await within(dialog).findByText(
    /We couldn't confirm whether your changes were saved/u,
  );
  expect(secret).toHaveValue("test-client-secret");
  expect(within(dialog).getByLabelText("Display name")).toHaveValue(
    "Development",
  );
  failing = false;
  click(getAction("button", "Retry", dialog));
  await waitFor(() => {
    return expect(hosts).toHaveLength(2);
  });
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(hosts).toHaveLength(2);
  expect(hosts[0]).toStrictEqual(hosts[1]);
  expect(hosts[0]).toMatchObject({
    transport: {
      type: "cloudflare_access",
      create: {
        name: config.name,
        credentials: {
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
        },
      },
    },
  });
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

test("A Direct draft survives a failed conflict refresh and concurrent Access binding", async () => {
  let current = directHost;
  let refreshFails = false;
  const requests: unknown[] = [];
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [config] });
  });
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return refreshFails
      ? respond(500, {
          error: {
            code: "INTERNAL_ERROR",
            message: "private dependency detail",
          },
        })
      : respond(200, { connections: [current] });
  });
  context.mocks.api(sshConnectionsContract.update, ({ body, respond }) => {
    requests.push(body);
    if (body.expectedGeneration === 1) {
      current = { ...host, displayName: "Protected elsewhere", generation: 2 };
      refreshFails = true;
      return respond(409, {
        error: { code: "SSH_GENERATION_CONFLICT", message: "not user copy" },
      });
    }
    current = {
      ...(body.transport?.type === "direct" ? directHost : current),
      displayName: body.displayName ?? current.displayName,
      generation: 3,
    };
    return respond(200, current);
  });
  await page();
  await screen.findByText(directHost.displayName);
  click(getAction("button", "Edit host"));
  const dialog = await screen.findByRole("dialog");
  await fill(within(dialog).getByLabelText("Display name"), "My Direct draft");
  click(getAction("button", "Save", dialog));
  await within(dialog).findByText("Could not load SSH settings. Try again.");
  expect(getAction("button", "Save", dialog)).toBeDisabled();
  refreshFails = false;
  click(getAction("button", "Retry", dialog));
  await within(dialog).findByText("Protected elsewhere");
  expect(getAction("button", "Save", dialog)).toBeDisabled();
  click(getAction("button", "Keep my changes with this version", dialog));
  await waitFor(() => {
    return expect(getAction("button", "Save", dialog)).toBeEnabled();
  });
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  await screen.findByText("My Direct draft");
  click(getAction("button", "Edit host"));
  const saved = await screen.findByRole("dialog");
  expect(getAction("radio", "Direct", saved)).toHaveAttribute(
    "aria-checked",
    "true",
  );
  expect(within(saved).getByLabelText("Port")).toHaveValue(443);
  expect(requests).toStrictEqual(
    [1, 2].map((expectedGeneration) => {
      return {
        expectedGeneration,
        displayName: "My Direct draft",
        host: directHost.host,
        port: 443,
        credential: { id: credential.id },
        transport: { type: "direct" },
      };
    }),
  );
});

test("A new host can be explicitly saved as Direct after Access becomes unavailable", async () => {
  let unavailable = false;
  let hosts: SshConnectionResponse[] = [];
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: hosts });
  });
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return unavailable
      ? respond(404, {
          error: {
            code: "CLOUDFLARE_ACCESS_UNAVAILABLE",
            message: "not user copy",
          },
        })
      : respond(200, { configs: [config] });
  });
  context.mocks.api(sshConnectionsContract.create, ({ body, respond }) => {
    if (body.transport?.type === "cloudflare_access") {
      unavailable = true;
      return respond(404, {
        error: {
          code: "CLOUDFLARE_ACCESS_UNAVAILABLE",
          message: "not user copy",
        },
      });
    }
    const saved = {
      ...directHost,
      displayName: body.displayName,
      port: body.port,
    };
    hosts = [saved];
    return respond(201, saved);
  });
  await page(true);
  const dialog = await screen.findByRole("dialog");
  await fill(within(dialog).getByLabelText("Display name"), "Recoverable host");
  await fill(
    within(dialog).getByLabelText("Public hostname or IP address"),
    host.host,
  );
  await selectCredential(dialog);
  click(getAction("radio", "Cloudflare Access", dialog));
  await within(dialog).findByLabelText("Cloudflare Access");
  await selectConfig(dialog);
  click(getAction("button", "Save", dialog));
  await within(dialog).findAllByText(
    "Cloudflare Access is not available for this account.",
  );
  click(getAction("radio", "Direct", dialog));
  await waitFor(() => {
    return expect(getAction("button", "Save", dialog)).toBeEnabled();
  });
  expect(within(dialog).getByLabelText("Display name")).toHaveValue(
    "Recoverable host",
  );
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  await screen.findByText("Recoverable host");
  await screen.findByText("deploy@ssh.example.com:22");
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

test("A configuration deleted before host Save can be replaced without losing the host draft", async () => {
  const alternate = {
    ...config,
    id: "a0000000-0000-4000-8000-000000000002",
    name: "Alternate gateway",
  };
  let configs = [config, alternate];
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs });
  });
  context.mocks.api(sshConnectionsContract.create, ({ body, respond }) => {
    if (
      body.transport?.type === "cloudflare_access" &&
      "configId" in body.transport &&
      body.transport.configId === config.id
    ) {
      configs = [alternate];
      return respond(404, {
        error: {
          code: "CLOUDFLARE_ACCESS_NOT_FOUND",
          message: "not user copy",
        },
      });
    }
    return respond(201, host);
  });
  await page(true);
  const dialog = await screen.findByRole("dialog");
  await fill(within(dialog).getByLabelText("Display name"), "Retryable host");
  await fill(
    within(dialog).getByLabelText("Public hostname or IP address"),
    host.host,
  );
  await selectCredential(dialog);
  click(getAction("radio", "Cloudflare Access", dialog));
  await within(dialog).findByLabelText("Cloudflare Access");
  await selectConfig(dialog);
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    return expect(getAction("button", "Save", dialog)).toBeDisabled();
  });
  await within(dialog).findAllByText(
    /This Cloudflare Access is no longer available/u,
  );
  await selectConfig(dialog, alternate.name);
  expect(within(dialog).getByLabelText("Display name")).toHaveValue(
    "Retryable host",
  );
  await waitFor(() => {
    return expect(getAction("button", "Save", dialog)).toBeEnabled();
  });
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

test.each(["navigation", "owner"])(
  "Pending Access Save is cancelled and secrets cleared on %s loss",
  async (reason) => {
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
    await fill(
      within(dialog).getByLabelText("Private key"),
      "ssh-draft-canary",
    );
    const privateKey = within(dialog).getByLabelText("Private key");
    click(getAction("radio", "Cloudflare Access", dialog));
    await within(dialog).findByLabelText("Name");
    await tokenFields(dialog);
    const secret = within(dialog).getByLabelText("Service Token Client Secret");
    click(getAction("button", "Save", dialog));
    const requestSignal = await reached.promise;
    act(() => {
      if (reason === "navigation") {
        window.history.pushState({}, "", "/");
        window.dispatchEvent(new PopStateEvent("popstate"));
      } else {
        const clerk = context.mocks.clerk();
        clerk.user(
          { id: "next-owner", fullName: "Next Owner" },
          { token: "next-owner-token" },
        );
        clerk.stateChanged();
      }
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
  },
);
