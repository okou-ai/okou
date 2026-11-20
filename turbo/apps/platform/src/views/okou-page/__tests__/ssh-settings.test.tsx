import { SSH_ERROR_CODES } from "@okouai/api-contracts/contracts/ssh-errors";
import {
  sshConnectionsContract,
  type SshConnectionResponse,
} from "@okouai/api-contracts/contracts/ssh-connections";
import {
  sshCredentialsContract,
  type CreateSshCredentialRequest,
  type SshCredentialResponse,
  type UpdateSshCredentialRequest,
} from "@okouai/api-contracts/contracts/ssh-credentials";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getConnectorAction,
  queryConnectorAction,
} from "./connector-page-test-helpers.ts";
import {
  mockRemoteInventory,
  REMOTE_TIMESTAMP,
  remoteId,
  sshHost,
} from "./connectors-remote-control-test-helpers.ts";

const context = testContext();
const CREDENTIALS_PATH =
  "/connectors?scope=remote-control&remoteView=credentials";
const PRIVATE_DETAIL = "vault shard 10.4.2.7 rejected tenant payload";
const PRIVATE_KEY = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "b3BlbnNzaC1rZXktdjEAAAAA",
  "-----END OPENSSH PRIVATE KEY-----",
].join("\n");

function credential(
  index: number,
  name: string,
  overrides: Partial<SshCredentialResponse> = {},
): SshCredentialResponse {
  return {
    id: remoteId("d", index),
    name,
    username: "deploy",
    authMethod: "private_key",
    revision: 1,
    createdAt: REMOTE_TIMESTAMP,
    updatedAt: REMOTE_TIMESTAMP,
    hosts: [],
    ...overrides,
  };
}

function hostPath(connection: SshConnectionResponse): string {
  return `/connectors?scope=remote-control&remoteResource=ssh:${connection.id}`;
}

function radio(name: string, container: ParentNode): HTMLElement {
  const found = queryAllByRoleFast("radio", container).find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!found) {
    throw new Error(`Expected radio named "${name}"`);
  }
  return found;
}

function credentialCard(name: string): HTMLElement {
  const card = screen
    .getByRole("heading", { name, level: 2 })
    .closest("article");
  if (!card) {
    throw new Error(`Expected the credential card for "${name}"`);
  }
  return card;
}

async function openCredentials(): Promise<void> {
  await setupPage({ context, path: CREDENTIALS_PATH });
  await waitFor(() => {
    expect(getConnectorAction("button", "Add credential")).toBeEnabled();
  });
}

async function openNewCredential(): Promise<HTMLElement> {
  click(getConnectorAction("button", "Add credential"));
  const dialog = await screen.findByRole("dialog", { name: "Add credential" });
  await fill(within(dialog).getByLabelText("Credential name"), "Build login");
  await fill(within(dialog).getByLabelText("SSH username"), "builder");
  return dialog;
}

function recordCreates(
  respond: (
    body: CreateSshCredentialRequest & { id: string },
  ) => "created" | "invalid",
): (CreateSshCredentialRequest & { id: string })[] {
  const creates: (CreateSshCredentialRequest & { id: string })[] = [];
  context.mocks.api(
    sshCredentialsContract.create,
    ({ body, respond: send }) => {
      creates.push(body);
      if (respond(body) === "invalid") {
        return send(400, {
          error: {
            code: SSH_ERROR_CODES.INVALID_INPUT,
            message: PRIVATE_DETAIL,
          },
        });
      }
      return send(
        201,
        credential(9, body.name, {
          id: body.id,
          username: body.username,
          authMethod: body.authentication.method,
        }),
      );
    },
  );
  return creates;
}

/** A file whose bytes arrive only when the test releases them. */
function slowKeyFile(release: Promise<void>): File {
  const file = new File([PRIVATE_KEY], "id_ed25519");
  Object.defineProperty(file, "text", {
    value: async () => {
      await release;
      return PRIVATE_KEY;
    },
  });
  return file;
}

