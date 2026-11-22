import {
  chatThreadsContract,
  chatThreadComputerUseHostContract,
  type ChatThreadEvent,
} from "@okouai/api-contracts/contracts/chat-threads";
import { remotesContract } from "@okouai/api-contracts/contracts/remotes";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import {
  testContext,
  mockChatThreadSnapshotResponse,
} from "../../../signals/__tests__/test-helpers.ts";
import { changeChatThreadList } from "../../../mocks/mock-helpers.ts";
import { chatListThread, chatListEvent } from "./chat-list-test-helpers.ts";
import {
  openBrowserChat,
  remoteBrowserInput,
} from "./conversation-browser-fixtures.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { RUN_THREAD_ID } from "./chat-capability-test-helpers.ts";
const context = testContext();
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
