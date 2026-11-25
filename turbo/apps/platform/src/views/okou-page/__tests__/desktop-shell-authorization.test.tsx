import {
  desktopShellAuthorizationContract as contract,
  type DesktopShellAuthorization,
} from "@okouai/api-contracts/contracts/desktop-shell-authorization";
import { screen, waitFor } from "@testing-library/react";
import { test, expect } from "vitest";
import {
  setupPage,
  click,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { RUN_THREAD_ID, RUN_PATH } from "./chat-run-test-fixtures.ts";
import { now, mockNow } from "../../../lib/time.ts";
import { mockAuthorizationCallbackThread } from "./authorization-callback-test-helpers.ts";
const context = testContext();
const reason = "Run the project tests.";
const allow = "Allow for 1 hour";
async function visit(
  options: {
    standalone?: boolean;
    external?: boolean;
    callback?: string;
    data?: Partial<DesktopShellAuthorization>;
    grantMs?: number;
    requestMs?: number;
    refuse?: Promise<void>;
  } = {},
) {
  const id = crypto.randomUUID();
  const path = "/computer-use/shell/authorize/" + id;
  const url = new URL(
    path,
    options.external ? "https://external.test" : "https://app.okou.ai",
  );
  if (options.callback) {
    url.searchParams.set("threadId", RUN_THREAD_ID);
    url.searchParams.set("callbackPrompt", options.callback);
  }
  const after = (ms: number) => {
    return new Date(now() + ms).toISOString();
  };
  const approved = () => {
    return {
      status: "approved" as const,
      approvedAt: after(0),
      grantExpiresAt: after(options.grantMs ?? 3_600_000),
    };
  };
  let data: DesktopShellAuthorization = {
    id,
    chatThreadId: RUN_THREAD_ID,
    computerUseHostId: crypto.randomUUID(),
    requestedByRunId: crypto.randomUUID(),
    computerName: "Work Mac",
    reason,
    status: "pending",
    requestExpiresAt: after(options.requestMs ?? 60_000),
    approvedAt: null,
    grantExpiresAt: null,
    approvalBlockedReason: null,
    authorizationUrl: url.href,
    ...options.data,
  };
  if (data.status === "approved") {
    Object.assign(data, approved());
  }
  let gate: Promise<void> | undefined;
  let fail = false;
  const asked = context.mocks.deferred<void>();
  context.mocks.api(contract.get, async ({ params, respond }) => {
    expect(params.id).toBe(id);
    if (gate) {
      if (!asked.settled()) {
        asked.resolve();
      }
      await gate;
    }
    if (fail) {
      return respond(409, {
        error: { code: "UNAVAILABLE", message: "Host unavailable" },
      });
    }
    return respond(200, data);
  });
  context.mocks.api(contract.approve, async ({ params, respond }) => {
    expect(params.id).toBe(id);
    if (options.refuse) {
      await options.refuse;
      return respond(409, {
        error: { code: "CONFLICT", message: "Not available" },
      });
    }
    Object.assign(data, approved());
    return respond(200, data);
  });
  context.mocks.api(contract.deny, ({ respond }) => {
    data = { ...data, status: "denied" };
    return respond(200, data);
  });
  context.mocks.api(contract.revoke, ({ respond }) => {
    data = { ...data, status: "revoked" };
    return respond(200, data);
  });
  mockAuthorizationCallbackThread(context, RUN_THREAD_ID);
  const sent = context.mocks.deferred<string>();
  mockChatLifecycle(context, {
    threadId: RUN_THREAD_ID,
    chatEvents: [
      {
        role: "assistant",
        content: "[Review shell request](" + url.href + ")",
        createdAt: "2026-09-10T00:00:00Z",
      },
    ],
    onSendRequest(body) {
      expect(body.threadId).toBe(RUN_THREAD_ID);
      expect(body.clientEventId).toBe(id);
      sent.resolve(body.prompt);
    },
  });
  await setupPage({
    context,
    path: options.standalone ? path : RUN_PATH,
    host: "app.okou.ai",
  });
  return {
    url,
    sent,
    asked,
    refresh(
      patch: Partial<DesktopShellAuthorization>,
      opts: { hold?: Promise<void>; fail?: boolean; host?: boolean } = {},
    ) {
      data = { ...data, ...patch };
      gate = opts.hold;
      fail = opts.fail ?? false;
      context.mocks.ably.trigger(
        opts.host
          ? "computerUseHostsChanged"
          : "desktopShellAuthorizationChanged",
        {},
      );
    },
  };
}
async function button(name: string) {
  return await findFastControl("button", name);
}
async function label(text: string) {
  await waitFor(() => {
    expect(screen.queryAllByText(text).length).toBeGreaterThan(0);
  });
}
test("desktop-shell-authorization-001 the chat grants Work Mac access and then revokes it", async () => {
  await visit();
  await screen.findByText(reason);
  await screen.findByText(/Work Mac/);
  click(await button(allow));
  await label("Shell access allowed");
  await screen.findByText(/Work Mac · This chat/);
  click(await button("Revoke"));
  await label("Shell access revoked");
  expect(queryFastControl("button", "Revoke")).toBeNull();
});
test("desktop-shell-authorization-002 a shell update unblocks an active Run on the standalone page", async () => {
  const api = await visit({
    standalone: true,
    data: { approvalBlockedReason: "run_active" },
  });
  await screen.findByText(
    "Wait for the requesting Run to finish before approving.",
  );
  const yes = await button(allow);
  expect(yes).toBeDisabled();
  await expect(button("Deny")).resolves.toBeEnabled();
  api.refresh({ approvalBlockedReason: null });
  await waitFor(() => {
    expect(yes).toBeEnabled();
  });
});
test("desktop-shell-authorization-006 the keyboard reader can focus and read the entire reason", async () => {
  const long = Array.from({ length: 10 }, () => {
    return reason;
  }).join(" ");
  await visit({ data: { reason: long } });
  const text = await screen.findByText(long);
  const focus = text.closest<HTMLElement>("[tabindex]");
  expect(focus).not.toBeNull();
  focus!.focus();
  expect(focus).toHaveFocus();
  expect(focus).toHaveTextContent(long);
  await expect(button(allow)).resolves.toBeEnabled();
});
test("desktop-shell-authorization-007 a changed computer preserves its reason and only allows denial", async () => {
  await visit({ data: { approvalBlockedReason: "computer_changed" } });
  await screen.findByText("Select Work Mac again before approving.");
  expect(screen.getByText(reason)).toBeInTheDocument();
  await expect(button(allow)).resolves.toBeDisabled();
  await expect(button("Deny")).resolves.toBeEnabled();
});
test("desktop-shell-authorization-008 denying the card preserves its request reason", async () => {
  await visit();
  await screen.findByText(reason);
  click(await button("Deny"));
  await label("Shell access denied");
  expect(screen.getByText(reason)).toBeInTheDocument();
  expect(queryFastControl("button", allow)).toBeNull();
});
test("desktop-shell-authorization-009 the rejected approval releases both pending controls", async () => {
  const reject = context.mocks.deferred<void>();
  await visit({ refuse: reject.promise });
  const yes = await button(allow),
    no = await button("Deny");
  click(yes);
  await waitFor(() => {
    expect(yes).toHaveAttribute("aria-disabled", "true");
    expect(no).toBeDisabled();
  });
  reject.resolve();
  await screen.findByText("Could not update authorization.");
  expect(yes).toBeEnabled();
  expect(no).toBeEnabled();
});
test("desktop-shell-authorization-015 the original grant remains usable while its host refresh is pending", async () => {
  const api = await visit({ data: { status: "approved" } });
  await button("Revoke");
  const held = context.mocks.deferred<void>();
  api.refresh({ status: "revoked" }, { hold: held.promise, host: true });
  await api.asked.promise;
  await expect(button("Revoke")).resolves.toBeEnabled();
  expect(screen.getByText(reason)).toBeInTheDocument();
  expect(screen.getByText(/Work Mac/)).toBeInTheDocument();
  held.resolve();
  await label("Shell access revoked");
  expect(queryFastControl("button", "Revoke")).toBeNull();
  expect(queryFastControl("button", allow)).toBeNull();
});
test("desktop-shell-authorization-016 a later shell update recovers the unavailable grant card", async () => {
  const api = await visit({ data: { status: "approved" } });
  await expect(button("Revoke")).resolves.toBeEnabled();
  api.refresh({}, { fail: true, host: true });
  await label("Shell access unavailable");
  await expect(button("Authorization unavailable")).resolves.toBeDisabled();
  expect(queryFastControl("button", "Revoke")).toBeNull();
  api.refresh({ status: "revoked" });
  await label("Shell access revoked");
  expect(queryFastControl("button", "Authorization unavailable")).toBeNull();
});
test("desktop-shell-authorization-019 the approved short grant expires on its own deadline", async () => {
  await visit({ grantMs: 250 });
  click(await button(allow));
  await label("Shell access allowed");
  await label("Shell access expired");
  expect(queryFastControl("button", "Revoke")).toBeNull();
  expect(queryFastControl("button", allow)).toBeNull();
});
test("desktop-shell-authorization-021 a prior approval restores the grant after the request deadline", async () => {
  const fixed = new Date("2026-09-10T12:00:00.000Z");
  mockNow(fixed, context.signal);
  const api = await visit({ requestMs: 1 });
  await label("Shell access expired");
  mockNow(new Date(fixed.getTime() + 2), context.signal);
  api.refresh({
    status: "approved",
    approvedAt: fixed.toISOString(),
    grantExpiresAt: new Date(fixed.getTime() + 3_600_000).toISOString(),
  });
  await label("Shell access allowed");
  await expect(button("Revoke")).resolves.toBeEnabled();
  expect(screen.queryByText("Shell access expired")).toBeNull();
});
test("desktop-shell-authorization-023 an external origin with a shell-shaped path renders an ordinary link", async () => {
  const { url } = await visit({ external: true });
  await waitFor(() => {
    expect(
      queryAllByRoleFast("link").find((element) => {
        return element.getAttribute("href") === url.href;
      }),
    ).toBeVisible();
  });
  expect(screen.queryByText("Shell access")).toBeNull();
  expect(queryFastControl("button", allow)).toBeNull();
});
test.each([
  ["024", false],
  ["027", true],
] as const)(
  "desktop-shell-authorization-%s approving without a callback grants access without sending a chat prompt",
  async (_id, standalone) => {
    const api = await visit({ standalone });
    click(await button(allow));
    const revoke = await button("Revoke");
    await waitFor(() => {
      expect(revoke).toBeEnabled();
      expect(revoke).not.toHaveAttribute("aria-busy", "true");
      expect(revoke).not.toHaveAttribute("aria-disabled", "true");
    });
    expect(api.sent.settled()).toBeFalsy();
  },
);
test("desktop-shell-authorization-025 the approval sends its callback to the current conversation", async () => {
  const prompt = "Continue the approved test run";
  const api = await visit({ callback: prompt });
  click(await button(allow));
  await button("Revoke");
  await expect(api.sent.promise).resolves.toBe(prompt);
  await waitFor(() => {
    expect(screen.getAllByText(prompt, { exact: true })).toHaveLength(1);
  });
});
