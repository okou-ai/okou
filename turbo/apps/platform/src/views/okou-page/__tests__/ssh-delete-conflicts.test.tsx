import {
  sshConnectionsContract,
  type SshConnectionResponse,
} from "@okouai/api-contracts/contracts/ssh-connections";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { tailscaleContract } from "@okouai/api-contracts/contracts/tailscale";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getAction,
  queryAction,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();
const orgId = "org_ssh_delete";
const owner = Object.freeze({ id: "ssh-delete-owner", fullName: "SSH Owner" });
const host: SshConnectionResponse = Object.freeze({
  id: "b0000000-0000-4000-8000-000000000001",
  displayName: "Deployment",
  host: "ssh.example.com",
  port: 22,
  username: "deploy",
  credentialId: "d0000000-0000-4000-8000-000000000001",
  credentialName: "Deployment login",
  generation: 4,
  learnedHostKey: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
});
const unavailable = "This host is no longer available.";
const empty =
  "No SSH hosts configured. Add a host, then enable it by default or in individual chats.";

function mockSettings() {
  const data: { connections: SshConnectionResponse[]; failed: boolean } = {
    connections: [host],
    failed: false,
  };
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return data.failed
      ? respond(500, {
          error: { code: "INTERNAL_SERVER_ERROR", message: "unavailable" },
        })
      : respond(200, { connections: data.connections });
  });
  context.mocks.api(sshCredentialsContract.list, ({ respond }) => {
    return respond(200, { credentials: [] });
  });
  return data;
}

async function openDeletion() {
  await setupPage({
    context,
    path: "/connectors?scope=remote-control&type=ssh",
    auth: {
      user: owner,
      session: { id: "ssh-delete-session", token: "original-token" },
      organization: {
        activeOrg: { id: orgId, name: "SSH deletion" },
        memberships: [{ id: orgId }],
      },
    },
  });
  await screen.findByText(host.displayName);
  click(getAction("button", "Delete host"));
  return await screen.findByRole("dialog", { name: "Delete host" });
}

test.each(["click", "Enter", "Space"])(
  "%s acknowledges the reviewed deletion generation without submitting it",
  async (activation) => {
    const data = mockSettings();
    const requests: unknown[] = [];
    context.mocks.api(sshConnectionsContract.delete, ({ body, respond }) => {
      requests.push(body);
      if (body.expectedGeneration === 4) {
        data.connections = [
          {
            ...host,
            displayName: "Updated deployment",
            host: "updated.example.com",
            port: 2222,
            generation: 5,
          },
        ];
        context.mocks.ably.trigger("ssh:changed", { orgId });
        return respond(409, {
          error: { code: "SSH_GENERATION_CONFLICT", message: "changed" },
        });
      }
      data.connections = [];
      context.mocks.ably.trigger("ssh:changed", { orgId });
      return respond(204);
    });
    const dialog = await openDeletion();
    click(getAction("button", "Delete host", dialog));
    await within(dialog).findByText("Version 5");
    expect(
      within(dialog).getByText("deploy@updated.example.com:2222"),
    ).toBeInTheDocument();
    expect(getAction("button", "Delete host", dialog)).toBeDisabled();
    expect(
      queryAction("button", "Keep my changes with this version", dialog),
    ).toBeNull();
    const acknowledge = getAction(
      "button",
      "Use this version for deletion",
      dialog,
    );
    expect(acknowledge).toHaveAttribute("type", "button");
    if (activation === "click") {
      click(acknowledge);
    } else {
      acknowledge.focus();
      await userEvent.keyboard(activation === "Enter" ? "{Enter}" : " ");
    }
    await waitFor(() => {
      expect(getAction("button", "Delete host", dialog)).toBeEnabled();
    });
    expect(requests).toStrictEqual([{ expectedGeneration: 4 }]);
    click(getAction("button", "Delete host", dialog));
    await screen.findByText(empty);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(requests).toStrictEqual([
      { expectedGeneration: 4 },
      { expectedGeneration: 5 },
    ]);
  },
);

