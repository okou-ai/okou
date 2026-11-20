import {
  sshAuthorizationContract,
  type SshAuthorization,
} from "@okouai/api-contracts/contracts/ssh-authorization";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createMessageExperienceHelpers } from "./chat-message-experience-test-helpers.ts";

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
