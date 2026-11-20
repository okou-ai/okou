import { SSH_ERROR_CODES } from "@okouai/api-contracts/contracts/ssh-errors";
import {
  sshConnectionsContract,
  type SshConnectionResponse,
} from "@okouai/api-contracts/contracts/ssh-connections";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { getConnectorAction } from "./connector-page-test-helpers.ts";
import {
  mockRemoteInventory,
  sshHost,
} from "./connectors-remote-control-test-helpers.ts";

const context = testContext();
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

function recordDeletes(
  respond: () => "deleted" | "missing" | "changed",
): DeleteAttempt[] {
  const attempts: DeleteAttempt[] = [];
  context.mocks.api(
    sshConnectionsContract.delete,
    ({ body, request, respond: send }) => {
      attempts.push({
        authorization: request.headers.get("authorization"),
        expectedGeneration: body.expectedGeneration,
      });
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
  return attempts;
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
    const attempts = recordDeletes(() => {
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
    expect(
      attempts.map(({ expectedGeneration }) => {
        return expectedGeneration;
      }),
    ).toStrictEqual([4]);

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
  const attempts = recordDeletes(() => {
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
  expect(attempts).toStrictEqual([]);
});

test("A same-session token refresh preserves the deletion snapshot and uses the current token", async () => {
  const saved = sshHost(1, "Build host", { generation: 4 });
  const inventory = mockRemoteInventory(context, { ssh: [saved] });
  const attempts = recordDeletes(() => {
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
  expect(attempts).toStrictEqual([
    { authorization: "Bearer refreshed-token", expectedGeneration: 4 },
  ]);
});
