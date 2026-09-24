import {
  sshCredentialsContract,
  type SshCredentialResponse,
} from "@okouai/api-contracts/contracts/ssh-credentials";
import {
  agentsByIdContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import { agentSshAccessContract } from "@okouai/api-contracts/contracts/ssh-access";
import { userPermissionGrantsContract } from "@okouai/api-contracts/contracts/user-permission-grants";
import { connectorSlugSchema } from "@okouai/api-contracts/contracts/connector-identity";
import {
  sshConnectionsContract,
  type SshConnectionResponse,
} from "@okouai/api-contracts/contracts/ssh-connections";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname } from "../../../signals/location.ts";
import {
  catalogConnectorFixture,
  mockConnectorOverview,
} from "../../team-page/__tests__/team-page-test-helpers.ts";
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

async function selectNewCredential(dialog: HTMLElement) {
  await userEvent.click(await within(dialog).findByLabelText("Credential"));
  await userEvent.click(
    await screen.findByRole("option", { name: "Create new credential" }),
  );
}

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
  const name = within(hostFields).getByLabelText("Display name");
  expect(name).toHaveAttribute("placeholder", "e.g. Production server");
  expect(name).toHaveValue("");
  const host = within(hostFields).getByLabelText(
    "Public hostname or IP address",
  );
  expect(host).toHaveAttribute("placeholder", "e.g. ssh.example.com");
  expect(host).toHaveValue("");
  expect(within(hostFields).getByLabelText("Port")).toHaveValue(22);
  expect(within(hostFields).queryByLabelText("Credential name")).toBeNull();
  await waitFor(() => {
    return expect(
      within(credentialFields).getByRole("combobox"),
    ).toHaveTextContent("Deployment login · deploy");
  });
  expect(
    within(credentialFields).queryByLabelText("Credential name"),
  ).toBeNull();
  expect(within(credentialFields).queryByLabelText("SSH username")).toBeNull();
  expect(within(credentialFields).queryByLabelText("Private key")).toBeNull();
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
      id: expect.any(String),
      displayName: "Second host",
      host: "second.example.com",
      port: 22,
      transport: { type: "direct" },
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
      id: expect.any(String),
      name: "Password login",
      username: "operator",
      authentication: { method: "password", password: "  password-canary  " },
    },
  ]);
  expect(document.body.textContent).not.toContain("canary");
});

test("A known credential rejection leaves the retained input editable", async () => {
  context.mocks.api(sshCredentialsContract.create, ({ respond }) => {
    return respond(400, {
      error: { code: "SSH_INVALID_INPUT", message: "private server detail" },
    });
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
    "Deployment login",
  );
  await fill(within(dialog).getByLabelText("SSH username"), "deploy");
  click(getAction("radio", "Password", dialog));
  const secret = within(dialog).getByLabelText("Password");
  await fill(secret, "owned-secret");
  click(getAction("button", "Save", dialog));
  await within(dialog).findByRole("alert");
  expect(getAction("button", "Save", dialog)).toBeEnabled();
  expect(secret).toBeEnabled();
  expect(secret).toHaveValue("owned-secret");
  expect(queryAction("button", "Retry", dialog)).not.toBeInTheDocument();
  expect(document.body.textContent).not.toContain("private server detail");
});

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
    if (body.expectedRevision === 2) {
      return respond(200, {
        ...current,
        username: body.username ?? current.username,
        revision: 3,
      });
    }
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
  expect(dialog).toBeVisible();
  expect(within(dialog).getByLabelText("SSH username")).toHaveValue("new-user");
  expect(getAction("button", "Save", dialog)).toBeDisabled();
  expect(document.body.textContent).not.toContain("not UI copy");
  expect(requests).toStrictEqual([
    { expectedRevision: 1, username: "new-user" },
  ]);
  click(getAction("button", "Keep my changes with this version", dialog));
  await waitFor(() => {
    return expect(getAction("button", "Save", dialog)).toBeEnabled();
  });
  expect(within(dialog).getByLabelText("SSH username")).toHaveValue("new-user");
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(requests).toStrictEqual([
    { expectedRevision: 1, username: "new-user" },
    { expectedRevision: 2, username: "new-user" },
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
  await selectNewCredential(dialog);
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
async function page(path = "/connectors/ssh") {
  await setupPage({
    context,
    path,
    auth,
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

test("Shows configured credentials independently of hosts", async () => {
  const count = 2;
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
  await expect(
    screen.findByText("2 credentials configured"),
  ).resolves.toBeVisible();
  expect(getAction("button", "Add credential")).toBeEnabled();
  expect(screen.queryByText("0 hosts configured")).toBeNull();
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
    await selectNewCredential(dialog);
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
        id: expect.any(String),
        displayName: "Deployment",
        host: "ssh.example.com",
        port: 22,
        transport: { type: "direct" },
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
      transport: { type: "direct" },
    });
  },
);

test("An oversized key file shows a recoverable error without submitting credentials", async () => {
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [] });
  });
  const file = new File(["x".repeat(65_537)], "id_rsa");
  await page();
  await screen.findByText("0 hosts configured");
  click(getAction("button", "Add host"));
  const dialog = await screen.findByRole("dialog");
  await selectNewCredential(dialog);
  const input = within(dialog).getByLabelText("Choose private key file");
  const key = within(dialog).getByLabelText("Private key");
  await fill(key, "previous-key");
  await userEvent.upload(input, file);
  const alert = await within(dialog).findByRole("alert");
  expect(alert).toHaveTextContent(
    "Choose a non-empty private key file no larger than 64 KiB.",
  );
  expect(key).toHaveValue("");
  expect(key).toBeInvalid();
  await fill(key, "pasted-key");
  await waitFor(() => {
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
  });
  expect(key).toHaveValue("pasted-key");
});

