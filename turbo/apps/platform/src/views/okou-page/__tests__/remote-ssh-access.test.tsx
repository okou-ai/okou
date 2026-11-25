import {
  sshAuthorizationContract,
  type SshAuthorization,
} from "@okouai/api-contracts/contracts/ssh-authorization";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
  fill,
} from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createMessageExperienceHelpers } from "./chat-message-experience-test-helpers.ts";
import type { ScopedCloudflareAccessConfig } from "@okouai/api-contracts/contracts/cloudflare-access";
import { SSH_ERROR_CODES } from "@okouai/api-contracts/contracts/ssh-errors";
import {
  sshConnectionsContract,
  type SshConnectionResponse,
  type UpdateSshConnectionRequest,
} from "@okouai/api-contracts/contracts/ssh-connections";
import type { SshCredentialResponse } from "@okouai/api-contracts/contracts/ssh-credentials";
import userEvent from "@testing-library/user-event";
import { getConnectorAction } from "./connector-page-test-helpers.ts";
import {
  mockRemoteInventory,
  REMOTE_TIMESTAMP,
  remoteId,
  sshHost,
  type RemoteInventory,
} from "./connectors-remote-control-test-helpers.ts";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";

const context = testContext();

const { installMessageExperienceChat } =
  createMessageExperienceHelpers(context);
const NOW = "2026-11-20T08:00:00.000Z";
const EXPIRES_AT = "2026-11-20T09:00:00.000Z";
const REQUEST_ID = "a1000000-0000-4000-8000-000000000001";
const RUN_ID = "a2000000-0000-4000-8000-000000000001";
const REASON = "Read the deployment logs on the build host.";

function sshRequest(
  overrides: Partial<SshAuthorization> = {},
): SshAuthorization {
  return {
    id: REQUEST_ID,
    chatThreadId: context.resourceId,
    connectionId: "b0000000-0000-4000-8000-000000000001",
    requestedByRunId: RUN_ID,
    displayName: "Build box",
    host: "ssh.example.com",
    port: 22,
    username: "deploy",
    reason: REASON,
    status: "pending",
    requestExpiresAt: EXPIRES_AT,
    enabled: false,
    continuationPending: false,
    approvalBlockedReason: null,
    requiredPermissions: [],
    authorizationUrl: `http://localhost/ssh/authorize/${REQUEST_ID}`,
    ...overrides,
  };
}

/** The server's copy of the request, changed by approve and revoke. */
function mockSshRequest(initial: SshAuthorization): {
  current: SshAuthorization;
} {
  const server = { current: initial };
  context.mocks.api(sshAuthorizationContract.get, ({ respond }) => {
    return respond(200, server.current);
  });
  context.mocks.api(sshAuthorizationContract.approve, ({ respond }) => {
    server.current = { ...server.current, status: "approved", enabled: true };
    return respond(200, server.current);
  });
  context.mocks.api(sshAuthorizationContract.revoke, ({ respond }) => {
    server.current = { ...server.current, status: "revoked", enabled: false };
    return respond(200, server.current);
  });
  return server;
}

function action(name: string): HTMLElement | undefined {
  return queryAllByRoleFast("button").find((candidate) => {
    return (
      candidate.textContent?.trim() === name ||
      candidate.getAttribute("aria-label") === name
    );
  });
}

function getAction(name: string): HTMLElement {
  const found = action(name);
  if (!found) {
    throw new Error(`Expected button named "${name}"`);
  }
  return found;
}

