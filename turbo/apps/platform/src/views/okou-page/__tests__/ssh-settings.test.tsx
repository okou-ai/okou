import {
  sshCredentialsContract,
  type SshCredentialResponse,
} from "@okouai/api-contracts/contracts/ssh-credentials";
import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import {
  sshConnectionsContract,
  type SshConnectionResponse,
} from "@okouai/api-contracts/contracts/ssh-connections";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
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
  expect(secret).toBeEnabled();
  expect(secret).toHaveValue("owned-secret");
  expect(document.body.textContent).not.toContain("private server detail");
});

test("A concurrent shared-credential edit preserves its draft and blocks stale saving", async () => {
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
    context.mocks.ably.trigger("ssh:changed", { orgId });
    return respond(409, {
      error: {
        code: "SSH_CREDENTIAL_REVISION_CONFLICT",
        message: "not UI copy",
      },
    });
  });
  await page();
  await screen.findByText("Connections using this credential");
  expect(getAction("button", "Delete credential")).toBeDisabled();
  click(getAction("button", "Edit credential"));
  const dialog = await screen.findByRole("dialog");
  expect(
    within(dialog).getByText("Login changes apply to all 2 hosts:"),
  ).toBeVisible();
  expect(within(dialog).getByText("Second host")).toBeVisible();
  expect(within(dialog).queryByLabelText("Private key")).toBeNull();
  await fill(within(dialog).getByLabelText("SSH username"), "new-user");
  click(getAction("button", "Save", dialog));
  await screen.findByText("Edited elsewhere");
  await screen.findByText(/This credential changed/u);
  expect(dialog).toBeVisible();
  expect(within(dialog).getByLabelText("SSH username")).toHaveValue("new-user");
  expect(getAction("button", "Save", dialog)).toBeDisabled();
  expect(document.body.textContent).not.toContain("not UI copy");
  expect(requests).toStrictEqual([
    { expectedRevision: 1, username: "new-user" },
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

async function page(
  path = "/connectors?scope=remote-control&remoteView=credentials&type=ssh",
) {
  await setupPage({ context, path, auth });
}

async function hostPage() {
  await page(`/connectors?scope=remote-control&remoteResource=ssh:${id}`);
  await screen.findByRole("heading", { name: base.displayName });
}

test.each([
  {
    type: "tailscale",
    notice:
      "This host needs a new Tailscale network. Edit it to select or create one.",
  },
  {
    type: "cloudflare_access",
    notice:
      "This host needs a new Cloudflare Access configuration. Edit it to rebind or choose Direct. It will not connect until you do.",
  },
] as const)(
  "A retained $type host explains its actual recovery availability",
  async ({ type, notice }) => {
    context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
      return respond(200, {
        connections: [
          {
            ...base,
            host: type === "tailscale" ? "100.80.10.20" : base.host,
            port: type === "cloudflare_access" ? 443 : base.port,
            learnedHostKey: {
              algorithm: "ssh-ed25519",
              fingerprint: "SHA256:retained",
            },
            transport:
              type === "tailscale"
                ? { type: "tailscale", needsRebind: true }
                : { type: "cloudflare_access", needsRebind: true },
          },
        ],
      });
    });
    context.mocks.api(
      chatRemoteAccessContract.listHostDefaults,
      ({ respond }) => {
        return respond(200, {
          ssh: [
            {
              connectionId: base.id,
              displayName: base.displayName,
              defaultEnabled: false,
            },
          ],
          vnc: [],
        });
      },
    );
    await hostPage();
    const card = await screen.findByRole("article");
    expect(within(card).getByRole("alert").textContent).toBe(notice);
    click(within(card).getByText("Server identity and chat permissions"));
    expect(within(card).getByText("SHA256:retained")).toBeInTheDocument();
    expect(getAction("button", "Edit connection", card)).toBeEnabled();
    expect(getAction("button", "Reset host key", card)).toBeEnabled();
    expect(getAction("button", "Delete connection", card)).toBeEnabled();
    expect(screen.queryByRole("dialog")).toBeNull();
  },
);

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
  await expect(
    screen.findByText("2 credentials configured"),
  ).resolves.toBeVisible();
  expect(getAction("button", "Add credential")).toBeEnabled();
});

test("An oversized key file shows a recoverable error without submitting credentials", async () => {
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [] });
  });
  const file = new File(["x".repeat(65_537)], "id_rsa");
  await page();
  await screen.findByRole("heading", { name: "Deployment login" });
  click(getAction("button", "Add credential"));
  const dialog = await screen.findByRole("dialog");
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

test.each([
  { name: "Direct", connection: base },
  {
    name: "Cloudflare Access",
    connection: {
      ...base,
      port: 443,
      transport: {
        type: "cloudflare_access",
        configId: "e0000000-0000-4000-8000-000000000001",
      },
    },
  },
] satisfies readonly {
  name: string;
  connection: SshConnectionResponse;
}[])(
  "$name reset keeps its trust warning and uses the original generation",
  async ({ connection }) => {
    // A saved identity can survive a carrier change before native Tailscale delivery.
    const learned = {
      ...connection,
      learnedHostKey: {
        algorithm: "ssh-ed25519",
        fingerprint: "SHA256:fixture",
      },
    };
    if (
      "transport" in connection &&
      connection.transport.type === "cloudflare_access"
    ) {
      context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
        return respond(200, {
          configs: [
            {
              id: "e0000000-0000-4000-8000-000000000001",
              name: "Deployment gateway",
              scope: "personal",
              revision: 1,
              generation: 1,
              sshHosts: [{ id: base.id, displayName: base.displayName }],
              vncHosts: [],
              createdAt: base.createdAt,
              updatedAt: base.updatedAt,
            },
          ],
        });
      });
    }
    let hosts: SshConnectionResponse[] = [learned];
    const resetRequests: unknown[] = [];
    context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
      return respond(200, { connections: hosts });
    });
    context.mocks.api(
      sshConnectionsContract.resetHostKey,
      ({ body, respond }) => {
        resetRequests.push(body);
        hosts = [{ ...learned, generation: 2, learnedHostKey: null }];
        return respond(200, hosts[0]!);
      },
    );
    context.mocks.api(sshConnectionsContract.delete, ({ respond }) => {
      hosts = [];
      return respond(204);
    });
    await hostPage();
    click(screen.getByText("Server identity and chat permissions"));
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
    await waitFor(() => {
      return expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(screen.queryByText("SHA256:fixture")).toBeNull();
    expect(resetRequests).toStrictEqual([{ expectedGeneration: 1 }]);
    await screen.findByRole("heading", { name: base.displayName });
    click(getAction("button", "Delete connection"));
    const remove = await screen.findByRole("dialog");
    click(getAction("button", "Delete connection", remove));
    await screen.findByText(
      "This configuration is unavailable or you no longer have access.",
    );
  },
);
