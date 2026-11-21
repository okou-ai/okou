import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { findNamedLink } from "./chat-attachment-test-helpers.ts";
import {
  mockRemoteInventory,
  REMOTE_TIMESTAMP,
  sshHost,
  vncHost,
} from "./connectors-remote-control-test-helpers.ts";

const context = testContext();

test("connectors-remote-control-001 the connection inventory links to type-specific credentials", async () => {
  const sshKey = crypto.randomUUID();
  const desktopKey = crypto.randomUUID();
  const deployment = sshHost(1, "Deployment", { credentialId: sshKey });
  const analytics = sshHost(2, "Analytics", { credentialId: sshKey });
  const desktop = vncHost(1, "Design desktop", { credentialId: desktopKey });
  const metadata = {
    revision: 1,
    createdAt: REMOTE_TIMESTAMP,
    updatedAt: REMOTE_TIMESTAMP,
  };
  mockRemoteInventory(context, {
    ssh: [deployment, analytics],
    vnc: [desktop],
    sshCredentials: [
      {
        ...metadata,
        id: sshKey,
        name: "Deployment login",
        authMethod: "password",
        username: "deploy",
        hosts: [deployment, analytics].map(({ id, displayName }) => {
          return {
            id,
            displayName,
          };
        }),
      },
    ],
    vncCredentials: [
      {
        ...metadata,
        id: desktopKey,
        name: "Desktop login",
        authMethod: "vnc_password",
        hosts: [{ id: desktop.id, displayName: desktop.displayName }],
      },
    ],
  });
  await setupPage({ context, path: "/connectors?scope=remote-control" });
  const scope = await findFastControl("radio", /^Remote control\s*3$/i);
  expect(scope).toHaveAttribute("aria-checked", "true");
  const list = await screen.findByRole("list", { name: "Remote connections" });
  for (const label of ["Deployment", "Analytics", "Design desktop"]) {
    await within(list).findByText(label);
  }
  click(await findNamedLink("Manage credentials"));
  const ssh = await screen.findByRole("region", { name: "SSH" });
  await within(ssh).findByText("Deployment login");
  click(await findFastControl("radio", "VNC"));
  const vnc = await screen.findByRole("region", { name: "VNC" });
  await within(vnc).findByText("Desktop login");
  expect(within(vnc).queryByText("Deployment login")).not.toBeInTheDocument();
  await expect(
    findFastControl("button", "Add credential", vnc),
  ).resolves.toBeEnabled();
});
