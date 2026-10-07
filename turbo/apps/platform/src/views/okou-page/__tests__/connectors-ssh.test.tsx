import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getConnectorAction,
  mockConnectors,
  mockPublicConnectorStatus,
} from "./connector-page-test-helpers.ts";

const context = testContext();

const orgId = "org_ssh_card";

function sshHost(index: number) {
  return {
    id: `b0000000-0000-4000-8000-00000000000${index}`,
    displayName: `Host ${index}`,
    host: `host-${index}.example.com`,
    port: 22,
    username: "deploy",
    credentialId: "d0000000-0000-4000-8000-000000000001",
    credentialName: "Deploy login",
    generation: 1,
    learnedHostKey: null,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
  };
}

function mockSshHosts(count: number) {
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: count });
  });
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, {
      connections: Array.from({ length: count }, (_, index) => {
        return sshHost(index + 1);
      }),
    });
  });
  context.mocks.api(sshCredentialsContract.list, ({ respond }) => {
    return respond(200, { credentials: [] });
  });
}

test("Remote control summarizes SSH hosts that need attention and recovers", async () => {
  mockCatalog();
  mockSshHosts(3);
  let failed = true;
  context.mocks.api(sshConnectionsContract.observations, ({ respond }) => {
    return respond(200, {
      observations: [
        {
          connectionId: sshHost(1).id,
          generation: 1,
          observedAt: "2026-09-10T08:00:00.000Z",
          failureReason: failed ? "authentication_failed" : null,
        },
        {
          connectionId: sshHost(2).id,
          generation: 1,
          observedAt: "2026-09-10T08:00:00.000Z",
          failureReason: failed ? "network_failure" : null,
        },
        {
          connectionId: sshHost(3).id,
          generation: 1,
          observedAt: "2026-09-10T08:00:00.000Z",
          failureReason: null,
        },
      ],
    });
  });
  await setupPage({
    context,
    path: "/connectors?scope=remote-control&type=ssh",
    auth: {
      user: { id: "test-user-123", fullName: "Test User" },
      organization: {
        activeOrg: { id: orgId, name: "SSH test organization" },
        memberships: [{ id: orgId }],
      },
    },
  });
  await screen.findByRole("status", { name: "2 SSH hosts need attention" });
  expect(screen.getByText("Host 3")).toBeInTheDocument();
  failed = false;
  context.mocks.ably.trigger("ssh:changed", { orgId });
  await waitFor(() => {
    expect(
      screen.queryByRole("status", { name: "2 SSH hosts need attention" }),
    ).toBeNull();
  });
  expect(screen.getByText("Host 1")).toBeInTheDocument();
});

test("Remote control distinguishes unavailable SSH diagnostics from failed hosts", async () => {
  mockCatalog();
  mockSshHosts(2);
  context.mocks.api(sshConnectionsContract.observations, ({ respond }) => {
    return respond(500, {
      error: { code: "INTERNAL_SERVER_ERROR", message: "private error" },
    });
  });
  await page("/connectors?scope=remote-control&type=ssh");
  await screen.findByRole("status", {
    name: "SSH connection status is unavailable",
  });
  expect(screen.queryByText(/need attention/u)).toBeNull();
  expect(screen.queryByText("private error")).toBeNull();
  expect(screen.getByText("Host 2")).toBeInTheDocument();
});

function mockCatalog() {
  mockConnectors(context, []);
  mockPublicConnectorStatus(context, []);
}

async function page(path: string) {
  await setupPage({ context, path });
}

test("Deleting an SSH host referenced by VNC explains how to resolve the dependency", async () => {
  mockCatalog();
  const host = {
    id: "b0000000-0000-4000-8000-000000000001",
    displayName: "VNC gateway",
    host: "gateway.example.com",
    port: 22,
    username: "deploy",
    credentialId: "d0000000-0000-4000-8000-000000000001",
    credentialName: "Gateway login",
    generation: 1,
    learnedHostKey: null,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
  };
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 1 });
  });
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [host] });
  });
  context.mocks.api(sshConnectionsContract.delete, ({ respond }) => {
    return respond(409, {
      error: {
        code: "SSH_CONNECTION_IN_USE",
        message: "private dependency detail",
      },
    });
  });
  await page("/connectors?scope=remote-control&type=ssh");
  await screen.findByText(host.displayName);
  click(getConnectorAction("button", "Delete host"));
  const dialog = await screen.findByRole("dialog", { name: "Delete host" });
  click(getConnectorAction("button", "Delete host", dialog));
  await within(dialog).findByText(/This SSH host is used by a VNC route/u);
  expect(
    within(dialog).getByText(/switch them explicitly to Direct/u),
  ).toBeInTheDocument();
  expect(document.body.textContent).not.toContain("private dependency detail");
  expect(dialog).toBeInTheDocument();
});