test("A Tailscale SSH deletion reviews credential-free identity before acknowledging its generation", async () => {
  const data = mockSettings();
  const networkId = "e0000000-0000-4000-8000-000000000001";
  const identity: SshConnectionResponse = {
    id: host.id,
    displayName: host.displayName,
    host: "private-peer",
    port: 22,
    username: "ubuntu",
    generation: host.generation,
    learnedHostKey: null,
    createdAt: host.createdAt,
    updatedAt: host.updatedAt,
    transport: {
      type: "tailscale_ssh",
      configId: networkId,
    },
  };
  data.connections = [identity];
  context.mocks.ably.trigger("ssh:changed", { orgId });
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, {
      configs: [
        {
          id: networkId,
          name: "Identity network",
          scope: "personal",
          tags: ["tag:qa"],
          revision: 1,
          generation: 1,
          sshHosts: [{ id: host.id, displayName: host.displayName }],
          vncHosts: [],
          createdAt: host.createdAt,
          updatedAt: host.updatedAt,
        },
      ],
    });
  });
  const requests: unknown[] = [];
  context.mocks.api(sshConnectionsContract.delete, ({ body, respond }) => {
    requests.push(body);
    if (body.expectedGeneration === 4) {
      data.connections = [{ ...identity, host: "updated-peer", generation: 5 }];
      context.mocks.ably.trigger("ssh:changed", { orgId });
      return respond(409, {
        error: { code: "SSH_GENERATION_CONFLICT", message: "changed" },
      });
    }
    data.connections = [];
    context.mocks.ably.trigger("ssh:changed", { orgId });
    return respond(204);
  });
  const dialog = await openDeletion();
  click(getAction("button", "Delete host", dialog));
  await within(dialog).findByText("Version 5");
  expect(within(dialog).getByText("ubuntu@updated-peer:22")).toBeVisible();
  expect(within(dialog).getByText("Tailscale SSH")).toBeVisible();
  expect(getAction("button", "Delete host", dialog)).toBeDisabled();
  click(getAction("button", "Use this version for deletion", dialog));
  await waitFor(() => {
    expect(getAction("button", "Delete host", dialog)).toBeEnabled();
  });
  expect(requests).toStrictEqual([{ expectedGeneration: 4 }]);
  click(getAction("button", "Delete host", dialog));
  await screen.findByText(empty);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(requests).toStrictEqual([
    { expectedGeneration: 4 },
    { expectedGeneration: 5 },
  ]);
});

test("Passive refresh preserves original and acknowledged deletion generations across repeated conflicts", async () => {
  const data = mockSettings();
  const requests: unknown[] = [];
  context.mocks.api(sshConnectionsContract.delete, ({ body, respond }) => {
    requests.push(body);
    if (body.expectedGeneration !== data.connections[0]?.generation) {
      return respond(409, {
        error: { code: "SSH_GENERATION_CONFLICT", message: "changed" },
      });
    }
    data.connections = [];
    context.mocks.ably.trigger("ssh:changed", { orgId });
    return respond(204);
  });
  const dialog = await openDeletion();
  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription("ssh:changed")).toBeTruthy();
  });
  data.connections = [{ ...host, displayName: "Version five", generation: 5 }];
  context.mocks.ably.trigger("ssh:changed", { orgId });
  context.mocks.ably.trigger("ssh:changed", { orgId });
  await screen.findByText("Version five");
  click(getAction("button", "Delete host", dialog));
  await within(dialog).findByText("Version 5");
  click(getAction("button", "Use this version for deletion", dialog));
  await waitFor(() => {
    expect(getAction("button", "Delete host", dialog)).toBeEnabled();
  });
  data.connections = [{ ...host, displayName: "Version six", generation: 6 }];
  context.mocks.ably.trigger("ssh:changed", { orgId });
  context.mocks.ably.trigger("ssh:changed", { orgId });
  await screen.findByText("Version six");
  click(getAction("button", "Delete host", dialog));
  await within(dialog).findByText("Version 6");
  expect(getAction("button", "Delete host", dialog)).toBeDisabled();
  expect(requests).toStrictEqual([
    { expectedGeneration: 4 },
    { expectedGeneration: 5 },
  ]);
  click(getAction("button", "Use this version for deletion", dialog));
  await waitFor(() => {
    expect(getAction("button", "Delete host", dialog)).toBeEnabled();
  });
  click(getAction("button", "Delete host", dialog));
  await screen.findByText(empty);
  expect(requests).toStrictEqual([
    { expectedGeneration: 4 },
    { expectedGeneration: 5 },
    { expectedGeneration: 6 },
  ]);
});

test.each([404, 409] as const)(
  "A missing host after HTTP %s cannot authorize deletion",
  async (status) => {
    const data = mockSettings();
    const requests: unknown[] = [];
    context.mocks.api(sshConnectionsContract.delete, ({ body, respond }) => {
      requests.push(body);
      data.connections =
        status === 404
          ? []
          : [
              {
                ...host,
                id: "b0000000-0000-4000-8000-000000000002",
                displayName: "Different host",
                generation: 99,
              },
            ];
      context.mocks.ably.trigger("ssh:changed", { orgId });
      return respond(status, {
        error: {
          code:
            status === 404
              ? "SSH_CONNECTION_NOT_FOUND"
              : "SSH_GENERATION_CONFLICT",
          message: "missing",
        },
      });
    });
    const dialog = await openDeletion();
    click(getAction("button", "Delete host", dialog));
    await within(dialog).findByText(unavailable);
    expect(getAction("button", "Delete host", dialog)).toBeDisabled();
    expect(
      queryAction("button", "Use this version for deletion", dialog),
    ).toBeNull();
    click(getAction("button", "Cancel", dialog));
    await screen.findByText(status === 404 ? empty : "Different host");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(requests).toStrictEqual([{ expectedGeneration: 4 }]);
  },
);

