import type { TailscaleConfig } from "@okouai/api-contracts/contracts/tailscale";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { getConnectorAction } from "./connector-page-test-helpers.ts";
import {
  mockRemoteInventory,
  REMOTE_TIMESTAMP,
  remoteId,
} from "./connectors-remote-control-test-helpers.ts";

const context = testContext();
function naturalNames(): string[] {
  return ["android", "DEV-1", "dev-1", "dev-2", "dev-11"];
}

function tailnet(
  index: number,
  name: string,
  overrides: Partial<TailscaleConfig> = {},
): TailscaleConfig {
  return {
    id: remoteId("a", index),
    name,
    scope: "personal",
    tags: ["tag:okou"],
    revision: 1,
    generation: 1,
    createdAt: REMOTE_TIMESTAMP,
    updatedAt: REMOTE_TIMESTAMP,
    sshHosts: [],
    vncHosts: [],
    ...overrides,
  };
}

function managedNetworks(section: HTMLElement): string[] {
  return queryAllByRoleFast("link", section).flatMap((link) => {
    const label = link.getAttribute("aria-label") ?? "";
    return label.startsWith("Manage ") ? [label.slice("Manage ".length)] : [];
  });
}

test("Private networks are sorted within their scope", async () => {
  mockRemoteInventory(context, {
    tailscale: [
      tailnet(1, "Network-11"),
      tailnet(2, "Org-11", { scope: "organization" }),
      tailnet(3, "Network-2"),
      tailnet(4, "Android network"),
      tailnet(5, "Org-2", { scope: "organization" }),
      tailnet(6, "Network-1"),
    ],
  });

  await setupPage({ context, path: "/connectors?scope=private-network" });

  const personal = await screen.findByRole("region", {
    name: "Personal networks",
  });
  expect(managedNetworks(personal)).toStrictEqual([
    "Android network",
    "Network-1",
    "Network-2",
    "Network-11",
  ]);
  expect(
    managedNetworks(
      screen.getByRole("region", { name: "Organization networks" }),
    ),
  ).toStrictEqual(["Org-2", "Org-11"]);
});

test("A tailscale network shows linked hosts in natural order", async () => {
  // Linked hosts arrive in saved order, not natural name order.
  const saved = ["dev-11", "android", "dev-2", "DEV-1", "dev-1"];
  mockRemoteInventory(context, {
    tailscale: [
      tailnet(1, "Home tailnet", {
        sshHosts: saved.map((displayName, index) => {
          return { id: remoteId("b", index + 1), displayName };
        }),
        vncHosts: saved.map((name, index) => {
          return {
            id: remoteId("e", index + 1),
            displayName: `desktop-${name}`,
            roles: ["rfb" as const],
          };
        }),
      }),
    ],
  });
  await setupPage({ context, path: "/connectors?scope=private-network" });
  await waitFor(() => {
    expect(
      getConnectorAction("link", "Manage Home tailnet"),
    ).toBeInTheDocument();
  });

  click(getConnectorAction("link", "Manage Home tailnet"));

  const usage = await screen.findByRole("heading", {
    name: "Connections using this network",
  });
  const section = usage.parentElement;
  if (!section) {
    throw new Error("Expected the network usage section");
  }
  expect(
    queryAllByRoleFast("listitem", section).map((item) => {
      return item.textContent;
    }),
  ).toStrictEqual([
    ...naturalNames(),
    ...naturalNames().map((name) => {
      return `desktop-${name}`;
    }),
  ]);
});