test("Password credentials preserve whitespace, clear mode-switched secrets, and discard late key reads", async () => {
  const inventory = mockRemoteInventory(context);
  const creates = recordCreates((body) => {
    inventory.sshCredentials = [
      credential(9, body.name, { authMethod: body.authentication.method }),
    ];
    return "created";
  });
  const user = userEvent.setup({ delay: null });
  await openCredentials();
  const dialog = await openNewCredential();

  await fill(within(dialog).getByLabelText("Private key"), PRIVATE_KEY);
  const lateRead = context.mocks.deferred<void>();
  await user.upload(
    within(dialog).getByLabelText("Choose private key file"),
    slowKeyFile(lateRead.promise),
  );
  await expect(
    within(dialog).findByText("Reading private key file…"),
  ).resolves.toBeInTheDocument();

  click(radio("Password", dialog));
  await fill(within(dialog).getByLabelText("Password"), "discarded secret");
  click(radio("Private key", dialog));
  const keyField = await within(dialog).findByLabelText("Private key");
  expect(keyField).toHaveValue("");
  lateRead.resolve();
  await waitFor(() => {
    expect(
      within(dialog).queryByText("Reading private key file…"),
    ).not.toBeInTheDocument();
  });
  expect(keyField).toHaveValue("");

  click(radio("Password", dialog));
  const password = await within(dialog).findByLabelText("Password");
  expect(password).toHaveValue("");
  await fill(password, "  open sesame  ");
  click(getConnectorAction("button", "Save", dialog));

  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Add credential" }),
    ).not.toBeInTheDocument();
  });
  expect(creates).toStrictEqual([
    {
      id: expect.any(String),
      name: "Build login",
      username: "builder",
      authentication: { method: "password", password: "  open sesame  " },
    },
  ]);
  await expect(
    screen.findByRole("heading", { name: "Build login", level: 2 }),
  ).resolves.toBeInTheDocument();
  expect(document.body).not.toHaveTextContent("open sesame");
  expect(document.body).not.toHaveTextContent("discarded secret");
});

test("A known credential rejection leaves the retained input editable", async () => {
  mockRemoteInventory(context);
  recordCreates(() => {
    return "invalid";
  });
  await openCredentials();
  const dialog = await openNewCredential();
  click(radio("Password", dialog));
  const password = await within(dialog).findByLabelText("Password");
  await fill(password, "s3cret password");

  click(getConnectorAction("button", "Save", dialog));

  await expect(within(dialog).findByRole("alert")).resolves.toHaveTextContent(
    "Some SSH settings are invalid. Check the fields and try again.",
  );
  expect(password).toHaveValue("s3cret password");
  expect(password).toBeEnabled();
  expect(document.body).not.toHaveTextContent(PRIVATE_DETAIL);
});

test("A concurrent shared-credential edit preserves its draft and blocks stale saving", async () => {
  const shared = credential(1, "Deployment login", {
    hosts: [
      { id: remoteId("b", 1), displayName: "Web" },
      { id: remoteId("b", 2), displayName: "Worker" },
    ],
  });
  const inventory = mockRemoteInventory(context, {
    sshCredentials: [shared],
    ssh: [sshHost(1, "Web"), sshHost(2, "Worker")],
  });
  const updates: UpdateSshCredentialRequest[] = [];
  context.mocks.api(sshCredentialsContract.update, ({ body, respond }) => {
    updates.push(body);
    // Another editor renamed the credential first and the server announced it.
    inventory.sshCredentials = [
      { ...shared, name: "Release login", revision: 2 },
    ];
    context.mocks.ably.trigger("ssh:changed", { orgId: "org_default" });
    return respond(409, {
      error: {
        code: SSH_ERROR_CODES.CREDENTIAL_REVISION_CONFLICT,
        message: PRIVATE_DETAIL,
      },
    });
  });
  await openCredentials();
  click(
    getConnectorAction(
      "button",
      "Edit credential",
      credentialCard("Deployment login"),
    ),
  );
  const dialog = await screen.findByRole("dialog", { name: "Edit credential" });
  const username = within(dialog).getByLabelText("SSH username");
  await fill(username, "release");

  click(getConnectorAction("button", "Save", dialog));

  await expect(within(dialog).findByRole("alert")).resolves.toHaveTextContent(
    "This credential changed while you were editing. Your changes were not saved; your draft is preserved.",
  );
  // The modal dialog hides the refreshed card list from the accessibility tree.
  await expect(screen.findByText("Release login")).resolves.toBeInTheDocument();
  expect(dialog).toBeInTheDocument();
  expect(username).toHaveValue("release");
  expect(getConnectorAction("button", "Save", dialog)).toBeDisabled();
  expect(document.body).not.toHaveTextContent(PRIVATE_DETAIL);
  expect(updates).toStrictEqual([{ expectedRevision: 1, username: "release" }]);
});

