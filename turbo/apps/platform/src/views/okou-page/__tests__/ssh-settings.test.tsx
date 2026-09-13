import {
  sshCredentialsContract,
  type SshCredentialResponse,
} from "@okouai/api-contracts/contracts/ssh-credentials";
import {
  agentsByIdContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import { agentSshAccessContract } from "@okouai/api-contracts/contracts/ssh-access";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { userPermissionGrantsContract } from "@okouai/api-contracts/contracts/user-permission-grants";
import { connectorSlugSchema } from "@okouai/api-contracts/contracts/connector-identity";
import {
  sshConnectionsContract,
  type SshConnectionResponse,
} from "@okouai/api-contracts/contracts/ssh-connections";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname } from "../../../signals/location.ts";
import { catalogConnectorFixture } from "../../team-page/__tests__/team-page-test-helpers.ts";
import {
  getAction,
  queryAction,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();
const orgId = "org_ssh_settings";
const auth = Object.freeze({
  user: { id: "test-user-123", fullName: "Test User" },
  organization: {
    activeOrg: { id: orgId, name: "SSH test organization" },
    memberships: [{ id: orgId }],
  },
});
const id = "b0000000-0000-4000-8000-000000000001";
const agentId = "c0000000-0000-4000-8000-000000000001";
const base: SshConnectionResponse = Object.freeze({
  id,
  displayName: "Deployment",
  host: "ssh.example.com",
  port: 22,
  username: "deploy",
  credentialId: "d0000000-0000-4000-8000-000000000001",
  credentialName: "Deployment login",
  generation: 1,
  learnedHostKey: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
});

const credential: SshCredentialResponse = Object.freeze({
  id: base.credentialId,
  name: base.credentialName,
  username: base.username,
  authMethod: "private_key",
  revision: 1,
  hosts: [{ id: base.id, displayName: base.displayName }],
  createdAt: base.createdAt,
  updatedAt: base.updatedAt,
});
beforeEach(() => {
  context.mocks.api(sshCredentialsContract.list, ({ respond }) => {
    return respond(200, { credentials: [credential] });
  });
});

test("An existing credential can be reused without entering or reading its secrets", async () => {
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [] });
  });
  const requests: unknown[] = [];
  context.mocks.api(sshConnectionsContract.create, ({ body, respond }) => {
    requests.push(body);
    return respond(201, base);
  });
  await page("/connectors/ssh?add=1");
  const dialog = await screen.findByRole("dialog");
  const hostFields = within(dialog).getByRole("group", { name: "Host" });
  const credentialFields = within(dialog).getByRole("group", {
    name: "Credential",
  });
  expect(within(hostFields).getByLabelText("Port")).toHaveValue(22);
  expect(within(hostFields).queryByLabelText("Credential name")).toBeNull();
  expect(
    within(credentialFields).getByLabelText("Credential name"),
  ).toBeVisible();
  expect(within(credentialFields).getByLabelText("SSH username")).toBeVisible();
  expect(within(credentialFields).getByLabelText("Private key")).toBeVisible();
  expect(within(credentialFields).queryByLabelText("Display name")).toBeNull();
  await fill(within(hostFields).getByLabelText("Display name"), "Second host");
  await fill(
    within(hostFields).getByLabelText("Public hostname or IP address"),
    "second.example.com",
  );
  await userEvent.click(within(credentialFields).getByRole("combobox"));
  await userEvent.click(
    await screen.findByRole("option", { name: "Deployment login · deploy" }),
  );
  expect(within(dialog).queryByLabelText("Private key")).toBeNull();
  expect(within(dialog).queryByLabelText("SSH username")).toBeNull();
  expect(within(hostFields).getByLabelText("Display name")).toHaveValue(
    "Second host",
  );
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(requests).toStrictEqual([
    {
      displayName: "Second host",
      host: "second.example.com",
      port: 22,
      credential: { id: credential.id },
    },
  ]);
});

test("Password credentials preserve whitespace, clear mode-switched secrets, and discard late key reads", async () => {
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [] });
  });
  const requests: unknown[] = [];
  context.mocks.api(sshCredentialsContract.create, ({ body, respond }) => {
    requests.push(body);
    return respond(201, { ...credential, authMethod: "password", hosts: [] });
  });
  await page();
  click(getAction("radio", "Credentials"));
  click(
    await waitFor(() => {
      return getAction("button", "Add credential");
    }),
  );
  const dialog = await screen.findByRole("dialog");
  await fill(
    within(dialog).getByLabelText("Credential name"),
    "Password login",
  );
  await fill(within(dialog).getByLabelText("SSH username"), "operator");
  const pending = context.mocks.deferred<string>();
  const file = new File(["old-key"], "id_ed25519");
  vi.spyOn(file, "text").mockReturnValue(pending.promise);
  await userEvent.upload(
    within(dialog).getByLabelText("Choose private key file"),
    file,
  );
  await within(dialog).findByText("Reading private key file…");
  click(getAction("radio", "Password", dialog));
  await fill(within(dialog).getByLabelText("Password"), "discarded-password");
  click(getAction("radio", "Private key", dialog));
  pending.resolve("late-key-canary");
  await pending.promise;
  expect(within(dialog).getByLabelText("Private key")).toHaveValue("");
  click(getAction("radio", "Password", dialog));
  expect(within(dialog).getByLabelText("Password")).toHaveValue("");
  await fill(within(dialog).getByLabelText("Password"), "  password-canary  ");
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(requests).toStrictEqual([
    {
      name: "Password login",
      username: "operator",
      authentication: { method: "password", password: "  password-canary  " },
    },
  ]);
  expect(document.body.textContent).not.toContain("canary");
});

