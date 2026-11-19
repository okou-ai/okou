import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { getConnectorAction } from "./connector-page-test-helpers.ts";
import {
  mockRemoteInventory,
  REMOTE_TIMESTAMP,
  remoteId,
  sshHost,
  vncHost,
} from "./connectors-remote-control-test-helpers.ts";

const context = testContext();

test("Private network lists Cloudflare Access configurations", async () => {
  mockRemoteInventory(context, {
    ssh: [sshHost(1, "Deployment")],
    vnc: [vncHost(1, "Design desktop")],
    cloudflare: [
      {
        id: remoteId("c", 1),
        name: "Protected applications",
        scope: "personal",
        revision: 1,
        generation: 1,
        createdAt: REMOTE_TIMESTAMP,
        updatedAt: REMOTE_TIMESTAMP,
        sshHosts: [],
        vncHosts: [],
      },
    ],
  });

  await setupPage({ context, path: "/connectors" });
  click(await screen.findByRole("radio", { name: /^Private network/u }));

  const view = await screen.findByRole("region", { name: "Private networks" });
  await waitFor(() => {
    expect(within(view).getByText("Protected applications")).toBeVisible();
  });
  expect(getConnectorAction("button", "Add network", view)).toBeEnabled();
  expect(
    getConnectorAction("link", "Manage Protected applications", view),
  ).toBeInTheDocument();
});
