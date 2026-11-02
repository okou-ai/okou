import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import { tailscaleContract } from "@okouai/api-contracts/contracts/tailscale";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  mockConnectors,
  mockPublicConnectorStatus,
} from "./connector-page-test-helpers.ts";
import {
  mockHostInventories,
  orderedNames,
  resourceId,
  sshHosts,
  timestamp,
  vncHosts,
} from "./remote-resource-order-test-helpers.ts";

const context = testContext();

function network(
  name: string,
  index: number,
  scope: "personal" | "organization" = "personal",
) {
  return {
    id: resourceId("c", index),
    name,
    scope,
    revision: 1,
    generation: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    sshHosts: sshHosts.map(({ id, displayName }) => {
      return { id, displayName };
    }),
    vncHosts: vncHosts.map(({ id, displayName }) => {
      return { id, displayName, roles: ["rfb" as const] };
    }),
  };
}

function mockNetworks(): void {
  mockConnectors(context, []);
  mockPublicConnectorStatus(context, []);
  mockHostInventories(context);
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, {
      configs: [
        network("Network-11", 0),
        network("Network-2", 1),
        network("Org-11", 4, "organization"),
      ].map((config) => {
        return { ...config, tags: ["tag:okou"] };
      }),
    });
  });
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, {
      configs: [
        network("Network-1", 2),
        network("Android network", 3),
        network("Org-2", 5, "organization"),
      ],
    });
  });
}

test("Private networks are sorted within their scope", async () => {
  mockNetworks();
  await setupPage({
    context,
    path: "/connectors?scope=private-network",
  });
  await screen.findByText("Android network");
  await screen.findByText("Network-2");
  const personal = screen.getByRole("region", {
    name: "Personal networks",
  });
  const organization = screen.getByRole("region", {
    name: "Organization networks",
  });
  const renderedGroups = [personal, organization].map((group) => {
    return queryAllByRoleFast("link", group).map((link) => {
      return link.getAttribute("aria-label");
    });
  });
  expect(renderedGroups).toStrictEqual([
    [
      "Manage Android network",
      "Manage Network-1",
      "Manage Network-2",
      "Manage Network-11",
    ],
    ["Manage Org-2", "Manage Org-11"],
  ]);
});

test.each(["tailscale", "cloudflare"] as const)(
  "A %s network shows linked hosts in natural order",
  async (kind) => {
    mockNetworks();
    await setupPage({
      context,
      path: `/connectors?scope=private-network&remoteResource=${kind}:${resourceId("c", kind === "tailscale" ? 0 : 2)}`,
    });
    const list = await screen.findByRole("list", {
      name: "Connections using this network",
    });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => {
          return item.textContent;
        }),
    ).toStrictEqual([
      ...orderedNames,
      ...orderedNames.map((name) => {
        return `desktop-${name}`;
      }),
    ]);
  },
);
