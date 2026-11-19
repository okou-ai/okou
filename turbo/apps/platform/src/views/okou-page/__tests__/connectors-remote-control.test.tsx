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

test("Remote control lists each connection and filters credentials by type", async () => {
  const deployment = sshHost(1, "Deployment");
  const analytics = sshHost(2, "Analytics");
  const design = vncHost(1, "Design desktop");
  mockRemoteInventory(context, {
    ssh: [deployment, analytics],
    vnc: [design],
    sshCredentials: [
      {
        id: remoteId("d", 1),
        name: "Deployment login",
        username: "deploy",
        authMethod: "private_key",
        revision: 1,
        createdAt: REMOTE_TIMESTAMP,
        updatedAt: REMOTE_TIMESTAMP,
        hosts: [
          { id: deployment.id, displayName: deployment.displayName },
          { id: analytics.id, displayName: analytics.displayName },
        ],
      },
    ],
    vncCredentials: [
      {
        id: remoteId("f", 1),
        name: "Desktop login",
        authMethod: "vnc_password",
        revision: 1,
        createdAt: REMOTE_TIMESTAMP,
        updatedAt: REMOTE_TIMESTAMP,
        hosts: [{ id: design.id, displayName: design.displayName }],
      },
    ],
  });

  await setupPage({ context, path: "/connectors?scope=remote-control" });

  const scope = await screen.findByRole("radio", { name: /^Remote control/u });
  await waitFor(() => {
    expect(screen.getByText("Deployment")).toBeInTheDocument();
    expect(screen.getByText("Analytics")).toBeInTheDocument();
    expect(screen.getByText("Design desktop")).toBeInTheDocument();
    expect(scope).toHaveTextContent(/^Remote control3$/u);
  });

  click(getConnectorAction("link", "Manage credentials"));
  const ssh = await screen.findByRole("region", { name: "SSH" });
  await expect(
    within(ssh).findByText("Deployment login"),
  ).resolves.toBeInTheDocument();

  click(screen.getByRole("radio", { name: "VNC" }));
  const vnc = await screen.findByRole("region", { name: "VNC" });
  await expect(
    within(vnc).findByText("Desktop login"),
  ).resolves.toBeInTheDocument();
  expect(getConnectorAction("button", "Add credential", vnc)).toBeEnabled();
});