test("An unused credential can be deleted with confirmation and the rendered revision", async () => {
  const unused = credential(1, "Old login");
  const inventory = mockRemoteInventory(context, { sshCredentials: [unused] });
  const deletes: { credentialId: string; expectedRevision: number }[] = [];
  context.mocks.api(
    sshCredentialsContract.delete,
    ({ params, body, respond }) => {
      deletes.push({
        credentialId: params.credentialId,
        expectedRevision: body.expectedRevision,
      });
      inventory.sshCredentials = [];
      return respond(204);
    },
  );
  await openCredentials();
  click(
    getConnectorAction(
      "button",
      "Delete credential",
      credentialCard("Old login"),
    ),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Delete credential",
  });
  expect(dialog).toHaveAccessibleDescription(
    "Delete this unused credential? Its stored secret cannot be recovered.",
  );

  click(getConnectorAction("button", "Delete credential", dialog));

  await expect(
    screen.findByText("0 credentials configured"),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByText(
      "No SSH credentials yet. Add a private key or password to reuse across hosts.",
    ),
  ).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(queryConnectorAction("button", "Delete credential")).toBeNull();
  expect(deletes).toStrictEqual([
    { credentialId: unused.id, expectedRevision: 1 },
  ]);
});

test("Shows configured credentials independently of hosts", async () => {
  mockRemoteInventory(context, {
    sshCredentials: [
      credential(1, "Deployment login"),
      credential(2, "Backup login", { authMethod: "password" }),
    ],
  });

  await openCredentials();

  await expect(
    screen.findByText("2 credentials configured"),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "Deployment login", level: 2 }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "Backup login", level: 2 }),
  ).toBeInTheDocument();
  expect(getConnectorAction("button", "Add credential")).toBeEnabled();
});

test("An oversized key file shows a recoverable error without submitting credentials", async () => {
  mockRemoteInventory(context);
  const user = userEvent.setup({ delay: null });
  await openCredentials();
  const dialog = await openNewCredential();
  const keyField = within(dialog).getByLabelText("Private key");
  await fill(keyField, PRIVATE_KEY);

  await user.upload(
    within(dialog).getByLabelText("Choose private key file"),
    new File(["k".repeat(65_537)], "huge_key"),
  );

  await expect(within(dialog).findByRole("alert")).resolves.toHaveTextContent(
    "Choose a non-empty private key file no larger than 64 KiB.",
  );
  expect(keyField).toHaveValue("");
  expect(keyField).toBeInvalid();

  const replacement = PRIVATE_KEY.replace("AAAAA", "BBBBB");
  await user.click(keyField);
  await user.paste(replacement);

  await waitFor(() => {
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
  });
  expect(keyField).toHaveValue(replacement);
  expect(dialog).toBeInTheDocument();
});