test.each(["host", "credential"])(
  "A failed %s save keeps password input for a manual retry",
  async (kind) => {
    context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
      return respond(200, { connections: [] });
    });
    const ready = context.mocks.deferred<void>();
    const requests: unknown[] = [];
    let fail = true;
    const error = {
      error: { code: "INTERNAL_ERROR", message: "Temporary save failure" },
    };
    if (kind === "host") {
      context.mocks.api(
        sshConnectionsContract.create,
        async ({ body, respond }) => {
          requests.push(body);
          await ready.promise;
          return fail ? respond(500, error) : respond(201, base);
        },
      );
      await page("/connectors/ssh?add=1");
    } else {
      context.mocks.api(
        sshCredentialsContract.create,
        async ({ body, respond }) => {
          requests.push(body);
          await ready.promise;
          return fail
            ? respond(500, error)
            : respond(201, {
                ...credential,
                authMethod: "password",
                hosts: [],
              });
        },
      );
      await page();
      click(getAction("radio", "Credentials"));
      click(
        await waitFor(() => {
          return getAction("button", "Add credential");
        }),
      );
    }
    const dialog = await screen.findByRole("dialog");
    if (kind === "host") {
      await fill(within(dialog).getByLabelText("Display name"), "Deployment");
      await fill(
        within(dialog).getByLabelText("Public hostname or IP address"),
        "ssh.example.com",
      );
    }
    await fill(
      within(dialog).getByLabelText("Credential name"),
      "Password login",
    );
    await fill(within(dialog).getByLabelText("SSH username"), "deploy");
    click(getAction("radio", "Password", dialog));
    await fill(
      within(dialog).getByLabelText("Password"),
      "  retry-password-canary  ",
    );
    click(getAction("button", "Save", dialog));
    await waitFor(() => {
      expect(getAction("button", "Saving...", dialog)).toBeDisabled();
    });
    expect(within(dialog).getByLabelText("Password")).toHaveValue(
      "  retry-password-canary  ",
    );
    expect(within(dialog).getByLabelText("Password")).toBeDisabled();
    expect(within(dialog).getByLabelText("SSH username")).toBeDisabled();
    expect(getAction("button", "Cancel", dialog)).toBeDisabled();
    const privateKeyChoice = getAction("radio", "Private key", dialog);
    expect(privateKeyChoice).toHaveAttribute("aria-disabled", "true");
    ready.resolve();
    await waitFor(() => {
      expect(getAction("button", "Save", dialog)).toBeEnabled();
    });
    expect(within(dialog).getByLabelText("Credential name")).toHaveValue(
      "Password login",
    );
    expect(within(dialog).getByLabelText("SSH username")).toHaveValue("deploy");
    expect(within(dialog).getByLabelText("Password")).toHaveValue(
      "  retry-password-canary  ",
    );
    expect(within(dialog).getByLabelText("Password")).toBeEnabled();
    fail = false;
    click(getAction("button", "Save", dialog));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    const credentialBody = {
      name: "Password login",
      username: "deploy",
      authentication: {
        method: "password",
        password: "  retry-password-canary  ",
      },
    };
    const expected =
      kind === "host"
        ? {
            displayName: "Deployment",
            host: "ssh.example.com",
            port: 22,
            credential: { create: credentialBody },
          }
        : credentialBody;
    expect(requests).toStrictEqual([expected, expected]);
    click(getAction("button", kind === "host" ? "Add host" : "Add credential"));
    const reopened = await screen.findByRole("dialog");
    click(getAction("radio", "Password", reopened));
    expect(within(reopened).getByLabelText("Password")).toHaveValue("");
  },
);

test("Shared credential editing explains its impact and conflicts do not retry or overwrite", async () => {
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [base] });
  });
  let current = {
    ...credential,
    hosts: [
      ...credential.hosts,
      {
        id: "b0000000-0000-4000-8000-000000000002",
        displayName: "Second host",
      },
    ],
  };
  context.mocks.api(sshCredentialsContract.list, ({ respond }) => {
    return respond(200, { credentials: [current] });
  });
  const requests: unknown[] = [];
  context.mocks.api(sshCredentialsContract.update, ({ body, respond }) => {
    requests.push(body);
    current = { ...current, revision: 2, name: "Edited elsewhere" };
    return respond(409, {
      error: {
        code: "SSH_CREDENTIAL_REVISION_CONFLICT",
        message: "not UI copy",
      },
    });
  });
  await page();
  click(getAction("radio", "Credentials"));
  await screen.findByText("Login changes apply to all 2 hosts:");
  expect(getAction("button", "Delete credential")).toBeDisabled();
  click(getAction("button", "Edit credential"));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("Second host")).toBeVisible();
  expect(within(dialog).queryByLabelText("Private key")).toBeNull();
  await fill(within(dialog).getByLabelText("SSH username"), "new-user");
  click(getAction("button", "Save", dialog));
  await screen.findByText("Edited elsewhere");
  await screen.findByText(/This credential changed while you were editing/u);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.body.textContent).not.toContain("not UI copy");
  expect(requests).toStrictEqual([
    { expectedRevision: 1, name: credential.name, username: "new-user" },
  ]);
});

test("An unused credential can be deleted with confirmation and the rendered revision", async () => {
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [] });
  });
  let credentials = [{ ...credential, hosts: [] }];
  context.mocks.api(sshCredentialsContract.list, ({ respond }) => {
    return respond(200, { credentials });
  });
  context.mocks.api(
    sshCredentialsContract.delete,
    ({ body, params, respond }) => {
      expect(params.credentialId).toBe(credential.id);
      expect(body).toStrictEqual({ expectedRevision: 1 });
      credentials = [];
      return respond(204);
    },
  );
  await page();
  click(getAction("radio", "Credentials"));
  await screen.findByText("1 credential configured");
  click(getAction("button", "Delete credential"));
  const dialog = await screen.findByRole("dialog");
  expect(
    within(dialog).getByText(/Its stored secret cannot be recovered/u),
  ).toBeVisible();
  expect(getAction("button", "Delete credential", dialog)).toBeEnabled();
  click(getAction("button", "Delete credential", dialog));
  await screen.findByText(
    "No SSH credentials yet. Add a private key or password to reuse across hosts.",
  );
  expect(screen.getByText("0 credentials configured")).toBeVisible();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(queryAction("button", "Delete credential")).toBeNull();
});

test("SSH recovers after first opening Connectors during a workspace refresh", async () => {
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 1 });
  });
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [base] });
  });
  await page("/agents");
  await screen.findByRole("heading", { name: "Agents" });

  const clerk = context.mocks.clerk();
  act(() => {
    clerk.organization({ ...auth.organization, activeOrg: null });
    clerk.stateChanged();
  });
  click(
    getAction(
      "link",
      "Connectors",
      screen.getByRole("navigation", { name: "Sidebar" }),
    ),
  );
  await fill(await screen.findByPlaceholderText("Find connectors"), "ssh");
  await screen.findByText(/No connectors matching/u);

  act(() => {
    clerk.organization(auth.organization);
    clerk.stateChanged();
  });
  context.mocks.ably.trigger("ssh:changed", { orgId });

  click(
    await waitFor(() => {
      return getAction("link", "Manage SSH hosts");
    }),
  );
  await expect(
    screen.findByText("deploy@ssh.example.com:22"),
  ).resolves.toBeVisible();
});

