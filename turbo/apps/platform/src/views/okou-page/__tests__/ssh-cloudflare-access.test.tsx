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
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  applyFeatureSwitches$,
  featureSwitch$,
} from "../../../signals/external/feature-switch.ts";
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
  hosts: [],
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
    featureSwitches: {
      [FeatureSwitchKey.SshAccess]: true,
    },
  });
}
async function selectConfig(dialog: HTMLElement, name = config.name) {
  await userEvent.click(
    await within(dialog).findByLabelText("Access configuration"),
  );
  click(await screen.findByRole("option", { name }));
}
async function selectCredential(dialog: HTMLElement) {
  await userEvent.click(within(dialog).getByLabelText("Credential"));
  click(await screen.findByRole("option", { name: "SSH login · deploy" }));
}
async function tokenFields(dialog: HTMLElement, name = config.name) {
  await fill(within(dialog).getByLabelText("Configuration name"), name);
  await fill(
    within(dialog).getByLabelText("Service Token Client ID"),
    "test-client-id",
  );
  await fill(
    within(dialog).getByLabelText("Service Token Client Secret"),
    "test-client-secret",
  );
}

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
        within(dialog).getByLabelText("Access configuration"),
      ).toHaveTextContent(
        count === 0
          ? "Create new configuration"
          : count === 1
            ? "Gateway 1"
            : "Select a configuration",
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
      within(dialog).getByLabelText("Access configuration"),
    ).toHaveTextContent(
      count === 0 ? "Create new configuration" : `Gateway ${count}`,
    );
    click(getAction("button", "Cancel", dialog));
    await waitFor(() => {
      return expect(screen.queryByRole("dialog")).toBeNull();
    });
  },
);

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
  expect(within(dialog).queryByLabelText("Configuration name")).toBeNull();
  expect(getAction("button", "Save", dialog)).toBeDisabled();
  pendingAccess.resolve();
  await within(dialog).findByLabelText("Configuration name");
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
  await selectConfig(dialog, "Create new configuration");
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
  await selectConfig(dialog, "Create new configuration");
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

