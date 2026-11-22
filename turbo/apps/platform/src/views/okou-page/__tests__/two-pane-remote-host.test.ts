import {
  chatRemoteAccessContract,
  type ThreadRemoteHostAccess,
} from "@okouai/api-contracts/contracts/chat-remote-access";
import { remotesContract } from "@okouai/api-contracts/contracts/remotes";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createComposerConnectorHelpers,
  SCOUT_THREAD_ID,
  OTHER_THREAD_ID,
} from "./chat-composer-connectors-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
const context = testContext();
test("chat-composer-ssh-015 The other pane changes its SSH host override independently of Scout", async () => {
  const host = {
    connectionId: crypto.randomUUID(),
    displayName: "Shared build machine",
    defaultEnabled: false,
  };
  const overrides = new Map([[SCOUT_THREAD_ID, true]]),
    changes: { thread: string; enabled: boolean }[] = [];
  function access(id: string): ThreadRemoteHostAccess {
    const override = overrides.get(id);
    return {
      ...host,
      overrideEnabled: override ?? null,
      enabled: override ?? false,
      source: override === undefined ? "default" : "override",
    };
  }
  createComposerConnectorHelpers(context).installComposerConnectorFixture({
    threads: [
      { id: SCOUT_THREAD_ID, title: "Scout" },
      { id: OTHER_THREAD_ID, title: "Other pane" },
    ],
  });
  context.mocks.api(remotesContract.overview, ({ respond }) => {
    return respond(200, {
      computerUseHosts: [],
      cloudBrowserEnabledByDefault: false,
      cloudBrowserAvailable: false,
      sshHosts: [host],
      vncHosts: [],
    });
  });
  context.mocks.api(
    chatRemoteAccessContract.listThreadAccess,
    ({ params, respond }) => {
      return respond(200, { ssh: [access(params.threadId)], vnc: [] });
    },
  );
  context.mocks.api(
    chatRemoteAccessContract.setThreadOverride,
    ({ body, params, respond }) => {
      overrides.set(params.threadId, body.enabled);
      changes.push({ thread: params.threadId, enabled: body.enabled });
      return respond(200, access(params.threadId));
    },
  );
  await setupPage({
    context,
    path: "/chats/" + SCOUT_THREAD_ID + "?sidebar=" + OTHER_THREAD_ID,
  });
  async function open(id: string) {
    const pane = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(
        '[data-chat-thread-container-id="' + id + '"]',
      );
      expect(el).toBeVisible();
      return el!;
    });
    click(await findFastControl("button", "Connectors", pane));
    click(await findFastControl("button", /Remote access/));
    const dialog = await screen.findByRole("dialog", { name: "Remote access" });
    const choice = await within(dialog).findByRole("combobox", {
      name: "SSH Shared build machine",
    });
    return { dialog, choice };
  }
  async function close(dialog: HTMLElement) {
    click(await findFastControl("button", "Close", dialog));
    await waitFor(() => {
      return expect(dialog).not.toBeInTheDocument();
    });
  }
  let scout = await open(SCOUT_THREAD_ID);
  expect(scout.choice).toHaveTextContent(/^On$/);
  await close(scout.dialog);
  const other = await open(OTHER_THREAD_ID);
  expect(other.choice).toHaveTextContent(/Default.*Off/);
  click(other.choice);
  click(await screen.findByRole("option", { name: "On" }));
  await waitFor(() => {
    return expect(other.choice).toHaveTextContent(/^On$/);
  });
  await close(other.dialog);
  scout = await open(SCOUT_THREAD_ID);
  expect(scout.choice).toHaveTextContent(/^On$/);
  expect(changes).toStrictEqual([{ thread: OTHER_THREAD_ID, enabled: true }]);
});