test("A host referenced by VNC remains blocked without a deletion acknowledgement", async () => {
  mockSettings();
  const requests: unknown[] = [];
  context.mocks.api(sshConnectionsContract.delete, ({ body, respond }) => {
    requests.push(body);
    return respond(409, {
      error: { code: "SSH_CONNECTION_IN_USE", message: "referenced" },
    });
  });
  const dialog = await openDeletion();
  click(getAction("button", "Delete host", dialog));
  await within(dialog).findByText(/This SSH host is used by a VNC route/u);
  expect(getAction("button", "Delete host", dialog)).toBeDisabled();
  expect(
    queryAction("button", "Use this version for deletion", dialog),
  ).toBeNull();
  expect(requests).toStrictEqual([{ expectedGeneration: 4 }]);
});

test("Closing a reviewed deletion discards its acknowledgement for the next dialog", async () => {
  const data = mockSettings();
  const requests: unknown[] = [];
  context.mocks.api(sshConnectionsContract.delete, ({ body, respond }) => {
    requests.push(body);
    if (body.expectedGeneration === 4) {
      data.connections = [{ ...host, generation: 5 }];
      context.mocks.ably.trigger("ssh:changed", { orgId });
      return respond(409, {
        error: { code: "SSH_GENERATION_CONFLICT", message: "changed" },
      });
    }
    data.connections = [];
    context.mocks.ably.trigger("ssh:changed", { orgId });
    return respond(204);
  });
  const dialog = await openDeletion();
  click(getAction("button", "Delete host", dialog));
  await within(dialog).findByText("Version 5");
  click(getAction("button", "Use this version for deletion", dialog));
  await waitFor(() => {
    expect(getAction("button", "Delete host", dialog)).toBeEnabled();
  });
  click(getAction("button", "Cancel", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription("ssh:changed")).toBeTruthy();
  });
  data.connections = [
    { ...host, displayName: "Reopened version", generation: 6 },
  ];
  context.mocks.ably.trigger("ssh:changed", { orgId });
  context.mocks.ably.trigger("ssh:changed", { orgId });
  await screen.findByText("Reopened version");
  click(getAction("button", "Delete host"));
  const reopened = await screen.findByRole("dialog", { name: "Delete host" });
  click(getAction("button", "Delete host", reopened));
  await screen.findByText(empty);
  expect(requests).toStrictEqual([
    { expectedGeneration: 4 },
    { expectedGeneration: 6 },
  ]);
});

test.each(["logout", "owner", "session"])(
  "A %s change while deletion awaits a token prevents stale submission",
  async (change) => {
    mockSettings();
    const requests: unknown[] = [];
    context.mocks.api(sshConnectionsContract.delete, ({ body, respond }) => {
      requests.push(body);
      return respond(204);
    });
    const dialog = await openDeletion();
    const token = context.mocks.deferred<string>();
    const previous = mockedClerk.sessionGetToken.mock.calls.length;
    mockedClerk.sessionGetToken.mockImplementationOnce(() => {
      return token.promise;
    });
    click(getAction("button", "Delete host", dialog));
    await waitFor(() => {
      expect(mockedClerk.sessionGetToken.mock.calls).toHaveLength(previous + 1);
    });
    const clerk = context.mocks.clerk();
    act(() => {
      if (change === "logout") {
        clerk.user(null, null);
      } else {
        clerk.user(
          change === "owner" ? { id: "other-owner", fullName: "Other" } : owner,
          { id: "replacement-session", token: "replacement-token" },
        );
      }
      clerk.stateChanged();
    });
    await act(async () => {
      token.resolve("old-token");
      await token.promise;
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(requests).toStrictEqual([]);
  },
);

test("A same-session token refresh preserves the deletion snapshot and uses the current token", async () => {
  const data = mockSettings();
  const requests: unknown[] = [];
  context.mocks.api(
    sshConnectionsContract.delete,
    ({ body, request, respond }) => {
      requests.push({
        body,
        authorization: request.headers.get("authorization"),
      });
      data.connections = [];
      context.mocks.ably.trigger("ssh:changed", { orgId });
      return respond(204);
    },
  );
  const dialog = await openDeletion();
  const clerk = context.mocks.clerk();
  act(() => {
    clerk.user(owner, { id: "ssh-delete-session", token: "refreshed-token" });
    clerk.stateChanged();
  });
  await waitFor(() => {
    expect(getAction("button", "Delete host", dialog)).toBeEnabled();
  });
  click(getAction("button", "Delete host", dialog));
  await screen.findByText(empty);
  expect(requests).toStrictEqual([
    {
      body: { expectedGeneration: 4 },
      authorization: "Bearer refreshed-token",
    },
  ]);
});