test.each(["token", "profile", "session"])(
  "A same-owner Clerk %s refresh preserves an SSH form that can still be saved",
  async (refresh) => {
    let hosts = [base];
    context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
      return respond(200, { connections: hosts });
    });
    context.mocks.api(sshConnectionsContract.create, ({ body, respond }) => {
      const connection = {
        ...base,
        id: "b0000000-0000-4000-8000-000000000002",
        displayName: body.displayName,
        host: body.host,
        port: body.port,
        username:
          "create" in body.credential
            ? body.credential.create.username
            : base.username,
      };
      hosts = [...hosts, connection];
      return respond(201, connection);
    });
    await page();
    await screen.findByText("deploy@ssh.example.com:22");
    click(getAction("button", "Add host"));
    const dialog = await screen.findByRole("dialog");
    await fill(within(dialog).getByLabelText("Display name"), "Unsaved host");
    await fill(
      within(dialog).getByLabelText("Public hostname or IP address"),
      "unsaved.example.com",
    );
    await fill(within(dialog).getByLabelText("Port"), "2222");
    await fill(
      within(dialog).getByLabelText("Credential name"),
      "Deployment login",
    );
    await fill(within(dialog).getByLabelText("SSH username"), "unsaved-user");
    await fill(within(dialog).getByLabelText("Private key"), "unsaved-key");
    await fill(
      within(dialog).getByLabelText("Passphrase (optional)"),
      "unsaved-passphrase",
    );
    await userEvent.click(within(dialog).getByLabelText("Private key"));

    const clerk = context.mocks.clerk();
    act(() => {
      clerk.user(
        {
          ...auth.user,
          fullName:
            refresh === "profile" ? "Updated profile" : auth.user.fullName,
        },
        {
          id: refresh === "session" ? "replacement-session" : "test-session-id",
          token: "refreshed-token",
        },
      );
      clerk.stateChanged();
    });

    const current = within(await screen.findByRole("dialog"));
    expect(current.getByLabelText("Display name")).toHaveValue("Unsaved host");
    expect(current.getByLabelText("Public hostname or IP address")).toHaveValue(
      "unsaved.example.com",
    );
    expect(current.getByLabelText("Port")).toHaveValue(2222);
    expect(current.getByLabelText("SSH username")).toHaveValue("unsaved-user");
    expect(current.getByLabelText("Private key")).toHaveValue("unsaved-key");
    expect(current.getByLabelText("Private key")).toHaveFocus();
    expect(current.getByLabelText("Passphrase (optional)")).toHaveValue(
      "unsaved-passphrase",
    );
    expect(screen.getByText("deploy@ssh.example.com:22")).toBeInTheDocument();
    click(getAction("button", "Save", await screen.findByRole("dialog")));
    await screen.findByText("unsaved-user@unsaved.example.com:2222");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const displayName =
      refresh === "profile" ? "Updated profile" : auth.user.fullName;
    await waitFor(() => {
      expect(getAction("button", displayName)).toBeVisible();
    });
  },
);

test.each(["session", "organization"])(
  "Transiently missing Clerk %s data preserves an unsaved SSH credential form",
  async (missing) => {
    context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
      return respond(200, { connections: [base] });
    });
    await page();
    await screen.findByText("deploy@ssh.example.com:22");
    click(getAction("button", "Add host"));
    const dialog = await screen.findByRole("dialog");
    await fill(within(dialog).getByLabelText("Private key"), "unsaved-key");
    await fill(
      within(dialog).getByLabelText("Passphrase (optional)"),
      "unsaved-passphrase",
    );
    await userEvent.click(within(dialog).getByLabelText("Private key"));

    const clerk = context.mocks.clerk();
    act(() => {
      if (missing === "session") {
        clerk.user(auth.user, null);
      } else {
        clerk.organization({ ...auth.organization, activeOrg: null });
      }
      clerk.stateChanged();
    });

    const pending = within(await screen.findByRole("dialog"));
    expect(pending.getByLabelText("Private key")).toHaveValue("unsaved-key");
    expect(pending.getByLabelText("Private key")).toHaveFocus();
    expect(pending.getByLabelText("Passphrase (optional)")).toHaveValue(
      "unsaved-passphrase",
    );
    expect(screen.getByText("deploy@ssh.example.com:22")).toBeInTheDocument();

    act(() => {
      clerk.user(auth.user, { token: "refreshed-token" });
      clerk.organization(auth.organization);
      clerk.stateChanged();
    });

    const restored = within(await screen.findByRole("dialog"));
    expect(restored.getByLabelText("Private key")).toHaveValue("unsaved-key");
    expect(restored.getByLabelText("Private key")).toHaveFocus();
    expect(restored.getByLabelText("Passphrase (optional)")).toHaveValue(
      "unsaved-passphrase",
    );
    expect(screen.getByText("deploy@ssh.example.com:22")).toBeInTheDocument();
  },
);

test("Connection warnings explain the failure and recover through notifications without changing grants", async () => {
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, {
      connections: [
        {
          ...base,
          learnedHostKey: {
            algorithm: "ssh-ed25519",
            fingerprint: "SHA256://////////////////////////////////////////8",
          },
        },
      ],
    });
  });
  let failed = true;
  context.mocks.api(sshConnectionsContract.observations, ({ respond }) => {
    return respond(200, {
      observations: [
        {
          connectionId: id,
          generation: 1,
          observedAt: "2026-09-10T08:00:00.000Z",
          failureReason: failed ? "host_key_mismatch" : null,
        },
      ],
    });
  });
  await page();
  await screen.findByText(/The server's host key does not match/u);
  expect(
    screen.getByText(/Independently verify the server before/u),
  ).toBeInTheDocument();
  expect(getAction("button", "Reset host key")).toBeEnabled();
  expect(screen.queryByText(/connectivity not tested/u)).toBeNull();
  failed = false;
  context.mocks.ably.trigger("ssh:changed", { orgId });
  await waitFor(() => {
    expect(
      screen.queryByText(/The server's host key does not match/u),
    ).toBeNull();
  });
  expect(screen.getByText("Deployment")).toBeInTheDocument();
});

