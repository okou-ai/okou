import {
  sshAuthorizationContract,
  type SshAuthorization,
} from "@okouai/api-contracts/contracts/ssh-authorization";
import {
  vncAuthorizationContract,
  type VncAuthorization,
} from "@okouai/api-contracts/contracts/vnc-authorization";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
const REQUEST_ID = "a1000000-0000-4000-8000-000000000071";
const RUN_ID = "a2000000-0000-4000-8000-000000000071";
const REASON = "Check the build dashboard on the Work Mac.";

function vncRequest(
  overrides: Partial<VncAuthorization> = {},
): VncAuthorization {
  return {
    id: REQUEST_ID,
    chatThreadId: context.resourceId,
    connectionId: "e0000000-0000-4000-8000-000000000001",
    requestedByRunId: RUN_ID,
    displayName: "Work Mac",
    host: "ssh.example.com",
    port: 5900,
    reason: REASON,
    status: "pending",
    requestExpiresAt: "2026-11-20T09:00:00.000Z",
    enabled: false,
    continuationPending: false,
    approvalBlockedReason: null,
    requiredPermissions: [],
    requiredSshHosts: [],
    authorizationUrl: `http://localhost/vnc/authorize/${REQUEST_ID}`,
    ...overrides,
  };
}

/** The server's copy of the VNC request, changed by approve and revoke. */
function mockVncRequest(
  initial: VncAuthorization,
  approve: (
    current: VncAuthorization,
  ) => "approved" | "continuation-failed" = () => {
    return "approved";
  },
): { current: VncAuthorization } {
  const server = { current: initial };
  context.mocks.api(vncAuthorizationContract.get, ({ respond }) => {
    return respond(200, server.current);
  });
  context.mocks.api(vncAuthorizationContract.approve, ({ respond }) => {
    const outcome = approve(server.current);
    if (outcome === "continuation-failed") {
      // Access is granted, but the requesting task cannot continue yet.
      server.current = {
        ...server.current,
        status: "approved",
        enabled: true,
        continuationPending: true,
      };
      return respond(503, {
        error: { code: "SERVICE_UNAVAILABLE", message: "Run dispatch busy" },
      });
    }
    server.current = {
      ...server.current,
      status: "approved",
      enabled: true,
      continuationPending: false,
    };
    return respond(200, server.current);
  });
  context.mocks.api(vncAuthorizationContract.revoke, ({ respond }) => {
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

function installRequestChat(content: string): void {
  installMessageExperienceChat({
    threadId: context.resourceId,
    chatEvents: [
      {
        id: "access-request-message",
        role: "assistant",
        content,
        runId: RUN_ID,
        seqId: 1,
        createdAt: "2026-11-20T07:59:00.000Z",
      },
    ],
  });
}

test("The inline card allows only this chat and shows the desktop and access effect", async () => {
  mockNow(new Date(NOW), context.signal);
  mockVncRequest(vncRequest());
  installRequestChat(
    `I need to see the desktop: http://localhost/vnc/authorize/${REQUEST_ID}`,
  );
  const user = userEvent.setup({ delay: null });
  await setupPage({ context, path: `/chats/${context.resourceId}` });
  await expect(
    screen.findByText("ssh.example.com:5900 · This host · This chat only"),
  ).resolves.toBeInTheDocument();

  click(getAction("Access details"));

  const details = await screen.findByRole("dialog", { name: "Access details" });
  expect(details).toHaveTextContent(
    "Allows viewing and controlling this desktop until access is disabled. SSH hosts require separate approval.",
  );
  expect(details).toHaveTextContent(REASON);

  await user.keyboard("{Escape}");

  await waitFor(() => {
    expect(details).not.toBeInTheDocument();
  });

  click(getAction("Allow in this chat"));

  await expect(
    screen.findByText("VNC access allowed · Work Mac"),
  ).resolves.toBeInTheDocument();

  click(getAction("Revoke"));

  await expect(
    screen.findByText("VNC access revoked · Work Mac"),
  ).resolves.toBeInTheDocument();
  expect(action("Revoke")).toBeUndefined();
});

test("The direct page waits for connector approvals and requesting Run completion", async () => {
  mockNow(new Date(NOW), context.signal);
  const server = mockVncRequest(
    vncRequest({
      approvalBlockedReason: "permissions_required",
      requiredPermissions: [
        { connectorSlug: "cloudflare", permission: "dns.write" },
      ],
    }),
  );
  await setupPage({ context, path: `/vnc/authorize/${REQUEST_ID}` });
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
    screen.findByText("VNC access allowed"),
  ).resolves.toBeInTheDocument();
});

test("Continuation failure can be retried on the approved request without a second grant", async () => {
  mockNow(new Date(NOW), context.signal);
  mockVncRequest(vncRequest(), (current) => {
    return current.status === "pending" ? "continuation-failed" : "approved";
  });
  await setupPage({ context, path: `/vnc/authorize/${REQUEST_ID}` });
  await waitFor(() => {
    expect(getAction("Allow in this chat")).toBeEnabled();
  });

  click(getAction("Allow in this chat"));

  await expect(
    screen.findByText(
      "Could not complete the action. Retry to check access and continue.",
    ),
  ).resolves.toHaveAttribute("role", "alert");

  // The server announces the granted request whose task is still pending.
  context.mocks.ably.trigger("vncAuthorizationChanged");

  await expect(
    screen.findByText("VNC access allowed"),
  ).resolves.toBeInTheDocument();
  expect(getAction("Continue task")).toBeEnabled();
  expect(getAction("Revoke")).toBeEnabled();
  expect(action("Allow in this chat")).toBeUndefined();

  click(getAction("Continue task"));

  await waitFor(() => {
    expect(action("Continue task")).toBeUndefined();
  });
  expect(screen.getByText("VNC access allowed")).toBeInTheDocument();
  expect(getAction("Revoke")).toBeEnabled();
  expect(action("Allow in this chat")).toBeUndefined();
});

test("VNC and SSH requests with the same ID remain separate actionable cards", async () => {
  mockNow(new Date(NOW), context.signal);
  mockVncRequest(vncRequest());
  const ssh: SshAuthorization = {
    ...vncRequest(),
    connectionId: "b0000000-0000-4000-8000-000000000001",
    displayName: "Build box",
    port: 22,
    username: "operator",
    authorizationUrl: `http://localhost/ssh/authorize/${REQUEST_ID}`,
  };
  context.mocks.api(sshAuthorizationContract.get, ({ respond }) => {
    return respond(200, ssh);
  });
  installRequestChat(
    [
      `Desktop: http://localhost/vnc/authorize/${REQUEST_ID}`,
      "",
      `Shell: http://localhost/ssh/authorize/${REQUEST_ID}`,
    ].join("\n"),
  );

  await setupPage({ context, path: `/chats/${context.resourceId}` });

  await expect(
    screen.findByText("VNC access · Work Mac"),
  ).resolves.toBeInTheDocument();
  expect(screen.getByText("SSH access · Build box")).toBeInTheDocument();
  expect(
    screen.getByText("ssh.example.com:5900 · This host · This chat only"),
  ).toBeInTheDocument();
  expect(
    screen.getByText(
      "operator@ssh.example.com:22 · This host · This chat only",
    ),
  ).toBeInTheDocument();
  expect(
    queryAllByRoleFast("button").filter((button) => {
      return button.textContent?.trim() === "Allow in this chat";
    }),
  ).toHaveLength(2);
});