test("Access configuration CRUD is inside SSH and never turns zero hosts into configured SSH", async () => {
  let configs: CloudflareAccessConfig[] = [];
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs });
  });
  context.mocks.api(cloudflareAccessContract.create, ({ body, respond }) => {
    const created = { ...config, name: body.name };
    configs = [created];
    return respond(201, created);
  });
  context.mocks.api(cloudflareAccessContract.delete, ({ body, respond }) => {
    expect(body).toStrictEqual({ expectedRevision: 1 });
    configs = [];
    return respond(204);
  });
  await page();
  await screen.findByText("0 hosts configured");
  click(getAction("radio", "Cloudflare Access"));
  await screen.findByText("0 Access configurations configured");
  click(getAction("button", "Add Access configuration"));
  let dialog = await screen.findByRole("dialog", {
    name: "Add Access configuration",
  });
  await tokenFields(dialog);
  const secret = within(dialog).getByLabelText("Service Token Client Secret");
  click(getAction("button", "Save", dialog));
  await screen.findByText("1 Access configuration configured");
  expect(secret).toHaveValue("");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  click(getAction("radio", "Hosts"));
  await screen.findByText("0 hosts configured");
  click(getAction("radio", "Cloudflare Access"));
  await screen.findByText(config.name);
  click(getAction("button", "Delete configuration"));
  dialog = await screen.findByRole("dialog", { name: "Delete configuration" });
  click(getAction("button", "Delete configuration", dialog));
  await screen.findByText("0 Access configurations configured");
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
  await within(dialog).findByLabelText("Access configuration");
  expect(within(dialog).getByLabelText("Port")).not.toBeVisible();
  await selectConfig(dialog);
  click(getAction("radio", "Direct", dialog));
  expect(within(dialog).getByLabelText("Port")).toHaveValue(2222);
  click(getAction("radio", "Cloudflare Access", dialog));
  await expect(
    within(dialog).findByLabelText("Access configuration"),
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

test.each(["create", "edit"] as const)(
  "A %s host can atomically select or create both resource types",
  async (mode) => {
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
    for (const newAccess of [false, true]) {
      for (const newCredential of [false, true]) {
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
        await within(dialog).findByLabelText("Access configuration");
        if (newAccess) {
          await selectConfig(dialog, "Create new configuration");
          await tokenFields(dialog);
        }
        if (newCredential) {
          await userEvent.click(
            await within(dialog).findByLabelText("Credential"),
          );
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
          await fill(
            within(dialog).getByLabelText("Password"),
            "password-canary",
          );
        }
        expect(screen.getAllByRole("dialog")).toHaveLength(1);
        click(getAction("button", "Save", dialog));
        await waitFor(() => {
          return expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        });
        const generatedId = expect.any(String);
        expect(requests.at(-1)).toStrictEqual({
          ...(mode === "edit"
            ? { expectedGeneration: 1 }
            : { id: generatedId }),
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
      }
    }
    expect(requests).toHaveLength(4);
  },
);

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
  await within(dialog).findByLabelText("Configuration name");
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

test("Pending and failed Access Save keep secrets for retry; a background refresh cannot reset them", async () => {
  const pending = context.mocks.deferred<void>();
  let failing = true;
  context.mocks.api(cloudflareAccessContract.create, async ({ respond }) => {
    await pending.promise;
    return failing
      ? respond(500, {
          error: { code: "INTERNAL_ERROR", message: "Temporary failure" },
        })
      : respond(201, config);
  });
  await page();
  click(getAction("radio", "Cloudflare Access"));
  click(
    await waitFor(() => {
      return getAction("button", "Add Access configuration");
    }),
  );
  const dialog = await screen.findByRole("dialog");
  await tokenFields(dialog);
  const secret = within(dialog).getByLabelText("Service Token Client Secret");
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    return expect(getAction("button", "Saving...", dialog)).toBeDisabled();
  });
  expect(secret).toHaveValue("test-client-secret");
  context.mocks.ably.trigger("ssh:changed", { orgId });
  pending.resolve();
  await within(dialog).findByText(
    /We couldn't confirm whether your changes were saved/u,
  );
  expect(secret).toHaveValue("test-client-secret");
  failing = false;
  click(getAction("button", "Retry", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(secret).toHaveValue("");
});

test("A committed Access creation completes on same-ID retry without another configuration", async () => {
  const submitted: unknown[] = [];
  context.mocks.api(cloudflareAccessContract.create, ({ body, respond }) => {
    submitted.push(body);
    return submitted.length > 1
      ? respond(204)
      : respond(500, {
          error: { code: "INTERNAL_ERROR", message: "Response unavailable" },
        });
  });
  await page();
  click(getAction("radio", "Cloudflare Access"));
  click(
    await waitFor(() => {
      return getAction("button", "Add Access configuration");
    }),
  );
  const dialog = await screen.findByRole("dialog");
  await tokenFields(dialog);
  const secret = within(dialog).getByLabelText("Service Token Client Secret");
  click(getAction("button", "Save", dialog));
  await within(dialog).findByText(
    /We couldn't confirm whether your changes were saved/u,
  );
  expect(secret).toHaveValue("test-client-secret");
  expect(secret).toBeDisabled();
  expect(submitted).toHaveLength(1);
  click(getAction("button", "Retry", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(submitted).toHaveLength(2);
  expect(submitted[0]).toHaveProperty("id", expect.any(String));
  expect(submitted[0]).toStrictEqual(submitted[1]);
  expect(secret).toHaveValue("");
});

test("A token replacement conflict preserves input and needs explicit latest-version review", async () => {
  let current = config;
  const requests: unknown[] = [];
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [current] });
  });
  context.mocks.api(cloudflareAccessContract.update, ({ body, respond }) => {
    requests.push(body);
    if (body.expectedRevision === 1) {
      current = { ...config, name: "Renamed elsewhere", revision: 2 };
      return respond(409, {
        error: {
          code: "CLOUDFLARE_ACCESS_REVISION_CONFLICT",
          message: "not user copy",
        },
      });
    }
    return respond(200, { ...current, revision: 3, generation: 2 });
  });
  await page();
  click(getAction("radio", "Cloudflare Access"));
  await screen.findByText(config.name);
  click(getAction("button", "Edit Access configuration"));
  const dialog = await screen.findByRole("dialog");
  await userEvent.click(
    within(dialog).getByRole("checkbox", { name: "Replace Service Token" }),
  );
  await fill(
    within(dialog).getByLabelText("Service Token Client ID"),
    "replacement-id",
  );
  await fill(
    within(dialog).getByLabelText("Service Token Client Secret"),
    "replacement-secret",
  );
  click(getAction("button", "Save", dialog));
  await within(dialog).findByText("Renamed elsewhere");
  expect(getAction("button", "Save", dialog)).toBeDisabled();
  expect(
    within(dialog).getByLabelText("Service Token Client Secret"),
  ).toHaveValue("replacement-secret");
  click(getAction("button", "Keep my changes with this version", dialog));
  await waitFor(() => {
    return expect(getAction("button", "Save", dialog)).toBeEnabled();
  });
  expect(
    within(dialog).getByLabelText("Service Token Client Secret"),
  ).toHaveValue("replacement-secret");
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(requests).toStrictEqual(
    [1, 2].map((expectedRevision) => {
      return {
        expectedRevision,
        credentials: {
          clientId: "replacement-id",
          clientSecret: "replacement-secret",
        },
      };
    }),
  );
  expect(document.body.textContent).not.toContain("not user copy");
});

test("A referenced deletion race explains the new affected host without removing the config", async () => {
  let current = config;
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [current] });
  });
  context.mocks.api(cloudflareAccessContract.delete, ({ respond }) => {
    current = {
      ...config,
      hosts: [{ id: host.id, displayName: host.displayName }],
    };
    return respond(409, {
      error: { code: "CLOUDFLARE_ACCESS_IN_USE", message: "not user copy" },
    });
  });
  await page();
  click(getAction("radio", "Cloudflare Access"));
  await screen.findByText(config.name);
  click(getAction("button", "Delete configuration"));
  const dialog = await screen.findByRole("dialog");
  click(getAction("button", "Delete configuration", dialog));
  await within(dialog).findByText(host.displayName);
  expect(getAction("button", "Delete configuration", dialog)).toBeDisabled();
  expect(
    getAction("button", "Keep my changes with this version", dialog),
  ).toBeDisabled();
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
  await within(dialog).findByLabelText("Access configuration");
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
  await within(dialog).findByLabelText("Access configuration");
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

