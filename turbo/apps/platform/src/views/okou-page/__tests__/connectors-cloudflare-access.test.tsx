import {
  cloudflareAccessContract,
  type CloudflareAccessConfig,
} from "@okouai/api-contracts/contracts/cloudflare-access";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
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

function mockRemoteAccess(configured: boolean) {
  mockConnectors(context, []);
  mockPublicConnectorStatus(context, []);
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: configured ? 1 : 0 });
  });
  context.mocks.api(vncConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: configured ? 1 : 0 });
  });
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: configured ? [config] : [] });
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

test.each([false, true])(
  "Remote access keeps SSH, VNC, then Cloudflare Access order (configured: %s)",
  async (configured) => {
    mockRemoteAccess(configured);
    await page(configured ? "/connectors?scope=connected" : "/connectors");
    const container = configured
      ? await screen.findByTestId("connectors-connected-grid")
      : await screen.findByTestId("connector-category-remote-access");
    expect(
      within(container)
        .getAllByTestId("connector-card-label")
        .map((label) => {
          return label.textContent;
        }),
    ).toStrictEqual(["SSH", "VNC", "Cloudflare Access"]);
    expect(
      getAction("link", "Manage Cloudflare Access", container),
    ).toHaveAttribute(
      "href",
      configured
        ? "/connectors/cloudflare-access"
        : "/connectors/cloudflare-access?add=1",
    );
    const cloudflareCard = within(container)
      .getByText("Cloudflare Access")
      .closest('[data-slot="connector-card"]');
    expect(cloudflareCard).not.toBeNull();
    expect(
      within(cloudflareCard as HTMLElement).queryByTestId(
        "connector-card-agent-access",
      ),
    ).toBeNull();
  },
);

test.each(["unshared", `agent:${agentId}`])(
  "Cloudflare Access is excluded from the %s Agent-sharing filter",
  async (connection) => {
    mockRemoteAccess(true);
    let listed = false;
    context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
      listed = true;
      return respond(200, { configs: [config] });
    });
    context.mocks.data.agents([listAgent(agentId, "Research")]);
    await page(
      `/connectors?scope=connected&keywords=cloudflare&connection=${connection}`,
    );
    await waitFor(() => {
      expect(listed).toBeTruthy();
    });
    expect(queryAction("link", "Manage Cloudflare Access")).toBeNull();
  },
);

test("The connected directory names Cloudflare Access while its summary loads", async () => {
  mockRemoteAccess(false);
  const pending = context.mocks.deferred<void>();
  context.mocks.api(cloudflareAccessContract.list, async ({ respond }) => {
    await pending.promise;
    return respond(200, { configs: [] });
  });
  await page("/connectors?scope=connected");
  await expect(
    screen.findByText("Loading Cloudflare Access…"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText("Loading VNC hosts…")).toBeNull();
  pending.resolve();
  await waitFor(() => {
    expect(screen.queryByText("Loading Cloudflare Access…")).toBeNull();
  });
});
