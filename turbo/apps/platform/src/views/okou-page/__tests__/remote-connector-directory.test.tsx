import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { screen, within } from "@testing-library/react";
import { test, expect } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  mockRemoteInventory,
  sshHost,
  vncHost,
  REMOTE_TIMESTAMP,
} from "./connectors-remote-control-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { findNamedLink } from "./chat-attachment-test-helpers.ts";

const context = testContext();

const path = "/connectors?scope=remote-control&type=ssh";

test("connectors-ssh-001 returning to each directory picks up its latest inventory", async () => {
  const host = sshHost(1, "Original SSH host");
  const gateway = {
    id: crypto.randomUUID(),
    name: "Original private network",
    scope: "personal" as const,
    generation: 1,
    revision: 1,
    createdAt: REMOTE_TIMESTAMP,
    updatedAt: REMOTE_TIMESTAMP,
    sshHosts: [],
    vncHosts: [],
  };
  const db = mockRemoteInventory(context, {
    ssh: [host],
    cloudflare: [gateway],
  });
  await setupPage({ context, path });
  await screen.findByText(host.displayName);
  click(await findFastControl("radio", /^Private network/i));
  await screen.findByText(gateway.name);
  for (const [hostName, networkName] of [
    ["Updated SSH host", "Network after SSH change"],
    ["Latest SSH host", "Latest private network"],
  ]) {
    db.ssh = [{ ...host, displayName: hostName }];
    click(await findFastControl("radio", /^Remote control/i));
    await expect(screen.findByText(hostName)).resolves.toBeInTheDocument();
    db.cloudflare = [{ ...gateway, name: networkName }];
    click(await findFastControl("radio", /^Private network/i));
    await expect(screen.findByText(networkName)).resolves.toBeInTheDocument();
  }
});

test("connectors-ssh-005 an in-use SSH gateway explains how to change the dependent VNC route", async () => {
  const gateway = sshHost(1, "VNC gateway");
  mockRemoteInventory(context, {
    ssh: [gateway],
    vnc: [
      vncHost(1, "Desktop", {
        transport: { type: "ssh", connectionId: gateway.id },
      }),
    ],
  });
  context.mocks.api(sshConnectionsContract.delete, ({ respond }) => {
    return respond(409, {
      error: {
        code: "SSH_CONNECTION_IN_USE",
        message: "Private dependency detail",
      },
    });
  });
  await setupPage({ context, path });
  click(
    await findFastControl(
      "link",
      "Manage",
      await screen.findByRole("listitem", { name: "VNC gateway" }),
    ),
  );
  click(await findFastControl("button", "Delete connection"));
  const dialog = await screen.findByRole("dialog");
  click(await findFastControl("button", /Delete/i, dialog));
  await within(dialog).findByText(
    /This SSH host is used by a VNC route.*switch them explicitly to Direct/,
  );
  expect(
    screen.queryByText(/Private dependency detail/),
  ).not.toBeInTheDocument();
  expect(dialog).toBeInTheDocument();
});

test("A host detail can read diagnostics while its saved entry remains available on return", async () => {
  const rejected = context.mocks.deferred<void>();
  mockRemoteInventory(context, {
    ssh: [sshHost(1, "Records gateway"), sshHost(2, "Archive gateway")],
  });
  context.mocks.api(sshConnectionsContract.observations, ({ respond }) => {
    rejected.resolve();
    return respond(500, {
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Private upstream diagnostic service",
      },
    });
  });
  await setupPage({ context, path });
  const archived = await screen.findByRole("listitem", {
    name: "Archive gateway",
  });
  expect(
    screen.getByRole("listitem", { name: "Records gateway" }),
  ).toBeVisible();
  expect(within(archived).queryByRole("status")).toBeNull();
  click(await findFastControl("link", "Manage", archived));
  await rejected.promise;
  await findFastControl("button", "Delete connection");
  expect(screen.queryByText("Private upstream diagnostic service")).toBeNull();
  window.history.back();
  await expect(
    screen.findByRole("listitem", { name: "Archive gateway" }),
  ).resolves.toBeVisible();
  expect(screen.queryByText("Private upstream diagnostic service")).toBeNull();
});

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
