import {
  cloudflareAccessContract,
  type CloudflareAccessImpactPreview,
  type ScopedCloudflareAccessConfig,
} from "@okouai/api-contracts/contracts/cloudflare-access";
import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import { tailscaleContract } from "@okouai/api-contracts/contracts/tailscale";
import {
  sshConnectionsContract,
  type SshConnectionResponse,
} from "@okouai/api-contracts/contracts/ssh-connections";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { getAction } from "./connector-integrations-test-helpers.ts";

const context = testContext();
const orgId = "org_cloudflare_parity";
const timestamp = "2026-10-13T00:00:00.000Z";
const config: ScopedCloudflareAccessConfig = Object.freeze({
  id: "a0000000-0000-4000-8000-000000000001",
  name: "Protected applications",
  scope: "personal",
  revision: 1,
  generation: 1,
  sshHosts: [],
  vncHosts: [],
  createdAt: timestamp,
  updatedAt: timestamp,
});
const shared: ScopedCloudflareAccessConfig = Object.freeze({
  ...config,
  scope: "organization",
});
const impact: CloudflareAccessImpactPreview = Object.freeze({
  expectedRevision: 1,
  ownHostCount: 0,
  otherHostCount: 2,
  affectedOwners: [{ userId: "other-owner", displayName: "Other Owner" }],
  impactSnapshot: "a".repeat(64),
});
const detailsPath = `/connectors?scope=private-network&remoteResource=cloudflare:${config.id}`;

beforeEach(() => {
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, { configs: [] });
  });
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [config] });
  });
});

async function page(path = detailsPath, role: "admin" | "member" = "member") {
  context.mocks.data.org({ id: orgId, name: "Engineering", role });
  await setupPage({
    context,
    path,
    auth: {
      user: { id: "access-owner", fullName: "Access Owner" },
      organization: {
        activeOrg: { id: orgId, name: "Engineering" },
        memberships: [{ id: orgId }],
      },
    },
  });
}

async function sharedDeletion() {
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [shared] });
  });
  await page(detailsPath, "admin");
  await screen.findByRole("heading", { name: shared.name });
  click(getAction("button", "Delete Cloudflare Access"));
  const dialog = await screen.findByRole("dialog", {
    name: "Delete Cloudflare Access",
  });
  await within(dialog).findByText(/Other Owner/u);
  await userEvent.click(within(dialog).getByRole("checkbox"));
  expect(getAction("button", "Delete Cloudflare Access", dialog)).toBeEnabled();
  return dialog;
}

test("An unchanged save returns to details without updating the configuration", async () => {
  context.mocks.api(cloudflareAccessContract.update, ({ respond }) => {
    return respond(500, {
      error: { code: "INTERNAL_ERROR", message: "Unavailable" },
    });
  });
  await page();
  await screen.findByRole("heading", { name: config.name });
  click(getAction("button", "Edit settings"));
  const name = await screen.findByLabelText("Network name");
  await fill(name, ` ${config.name} `);
  click(getAction("button", "Save network"));
  await screen.findByRole("heading", { name: config.name });
  expect(getAction("button", "Edit settings")).toBeInTheDocument();
});

test.each(["cloudflare-access:changed", "ssh:changed"])(
  "Shared deletion refreshes changed impact on %s and requires fresh confirmation",
  async (topic) => {
    let currentImpact = impact;
    context.mocks.api(cloudflareAccessContract.impactPreview, ({ respond }) => {
      return respond(200, currentImpact);
    });
    const dialog = await sharedDeletion();
    currentImpact = {
      ...impact,
      otherHostCount: 3,
      impactSnapshot: "b".repeat(64),
    };
    await act(() => {
      return context.mocks.ably.trigger(topic, { orgId });
    });
    await within(dialog).findByText(/1 member and 3 hosts/u);
    expect(within(dialog).getByRole("checkbox")).not.toBeChecked();
    expect(
      getAction("button", "Delete Cloudflare Access", dialog),
    ).toBeDisabled();
  },
);

test("Shared deletion keeps confirmation when a refreshed impact snapshot is unchanged", async () => {
  let currentImpact = impact;
  context.mocks.api(cloudflareAccessContract.impactPreview, ({ respond }) => {
    return respond(200, currentImpact);
  });
  const dialog = await sharedDeletion();
  currentImpact = {
    ...impact,
    affectedOwners: [{ userId: "other-owner", displayName: "Updated Owner" }],
  };
  await act(() => {
    return context.mocks.ably.trigger("cloudflare-access:changed", { orgId });
  });
  await within(dialog).findByText(/Updated Owner/u);
  expect(within(dialog).getByRole("checkbox")).toBeChecked();
  expect(getAction("button", "Delete Cloudflare Access", dialog)).toBeEnabled();
});

test("A network-only removal refreshes SSH rebind requirements and preserves default access", async () => {
  let removed = false;
  const host: SshConnectionResponse = {
    id: "c0000000-0000-4000-8000-000000000001",
    displayName: "Private server",
    host: "ssh.example.com",
    port: 443,
    username: "deploy",
    credentialId: "b0000000-0000-4000-8000-000000000001",
    credentialName: "SSH login",
    generation: 1,
    learnedHostKey: null,
    transport: { type: "cloudflare_access", configId: config.id },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, {
      configs: removed
        ? []
        : [
            {
              ...shared,
              sshHosts: [{ id: host.id, displayName: host.displayName }],
            },
          ],
    });
  });
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 1 });
  });
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, {
      connections: [
        removed
          ? {
              ...host,
              generation: 2,
              transport: { type: "cloudflare_access", needsRebind: true },
            }
          : host,
      ],
    });
  });
  context.mocks.api(sshConnectionsContract.observations, ({ respond }) => {
    return respond(200, { observations: [] });
  });
  context.mocks.api(
    chatRemoteAccessContract.listHostDefaults,
    ({ respond }) => {
      return respond(200, {
        ssh: [
          {
            connectionId: host.id,
            displayName: host.displayName,
            defaultEnabled: true,
          },
        ],
        vnc: [],
      });
    },
  );
  await page(`/connectors?scope=remote-control&remoteResource=ssh:${host.id}`);
  await screen.findByRole("heading", { name: host.displayName });
  const toggle = await screen.findByRole("switch", {
    name: "Enabled by default for chats",
  });
  await waitFor(() => {
    expect(toggle).toBeChecked();
  });
  removed = true;
  await act(() => {
    return context.mocks.ably.trigger("cloudflare-access:changed", { orgId });
  });
  await screen.findByText(
    "This host needs a new Cloudflare Access configuration. Edit it to rebind or choose Direct. It will not connect until you do.",
  );
  expect(
    screen.getByRole("switch", { name: "Enabled by default for chats" }),
  ).toBeChecked();
});
