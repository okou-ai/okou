import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import {
  mockRemoteInventory,
  remoteId,
  sshHost,
  vncHost,
  REMOTE_TIMESTAMP,
} from "./connectors-remote-control-test-helpers.ts";
const context = testContext(),
  sshName = "Archive shell",
  vncName = "Archive desktop";
async function directory(mode: "ready" | "missing-vnc" | "failed" = "ready") {
  const gateway = remoteId("a", 49),
    ssh = sshHost(61, sshName, {
      transport: { type: "cloudflare_access", configId: gateway },
    }),
    vnc = vncHost(62, vncName);
  mockRemoteInventory(context, {
    ssh: [ssh],
    vnc: [vnc],
    cloudflare: [
      {
        id: gateway,
        scope: "organization",
        name: "Archive team network",
        generation: 1,
        revision: 1,
        createdAt: REMOTE_TIMESTAMP,
        updatedAt: REMOTE_TIMESTAMP,
        sshHosts: [{ id: ssh.id, displayName: sshName }],
        vncHosts: [],
      },
    ],
  });
  const defaults = {
    ssh: [{ connectionId: ssh.id, displayName: sshName, defaultEnabled: true }],
    vnc:
      mode === "missing-vnc"
        ? []
        : [
            {
              connectionId: vnc.id,
              displayName: vncName,
              defaultEnabled: false,
            },
          ],
  };
  context.mocks.api(
    chatRemoteAccessContract.listHostDefaults,
    ({ respond }) => {
      return mode === "failed"
        ? respond(500, {
            error: {
              code: "REMOTE_ACCESS_UNAVAILABLE",
              message: "Local settings unavailable",
            },
          })
        : respond(200, defaults);
    },
  );
  context.mocks.api(
    chatRemoteAccessContract.updateHostDefault,
    ({ params, body, respond }) => {
      const row = defaults[params.protocol].find((item) => {
        return item.connectionId === params.connectionId;
      });
      if (!row) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Unknown device" },
        });
      }
      row.defaultEnabled = body.enabled;
      return respond(200, { ...row });
    },
  );
  await setupPage({ context, path: "/connectors?scope=remote-control" });
  return {
    ssh: await screen.findByRole("listitem", { name: sshName }),
    vnc: await screen.findByRole("listitem", { name: vncName }),
    defaults,
  };
}
test("remote-control-guided-setup-124 A team-network shell and desktop share one directory list with management links and a working add action", async () => {
  const rows = await directory();
  expect(rows.ssh.closest("ul")).toBe(rows.vnc.closest("ul"));
  expect(rows.ssh).toHaveTextContent(sshName);
  expect(rows.vnc).toHaveTextContent(vncName);
  await expect(
    findFastControl("link", "Manage", rows.ssh),
  ).resolves.toHaveAttribute(
    "href",
    expect.stringContaining("remoteResource="),
  );
  await expect(
    findFastControl("link", "Manage", rows.vnc),
  ).resolves.toHaveAttribute(
    "href",
    expect.stringContaining("remoteResource="),
  );
  expect(
    screen.queryByRole("heading", { name: "Remote connections" }),
  ).toBeNull();
  expect(screen.queryByText("No devices added yet")).toBeNull();
  expect(screen.queryByText("Only you have access")).toBeNull();
  click(await findFastControl("button", "Add connection"));
  await expect(
    screen.findByRole("heading", { name: "Add remote connection" }),
  ).resolves.toBeVisible();
});
test.each([
  ["remote-control-guided-setup-125", "ssh"],
  ["remote-control-guided-setup-126", "vnc"],
] as const)(
  "%s Changing the %s chat default persists independently and its detail page shows the enabled permission",
  async (_id, protocol) => {
    const rows = await directory(),
      user = userEvent.setup({ delay: null });
    const ssh = await within(rows.ssh).findByRole("switch"),
      vnc = await within(rows.vnc).findByRole("switch");
    await waitFor(() => {
      return expect(ssh).toBeChecked();
    });
    await waitFor(() => {
      return expect(vnc).toBeEnabled();
    });
    expect(vnc).not.toBeChecked();
    const selected = protocol === "ssh" ? ssh : vnc;
    if (protocol === "ssh") {
      await user.click(ssh);
    }
    await waitFor(() => {
      return expect(selected).not.toBeChecked();
    });
    await user.click(selected);
    await waitFor(() => {
      return expect(selected).toBeChecked();
    });
    expect(ssh).toBeChecked();
    expect(vnc.getAttribute("aria-checked")).toBe(String(protocol === "vnc"));
    expect(rows.defaults[protocol][0]?.defaultEnabled).toBeTruthy();
    click(await findFastControl("link", "Manage", rows[protocol]));
    const permissions = await screen.findByText(
      "Server identity and chat permissions",
    );
    click(permissions);
    expect(permissions.closest("details")).toHaveAttribute("open");
    await expect(
      screen.findByRole("switch", { name: "Enabled by default for chats" }),
    ).resolves.toBeChecked();
  },
);
test("remote-control-guided-setup-128 Chat-default failure leaves both remote connections manageable and announces the missing access controls in the shell row", async () => {
  const rows = await directory("failed");
  const alert = await within(rows.ssh).findByRole("alert");
  expect(alert).toHaveTextContent("Couldn't load remote access.");
  expect(within(rows.ssh).queryByRole("switch")).toBeNull();
  await expect(
    findFastControl("link", "Manage", rows.ssh),
  ).resolves.toBeVisible();
  expect(rows.vnc).toBeVisible();
});
test("remote-control-guided-setup-129 A missing desktop default disables only its switch while its connection can still be managed", async () => {
  const rows = await directory("missing-vnc");
  await waitFor(() => {
    return expect(within(rows.ssh).getByRole("switch")).toBeChecked();
  });
  expect(within(rows.vnc).getByRole("switch")).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(
    findFastControl("link", "Manage", rows.vnc),
  ).resolves.toBeVisible();
});