test("Whitespace-only host is rejected visibly before submission and can be corrected", async () => {
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
  await selectNewCredential(dialog);
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
  const field = within(dialog).getByLabelText("Public hostname or IP address");
  await fill(field, "   ");
  click(getAction("button", "Save", dialog));
  expect(field).toBeInvalid();
  expect(dialog).toBeInTheDocument();
  await fill(field, "valid");
  click(getAction("button", "Save", dialog));
  await screen.findByText("deploy@ssh.example.com:22");
});

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
  let hosts: SshConnectionResponse[] = [learned];
  const resetRequests: unknown[] = [];
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: hosts });
  });
  context.mocks.api(
    sshConnectionsContract.resetHostKey,
    ({ body, respond }) => {
      resetRequests.push(body);
      if (body.expectedGeneration === 2) {
        hosts = [{ ...learned, generation: 3, learnedHostKey: null }];
        return respond(200, hosts[0]!);
      }
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
  expect(getAction("button", "Reset host key", reset)).toBeDisabled();
  expect(resetRequests).toStrictEqual([{ expectedGeneration: 1 }]);
  click(
    await waitFor(() => {
      return getAction("button", "Keep my changes with this version", reset);
    }),
  );
  await waitFor(() => {
    return expect(getAction("button", "Reset host key", reset)).toBeEnabled();
  });
  click(getAction("button", "Reset host key", reset));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(screen.queryByText("SHA256:fixture")).toBeNull();
  expect(resetRequests).toStrictEqual([
    { expectedGeneration: 1 },
    { expectedGeneration: 2 },
  ]);
  click(getAction("button", "Delete host"));
  const remove = await screen.findByRole("dialog");
  expect(screen.getByText("deploy@ssh.example.com:22")).toBeInTheDocument();
  click(getAction("button", "Delete host", remove));
  await screen.findByText(
    "No SSH hosts configured. Add a host to make it available to Agents with SSH access.",
  );
});

test("An ordinary owner can manage SSH without feature overrides", async () => {
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [base] });
  });
  await setupPage({
    context,
    path: "/connectors/ssh",
  });
  await screen.findByText("deploy@ssh.example.com:22");
  expect(getAction("button", "Add host")).toBeEnabled();
});

test("Changing owner while an SSH token is pending prevents the old mutation", async () => {
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [] });
  });
  const requests: unknown[] = [];
  context.mocks.api(sshConnectionsContract.create, ({ body, respond }) => {
    requests.push(body);
    return respond(201, base);
  });
  await page();
  await screen.findByText("0 hosts configured");
  click(getAction("button", "Add host"));
  const dialog = await screen.findByRole("dialog");
  await selectNewCredential(dialog);
  await fill(within(dialog).getByLabelText("Display name"), "Old owner host");
  await fill(
    within(dialog).getByLabelText("Public hostname or IP address"),
    "old-owner.example.com",
  );
  await fill(
    within(dialog).getByLabelText("Credential name"),
    "Old owner credential",
  );
  await fill(within(dialog).getByLabelText("SSH username"), "old-owner");
  await fill(within(dialog).getByLabelText("Private key"), "old-owner-key");

  const token = context.mocks.deferred<string>();
  const tokenRequestCount = mockedClerk.sessionGetToken.mock.calls.length;
  mockedClerk.sessionGetToken.mockImplementationOnce(() => {
    return token.promise;
  });
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    expect(mockedClerk.sessionGetToken.mock.calls).toHaveLength(
      tokenRequestCount + 1,
    );
  });

  const clerk = context.mocks.clerk();
  act(() => {
    clerk.user(
      { id: "other-owner", fullName: "Other Owner" },
      { token: "other-token" },
    );
    clerk.stateChanged();
  });
  await act(async () => {
    token.resolve("old-owner-token");
    await token.promise;
  });

  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(requests).toStrictEqual([]);
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

test("SSH uses connector authorization search", async () => {
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
  mockConnectorOverview(context, [github]);
  context.mocks.api(userPermissionGrantsContract.list, ({ respond }) => {
    return respond(200, []);
  });
  await page(`/agents/${agentId}?tab=authorization`);
  await screen.findByRole("switch", { name: "Revoke SSH access" });
  await screen.findByRole("switch", { name: "Grant GitHub access" });
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
});
