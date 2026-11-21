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

test("connectors-cloudflare-access-001 Private network offers management for the listed Cloudflare configuration", async () => {
  const name = "Protected applications";
  mockRemoteInventory(context, {
    ssh: [sshHost(1, "Shell host")],
    vnc: [vncHost(1, "Desktop")],
    cloudflare: [
      {
        id: crypto.randomUUID(),
        scope: "personal",
        name,
        generation: 1,
        revision: 1,
        createdAt: REMOTE_TIMESTAMP,
        updatedAt: REMOTE_TIMESTAMP,
        sshHosts: [],
        vncHosts: [],
      },
    ],
  });
  await setupPage({ context, path: "/connectors" });
  click(await findFastControl("radio", /^Private network/i));
  const networks = await screen.findByRole("region", {
    name: /private network/i,
  });
  await within(networks).findByText(name);
  await expect(
    findFastControl("button", "Add network", networks),
  ).resolves.toBeEnabled();
  await expect(
    findNamedLink("Manage Protected applications", networks),
  ).resolves.toBeInTheDocument();
});
