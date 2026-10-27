import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  sshConnectionsContract,
  type SshConnectionResponse,
} from "@okouai/api-contracts/contracts/ssh-connections";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { getAction } from "./connector-integrations-test-helpers.ts";

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
    featureSwitches: { [FeatureSwitchKey.RemoteControlGuidedSetup]: false },
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
    await within(dialog).findByText(
      status === 404
        ? /This SSH host is no longer available/u
        : /This host changed/u,
    );
    expect(getAction("button", "Delete host", dialog)).toBeDisabled();
    click(getAction("button", "Cancel", dialog));
    await screen.findByText(status === 404 ? empty : "Different host");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(requests).toStrictEqual([{ expectedGeneration: 4 }]);
  },
);

test("A host referenced by VNC cannot be deleted", async () => {
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
  expect(requests).toStrictEqual([{ expectedGeneration: 4 }]);
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