test("The inline card allows only this chat and shows the remote user and access effect", async () => {
  mockNow(new Date(NOW), context.signal);
  mockSshRequest(sshRequest());
  installMessageExperienceChat({
    threadId: context.resourceId,
    chatEvents: [
      {
        id: "ssh-request-message",
        role: "assistant",
        content: `I need SSH access to continue: http://localhost/ssh/authorize/${REQUEST_ID}`,
        runId: RUN_ID,
        seqId: 1,
        createdAt: "2026-11-20T07:59:00.000Z",
      },
    ],
  });
  await setupPage({ context, path: `/chats/${context.resourceId}` });
  await expect(
    screen.findByText("deploy@ssh.example.com:22 · This host · This chat only"),
  ).resolves.toBeInTheDocument();

  click(getAction("Access details"));

  const details = await screen.findByRole("dialog", { name: "Access details" });
  expect(details).toHaveTextContent(
    "Allows commands and file transfers as this remote user until access is disabled.",
  );
  expect(details).toHaveTextContent(REASON);

  click(getAction("Allow in this chat"));

  await expect(
    screen.findByText("SSH access allowed · Build box"),
  ).resolves.toBeInTheDocument();
  expect(action("Allow in this chat")).toBeUndefined();

  click(getAction("Revoke"));

  await expect(
    screen.findByText("SSH access revoked · Build box"),
  ).resolves.toBeInTheDocument();
  expect(action("Revoke")).toBeUndefined();
});

test("The direct page waits for connector approvals and requesting Run completion", async () => {
  mockNow(new Date(NOW), context.signal);
  const server = mockSshRequest(
    sshRequest({
      approvalBlockedReason: "permissions_required",
      requiredPermissions: [
        { connectorSlug: "cloudflare", permission: "dns.write" },
      ],
    }),
  );
  await setupPage({ context, path: `/ssh/authorize/${REQUEST_ID}` });
  await expect(
    screen.findByText("Approve the accompanying connector permissions first."),
  ).resolves.toHaveAttribute("role", "status");
  expect(screen.getByText("cloudflare / dns.write")).toBeInTheDocument();
  expect(getAction("Allow in this chat")).toBeDisabled();

  // The permission is granted elsewhere while the requesting Run still works.
  server.current = { ...server.current, approvalBlockedReason: "run_active" };
  context.mocks.ably.trigger("connectorPermissionUpdated");

  await expect(
    screen.findByText(
      "Wait for the requesting Run to finish before approving.",
    ),
  ).resolves.toHaveAttribute("role", "status");
  expect(getAction("Allow in this chat")).toBeDisabled();

  // The Run finishes and the server announces the changed eligibility.
  server.current = { ...server.current, approvalBlockedReason: null };
  context.mocks.ably.trigger("desktopShellAuthorizationChanged");

  await waitFor(() => {
    expect(getAction("Allow in this chat")).toBeEnabled();
  });

  click(getAction("Allow in this chat"));

  await expect(
    screen.findByText("SSH access allowed"),
  ).resolves.toBeInTheDocument();
});

function gateway(
  index: number,
  name: string,
  scope: ScopedCloudflareAccessConfig["scope"] = "personal",
): ScopedCloudflareAccessConfig {
  return {
    id: remoteId("c", index),
    name,
    scope,
    revision: 1,
    generation: 1,
    createdAt: REMOTE_TIMESTAMP,
    updatedAt: REMOTE_TIMESTAMP,
    sshHosts: [],
    vncHosts: [],
  };
}

function deploymentLogin(hostId: string): SshCredentialResponse {
  return {
    id: remoteId("d", 1),
    name: "Deployment login",
    username: "deploy",
    authMethod: "private_key",
    revision: 1,
    createdAt: REMOTE_TIMESTAMP,
    updatedAt: REMOTE_TIMESTAMP,
    hosts: [{ id: hostId, displayName: "Build box" }],
  };
}

function inventoryFor(
  host: SshConnectionResponse,
  gateways: ScopedCloudflareAccessConfig[],
): RemoteInventory {
  return mockRemoteInventory(context, {
    ssh: [host],
    sshCredentials: [deploymentLogin(host.id)],
    cloudflare: gateways,
  });
}

