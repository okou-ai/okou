import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import { tailscaleContract } from "@okouai/api-contracts/contracts/tailscale";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getConnectorAction,
  mockConnectors,
  mockPublicConnectorStatus,
} from "./connector-page-test-helpers.ts";
import { chooseSshConnectionType } from "./connector-integrations-test-helpers.ts";
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

test.each([false, true])(
  "Private networks are sorted within their scope with guided setup %s",
  async (guided) => {
    mockNetworks();
    await setupPage({
      context,
      path: "/connectors?scope=private-network",
      featureSwitches: { [FeatureSwitchKey.RemoteControlGuidedSetup]: guided },
    });
    await screen.findByText("Android network");
    await screen.findByText("Network-2");
    let renderedGroups: (string | null)[][];
    if (guided) {
      const personal = screen.getByRole("region", {
        name: "Personal networks",
      });
      const organization = screen.getByRole("region", {
        name: "Organization networks",
      });
      renderedGroups = [personal, organization].map((group) => {
        return queryAllByRoleFast("link", group).map((link) => {
          return link.getAttribute("aria-label");
        });
      });
    } else {
      const tailscale = screen.getByRole("region", { name: "Tailscale" });
      const cloudflare = screen.getByRole("region", {
        name: "Cloudflare Access",
      });
      renderedGroups = [tailscale, cloudflare].map((group) => {
        return within(group)
          .getAllByRole("article")
          .map((card) => {
            return within(card).getByRole("heading").textContent;
          });
      });
    }
    expect(renderedGroups).toStrictEqual(
      guided
        ? [
            [
              "Manage Android network",
              "Manage Network-1",
              "Manage Network-2",
              "Manage Network-11",
            ],
            ["Manage Org-2", "Manage Org-11"],
          ]
        : [
            ["Network-2", "Network-11", "Org-11"],
            ["Android network", "Network-1", "Org-2"],
          ],
    );
  },
);

test.each(["tailscale", "cloudflare"] as const)(
  "A %s network shows linked hosts in natural order",
  async (kind) => {
    mockNetworks();
    await setupPage({
      context,
      path: `/connectors?scope=private-network&remoteResource=${kind}:${resourceId("c", kind === "tailscale" ? 0 : 2)}`,
      featureSwitches: { [FeatureSwitchKey.RemoteControlGuidedSetup]: true },
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

test("SSH network choices are naturally ordered within their existing groups", async () => {
  mockNetworks();
  await setupPage({
    context,
    path: "/connectors?scope=remote-control",
    featureSwitches: { [FeatureSwitchKey.RemoteControlGuidedSetup]: false },
  });
  await screen.findByRole("heading", { name: "android" });
  const ssh = screen.getByRole("region", { name: "SSH" });
  click(getConnectorAction("button", "Add host", ssh));
  const dialog = await screen.findByRole("dialog");
  await chooseSshConnectionType(dialog, "Tailscale");
  click(await within(dialog).findByRole("combobox", { name: "Tailscale" }));
  const list = await screen.findByRole("listbox");
  expect(
    within(list)
      .getAllByRole("option")
      .map((option) => {
        return option.textContent;
      }),
  ).toStrictEqual([
    "Network-2",
    "Network-11",
    "Create new Tailscale network",
    "Org-11",
  ]);
});
