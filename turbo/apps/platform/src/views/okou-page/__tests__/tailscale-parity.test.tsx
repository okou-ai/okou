import {
  tailscaleContract,
  type TailscaleConfig,
} from "@okouai/api-contracts/contracts/tailscale";
import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import { act, screen } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { getAction } from "./connector-integrations-test-helpers.ts";

const context = testContext();
const orgId = "org_tailscale_parity";
const config: TailscaleConfig = Object.freeze({
  id: "a0000000-0000-4000-8000-000000000001",
  name: "Development network",
  scope: "personal",
  tags: ["tag:okou", "tag:build"],
  revision: 1,
  generation: 1,
  sshHosts: [],
  vncHosts: [],
  createdAt: "2026-10-12T00:00:00.000Z",
  updatedAt: "2026-10-12T00:00:00.000Z",
});

beforeEach(() => {
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [] });
  });
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, { configs: [config] });
  });
});

async function page() {
  context.mocks.data.org({ id: orgId, name: "Engineering", role: "admin" });
  await setupPage({
    context,
    auth: {
      user: { id: "tailscale-owner", fullName: "Tailscale Owner" },
      organization: {
        activeOrg: { id: orgId, name: "Engineering" },
        memberships: [{ id: orgId }],
      },
    },
    path: `/connectors?scope=private-network&remoteResource=tailscale:${config.id}`,
  });
  await screen.findByRole("heading", { name: config.name });
}

async function edit() {
  click(getAction("button", "Edit settings"));
  return await screen.findByLabelText("Network name");
}

test("A common SSH notice refreshes network usage and restores deletion after unbinding", async () => {
  let current = config;
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, { configs: [current] });
  });
  await page();
  await screen.findByText("Not used by any of your hosts");
  expect(getAction("button", "Delete Tailscale")).toBeEnabled();
  current = {
    ...config,
    sshHosts: [
      {
        id: "b0000000-0000-4000-8000-000000000001",
        displayName: "New private server",
      },
    ],
  };
  await act(() => {
    return context.mocks.ably.trigger("ssh:changed", { orgId });
  });
  await screen.findByText("New private server");
  expect(getAction("button", "Delete Tailscale")).toBeDisabled();
  current = config;
  await act(() => {
    return context.mocks.ably.trigger("ssh:changed", { orgId });
  });
  await screen.findByText("Not used by any of your hosts");
  expect(getAction("button", "Delete Tailscale")).toBeEnabled();
});

test("Saving unchanged normalized metadata returns to details even when writes are unavailable", async () => {
  context.mocks.api(tailscaleContract.update, ({ respond }) => {
    return respond(500, {
      error: { code: "INTERNAL_ERROR", message: "Writes unavailable" },
    });
  });
  await page();
  const name = await edit();
  await fill(name, `  ${config.name}  `);
  await fill(screen.getByLabelText("Allowed tags"), "tag:okou, tag:build");
  click(getAction("button", "Save network"));
  await screen.findByRole("heading", { name: config.name });
  expect(getAction("button", "Edit settings")).toBeInTheDocument();
});

test("An intentional tag-order edit is saved against the current revision", async () => {
  let current = config;
  const requests: unknown[] = [];
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, { configs: [current] });
  });
  context.mocks.api(tailscaleContract.update, ({ body, respond }) => {
    requests.push(body);
    current = { ...config, tags: body.tags ?? config.tags, revision: 2 };
    return respond(200, current);
  });
  await page();
  await edit();
  await fill(screen.getByLabelText("Allowed tags"), "tag:build, tag:okou");
  click(getAction("button", "Save network"));
  await screen.findByRole("heading", { name: config.name });
  await screen.findByText("tag:build, tag:okou");
  expect(requests).toStrictEqual([
    { expectedRevision: 1, name: config.name, tags: ["tag:build", "tag:okou"] },
  ]);
});
