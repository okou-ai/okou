import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  cloudflareAccessContract,
  type CloudflareAccessImpactPreview,
  type ScopedCloudflareAccessConfig,
} from "@okouai/api-contracts/contracts/cloudflare-access";
import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
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
const operations = ["convert", "delete"] as const;

beforeEach(() => {
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [config] });
  });
});

async function page(
  role: "admin" | "member" = "member",
  path = "/connectors?scope=private-network",
) {
  context.mocks.data.org({ id: orgId, name: "Engineering", role });
  await setupPage({
    context,
    featureSwitches: { [FeatureSwitchKey.RemoteControlGuidedSetup]: false },
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

async function sharedDialog(operation: (typeof operations)[number]) {
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [shared] });
  });
  await page("admin");
  const organization = await screen.findByRole("region", {
    name: "Organization",
  });
  await within(organization).findByText(shared.name);
  const action =
    operation === "convert" ? "Make personal" : "Delete Cloudflare Access";
  click(getAction("button", action, organization));
  const dialog = await screen.findByRole("dialog", { name: action });
  await within(dialog).findByText(/Other Owner/u);
  await userEvent.click(within(dialog).getByRole("checkbox"));
  expect(getAction("button", action, dialog)).toBeEnabled();
  return { dialog, action };
}

test("An unchanged save closes the editor without updating the configuration", async () => {
  context.mocks.api(cloudflareAccessContract.update, ({ respond }) => {
    return respond(500, {
      error: { code: "INTERNAL_ERROR", message: "Unavailable" },
    });
  });
  await page();
  await screen.findByText(config.name);
  click(getAction("button", "Edit Cloudflare Access"));
  const dialog = await screen.findByRole("dialog");
  await fill(within(dialog).getByLabelText("Name"), ` ${config.name} `);
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(screen.getByText(config.name)).toBeInTheDocument();
});

test.each(
  operations.flatMap((operation) => {
    return ["cloudflare-access:changed", "ssh:changed"].map((topic) => {
      return { operation, topic };
    });
  }),
)(
  "$operation refreshes changed impact on $topic and requires fresh confirmation",
  async ({ operation, topic }) => {
    let currentImpact = impact;
    context.mocks.api(cloudflareAccessContract.impactPreview, ({ respond }) => {
      return respond(200, currentImpact);
    });
    const { dialog, action } = await sharedDialog(operation);
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
    expect(getAction("button", action, dialog)).toBeDisabled();
  },
);

test.each(operations)(
  "%s keeps confirmation when a refreshed impact snapshot is unchanged",
  async (operation) => {
    let currentImpact = impact;
    context.mocks.api(cloudflareAccessContract.impactPreview, ({ respond }) => {
      return respond(200, currentImpact);
    });
    const { dialog, action } = await sharedDialog(operation);
    currentImpact = {
      ...impact,
      affectedOwners: [{ userId: "other-owner", displayName: "Updated Owner" }],
    };
    await act(() => {
      return context.mocks.ably.trigger("cloudflare-access:changed", { orgId });
    });
    await within(dialog).findByText(/Updated Owner/u);
    expect(within(dialog).getByRole("checkbox")).toBeChecked();
    expect(getAction("button", action, dialog)).toBeEnabled();
  },
);

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
              vncHosts: [],
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
  await page("member", "/connectors?scope=remote-control&type=ssh");
  await screen.findByText(host.displayName);
  const toggle = await screen.findByRole("switch", {
    name: "Enabled by default for chats",
  });
  await waitFor(() => {
    return expect(toggle).toBeChecked();
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

test("Background network revalidation preserves an open name and credential draft", async () => {
  let current = config;
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [current] });
  });
  await page();
  await screen.findByText(config.name);
  click(getAction("button", "Edit Cloudflare Access"));
  const dialog = await screen.findByRole("dialog");
  await fill(within(dialog).getByLabelText("Name"), "Local draft");
  await userEvent.click(within(dialog).getByRole("checkbox"));
  const secret = within(dialog).getByLabelText("Service Token Client Secret");
  await fill(secret, "draft-secret");
  current = { ...config, name: "Server rename", revision: 2 };
  await act(() => {
    return context.mocks.ably.trigger("cloudflare-access:changed", { orgId });
  });
  await screen.findByText(current.name);
  expect(within(dialog).getByLabelText("Name")).toHaveValue("Local draft");
  expect(secret).toHaveValue("draft-secret");
});
