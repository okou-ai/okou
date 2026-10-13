import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
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

test("A Cloudflare network removal refreshes the current chat's available SSH hosts", async () => {
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
  let removed = false;
  installComposerConnectorFixture({ threadId: SCOUT_THREAD_ID });
  context.mocks.data.org({ id: orgId, name: "Engineering", role: "member" });
  context.mocks.api(
    chatRemoteAccessContract.listHostDefaults,
    ({ respond }) => {
      return respond(200, {
        ssh: removed ? [directHost] : [privateHost, directHost],
        vnc: [],
      });
    },
  );
  context.mocks.api(
    chatRemoteAccessContract.listThreadAccess,
    ({ respond }) => {
      const hosts = removed ? [directHost] : [privateHost, directHost];
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
  click(await findFastControl("button", "Connectors"));
  const remoteAccess = await screen.findByText("Remote access");
  const trigger = remoteAccess.closest("button");
  await waitFor(() => {
    expect(trigger).toHaveTextContent("1 enabled");
  });
  click(remoteAccess);
  await screen.findByRole("combobox", { name: "SSH Private server" });
  removed = true;
  await act(() => {
    return context.mocks.ably.trigger("cloudflare-access:changed", { orgId });
  });
  await waitFor(() => {
    return expect(trigger).toHaveTextContent("0 enabled");
  });
  expect(
    screen.getByRole("combobox", { name: "SSH Direct server" }),
  ).toHaveTextContent("Default (Off)");
  expect(
    screen.queryByRole("combobox", { name: "SSH Private server" }),
  ).toBeNull();
});