test.each([404, 500] as const)(
  "Diagnostic read failure (%s) is not a host failure and keeps management available",
  async (status) => {
    context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
      return respond(200, { connections: [base] });
    });
    context.mocks.api(sshConnectionsContract.observations, ({ respond }) => {
      return respond(status, {
        error: {
          code: status === 404 ? "NOT_FOUND" : "INTERNAL_SERVER_ERROR",
          message: "private server error",
        },
      });
    });
    await page();
    await screen.findByText("SSH connection status is unavailable");
    expect(getAction("button", "Edit host")).toBeEnabled();
    expect(screen.queryByText(/needs attention/u)).toBeNull();
    expect(document.body.textContent).not.toContain("private server error");
  },
);

test("Live notifications refresh hosts across reconnect without clearing an open credential form", async () => {
  let host = base;
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [host] });
  });
  await page();
  click(
    await waitFor(() => {
      return getAction("button", "Edit host");
    }),
  );
  const editDialog = await screen.findByRole("dialog");
  await userEvent.click(within(editDialog).getByRole("combobox"));
  await userEvent.click(
    await screen.findByRole("option", { name: "Create new credential" }),
  );
  const dialog = await screen.findByRole("dialog");
  const key = within(dialog).getByLabelText("Private key");
  await fill(key, "unsaved-key");
  await fill(
    within(dialog).getByLabelText("Passphrase (optional)"),
    "unsaved-passphrase",
  );
  host = { ...base, displayName: "Changed remotely", generation: 2 };
  context.mocks.ably.trigger("ssh:changed", { orgId });
  await screen.findByText("Changed remotely");
  expect(key).toHaveValue("unsaved-key");
  expect(within(dialog).getByLabelText("Passphrase (optional)")).toHaveValue(
    "unsaved-passphrase",
  );
  expect(dialog).toBeInTheDocument();
  host = { ...host, displayName: "Changed while offline" };
  await act(async () => {
    context.mocks.ably.triggerReconnect();
    await Promise.resolve();
  });
  expect(screen.getByText("Changed remotely")).toBeInTheDocument();
  expect(screen.queryByText("Changed while offline")).toBeNull();
  context.mocks.ably.trigger("ssh:changed", { orgId });
  await screen.findByText("Changed while offline");
  expect(key).toHaveValue("unsaved-key");
});

test("SSH notifications ignore malformed and other-workspace payloads", async () => {
  let host = base;
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [host] });
  });
  await page();
  await screen.findByText("Deployment");
  host = { ...base, displayName: "Changed remotely" };
  await act(async () => {
    context.mocks.ably.trigger("ssh:changed", { orgId: "another-org" });
    context.mocks.ably.trigger("ssh:changed", { orgId, unexpected: true });
    context.mocks.ably.trigger("ssh:changed", null);
    await Promise.resolve();
  });
  expect(screen.getByText("Deployment")).toBeInTheDocument();
  expect(screen.queryByText("Changed remotely")).toBeNull();
  context.mocks.ably.trigger("ssh:changed", { orgId });
  await screen.findByText("Changed remotely");
});

test("The zero-host Add intent is consumed once and notifications never reopen it", async () => {
  let hosts: SshConnectionResponse[] = [];
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: hosts });
  });
  await page("/connectors/ssh?add=1");
  const dialog = await screen.findByRole("dialog");
  expect(window.location.search).toBe("");
  click(getAction("button", "Cancel", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
  hosts = [base];
  context.mocks.ably.trigger("ssh:changed", { orgId });
  await screen.findByText("Deployment");
  expect(screen.queryByRole("dialog")).toBeNull();
  hosts = [];
  context.mocks.ably.trigger("ssh:changed", { orgId });
  await screen.findByText("0 hosts configured");
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("A stale zero-host entry does not auto-open Add when a host already exists", async () => {
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [base] });
  });
  await page("/connectors/ssh?add=1");
  await screen.findByText("Deployment");
  expect(window.location.search).toBe("");
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("A localized load error is retryable and distinct from feature unavailability", async () => {
  let failed = true;
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return failed
      ? respond(500, {
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "opaque server message",
          },
        })
      : respond(200, { connections: [] });
  });
  await setupPage({
    context,
    path: "/connectors/ssh",
    auth,
    locale: "fr-FR",
    featureSwitches: { [FeatureSwitchKey.SshAccess]: true },
  });
  await screen.findByText(
    "Impossible de charger les paramètres SSH. Réessayez.",
  );
  expect(document.body.textContent).not.toContain("opaque server message");
  expect(screen.queryByText(/pas disponible pour ce compte/u)).toBeNull();
  failed = false;
  click(getAction("button", "Réessayer"));
  await screen.findByText("0 hôte configuré");
  expect(screen.queryByRole("alert")).toBeNull();
});

test("Invalid host errors preserve credentials so the host can be corrected and saved", async () => {
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [] });
  });
  context.mocks.api(sshConnectionsContract.create, ({ body, respond }) => {
    if (body.host === "ssh.example.com") {
      return respond(201, base);
    }
    return respond(400, {
      error: {
        code: "SSH_INVALID_HOST",
        message: "server diagnostic must not be UI copy",
      },
    });
  });
  await page("/connectors/ssh?add=1");
  const dialog = await screen.findByRole("dialog");
  await fill(within(dialog).getByLabelText("Display name"), "Deployment");
  await fill(
    within(dialog).getByLabelText("Public hostname or IP address"),
    "https://ssh.example.com",
  );
  await fill(
    within(dialog).getByLabelText("Credential name"),
    "Deployment login",
  );
  await fill(within(dialog).getByLabelText("SSH username"), "deploy");
  await fill(within(dialog).getByLabelText("Private key"), "not-a-real-key");
  click(getAction("button", "Save", dialog));
  await screen.findByText(
    "Enter a hostname or IP address without a URL scheme, path or spaces.",
  );
  expect(document.body.textContent).not.toContain(
    "server diagnostic must not be UI copy",
  );
  expect(within(dialog).getByLabelText("Private key")).toHaveValue(
    "not-a-real-key",
  );
  expect(within(dialog).getByLabelText("Display name")).toHaveValue(
    "Deployment",
  );
  await fill(
    within(dialog).getByLabelText("Public hostname or IP address"),
    "ssh.example.com",
  );
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
async function page(path = "/connectors/ssh", enabled = true) {
  await setupPage({
    context,
    path,
    auth,
    featureSwitches: { [FeatureSwitchKey.SshAccess]: enabled },
  });
}

