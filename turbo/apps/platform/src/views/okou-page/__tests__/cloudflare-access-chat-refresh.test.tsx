import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import { remotesContract } from "@okouai/api-contracts/contracts/remotes";
import { act, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import {
  context,
  findFastControl,
} from "./chat-message-experience-test-helpers.ts";
import {
  installComposerConnectorFixture,
  SCOUT_THREAD_ID,
} from "./chat-composer-connectors-test-helpers.ts";

test("Reopening the composer refreshes a renamed SSH host while preserving default access", async () => {
  const orgId = "org_cloudflare_chat";
  const privateHost = {
    connectionId: "b0000000-0000-4000-8000-000000000001",
    displayName: "Private server",
    defaultEnabled: true,
  };
  const directHost = {
    connectionId: "b0000000-0000-4000-8000-000000000002",
    displayName: "Direct server",
    defaultEnabled: false,
  };
  let currentPrivateHost = privateHost;
  const reads = { remotes: 0, access: 0 };
  installComposerConnectorFixture({ threadId: SCOUT_THREAD_ID });
  context.mocks.data.org({ id: orgId, name: "Engineering", role: "member" });
  context.mocks.api(remotesContract.overview, ({ respond }) => {
    reads.remotes += 1;
    return respond(200, {
      computerUseHosts: [],
      cloudBrowserAvailable: true,
      cloudBrowserEnabledByDefault: true,
      sshHosts: [currentPrivateHost, directHost],
      vncHosts: [],
    });
  });
  context.mocks.api(
    chatRemoteAccessContract.listThreadAccess,
    ({ respond }) => {
      reads.access += 1;
      const hosts = [currentPrivateHost, directHost];
      return respond(200, {
        ssh: hosts.map((host) => {
          return {
            ...host,
            overrideEnabled: null,
            enabled: host.defaultEnabled,
            source: "default" as const,
          };
        }),
        vnc: [],
      });
    },
  );
  await setupPage({
    context,
    path: `/chats/${SCOUT_THREAD_ID}`,
    auth: {
      user: { id: "chat-owner", fullName: "Chat Owner" },
      organization: {
        activeOrg: { id: orgId, name: "Engineering" },
        memberships: [{ id: orgId }],
      },
    },
    featureSwitches: {},
  });
  const menuTrigger = await findFastControl("button", "Connectors");
  expect(reads).toStrictEqual({ remotes: 0, access: 0 });
  click(menuTrigger);
  const remoteAccess = await screen.findByText("Remote access");
  await waitFor(() => {
    expect(remoteAccess.closest("button")).toHaveTextContent("1 enabled");
  });
  click(remoteAccess);
  await expect(
    screen.findByRole("combobox", { name: "SSH Private server" }),
  ).resolves.toHaveTextContent("Default (On)");
  expect(
    screen.getByRole("combobox", { name: "SSH Direct server" }),
  ).toHaveTextContent("Default (Off)");
  expect(reads).toStrictEqual({ remotes: 1, access: 1 });
  click(menuTrigger);
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Connectors" })).toBeNull();
    expect(
      screen.queryByRole("combobox", { name: "SSH Private server" }),
    ).toBeNull();
  });

  // Background network notices do not retain a closed composer's list readers.
  currentPrivateHost = {
    ...privateHost,
    displayName: "Renamed private server",
  };
  await act(() => {
    return context.mocks.ably.trigger("cloudflare-access:changed", { orgId });
  });
  expect(reads).toStrictEqual({ remotes: 1, access: 1 });
  click(menuTrigger);
  const refreshedRemoteAccess = await screen.findByText("Remote access");
  await waitFor(() => {
    expect(refreshedRemoteAccess.closest("button")).toHaveTextContent(
      "1 enabled",
    );
  });
  click(refreshedRemoteAccess);
  await expect(
    screen.findByRole("combobox", { name: "SSH Renamed private server" }),
  ).resolves.toHaveTextContent("Default (On)");
  expect(reads).toStrictEqual({ remotes: 2, access: 2 });
  expect(
    screen.getByRole("combobox", { name: "SSH Direct server" }),
  ).toHaveTextContent("Default (Off)");
  expect(
    screen.queryByRole("combobox", { name: "SSH Private server" }),
  ).toBeNull();
});
