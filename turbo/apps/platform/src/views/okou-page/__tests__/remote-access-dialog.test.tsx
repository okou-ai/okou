import {
  chatRemoteAccessContract,
  type ThreadRemoteHostAccess,
} from "@okouai/api-contracts/contracts/chat-remote-access";
import { remotesContract } from "@okouai/api-contracts/contracts/remotes";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

/**
 * The chat's SSH hosts as the API stores them. Host 1 is allowed by default;
 * `saveFails` models a write the service stores but cannot confirm.
 */
function mockChatHosts(count: number, saveFails = false) {
  const hosts: ThreadRemoteHostAccess[] = Array.from(
    { length: count },
    (_, index) => {
      return {
        connectionId: remoteId("b", index + 1),
        displayName: `Host ${index + 1}`,
        defaultEnabled: index === 0,
        overrideEnabled: null,
        enabled: index === 0,
        source: "default" as const,
      };
    },
  );
  context.mocks.api(remotesContract.overview, ({ respond }) => {
    return respond(200, {
      computerUseHosts: [],
      cloudBrowserAvailable: true,
      cloudBrowserEnabledByDefault: true,
      sshHosts: hosts.map(({ connectionId, displayName, defaultEnabled }) => {
        return { connectionId, displayName, defaultEnabled };
      }),
      vncHosts: [],
    });
  });
  context.mocks.api(
    chatRemoteAccessContract.listThreadAccess,
    ({ respond }) => {
      return respond(200, { ssh: [...hosts], vnc: [] });
    },
  );
  context.mocks.api(
    chatRemoteAccessContract.setThreadOverride,
    ({ params, body, respond }) => {
      const index = hosts.findIndex((host) => {
        return host.connectionId === params.connectionId;
      });
      hosts[index] = {
        ...hosts[index],
        overrideEnabled: body.enabled,
        enabled: body.enabled,
        source: "override",
      };
      if (saveFails) {
        return respond(500, {
          error: { code: "INTERNAL_SERVER_ERROR", message: "Lost response" },
        });
      }
      return respond(200, hosts[index]);
    },
  );
}

async function openRemoteAccess(): Promise<HTMLElement> {
  await setupPage({ context, path: `/chats/${SCOUT_THREAD_ID}` });
  click(await findFastControl("button", "Connectors"));
  click(await findFastControl("button", /^Remote access/));
  return await screen.findByRole("dialog", { name: "Remote access" });
}

function hostChoices(dialog: HTMLElement): string[] {
  return within(dialog)
    .queryAllByRole("combobox")
    .map((choice) => {
      return choice.getAttribute("aria-label") ?? "";
    });
}

test("Allowed filtering retains a changed connection and keyboard focus until the filter changes", async () => {
  installComposerConnectorFixture({ threadId: SCOUT_THREAD_ID });
  mockChatHosts(12);
  const user = userEvent.setup({ delay: null });
  const dialog = await openRemoteAccess();
  await waitFor(() => {
    expect(hostChoices(dialog)).toHaveLength(12);
  });
  click(await findFastControl("button", "Allowed1", dialog));
  await waitFor(() => {
    expect(hostChoices(dialog)).toStrictEqual(["SSH Host 1"]);
  });
  const host1 = within(dialog).getByRole("combobox", { name: "SSH Host 1" });

  host1.focus();
  await user.keyboard("{Enter}");
  await screen.findByRole("option", { name: "Off" });
  await user.keyboard("{End}{Enter}");

  await waitFor(() => {
    expect(host1).toHaveTextContent("Off");
  });
  await expect(
    within(dialog).findByText("Saved for this chat"),
  ).resolves.toBeInTheDocument();
  expect(hostChoices(dialog)).toStrictEqual(["SSH Host 1"]);
  expect(host1).toHaveFocus();
  expect(
    within(dialog).getByText(
      "Changed connections stay visible until you switch filters",
    ),
  ).toBeInTheDocument();

  click(await findFastControl("button", "All12", dialog));

  await waitFor(() => {
    expect(hostChoices(dialog)).toHaveLength(12);
  });

  click(await findFastControl("button", "Allowed0", dialog));

  await expect(
    within(dialog).findByText("No connections are allowed in this chat"),
  ).resolves.toBeInTheDocument();
  expect(hostChoices(dialog)).toStrictEqual([]);

  click(await findFastControl("button", "Show all connections", dialog));

  await waitFor(() => {
    expect(hostChoices(dialog)).toHaveLength(12);
  });
});

test("An unconfirmed write is reconciled by reading saved permissions before another change", async () => {
  installComposerConnectorFixture({ threadId: SCOUT_THREAD_ID });
  mockChatHosts(1, true);
  const user = userEvent.setup({ delay: null });
  const dialog = await openRemoteAccess();
  const host1 = await within(dialog).findByRole("combobox", {
    name: "SSH Host 1",
  });
  expect(host1).toHaveTextContent("Default (On)");

  await user.click(host1);
  click(await screen.findByRole("option", { name: "Off" }));

  await expect(within(dialog).findByRole("alert")).resolves.toHaveTextContent(
    "Couldn't confirm whether your change was saved. Reload permissions before making another change.",
  );
  expect(host1).toHaveTextContent("Default (On)");
  expect(host1).toHaveAttribute("aria-readonly", "true");
  expect(
    within(dialog).getByText("Reload to confirm permissions"),
  ).toBeInTheDocument();

  click(await findFastControl("button", "Reload", dialog));

  await waitFor(() => {
    expect(
      within(dialog).getByRole("combobox", { name: "SSH Host 1" }),
    ).toHaveTextContent("Off");
  });
  const reloaded = within(dialog).getByRole("combobox", { name: "SSH Host 1" });
  expect(reloaded).not.toHaveAttribute("aria-readonly", "true");
  expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
  expect(
    within(dialog).getByText("SSH · Not allowed · This chat"),
  ).toBeInTheDocument();
});