function recordUpdates(
  inventory: RemoteInventory,
  outcome: "saved" | "changed" = "saved",
): { body?: UpdateSshConnectionRequest } {
  const updated: { body?: UpdateSshConnectionRequest } = {};
  context.mocks.api(
    sshConnectionsContract.update,
    ({ params, body, respond }) => {
      updated.body = body;
      if (outcome === "changed") {
        return respond(409, {
          error: {
            code: SSH_ERROR_CODES.GENERATION_CONFLICT,
            message: "SSH connection was modified by another request",
          },
        });
      }
      const saved = sshHost(1, body.displayName ?? "Build box", {
        id: params.connectionId,
        host: body.host,
        port: body.port,
        generation: body.expectedGeneration + 1,
        ...(body.transport?.type === "cloudflare_access" &&
        "configId" in body.transport
          ? {
              transport: {
                type: "cloudflare_access" as const,
                configId: body.transport.configId,
              },
            }
          : {}),
      });
      inventory.ssh = [saved];
      return respond(200, saved);
    },
  );
  return updated;
}

async function choose(combobox: string, option: string): Promise<void> {
  const user = userEvent.setup({ delay: null });
  const trigger = screen.getByRole("combobox", { name: combobox });
  await user.click(trigger);
  click(await screen.findByRole("option", { name: option }));
  await waitFor(() => {
    expect(trigger).toHaveTextContent(option);
  });
}

const REBIND_GUIDANCE =
  "This host needs a new Cloudflare Access configuration. Edit it to rebind or choose Direct. It will not connect until you do.";

async function openHost(host: SshConnectionResponse): Promise<void> {
  await setupPage({
    context,
    path: `/connectors?scope=remote-control&remoteResource=ssh:${host.id}`,
  });
  await waitFor(() => {
    expect(getConnectorAction("button", "Edit connection")).toBeEnabled();
  });
}

async function openEditor(host: SshConnectionResponse): Promise<void> {
  await openHost(host);
  await editOpenHost();
}

async function editOpenHost(): Promise<void> {
  click(getConnectorAction("button", "Edit connection"));
  await expect(
    screen.findByRole("heading", { name: "Edit connection" }),
  ).resolves.toBeInTheDocument();
  click(screen.getByText("Connection settings"));
}

async function saveAndReturn(): Promise<void> {
  click(getConnectorAction("button", "Save"));
  await waitFor(() => {
    expect(getConnectorAction("button", "Edit connection")).toBeEnabled();
  });
}

test("A retained protected host requires explicit shared Access selection before saving", async () => {
  const retained = sshHost(1, "Build box", {
    host: "ssh.example.com",
    port: 443,
    generation: 3,
    transport: { type: "cloudflare_access", needsRebind: true },
  });
  const shared = gateway(1, "Team gateway", "organization");
  const inventory = inventoryFor(retained, [shared]);
  const updated = recordUpdates(inventory);
  await openHost(retained);
  expect(screen.getByText(REBIND_GUIDANCE)).toBeInTheDocument();
  await editOpenHost();
  expect(getConnectorAction("button", "Save")).toBeDisabled();

  await choose("Cloudflare Access", "Team gateway");

  expect(getConnectorAction("button", "Save")).toBeEnabled();

  await saveAndReturn();

  expect(screen.queryByText(REBIND_GUIDANCE)).not.toBeInTheDocument();
  expect(updated.body).toStrictEqual({
    expectedGeneration: 3,
    displayName: "Build box",
    host: "ssh.example.com",
    port: 443,
    credential: { id: remoteId("d", 1) },
    transport: { type: "cloudflare_access", configId: shared.id },
  });
});

test("Direct and protected mode retain their port and configuration drafts but submit only active fields", async () => {
  const direct = sshHost(1, "Build box", { port: 22 });
  const office = gateway(1, "Office gateway");
  const inventory = inventoryFor(direct, [office]);
  const updated = recordUpdates(inventory);
  await openEditor(direct);
  await fill(screen.getByLabelText("Port"), "2222");
  await choose("Connection", "Cloudflare Access");
  await fill(screen.getByLabelText("Published hostname"), "ssh.example.com");
  await choose("Cloudflare Access", "Office gateway");

  await choose("Connection", "Direct");

  expect(screen.getByLabelText("Port")).toHaveValue(2222);

  await choose("Connection", "Cloudflare Access");

  expect(
    screen.getByRole("combobox", { name: "Cloudflare Access" }),
  ).toHaveTextContent("Office gateway");

  await saveAndReturn();

  expect(updated.body).toMatchObject({
    host: "ssh.example.com",
    port: 443,
    transport: { type: "cloudflare_access", configId: office.id },
  });
});

