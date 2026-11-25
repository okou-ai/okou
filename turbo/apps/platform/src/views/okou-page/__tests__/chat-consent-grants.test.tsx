import {
  chatRemoteAccessContract,
  type ThreadRemoteHostAccess,
} from "@okouai/api-contracts/contracts/chat-remote-access";
import { remotesContract } from "@okouai/api-contracts/contracts/remotes";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import {
  testContext,
  mockChatThreadSnapshotResponse,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  createComposerConnectorHelpers,
  SCOUT_THREAD_ID,
  OTHER_THREAD_ID,
} from "./chat-composer-connectors-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { remoteId } from "./connectors-remote-control-test-helpers.ts";
import {
  chatThreadsContract,
  chatThreadComputerUseHostContract,
  type ChatThreadEvent,
} from "@okouai/api-contracts/contracts/chat-threads";
import { changeChatThreadList } from "../../../mocks/mock-helpers.ts";
import { chatListThread, chatListEvent } from "./chat-list-test-helpers.ts";
import {
  openBrowserChat,
  remoteBrowserInput,
} from "./conversation-browser-fixtures.ts";
import { RUN_THREAD_ID } from "./chat-capability-test-helpers.ts";

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

const cases = [
  { id: "chat-navigation-browser-004", snapshot: false, initial: false },
  { id: "chat-navigation-browser-005", snapshot: true, initial: false },
  { id: "chat-navigation-browser-006", snapshot: false, initial: true },
] as const;
test.each(cases)(
  "$id Browser input follows confirmed changes to this chat's grant",
  async ({ snapshot, initial }) => {
    const written = context.mocks.deferred<string>(),
      release = context.mocks.deferred<void>();
    let enabled = initial,
      expire = false;
    const confirmed = context.mocks.deferred<void>();
    const events: ChatThreadEvent[] = [];
    const thread = chatListThread(24, "Invoice review", {
      id: RUN_THREAD_ID,
      cloudBrowserEnabled: initial,
    });
    const view = await openBrowserChat(
      context,
      initial ? "live" : "denied",
      false,
      {
        initialGrant: initial,
        beforeStart() {
          context.mocks.api(remotesContract.overview, ({ respond }) => {
            return respond(200, {
              computerUseHosts: [],
              cloudBrowserEnabledByDefault: false,
              cloudBrowserAvailable: true,
              sshHosts: [],
              vncHosts: [],
            });
          });
          context.mocks.api(
            chatThreadComputerUseHostContract.update,
            async ({ body, respond }) => {
              expect(body.cloudBrowserEnabled).toBe(!initial);
              written.resolve(body.eventId!);
              await release.promise;
              return respond(204);
            },
          );
          context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
            if (snapshot && events.length === 1) {
              confirmed.resolve();
            }
            return respond(
              200,
              mockChatThreadSnapshotResponse(context, {
                chatThreads: [{ ...thread, cloudBrowserEnabled: enabled }],
                latestSeqId: events.at(-1)?.seqId ?? 1,
                latestEventId:
                  events.at(-1)?.id ?? "71111111-1111-4111-a111-111111111111",
              }),
            );
          });
          context.mocks.api(
            chatThreadsContract.events,
            ({ query, respond }) => {
              if (expire) {
                expire = false;
                return respond(410, {
                  error: {
                    code: "CURSOR_EXPIRED",
                    message: "Refresh snapshot",
                  },
                });
              }
              if (
                !snapshot &&
                events.some((e) => {
                  return e.seqId === 2 && e.seqId > (query.sinceSeqId ?? 0);
                })
              ) {
                confirmed.resolve();
              }
              return respond(200, {
                events: events.filter((e) => {
                  return e.seqId > (query.sinceSeqId ?? 0);
                }),
                hasMore: false,
              });
            },
          );
        },
      },
    );
    click(view.open);
    async function authorization(on: boolean) {
      if (on) {
        await remoteBrowserInput();
      } else {
        await screen.findAllByText(
          "Cloud browser is not enabled for this chat",
        );
      }
      expect(Boolean(screen.queryByLabelText("Remote browser input"))).toBe(on);
      expect(
        screen.queryAllByText("Cloud browser is not enabled for this chat")
          .length > 0,
      ).toBe(!on);
    }
    await authorization(initial);
    click(await findFastControl("button", "Connectors"));
    const label = await screen.findByText("Cloud browser", {
      selector: "label span",
      exact: true,
    });
    const toggle = within(label.closest("label")!).getByRole("switch");
    expect(toggle).toHaveAttribute("aria-checked", String(initial));
    click(toggle);
    const first = await written.promise;
    function publish(on: boolean, id: string, seq: number) {
      enabled = on;
      view.setStatus(on ? "live" : "denied");
      events.push(
        chatListEvent(527, seq, "computer_use_host_updated", RUN_THREAD_ID, {
          id,
          cloudBrowserEnabled: on,
        }),
      );
      changeChatThreadList();
    }
    expire = snapshot;
    release.resolve();
    publish(!initial, first, 2);
    await confirmed.promise;
    await authorization(!initial);
    publish(initial, crypto.randomUUID(), 3);
    await authorization(initial);
    await waitFor(() => {
      return expect(toggle).toHaveAttribute("aria-checked", String(initial));
    });
  },
);
