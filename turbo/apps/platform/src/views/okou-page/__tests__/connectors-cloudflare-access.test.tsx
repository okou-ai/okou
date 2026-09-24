import {
  cloudflareAccessContract,
  type CloudflareAccessConfig,
} from "@okouai/api-contracts/contracts/cloudflare-access";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  listAgent,
  mockConnectors,
  mockPublicConnectorStatus,
} from "./connector-page-test-helpers.ts";
import {
  getAction,
  queryAction,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();
const agentId = "c0000000-0000-4000-8000-000000000001";
const config: CloudflareAccessConfig = Object.freeze({
  id: "a0000000-0000-4000-8000-000000000001",
  name: "Protected applications",
  revision: 1,
  generation: 1,
  sshHosts: [],
  createdAt: "2026-09-22T00:00:00.000Z",
  updatedAt: "2026-09-22T00:00:00.000Z",
});

function mockRemoteAccess() {
  mockConnectors(context, []);
  mockPublicConnectorStatus(context, []);
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 1 });
  });
  context.mocks.api(vncConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 1 });
  });
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [config] });
  });
}

async function page(path = "/connectors") {
  await setupPage({
    context,
    path,
    featureSwitches: {
      [FeatureSwitchKey.ConnectorDirectory]: true,
      [FeatureSwitchKey.VncAccess]: true,
    },
  });
}

test("Private network lists Cloudflare Access configurations", async () => {
  mockRemoteAccess();
  await page("/connectors?scope=private-network");
  expect(screen.getByTestId("connectors-scope-private-network")).toBeVisible();
  await screen.findByRole("heading", { name: "Protected applications" });
  expect(getAction("button", "Add Cloudflare Access")).toBeVisible();
  expect(screen.queryByTestId("connector-category-remote-access")).toBeNull();
  expect(screen.queryByRole("heading", { name: "SSH" })).toBeNull();
});

test("Cloudflare Access is excluded from the Agent-sharing filter", async () => {
  mockRemoteAccess();
  let listed = false;
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    listed = true;
    return respond(200, { configs: [config] });
  });
  context.mocks.data.agents([listAgent(agentId, "Research")]);
  await page(
    `/connectors?scope=connected&keywords=cloudflare&connection=agent:${agentId}`,
  );
  await waitFor(() => {
    expect(listed).toBeTruthy();
  });
  expect(queryAction("link", "Manage Cloudflare Access")).toBeNull();
});
