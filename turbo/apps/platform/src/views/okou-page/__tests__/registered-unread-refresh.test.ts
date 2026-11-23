import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { triggerSharedWorkerAblyChannelGap } from "../../../mocks/ably.ts";
import { expect, test, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import {
  setupPage,
  click,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import {
  installContinuityWorkspace,
  continuityThread,
} from "./chat-continuity-test-helpers.ts";

const context = testContext();
const events = vi.hoisted(() => {
  return [] as { name: string; "attributes.custom": Record<string, string> }[];
});
vi.mock("@axiomhq/js", () => {
  return {
    Axiom: class {
      ingest(_dataset: string, batch: typeof events) {
        events.push(...batch);
      }
      flush() {
        return Promise.resolve();
      }
    },
  };
});

test.each([
  ["message-port-002", "denied"],
  ["Granted control", "granted"],
] as const)(
  "%s A registered tab receives a %s credential decision on refresh of unread chats",
  async (_case, decision) => {
    events.length = 0;
    const Channel = MessageChannel;
    interface WorkerRequest {
      type: string;
      requestId?: string;
      computedKey?: string;
    }
    const token = context.mocks.deferred<string>();
    const requested = context.mocks.deferred<void>();
    let armed = false;
    const errorSink = vi.spyOn(console, "error");
    let read: string | undefined;
    let credential: string | undefined;
    vi.stubGlobal(
      "MessageChannel",
      class extends Channel {
        constructor() {
          super();
          for (const port of [this.port1, this.port2]) {
            port.addEventListener(
              "message",
              ({ data }: MessageEvent<WorkerRequest>) => {
                if (
                  data.type === "get-computed" &&
                  armed &&
                  !read &&
                  data.computedKey === "chat-thread-indicators"
                ) {
                  read = data.requestId;
                }
                if (read && !credential && data.type === "get-token") {
                  credential = data.requestId;
                  mockedClerk.sessionGetToken.mockImplementationOnce(() => {
                    requested.resolve();
                    return token.promise;
                  });
                }
              },
              { signal: context.signal },
            );
          }
        }
      },
    );
    context.mocks.browser.matchMedia((query) => {
      return query.includes("min-width");
    });
    const thread = continuityThread(910, 1, "Timesheet conversation");
    const follow = continuityThread(910, 2, "Reimbursement reminders");
    const { pageOptions } = installContinuityWorkspace(context, {
      caseId: 910,
      threads: [thread, follow],
    });
    context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
      return respond(
        200,
        armed
          ? {
              threads: { [follow.id]: "unread" },
              unreadAt: { [follow.id]: follow.updatedAt },
            }
          : { threads: {}, unreadAt: {} },
      );
    });
    await setupPage({
      context,
      ...pageOptions,
      path: "/chats/" + thread.id,
      host: "app.okou.ai",
      sharedWorkerTestTransport: "message-port",
      env: { VITE_AXIOM_CLIENT_TELEMETRY_TOKEN: "worker-check" },
    });

    click(await findFastControl("button", "Open chat list menu"));
    click(
      await waitFor(() => {
        const item = queryAllByRoleFast("menuitem").find((element) => {
          return element.textContent?.includes("Unread");
        });
        if (!item) {
          throw new Error("Unread filter unavailable");
        }
        return item;
      }),
    );
    await screen.findByText("No unread chats");
    armed = true;
    const auth = pageOptions.auth;
    triggerSharedWorkerAblyChannelGap(
      "user-org:" + auth.user.id + ":" + auth.organization?.activeOrg?.id,
    );

    await requested.promise;
    const credentialEvents = () => {
      return events.filter((e) => {
        return (
          e["attributes.custom"]?.[
            "okou.shared_database.token_request.request_id"
          ] === credential
        );
      });
    };
    expect(
      credentialEvents().map((e) => {
        return e["attributes.custom"]["okou.client.outcome"];
      }),
    ).toStrictEqual(["started"]);
    if (decision === "granted") {
      token.resolve("queue-read-ticket");
      await screen.findByText("Reimbursement reminders");
    } else {
      token.reject(new Error("private token refusal 84"));
    }
    await waitFor(() => {
      return expect(
        credentialEvents().map((event) => {
          return event["attributes.custom"]["okou.client.outcome"];
        }),
      ).toStrictEqual([
        "started",
        decision === "granted" ? "success" : "error",
      ]);
    });
    if (decision === "granted") {
      return;
    }
    expect(JSON.stringify(credentialEvents())).not.toContain(
      "private token refusal 84",
    );
    await waitFor(() => {
      return expect(screen.queryAllByTestId("sidebar-skeleton")).toHaveLength(
        0,
      );
    });
    await waitFor(() => {
      return expect(errorSink.mock.calls.flat()).toContainEqual(
        expect.objectContaining({ name: "AggregateError" }),
      );
    });
    expect(screen.queryByText("Reimbursement reminders")).toBeNull();
    await expect(
      screen.findByRole("textbox", { name: "Message" }),
    ).resolves.toBeVisible();
  },
);
