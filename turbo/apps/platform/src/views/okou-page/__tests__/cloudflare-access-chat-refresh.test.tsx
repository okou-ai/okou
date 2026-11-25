import {
  chatRemoteAccessContract,
  type RemoteHostDefault,
} from "@okouai/api-contracts/contracts/chat-remote-access";
import { remotesContract } from "@okouai/api-contracts/contracts/remotes";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createComposerConnectorHelpers,
  SCOUT_THREAD_ID,
} from "./chat-composer-connectors-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { remoteId } from "./connectors-remote-control-test-helpers.ts";

const context = testContext();
const { installComposerConnectorFixture } =
  createComposerConnectorHelpers(context);

/** The owner's SSH hosts and their chat defaults as the API reports them. */
function mockSshDefaults(hosts: { current: RemoteHostDefault[] }): void {
  context.mocks.api(remotesContract.overview, ({ respond }) => {
    return respond(200, {
      computerUseHosts: [],
      cloudBrowserAvailable: true,
      cloudBrowserEnabledByDefault: true,
      sshHosts: hosts.current,
      vncHosts: [],
    });
  });
  context.mocks.api(
    chatRemoteAccessContract.listThreadAccess,
    ({ respond }) => {
      return respond(200, {
        ssh: hosts.current.map((host) => {
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
}

async function openRemoteAccess(): Promise<HTMLElement> {
  click(await findFastControl("button", "Connectors"));
  click(await findFastControl("button", /^Remote access/));
  return await screen.findByRole("dialog", { name: "Remote access" });
}

test("Reopening the composer refreshes a renamed SSH host while preserving default access", async () => {
  installComposerConnectorFixture({ threadId: SCOUT_THREAD_ID });
  const hosts = {
    current: [
      {
        connectionId: remoteId("b", 1),
        displayName: "Private server",
        defaultEnabled: true,
      },
      {
        connectionId: remoteId("b", 2),
        displayName: "Direct server",
        defaultEnabled: false,
      },
    ],
  };
  mockSshDefaults(hosts);
  await setupPage({ context, path: `/chats/${SCOUT_THREAD_ID}` });
  click(await findFastControl("button", "Connectors"));
  await expect(
    findFastControl("button", "Remote access1 enabled"),
  ).resolves.toBeInTheDocument();
  click(await findFastControl("button", /^Remote access/));
  const first = await screen.findByRole("dialog", { name: "Remote access" });
  expect(
    within(first).getByRole("combobox", { name: "SSH Private server" }),
  ).toHaveTextContent("Default (On)");
  click(await findFastControl("button", "Close", first));
  await waitFor(() => {
    expect(first).not.toBeInTheDocument();
  });

  hosts.current = [
    { ...hosts.current[0], displayName: "Renamed private server" },
    hosts.current[1],
  ];
  context.mocks.ably.trigger("cloudflare-access:changed", {
    orgId: "org_default",
  });

  const reopened = await openRemoteAccess();

  await expect(
    within(reopened).findByRole("combobox", {
      name: "SSH Renamed private server",
    }),
  ).resolves.toHaveTextContent("Default (On)");
  expect(
    within(reopened).getByRole("combobox", { name: "SSH Direct server" }),
  ).toHaveTextContent("Default (Off)");
  expect(
    within(reopened).queryByRole("combobox", { name: "SSH Private server" }),
  ).not.toBeInTheDocument();
  expect(
    within(reopened).queryByText("Private server"),
  ).not.toBeInTheDocument();
});
