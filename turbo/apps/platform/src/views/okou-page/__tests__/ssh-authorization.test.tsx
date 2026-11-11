import {
  sshAuthorizationContract as contract,
  type SshAuthorization,
} from "@okouai/api-contracts/contracts/ssh-authorization";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { now } from "../../../lib/time.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const id = "10000000-0000-4000-8000-000000000001";
const threadId = "20000000-0000-4000-8000-000000000001";
const path = `/ssh/authorize/${id}`;
const url = `https://app.okou.ai${path}`;
function request(overrides: Partial<SshAuthorization> = {}): SshAuthorization {
  return {
    id,
    connectionId: id,
    chatThreadId: threadId,
    requestedByRunId: "30000000-0000-4000-8000-000000000001",
    displayName: "Work Mac",
    host: "ssh.example.com",
    port: 22,
    username: "deploy",
    reason: "Verify SSH login and inspect the project",
    status: "pending",
    requestExpiresAt: new Date(now() + 3_600_000).toISOString(),
    enabled: false,
    continuationPending: false,
    approvalBlockedReason: null,
    requiredPermissions: [],
    authorizationUrl: url,
    ...overrides,
  };
}
function button(card: HTMLElement, name: string) {
  const result = queryAllByRoleFast("button", card).find((value) => {
    return (
      (value.textContent?.trim() || value.getAttribute("aria-label")) === name
    );
  });
  if (!result) {
    throw new Error(`Missing button: ${name}`);
  }
  return result;
}
async function chat(content = url) {
  mockChatLifecycle(context, {
    threadId,
    threadTitle: "SSH setup",
    chatEvents: [
      {
        id: "ssh-request",
        role: "assistant",
        runId: "source-run",
        content,
        createdAt: "2026-11-11T03:00:00.000Z",
      },
    ],
  });
  await setupPage({ context, path: `/chats/${threadId}`, host: "app.okou.ai" });
}

test("The inline card allows only this chat and shows the remote user and access effect", async () => {
  let current = request();
  let approvals = 0;
  context.mocks.api(contract.get, ({ respond }) => {
    return respond(200, current);
  });
  context.mocks.api(contract.approve, ({ respond }) => {
    approvals++;
    current = request({ status: "approved", enabled: true });
    return respond(200, current);
  });
  context.mocks.api(contract.revoke, ({ respond }) => {
    current = request({ status: "revoked", enabled: false });
    return respond(200, current);
  });
  await chat(`SSH setup is ready.\n\n[Review access](${url})`);
  const card = await screen.findByTestId("ssh-authorization-card");
  await waitFor(() => {
    return expect(button(card, "Allow in this chat")).toBeEnabled();
  });
  expect(card).toHaveTextContent("deploy@ssh.example.com:22");
  expect(card).toHaveTextContent("This host · This chat only");
  click(button(card, "Access details"));
  const details = await screen.findByRole("dialog", { name: "Access details" });
  expect(details).toHaveTextContent("commands and file transfers");
  expect(details).toHaveTextContent("Verify SSH login and inspect the project");
  click(button(card, "Access details"));
  click(button(card, "Allow in this chat"));
  await within(card).findByText("SSH access allowed · Work Mac");
  expect(approvals).toBe(1);
  click(button(card, "Revoke"));
  await within(card).findByText("SSH access revoked · Work Mac");
});

test("The direct page waits for connector approvals and requesting Run completion", async () => {
  let current = request({
    approvalBlockedReason: "permissions_required",
    requiredPermissions: [
      { connectorSlug: "cloudflare", permission: "dns.write" },
    ],
  });
  context.mocks.api(contract.get, ({ respond }) => {
    return respond(200, current);
  });
  context.mocks.api(contract.approve, ({ respond }) => {
    current = request({ status: "approved", enabled: true });
    return respond(200, current);
  });
  await setupPage({ context, path, host: "app.okou.ai" });
  const card = await screen.findByTestId("ssh-authorization-card");
  await within(card).findByText(
    "Approve the accompanying connector permissions first.",
  );
  expect(button(card, "Allow in this chat")).toBeDisabled();
  expect(card).toHaveTextContent("cloudflare / dns.write");
  current = request({ approvalBlockedReason: "run_active" });
  context.mocks.ably.trigger("connectorPermissionUpdated");
  await within(card).findByText(
    "Wait for the requesting Run to finish before approving.",
  );
  current = request();
  context.mocks.ably.trigger("desktopShellAuthorizationChanged");
  await waitFor(() => {
    return expect(button(card, "Allow in this chat")).toBeEnabled();
  });
  click(button(card, "Allow in this chat"));
  await within(card).findByText("SSH access allowed");
});

test("A forwarded card cannot approve a request belonging to a different chat", async () => {
  context.mocks.api(contract.get, ({ respond }) => {
    return respond(
      200,
      request({ chatThreadId: "40000000-0000-4000-8000-000000000001" }),
    );
  });
  await chat(url);
  const card = await screen.findByTestId("ssh-authorization-card");
  await expect(
    within(card).findByText(
      "This request is unavailable. Ask for a new request.",
    ),
  ).resolves.toBeInTheDocument();
});

test("Continuation failure can be retried on the approved request without a second grant", async () => {
  let current = request();
  let attempts = 0;
  context.mocks.api(contract.get, ({ respond }) => {
    return respond(200, current);
  });
  context.mocks.api(contract.approve, ({ respond }) => {
    attempts++;
    if (attempts === 1) {
      current = request({
        status: "approved",
        enabled: true,
        continuationPending: true,
      });
      context.mocks.ably.trigger("sshAuthorizationChanged");
      return respond(503, {
        error: { code: "CONTINUATION_UNAVAILABLE", message: "Try again" },
      });
    }
    current = request({ status: "approved", enabled: true });
    return respond(200, current);
  });
  await setupPage({ context, path, host: "app.okou.ai" });
  const card = await screen.findByTestId("ssh-authorization-card");
  await waitFor(() => {
    return expect(button(card, "Allow in this chat")).toBeEnabled();
  });
  click(button(card, "Allow in this chat"));
  await within(card).findByRole("alert");
  click(button(card, "Continue task"));
  await waitFor(() => {
    return expect(
      queryAllByRoleFast("button", card).map((value) => {
        return value.textContent?.trim();
      }),
    ).toStrictEqual(["Revoke"]);
  });
  expect(attempts).toBe(2);
});