test("Changing the owner clears Access secrets and hides the previous owner's configurations", async () => {
  await page();
  click(getAction("radio", "Cloudflare Access"));
  click(
    await waitFor(() => {
      return getAction("button", "Add Access configuration");
    }),
  );
  const dialog = await screen.findByRole("dialog");
  await tokenFields(dialog);
  const secret = within(dialog).getByLabelText("Service Token Client Secret");
  const clerk = context.mocks.clerk();
  clerk.user(
    { id: "other-owner", fullName: "Other Owner" },
    { token: "other-token" },
  );
  clerk.stateChanged();
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(secret).toHaveValue("");
});

test("Renaming changes metadata without requesting a new Service Token", async () => {
  let current = config;
  const requests: unknown[] = [];
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [current] });
  });
  context.mocks.api(cloudflareAccessContract.update, ({ body, respond }) => {
    requests.push(body);
    current = { ...config, name: body.name ?? config.name, revision: 2 };
    return respond(200, current);
  });
  await page();
  click(getAction("radio", "Cloudflare Access"));
  await screen.findByText(config.name);
  click(getAction("button", "Edit Access configuration"));
  const dialog = await screen.findByRole("dialog");
  expect(
    within(dialog).queryByLabelText("Service Token Client Secret"),
  ).not.toBeInTheDocument();
  await fill(
    within(dialog).getByLabelText("Configuration name"),
    "Renamed gateway",
  );
  click(getAction("button", "Save", dialog));
  await screen.findByText("Renamed gateway");
  expect(requests).toStrictEqual([
    { expectedRevision: 1, name: "Renamed gateway" },
  ]);
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
  await within(dialog).findByLabelText("Access configuration");
  await selectConfig(dialog);
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    return expect(getAction("button", "Save", dialog)).toBeDisabled();
  });
  await within(dialog).findAllByText(
    /This Access configuration is no longer available/u,
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

test.each(["navigation", "owner", "feature"])(
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
    await within(dialog).findByLabelText("Configuration name");
    await tokenFields(dialog);
    const secret = within(dialog).getByLabelText("Service Token Client Secret");
    click(getAction("button", "Save", dialog));
    const requestSignal = await reached.promise;
    act(() => {
      if (reason === "navigation") {
        window.history.pushState({}, "", "/");
        window.dispatchEvent(new PopStateEvent("popstate"));
      } else if (reason === "owner") {
        const clerk = context.mocks.clerk();
        clerk.user(
          { id: "next-owner", fullName: "Next Owner" },
          { token: "next-owner-token" },
        );
        clerk.stateChanged();
      } else {
        // Eligibility cannot change through this page or an SSH notification.
        // The Lab flow navigates away, already covered above. Inject only this
        // infrastructure-owned snapshot to exercise in-place feature loss.
        context.store.set(applyFeatureSwitches$, {
          ...context.store.get(featureSwitch$),
          [FeatureSwitchKey.SshAccess]: false,
        });
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

test("Access load failure offers retry while feature unavailability remains distinct", async () => {
  let unavailable = false;
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return unavailable
      ? respond(404, {
          error: {
            code: "CLOUDFLARE_ACCESS_UNAVAILABLE",
            message: "not user copy",
          },
        })
      : respond(500, {
          error: { code: "INTERNAL_ERROR", message: "private provider detail" },
        });
  });
  await page();
  click(getAction("radio", "Cloudflare Access"));
  await screen.findByText("Could not load Access configurations. Try again.");
  expect(
    queryAction("button", "Add Access configuration"),
  ).not.toBeInTheDocument();
  unavailable = true;
  click(getAction("button", "Retry"));
  await screen.findByText(
    "Cloudflare Access is not available for this account.",
  );
  expect(document.body.textContent).not.toContain("private provider detail");
});