test.each([
  {
    label: "tailscale",
    retained: sshHost(1, "Retained host", {
      generation: 3,
      learnedHostKey: {
        algorithm: "ssh-ed25519",
        fingerprint: "SHA256:retained",
      },
      transport: { type: "tailscale", needsRebind: true },
    }),
    guidance:
      "This host needs a new Tailscale network. Edit it to select or create one.",
  },
  {
    label: "cloudflare_access",
    retained: sshHost(1, "Retained host", {
      generation: 3,
      learnedHostKey: {
        algorithm: "ssh-ed25519",
        fingerprint: "SHA256:retained",
      },
      transport: { type: "cloudflare_access", needsRebind: true },
    }),
    guidance:
      "This host needs a new Cloudflare Access configuration. Edit it to rebind or choose Direct. It will not connect until you do.",
  },
])(
  "A retained $label host explains its actual recovery availability",
  async ({ retained, guidance }) => {
    mockRemoteInventory(context, { ssh: [retained] });

    await setupPage({ context, path: hostPath(retained) });

    await expect(screen.findByText(guidance)).resolves.toHaveAttribute(
      "role",
      "alert",
    );
    const identity = screen.getByText("Server identity and chat permissions");
    const fingerprint = screen.getByText("SHA256:retained");
    expect(fingerprint).not.toBeVisible();
    click(identity);
    expect(fingerprint).toBeVisible();
    expect(getConnectorAction("button", "Edit connection")).toBeEnabled();
    expect(getConnectorAction("button", "Reset host key")).toBeEnabled();
    expect(getConnectorAction("button", "Delete connection")).toBeEnabled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  },
);

test.each([
  { label: "Direct", cloudflare: false },
  { label: "Cloudflare Access", cloudflare: true },
])(
  "$label reset keeps its trust warning and uses the original generation",
  async ({ cloudflare }) => {
    const configId = remoteId("c", 1);
    const learned = sshHost(1, "Build host", {
      learnedHostKey: { algorithm: "ssh-ed25519", fingerprint: "SHA256:old" },
      ...(cloudflare
        ? { transport: { type: "cloudflare_access" as const, configId } }
        : {}),
    });
    const inventory = mockRemoteInventory(context, {
      ssh: [learned],
      cloudflare: cloudflare
        ? [
            {
              id: configId,
              name: "Office gateway",
              scope: "personal",
              revision: 1,
              generation: 1,
              createdAt: REMOTE_TIMESTAMP,
              updatedAt: REMOTE_TIMESTAMP,
              sshHosts: [],
              vncHosts: [],
            },
          ]
        : [],
    });
    const resets: number[] = [];
    context.mocks.api(
      sshConnectionsContract.resetHostKey,
      ({ body, respond }) => {
        resets.push(body.expectedGeneration);
        const reset = { ...learned, learnedHostKey: null, generation: 2 };
        inventory.ssh = [reset];
        return respond(200, reset);
      },
    );
    context.mocks.api(sshConnectionsContract.delete, ({ respond }) => {
      inventory.ssh = [];
      return respond(204);
    });

    await setupPage({ context, path: hostPath(learned) });
    await waitFor(() => {
      expect(getConnectorAction("button", "Reset host key")).toBeEnabled();
    });
    expect(screen.getByText("SHA256:old")).toBeInTheDocument();
    click(getConnectorAction("button", "Reset host key"));
    const confirmation = await screen.findByRole("dialog", {
      name: "Reset host key",
    });
    expect(confirmation).toHaveAccessibleDescription(
      "Only reset after independently verifying the new server identity. The next connection will trust and learn a new host key.",
    );

    click(getConnectorAction("button", "Reset host key", confirmation));

    await waitFor(() => {
      expect(screen.queryByText("SHA256:old")).not.toBeInTheDocument();
    });
    expect(resets).toStrictEqual([1]);

    click(getConnectorAction("button", "Delete connection"));
    const deletion = await screen.findByRole("dialog", {
      name: "Delete connection",
    });
    click(getConnectorAction("button", "Delete connection", deletion));

    await expect(
      screen.findByText(
        "This configuration is unavailable or you no longer have access.",
      ),
    ).resolves.toBeInTheDocument();
  },
);