test("SSH is a Connectors detail page with a working return breadcrumb", async () => {
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [] });
  });
  await page();
  await screen.findByText("0 hosts configured");
  expect(pathname()).toBe("/connectors/ssh");
  const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
  expect(within(breadcrumb).getByText("SSH")).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(
    getAction(
      "link",
      "Connectors",
      screen.getByRole("navigation", { name: "Sidebar" }),
    ),
  ).toHaveAttribute("aria-current", "page");
  click(getAction("link", "Connectors", breadcrumb));
  await screen.findByPlaceholderText("Find connectors");
  expect(pathname()).toBe("/connectors");
});

test("Mobile SSH management retains its Connectors section and return navigation", async () => {
  context.mocks.browser.matchMedia(false);
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [] });
  });
  await page();
  await screen.findByText("0 hosts configured");
  const name = await screen.findByTestId("breadcrumb-name");
  expect(name).toHaveTextContent("SSH");
  const section = name.parentElement;
  if (!section) {
    throw new Error("Mobile breadcrumb section is missing");
  }
  click(getAction("link", "Connectors", section));
  await screen.findByPlaceholderText("Find connectors");
  expect(pathname()).toBe("/connectors");
});

test.each([
  { count: 0, label: "0 hosts configured" },
  { count: 1, label: "1 host configured" },
  { count: 2, label: "2 hosts configured" },
])(
  "Shows the translated configured host count for $count hosts",
  async ({ count, label }) => {
    const hosts = Array.from({ length: count }, (_, index) => {
      return { ...base, id: `b0000000-0000-4000-8000-00000000000${index}` };
    });
    context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
      return respond(200, { connections: hosts });
    });
    await page();
    const configuredCount = await screen.findByText(label);
    expect(configuredCount).toBeInTheDocument();
  },
);

test.each([
  { count: 0, label: "0 credentials configured" },
  { count: 1, label: "1 credential configured" },
  { count: 2, label: "2 credentials configured" },
])(
  "Shows the configured credential count independently of hosts for $count credentials",
  async ({ count, label }) => {
    const credentials = Array.from({ length: count }, (_, index) => {
      return {
        ...credential,
        id: `d0000000-0000-4000-8000-00000000000${index}`,
        name: `Login ${index}`,
        hosts: [],
      };
    });
    context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
      return respond(200, { connections: [] });
    });
    context.mocks.api(sshCredentialsContract.list, ({ respond }) => {
      return respond(200, { credentials });
    });
    await page();
    await screen.findByText("0 hosts configured");
    click(getAction("radio", "Credentials"));
    await expect(screen.findByText(label)).resolves.toBeVisible();
    expect(getAction("button", "Add credential")).toBeEnabled();
    expect(screen.queryByText("0 hosts configured")).toBeNull();
  },
);