test("An eligible protected host can explicitly change to Direct", async () => {
  const office = gateway(1, "Office gateway");
  const protectedHost = sshHost(1, "Build box", {
    host: "ssh.example.com",
    port: 443,
    transport: { type: "cloudflare_access", configId: office.id },
  });
  const inventory = inventoryFor(protectedHost, [office]);
  recordUpdates(inventory);
  await openEditor(protectedHost);

  await choose("Connection", "Direct");

  expect(screen.getByLabelText("Port")).toHaveValue(22);

  await saveAndReturn();
  await editOpenHost();

  expect(
    screen.getByRole("combobox", { name: "Connection" }),
  ).toHaveTextContent("Direct");
  expect(screen.getByLabelText("Port")).toHaveValue(22);
});

test("A concurrent host update preserves the binding draft and blocks stale saving", async () => {
  const office = gateway(1, "Office gateway");
  const lab = gateway(2, "Lab gateway");
  const protectedHost = sshHost(1, "Build box", {
    host: "ssh.example.com",
    port: 443,
    transport: { type: "cloudflare_access", configId: office.id },
  });
  const inventory = inventoryFor(protectedHost, [office, lab]);
  const updated = recordUpdates(inventory, "changed");
  await openEditor(protectedHost);
  const name = screen.getByLabelText(/^Connection name/);
  await fill(name, "Release box");
  await choose("Cloudflare Access", "Lab gateway");

  click(getConnectorAction("button", "Save"));

  await expect(
    screen.findByText(
      "This host changed while you were editing. Your changes were not saved; your draft is preserved.",
    ),
  ).resolves.toHaveAttribute("role", "alert");
  expect(name).toHaveValue("Release box");
  expect(
    screen.getByRole("combobox", { name: "Cloudflare Access" }),
  ).toHaveTextContent("Lab gateway");
  expect(getConnectorAction("button", "Save")).toBeDisabled();
  expect(updated.body).toMatchObject({
    expectedGeneration: 1,
    displayName: "Release box",
    transport: { type: "cloudflare_access", configId: lab.id },
  });
});

const UNAVAILABLE =
  "This configuration is unavailable or you no longer have access.";
const OWNER_TOKEN = "owner-token";
const OWNER_SESSION_ID = "sess_owner";

function owner() {
  return { id: "user_owner", fullName: "Owner User" };
}

interface DeleteAttempt {
  readonly authorization: string | null;
  readonly expectedGeneration: number;
}

async function openDeletion(
  connection: SshConnectionResponse,
): Promise<HTMLElement> {
  await setupPage({
    context,
    path: `/connectors?scope=remote-control&remoteResource=ssh:${connection.id}`,
    auth: {
      user: owner(),
      session: { token: OWNER_TOKEN, id: OWNER_SESSION_ID },
    },
  });
  await waitFor(() => {
    expect(getConnectorAction("button", "Delete connection")).toBeEnabled();
  });
  click(getConnectorAction("button", "Delete connection"));
  return await screen.findByRole("dialog", { name: "Delete connection" });
}

function recordDeletes(respond: () => "deleted" | "missing" | "changed"): {
  attempt?: DeleteAttempt;
} {
  const deletion: { attempt?: DeleteAttempt } = {};
  context.mocks.api(
    sshConnectionsContract.delete,
    ({ body, request, respond: send }) => {
      deletion.attempt = {
        authorization: request.headers.get("authorization"),
        expectedGeneration: body.expectedGeneration,
      };
      const outcome = respond();
      if (outcome === "missing") {
        return send(404, {
          error: {
            code: SSH_ERROR_CODES.CONNECTION_NOT_FOUND,
            message: "SSH connection not found",
          },
        });
      }
      if (outcome === "changed") {
        return send(409, {
          error: {
            code: SSH_ERROR_CODES.GENERATION_CONFLICT,
            message: "SSH connection was modified by another request",
          },
        });
      }
      return send(204);
    },
  );
  return deletion;
}