test("Allows adding a host when more than 64 hosts are configured", async () => {
  let hosts = Array.from({ length: 65 }, (_, index) => {
    return {
      ...base,
      id: `b0000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
      displayName: `Host ${index}`,
      host: `host-${index}.example.com`,
    };
  });
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: hosts });
  });
  context.mocks.api(sshConnectionsContract.create, ({ body, respond }) => {
    const connection = {
      ...base,
      id: "b0000000-0000-4000-8000-000000000066",
      displayName: body.displayName,
      host: body.host,
      port: body.port,
      username:
        "create" in body.credential
          ? body.credential.create.username
          : base.username,
    };
    hosts = [...hosts, connection];
    return respond(201, connection);
  });
  await page();
  await screen.findByText("65 hosts configured");
  click(getAction("button", "Add host"));
  const dialog = await screen.findByRole("dialog");
  await fill(within(dialog).getByLabelText("Display name"), "Additional host");
  const port = within(dialog).getByLabelText("Port");
  await fill(port, "0");
  expect(port).toBeInvalid();
  await fill(port, "65536");
  expect(port).toBeInvalid();
  await fill(port, "22");
  expect(port).toBeValid();
  await fill(
    within(dialog).getByLabelText("Public hostname or IP address"),
    "additional.example.com",
  );
  await fill(
    within(dialog).getByLabelText("Credential name"),
    "Deployment login",
  );
  await fill(within(dialog).getByLabelText("SSH username"), "deploy");
  await fill(within(dialog).getByLabelText("Private key"), "test-key");
  click(getAction("button", "Save", dialog));
  await screen.findByText("66 hosts configured");
  expect(screen.getByText("Additional host")).toBeInTheDocument();
});

test.each(["paste", "file"])(
  "Create with %s credentials, then edit without replacing them",
  async (source) => {
    let hosts: SshConnectionResponse[] = [];
    const requests: unknown[] = [];
    context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
      return respond(200, { connections: hosts });
    });
    context.mocks.api(sshConnectionsContract.create, ({ body, respond }) => {
      requests.push(body);
      hosts = [base];
      return respond(201, base);
    });
    context.mocks.api(sshConnectionsContract.update, ({ body, respond }) => {
      requests.push(body);
      hosts = [{ ...base, displayName: "Renamed", generation: 2 }];
      return respond(200, hosts[0]!);
    });
    await page();
    await screen.findByText(
      "No SSH hosts configured. Add a host to make it available to Agents with SSH access.",
    );
    click(getAction("button", "Add host"));
    const dialog = await screen.findByRole("dialog");
    await fill(within(dialog).getByLabelText("Display name"), "Deployment");
    await fill(
      within(dialog).getByLabelText("Public hostname or IP address"),
      "ssh.example.com",
    );
    await fill(
      within(dialog).getByLabelText("Credential name"),
      "Deployment login",
    );
    await fill(within(dialog).getByLabelText("SSH username"), "deploy");
    if (source === "file") {
      await userEvent.upload(
        within(dialog).getByLabelText("Choose private key file"),
        new File([" key-canary\n"], "id_ed25519"),
      );
    } else {
      await fill(within(dialog).getByLabelText("Private key"), " key-canary\n");
    }
    await waitFor(() => {
      expect(within(dialog).getByLabelText("Private key")).toHaveValue(
        " key-canary\n",
      );
    });
    await fill(
      within(dialog).getByLabelText("Passphrase (optional)"),
      " passphrase-canary ",
    );
    click(getAction("button", "Save", dialog));
    await screen.findByText("deploy@ssh.example.com:22");
    expect(requests).toStrictEqual([
      {
        displayName: "Deployment",
        host: "ssh.example.com",
        port: 22,
        credential: {
          create: {
            name: "Deployment login",
            username: "deploy",
            authentication: {
              method: "private_key",
              privateKey: " key-canary\n",
              passphrase: " passphrase-canary ",
            },
          },
        },
      },
    ]);
    expect(document.body.textContent).not.toContain("canary");
    click(getAction("button", "Edit host"));
    const edit = await screen.findByRole("dialog");
    expect(
      within(edit).queryByLabelText("Private key"),
    ).not.toBeInTheDocument();
    await fill(within(edit).getByLabelText("Display name"), "Renamed");
    click(getAction("button", "Save", edit));
    await screen.findByText("Renamed");
    expect(requests[1]).toStrictEqual({
      displayName: "Renamed",
      host: "ssh.example.com",
      port: 22,
      credential: { id: credential.id },
      expectedGeneration: 1,
    });
  },
);

test.each(["empty", "oversized", "unreadable"])(
  "A %s key file shows a recoverable error without submitting credentials",
  async (kind) => {
    context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
      return respond(200, { connections: [] });
    });
    const file = new File(
      [
        kind === "empty"
          ? ""
          : kind === "oversized"
            ? "x".repeat(65_537)
            : "file-canary",
      ],
      "id_rsa",
    );
    if (kind === "unreadable") {
      vi.spyOn(file, "text").mockRejectedValue(
        new DOMException("file-read-canary", "NotReadableError"),
      );
    }
    await page();
    await screen.findByText("0 hosts configured");
    click(getAction("button", "Add host"));
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByLabelText("Choose private key file");
    const key = within(dialog).getByLabelText("Private key");
    await fill(key, "previous-key");
    await userEvent.upload(input, file);
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent(
      kind === "unreadable"
        ? "Could not read this file. Choose it again or paste the private key."
        : "Choose a non-empty private key file no larger than 64 KiB.",
    );
    expect(key).toHaveValue("");
    expect(key).toBeInvalid();
    expect(document.body.textContent).not.toContain("canary");
    await fill(key, "pasted-key");
    await waitFor(() => {
      expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    });
    expect(key).toHaveValue("pasted-key");
    const replacement = new File(["  replacement-key\n"], "key.pem");
    await userEvent.upload(input, replacement);
    await waitFor(() => {
      expect(key).toHaveValue("  replacement-key\n");
    });
    await fill(key, "edited-key");
    await userEvent.upload(input, replacement);
    await waitFor(() => {
      expect(key).toHaveValue("  replacement-key\n");
    });
  },
);

test.each(["another file", "manual input", "close"])(
  "A pending file read cannot overwrite %s",
  async (action) => {
    context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
      return respond(200, { connections: [] });
    });
    const pending = context.mocks.deferred<string>();
    const file = new File(["delayed-key"], "id_ed25519");
    vi.spyOn(file, "text").mockReturnValue(pending.promise);
    await page();
    await screen.findByText("0 hosts configured");
    click(getAction("button", "Add host"));
    let dialog = await screen.findByRole("dialog");
    const originalKey = within(dialog).getByLabelText("Private key");
    await userEvent.upload(
      within(dialog).getByLabelText("Choose private key file"),
      file,
    );
    await within(dialog).findByText("Reading private key file…");
    expect(getAction("button", "Save", dialog)).toBeDisabled();
    if (action === "close") {
      click(getAction("button", "Cancel", dialog));
    }
    await waitFor(() => {
      expect(screen.queryByRole("dialog") !== null).toBe(action !== "close");
    });
    expect(originalKey).toHaveValue("");
    if (action === "close") {
      click(getAction("button", "Add host"));
      dialog = await screen.findByRole("dialog");
    }
    expect(within(dialog).getByLabelText("Private key")).toHaveValue("");
    if (action === "another file") {
      await userEvent.upload(
        within(dialog).getByLabelText("Choose private key file"),
        new File(["current-key"], "id_rsa"),
      );
    } else {
      await fill(within(dialog).getByLabelText("Private key"), "current-key");
    }
    await waitFor(() => {
      expect(within(dialog).getByLabelText("Private key")).toHaveValue(
        "current-key",
      );
      expect(getAction("button", "Save", dialog)).toBeEnabled();
    });
    pending.resolve("obsolete-key");
    await pending.promise;
    expect(within(dialog).getByLabelText("Private key")).toHaveValue(
      "current-key",
    );
  },
);

test.each(["Display name", "Public hostname or IP address", "SSH username"])(
  "Whitespace-only %s is rejected visibly before submission and can be corrected",
  async (label) => {
    let hosts: SshConnectionResponse[] = [];
    context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
      return respond(200, { connections: hosts });
    });
    context.mocks.api(sshConnectionsContract.create, ({ respond }) => {
      hosts = [base];
      return respond(201, base);
    });
    await page();
    click(
      await waitFor(() => {
        return getAction("button", "Add host");
      }),
    );
    const dialog = await screen.findByRole("dialog");
    await fill(within(dialog).getByLabelText("Display name"), "Deployment");
    await fill(
      within(dialog).getByLabelText("Public hostname or IP address"),
      "ssh.example.com",
    );
    await fill(
      within(dialog).getByLabelText("Credential name"),
      "Deployment login",
    );
    await fill(within(dialog).getByLabelText("SSH username"), "deploy");
    await fill(within(dialog).getByLabelText("Private key"), "test-key");
    const field = within(dialog).getByLabelText(label);
    await fill(field, "   ");
    click(getAction("button", "Save", dialog));
    expect(field).toBeInvalid();
    expect(dialog).toBeInTheDocument();
    await fill(field, "valid");
    click(getAction("button", "Save", dialog));
    await screen.findByText("deploy@ssh.example.com:22");
  },
);

test("Credential replacement retains input during saving and clears secrets on close", async () => {
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [base] });
  });
  const ready = context.mocks.deferred<void>();
  const requests: unknown[] = [];
  context.mocks.api(
    sshCredentialsContract.update,
    async ({ body, respond }) => {
      requests.push(body);
      await ready.promise;
      return respond(200, { ...credential, revision: 2 });
    },
  );
  await page();
  click(getAction("radio", "Credentials"));
  click(
    await waitFor(() => {
      return getAction("button", "Edit credential");
    }),
  );
  await userEvent.click(
    within(await screen.findByRole("dialog")).getByRole("checkbox", {
      name: "Replace authentication",
    }),
  );
  let dialog = await screen.findByRole("dialog");
  await fill(within(dialog).getByLabelText("Private key"), "close-canary");
  click(getAction("button", "Cancel", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  click(getAction("button", "Edit credential"));
  dialog = await screen.findByRole("dialog");
  await userEvent.click(
    within(dialog).getByRole("checkbox", { name: "Replace authentication" }),
  );
  expect(within(dialog).getByLabelText("Private key")).toHaveValue("");
  await userEvent.upload(
    within(dialog).getByLabelText("Choose private key file"),
    new File([" new-key\n"], "encrypted-key.pem"),
  );
  await waitFor(() => {
    expect(within(dialog).getByLabelText("Private key")).toHaveValue(
      " new-key\n",
    );
  });
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    expect(getAction("button", "Saving...", dialog)).toBeDisabled();
  });
  expect(within(dialog).getByLabelText("Private key")).toHaveValue(
    " new-key\n",
  );
  expect(within(dialog).getByLabelText("Private key")).toBeDisabled();
  expect(
    within(dialog).getByRole("checkbox", { name: "Replace authentication" }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(getAction("button", "Choose file", dialog)).toBeDisabled();
  ready.resolve();
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(requests).toStrictEqual([
    {
      expectedRevision: 1,
      name: credential.name,
      username: credential.username,
      authentication: {
        method: "private_key",
        privateKey: " new-key\n",
        passphrase: null,
      },
    },
  ]);
  click(getAction("button", "Edit credential"));
  const reopened = await screen.findByRole("dialog");
  await userEvent.click(
    within(reopened).getByRole("checkbox", { name: "Replace authentication" }),
  );
  expect(within(reopened).getByLabelText("Private key")).toHaveValue("");
});

test("Reset requires confirmation, generation conflict refreshes without retry, and deletion is explicit", async () => {
  const learned = {
    ...base,
    learnedHostKey: { algorithm: "ssh-ed25519", fingerprint: "SHA256:fixture" },
  };
  let hosts = [learned];
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: hosts });
  });
  context.mocks.api(
    sshConnectionsContract.resetHostKey,
    ({ body, respond }) => {
      expect(body).toStrictEqual({ expectedGeneration: 1 });
      hosts = [{ ...learned, generation: 2 }];
      return respond(409, {
        error: { code: "SSH_GENERATION_CONFLICT", message: "changed" },
      });
    },
  );
  context.mocks.api(sshConnectionsContract.delete, ({ respond }) => {
    hosts = [];
    return respond(204);
  });
  await page();
  await screen.findByText("SHA256:fixture");
  click(getAction("button", "Reset host key"));
  const reset = await screen.findByRole("dialog");
  expect(screen.getByText("SHA256:fixture")).toBeInTheDocument();
  expect(
    within(reset).getByText(/Only reset after independently verifying/),
  ).toBeInTheDocument();
  expect(reset).toHaveAccessibleDescription(
    "Only reset after independently verifying the new server identity. The next connection will trust and learn a new host key.",
  );
  click(getAction("button", "Reset host key", reset));
  await screen.findByRole("alert");
  expect(screen.getByText("SHA256:fixture")).toBeInTheDocument();
  click(getAction("button", "Delete host"));
  const remove = await screen.findByRole("dialog");
  expect(screen.getByText("deploy@ssh.example.com:22")).toBeInTheDocument();
  click(getAction("button", "Delete host", remove));
  await screen.findByText(
    "No SSH hosts configured. Add a host to make it available to Agents with SSH access.",
  );
});

test("Disabled SSH shows unavailability without management controls", async () => {
  await page("/connectors/ssh", false);
  await screen.findByText("SSH access is not available for this account.");
  expect(queryAction("button", "Add host")).not.toBeInTheDocument();
});

test("An ordinary owner can manage SSH when the feature flag is enabled", async () => {
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [base] });
  });
  await setupPage({
    context,
    path: "/connectors/ssh",
    featureSwitches: { [FeatureSwitchKey.SshAccess]: true },
  });
  await screen.findByText("deploy@ssh.example.com:22");
  expect(getAction("button", "Add host")).toBeEnabled();
});

test("Changing owner closes the credential form and clears its fields", async () => {
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [base] });
  });
  await page();
  click(
    await waitFor(() => {
      return getAction("button", "Edit host");
    }),
  );
  const editDialog = await screen.findByRole("dialog");
  await userEvent.click(within(editDialog).getByRole("combobox"));
  await userEvent.click(
    await screen.findByRole("option", { name: "Create new credential" }),
  );
  const dialog = await screen.findByRole("dialog");
  await fill(within(dialog).getByLabelText("Private key"), "old-owner-canary");
  const clerk = context.mocks.clerk();
  clerk.user(
    { id: "other-owner", fullName: "Other Owner" },
    { token: "other-token" },
  );
  clerk.stateChanged();
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(
    screen.queryByDisplayValue("old-owner-canary"),
  ).not.toBeInTheDocument();
});

test("A visible shared Agent offers the current user's SSH authorization", async () => {
  const agent: AgentResponse = {
    isDefaultAgent: false,
    agentId,
    ownerId: "another-owner",
    displayName: "Shared Agent",
    description: null,
    sound: null,
    avatarUrl: null,
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
    visibility: "public",
  };
  context.mocks.data.agents([agent]);
  context.mocks.api(agentsByIdContract.get, ({ respond }) => {
    return respond(200, agent);
  });
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 1 });
  });
  let enabled = true;
  context.mocks.api(agentSshAccessContract.get, ({ respond }) => {
    return respond(200, { enabled });
  });
  context.mocks.api(agentSshAccessContract.update, ({ body, respond }) => {
    enabled = body.enabled;
    return respond(200, { enabled });
  });
  await page(`/agents/${agentId}?tab=authorization`);
  const control = await screen.findByRole("switch", {
    name: "Revoke SSH access",
  });
  expect(control).toBeChecked();
  click(control);
  await screen.findByRole("switch", { name: "Grant SSH access" });
  expect(
    screen.getByRole("switch", { name: "Grant SSH access" }),
  ).not.toBeChecked();
});

test("Changing users hides the previous user's SSH grant while the new grant loads", async () => {
  const agent: AgentResponse = {
    isDefaultAgent: false,
    agentId,
    ownerId: "shared-agent-owner",
    displayName: "Shared Agent",
    description: null,
    sound: null,
    avatarUrl: null,
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
    visibility: "public",
  };
  context.mocks.data.agents([agent]);
  context.mocks.api(agentsByIdContract.get, ({ respond }) => {
    return respond(200, agent);
  });
  const nextOwner = context.mocks.deferred<void>();
  let changing = false;
  context.mocks.api(sshConnectionsContract.summary, async ({ respond }) => {
    if (changing) {
      await nextOwner.promise;
    }
    return respond(200, { configuredCount: 1 });
  });
  context.mocks.api(agentSshAccessContract.get, ({ respond }) => {
    return respond(200, { enabled: !changing });
  });
  await page(`/agents/${agentId}?tab=authorization`);
  await screen.findByRole("switch", { name: "Revoke SSH access" });
  const clerk = context.mocks.clerk();
  changing = true;
  act(() => {
    clerk.user(
      { id: "other-owner", fullName: "Other Owner" },
      { token: "other-token" },
    );
    clerk.stateChanged();
  });
  await waitFor(() => {
    expect(screen.queryByRole("switch", { name: /SSH access/ })).toBeNull();
  });
  nextOwner.resolve();
  const control = await screen.findByRole("switch", {
    name: "Grant SSH access",
  });
  expect(control).not.toBeChecked();
});

test("A last-host deletion notification hides Authorization without clearing its retained grant", async () => {
  const agent: AgentResponse = {
    isDefaultAgent: false,
    agentId,
    ownerId: auth.user.id,
    displayName: "SSH Research",
    description: null,
    sound: null,
    avatarUrl: null,
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
    visibility: "public",
  };
  context.mocks.data.agents([agent]);
  context.mocks.api(agentsByIdContract.get, ({ respond }) => {
    return respond(200, agent);
  });
  let exists = true;
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: exists ? 1 : 0 });
  });
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: exists ? [base] : [] });
  });
  context.mocks.api(sshConnectionsContract.delete, ({ respond }) => {
    exists = false;
    return respond(204);
  });
  context.mocks.api(agentSshAccessContract.get, ({ respond }) => {
    return respond(200, { enabled: true });
  });
  await page(`/agents/${agentId}?tab=authorization`);
  await screen.findByRole("switch", { name: "Revoke SSH access" });
  exists = false;
  context.mocks.ably.trigger("ssh:changed", { orgId });
  await screen.findByText(/No connected services yet/);
  expect(
    screen.queryByRole("switch", { name: /SSH access/ }),
  ).not.toBeInTheDocument();
});

test("Owner Authorization offers SSH access while Profile has no SSH controls", async () => {
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 1 });
  });
  const agent: AgentResponse = {
    isDefaultAgent: false,
    agentId,
    ownerId: auth.user.id,
    displayName: "Research",
    description: null,
    sound: null,
    avatarUrl: null,
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
    visibility: "private",
  };
  context.mocks.data.agents([agent]);
  context.mocks.api(agentsByIdContract.get, ({ respond }) => {
    return respond(200, agent);
  });
  let enabled = false;
  context.mocks.api(agentSshAccessContract.get, ({ params, respond }) => {
    expect(params.agentId).toBe(agentId);
    return respond(200, { enabled });
  });
  context.mocks.api(
    agentSshAccessContract.update,
    ({ body, params, respond }) => {
      expect(params.agentId).toBe(agentId);
      enabled = body.enabled;
      return respond(200, body);
    },
  );
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [] });
  });
  await page(`/agents/${agentId}?tab=profile`);
  await screen.findByDisplayValue("Research");
  expect(
    screen.queryByRole("switch", { name: /SSH access/ }),
  ).not.toBeInTheDocument();
  click(getAction("button", "Authorization"));
  const control = await screen.findByRole("switch", {
    name: "Grant SSH access",
  });
  expect(control).not.toBeChecked();
  expect(
    screen.getByText(
      "Allow this Agent to execute commands on all your current and future configured SSH hosts. This is separate from connector permissions.",
    ),
  ).toBeInTheDocument();
  expect(
    screen.queryByText(/No connected services yet/),
  ).not.toBeInTheDocument();
  click(control);
  await waitFor(() => {
    return expect(
      screen.getByRole("switch", { name: "Revoke SSH access" }),
    ).toBeChecked();
  });
  click(screen.getByRole("switch", { name: "Revoke SSH access" }));
  await waitFor(() => {
    return expect(
      screen.getByRole("switch", { name: "Grant SSH access" }),
    ).not.toBeChecked();
  });
});

test.each([false, true])(
  "SSH uses connector authorization search and survives ordinary permission failure (%s)",
  async (ordinaryFailure) => {
    context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
      return respond(200, { configuredCount: 1 });
    });
    const agent: AgentResponse = {
      isDefaultAgent: false,
      agentId,
      ownerId: auth.user.id,
      displayName: "Research",
      description: null,
      sound: null,
      avatarUrl: null,
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
      visibility: "private",
    };
    context.mocks.data.agents([agent]);
    context.mocks.api(agentsByIdContract.get, ({ respond }) => {
      return respond(200, agent);
    });
    context.mocks.api(agentSshAccessContract.get, ({ respond }) => {
      return respond(200, { enabled: true });
    });
    const github = catalogConnectorFixture(
      connectorSlugSchema.parse("github"),
      "GitHub",
      { hasPermissions: false },
    );
    context.mocks.api(connectorCatalogContract.status, ({ respond }) => {
      return respond(200, { connectors: [github] });
    });
    context.mocks.api(userPermissionGrantsContract.list, ({ respond }) => {
      return ordinaryFailure
        ? respond(403, {
            error: {
              message: "Permission grants unavailable",
              code: "FORBIDDEN",
            },
          })
        : respond(200, []);
    });
    await page(`/agents/${agentId}?tab=authorization`);
    await screen.findByRole("switch", { name: "Revoke SSH access" });
    if (!ordinaryFailure) {
      await screen.findByRole("switch", { name: "Grant GitHub access" });
    } else {
      await screen.findByText("Failed to load permission grants");
    }
    click(getAction("button", "Find connectors"));
    const search = screen.getByPlaceholderText("Find connectors...");
    await fill(search, "ssh");
    expect(
      screen.getByRole("switch", { name: "Revoke SSH access" }),
    ).toBeChecked();
    expect(
      screen.queryByRole("switch", { name: /GitHub access/ }),
    ).not.toBeInTheDocument();
    await fill(search, "github");
    expect(
      screen.queryByRole("switch", { name: /SSH access/ }),
    ).not.toBeInTheDocument();
    await fill(search, "");
    expect(
      screen.getByRole("switch", { name: "Revoke SSH access" }),
    ).toBeChecked();
  },
);