test.each([
  {
    status: 404,
    outcome: "missing" as const,
    remaining: [],
    warning:
      "This SSH host is no longer available. Return to the host list and choose an existing host.",
  },
  {
    status: 409,
    outcome: "changed" as const,
    remaining: [sshHost(2, "Replacement host", { generation: 99 })],
    warning:
      "This host changed while you were editing. Your changes were not saved; your draft is preserved.",
  },
])(
  "A missing host after HTTP $status cannot authorize deletion",
  async ({ outcome, remaining, warning }) => {
    const saved = sshHost(1, "Build host", { generation: 4 });
    const inventory = mockRemoteInventory(context, { ssh: [saved] });
    const deletion = recordDeletes(() => {
      // Another actor already changed the host; the server announces it.
      inventory.ssh = remaining;
      context.mocks.ably.trigger("ssh:changed", { orgId: "org_default" });
      return outcome;
    });
    const dialog = await openDeletion(saved);

    click(getConnectorAction("button", "Delete connection", dialog));

    await expect(within(dialog).findByText(warning)).resolves.toHaveAttribute(
      "role",
      "alert",
    );
    expect(
      getConnectorAction("button", "Delete connection", dialog),
    ).toBeDisabled();
    expect(deletion.attempt?.expectedGeneration).toBe(4);

    click(getConnectorAction("button", "Cancel", dialog));

    await expect(screen.findByText(UNAVAILABLE)).resolves.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  },
);

test("A owner change while deletion awaits a token prevents stale submission", async () => {
  const saved = sshHost(1, "Build host", { generation: 4 });
  mockRemoteInventory(context, { ssh: [saved] });
  // The server lists the host only for its owner's token.
  context.mocks.api(sshConnectionsContract.list, ({ request, respond }) => {
    const owner =
      request.headers.get("authorization") === `Bearer ${OWNER_TOKEN}`;
    return respond(200, { connections: owner ? [saved] : [] });
  });
  const deletion = recordDeletes(() => {
    return "deleted";
  });
  const dialog = await openDeletion(saved);
  const issueToken = mockedClerk.sessionGetToken.getMockImplementation();
  if (!issueToken) {
    throw new Error("Expected the Clerk session token implementation");
  }
  const tokenRequested = context.mocks.deferred<void>();
  const tokenIssued = context.mocks.deferred<void>();
  mockedClerk.sessionGetToken.mockImplementation(async (options) => {
    if (!tokenRequested.settled()) {
      tokenRequested.resolve();
    }
    await tokenIssued.promise;
    return await issueToken(options);
  });

  click(getConnectorAction("button", "Delete connection", dialog));
  await tokenRequested.promise;

  const clerk = context.mocks.clerk();
  clerk.user(
    { id: "user_successor", fullName: "Successor User" },
    { token: "successor-token", id: "sess_successor" },
  );
  clerk.stateChanged();

  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });

  tokenIssued.resolve();

  await expect(screen.findByText(UNAVAILABLE)).resolves.toBeInTheDocument();
  // The stale owner's deletion never reaches the server.
  expect(deletion.attempt).toBeUndefined();
});

test("A same-session token refresh preserves the deletion snapshot and uses the current token", async () => {
  const saved = sshHost(1, "Build host", { generation: 4 });
  const inventory = mockRemoteInventory(context, { ssh: [saved] });
  const deletion = recordDeletes(() => {
    inventory.ssh = [];
    return "deleted";
  });
  const dialog = await openDeletion(saved);

  const clerk = context.mocks.clerk();
  clerk.user(owner(), { token: "refreshed-token", id: OWNER_SESSION_ID });
  clerk.stateChanged();
  click(getConnectorAction("button", "Delete connection", dialog));

  await expect(screen.findByText(UNAVAILABLE)).resolves.toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "Build host" }),
  ).not.toBeInTheDocument();
  expect(deletion.attempt).toStrictEqual({
    authorization: "Bearer refreshed-token",
    expectedGeneration: 4,
  });
});
