import { createCanvas, loadImage } from "@napi-rs/canvas";
import jsQR from "jsqr";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { publicStatusItem } from "./connector-page-test-helpers.ts";
import { connectorCatalogConnectItem } from "../../../mocks/handlers/api-connectors.ts";
import {
  onboardingOAuth,
  onboardingSourceItem,
} from "../../onboarding-sources-first/__tests__/onboarding-catalog-test-helpers.ts";
import { DetachedBrowserContext } from "happy-dom";
import { integrationsAgentPhoneContract } from "@okouai/api-contracts/contracts/integrations-agentphone";
import {
  getStartedContract,
  GET_STARTED_REWARDS,
  GET_STARTED_REWARDS_CHANGED_EVENT,
  type GetStartedStatus,
  type GetStartedQuestKey,
} from "@okouai/api-contracts/contracts/get-started";
import { friendReferralsContract } from "@okouai/api-contracts/contracts/friend-referrals";
import { orgContract } from "@okouai/api-contracts/contracts/org-routes";
import { integrationsSlackContract } from "@okouai/api-contracts/contracts/integrations-slack";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect, vi } from "vitest";
import { setupPage, click, fill } from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
const context = testContext();
const clock = "2026-09-10T12:00:00.000Z";
function rewards(
  keys: GetStartedQuestKey[] = [
    "connector",
    "slack",
    "workflow",
    "invite",
    "checkin",
  ],
): GetStartedStatus {
  return {
    serverNow: clock,
    nextResetAt: "2026-09-11T00:00:00.000Z",
    claimedToday: false,
    checkinStreak: 0,
    recentGrants: [],
    quests: keys.map((key) => {
      const rule = GET_STARTED_REWARDS[key];
      const claimedCount = key === "connector" ? 3 : key === "invite" ? 1 : 0;
      return {
        key,
        rewardAmount: rule.amount,
        rewardTarget: rule.target,
        claimedCount,
        limit: rule.limit,
        earnedCredits: claimedCount * rule.amount,
        canEarnMore: true,
        pendingCount: 0,
      };
    }),
  };
}
function record(data: GetStartedStatus, key: GetStartedQuestKey) {
  const row = data.quests.find((q) => {
    return q.key === key;
  });
  if (!row) {
    throw new Error("Missing quest " + key);
  }
  return row;
}
function serve(
  data: GetStartedStatus,
  gate: () => Promise<void> | undefined = () => {
    return undefined;
  },
) {
  context.mocks.api(getStartedContract.status, async ({ respond }) => {
    await gate();
    return respond(200, data);
  });
}
async function home(admin = true) {
  mockNow(new Date(clock), context.signal);
  const org = { id: "org_workshop", name: "Workshop" };
  context.mocks.api(orgContract.get, ({ respond }) => {
    return respond(200, { ...org, role: admin ? "admin" : "member" });
  });
  await setupPage({
    context,
    path: "/",
    host: "app.okou.ai",
    auth: {
      user: { id: "user_harbor", fullName: "Harbor reader" },
      organization: {
        activeOrg: org,
        memberships: [{ id: org.id, role: admin ? "org:admin" : "org:member" }],
      },
    },
  });
}
async function open() {
  const entry = await screen.findByTestId("get-started-entry");
  click(entry);
  await screen.findByRole("menu");
  return entry;
}
async function quest(key: GetStartedQuestKey) {
  return await screen.findByTestId("get-started-quest-" + key);
}
async function intro(key: GetStartedQuestKey) {
  click(await quest(key));
  return await screen.findByRole("dialog");
}
function referral(success: () => boolean, gate?: Promise<void>) {
  context.mocks.api(friendReferralsContract.link, async ({ respond }) => {
    await gate;
    return success()
      ? respond(200, {
          code: "a7k2p9",
          registeredCount: 1,
          rewardedCount: 0,
          earnedCredits: 0,
        })
      : respond(403, { error: { code: "FORBIDDEN", message: "Unavailable" } });
  });
}
test("get-started-entry-002 browser history returns to chat with the invitation closed", async () => {
  serve(rewards([]));
  referral(() => {
    return true;
  });
  await home();
  click(await findFastControl("link", "Workflows"));
  await waitFor(() => {
    expect(location.pathname).toBe("/workflows");
  });
  window.history.back();
  const gift = await findFastControl("button", "Invite your friends");
  click(gift);
  await screen.findByRole("dialog", { name: "Invite friends, get $20 each" });
  window.history.forward();
  await waitFor(() => {
    expect(location.pathname).toBe("/workflows");
  });
  window.history.back();
  await findFastControl("button", "Invite your friends");
  expect(
    screen.queryByRole("dialog", { name: "Invite friends, get $20 each" }),
  ).toBeNull();
});
test("get-started-entry-003 a denied invitation link can be retried in the open dialog", async () => {
  let allowed = false;
  serve(rewards([]));
  referral(() => {
    return allowed;
  });
  await home();
  click(await findFastControl("button", "Invite your friends"));
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText(
    "Your invitation link could not be loaded. Try again.",
  );
  allowed = true;
  click(await findFastControl("button", "Try again", dialog));
  await expect(
    findFastControl("button", "Copy invite link", dialog),
  ).resolves.toBeEnabled();
});
test("get-started-entry-005 completed Slack and partially earned connector rewards remain distinguishable", async () => {
  serve(rewards());
  await home();
  const entry = await open();
  expect(entry).toHaveTextContent("3/5");
  await screen.findByText("How rewards work");
  await expect(quest("workflow")).resolves.toHaveTextContent(/1,000/);
  await expect(quest("invite")).resolves.toHaveTextContent("Invite your team");
  const slack = await quest("slack");
  expect(slack).not.toHaveAttribute("role", "menuitem");
  expect(within(slack).queryByText("Add", { exact: true })).toBeNull();
  const connector = await quest("connector");
  expect(connector).toHaveAttribute("role", "menuitem");
  expect(connector).toHaveTextContent("3/10");
  expect(connector).toHaveTextContent("100");
});
test("get-started-entry-009 a granted workflow refreshes the open rewards panel", async () => {
  const data = rewards();
  const flow = record(data, "workflow");
  flow.pendingCount = 1;
  serve(data);
  await home();
  const entry = await open();
  expect(entry).toHaveTextContent("3/5");
  await expect(quest("workflow")).resolves.toHaveTextContent("In review");
  Object.assign(flow, {
    pendingCount: 0,
    claimedCount: 1,
    canEarnMore: false,
    earnedCredits: 1000,
  });
  context.mocks.ably.trigger(GET_STARTED_REWARDS_CHANGED_EVENT, {});
  await waitFor(() => {
    expect(entry).toHaveTextContent("4/5");
  });
  await expect(quest("workflow")).resolves.toBeVisible();
  await expect(quest("workflow")).resolves.not.toHaveTextContent("In review");
});
function slackStatus(state: {
  installed: boolean;
  url: string | null;
  fail?: boolean;
  gate?: Promise<void>;
  started?: () => void;
}) {
  context.mocks.api(
    integrationsSlackContract.getStatus,
    async ({ respond }) => {
      if (state.gate) {
        state.started?.();
        await state.gate;
      }
      return state.fail
        ? respond(401, { error: { code: "UNAVAILABLE", message: "Offline" } })
        : respond(200, {
            isInstalled: state.installed,
            isConnected: false,
            isAdmin: true,
            workspaceName: null,
            installUrl: state.url,
          });
    },
  );
}
const oauth = "https://accounts.example.test/slack/install?state=workshop";
test.each([
  ["015", null, true],
  ["023", oauth, false],
  ["024", null, false],
] as const)(
  "get-started-entry-%s Slack opens the correct installation destination while retaining the chat",
  async (id, url, fail) => {
    const destination = new URL(
      url ?? "/settings/slack",
      "https://app.okou.ai",
    );
    context.mocks.http.get(destination.origin + destination.pathname, () => {
      return new Response("<title>Slack connection</title>", {
        headers: { "Content-Type": "text/html" },
      });
    });
    const tabs = vi.spyOn(DetachedBrowserContext.prototype, "newPage");
    serve(rewards());
    slackStatus({ installed: false, url, fail });
    await home();
    const editor = await findComposerEditor();
    if (id !== "015") {
      await fill(editor, "Keep my outline");
    }
    await open();
    const dialog = await intro("slack");
    expect(dialog).toHaveTextContent("2,000");
    click(await findFastControl("button", "Add to Slack", dialog));
    await waitFor(() => {
      expect(dialog).not.toBeInTheDocument();
    });
    const dest = new URL(url ?? "/settings/slack", "https://app.okou.ai");
    dest.searchParams.set("_t", String(Date.parse(clock)));
    await waitFor(() => {
      expect(
        tabs.mock.results.map((r) => {
          return r.value.url;
        }),
      ).toContain(dest.href);
    });
    for (const tab of tabs.mock.results) {
      await tab.value.close();
    }
    expect(location.pathname).toBe("/");
    expect(editor.textContent).toBe(id === "015" ? "" : "Keep my outline");
  },
);
test("get-started-entry-026 Slack can use its previously displayed workspace URL while its refresh is held", async () => {
  const address = new URL(oauth);
  context.mocks.http.get(address.origin + address.pathname, () => {
    return new Response("<title>Slack connection</title>", {
      headers: { "Content-Type": "text/html" },
    });
  });
  const tabs = vi.spyOn(DetachedBrowserContext.prototype, "newPage");
  const hold = context.mocks.deferred<void>(),
    request = context.mocks.deferred<void>();
  const state = {
    installed: false,
    url: oauth,
    gate: undefined as Promise<void> | undefined,
    started: () => {
      if (!request.settled()) {
        request.resolve();
      }
    },
  };
  serve(rewards());
  slackStatus(state);
  await home();
  await open();
  const dialog = await intro("slack");
  const add = await findFastControl("button", "Add to Slack", dialog);
  state.gate = hold.promise;
  state.url = "https://accounts.example.test/other";
  context.mocks.ably.trigger("slack:changed", {});
  await request.promise;
  click(add);
  await waitFor(() => {
    expect(
      tabs.mock.results.map((r) => {
        return r.value.url;
      }),
    ).toContain(oauth + "&_t=" + String(Date.parse(clock)));
  });
  for (const tab of tabs.mock.results) {
    await tab.value.close();
  }
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
  expect(location.pathname).toBe("/");
  hold.resolve();
});
test("get-started-entry-027 reopening after a blocked Slack popup keeps the quest and uses a fresh timestamp", async () => {
  const launch = context.mocks.browser.open();
  serve(rewards());
  slackStatus({ installed: false, url: oauth });
  await home();
  for (const ms of [0, 1]) {
    mockNow(new Date(Date.parse(clock) + ms), context.signal);
    await expect(open()).resolves.toHaveTextContent("2/5");
    const dialog = await intro("slack");
    const add = await findFastControl("button", "Add to Slack", dialog);
    expect(add).toBeEnabled();
    click(add);
    await waitFor(() => {
      expect(dialog).not.toBeInTheDocument();
    });
    expect(launch.calls.at(-1)).toMatchObject({
      url: oauth + "&_t=" + String(Date.parse(clock) + ms),
      target: "_blank",
    });
    expect(location.pathname).toBe("/");
  }
});
test("get-started-entry-033 reopening refreshes Slack completion without a realtime event", async () => {
  const state = { installed: false, url: oauth };
  const data = rewards();
  data.claimedToday = true;
  Object.assign(record(data, "checkin"), { canEarnMore: false });
  Object.assign(record(data, "invite"), { claimedCount: 0, earnedCredits: 0 });
  serve(data);
  slackStatus(state);
  await home();
  const entry = await open();
  expect(entry).toHaveTextContent("2/5");
  await userEvent.keyboard("{Escape}");
  state.installed = true;
  await open();
  await waitFor(() => {
    expect(entry).toHaveTextContent("3/5");
  });
  await expect(quest("slack")).resolves.not.toHaveAttribute("role", "menuitem");
  await screen.findByText(/1,200 to go/);
});

function phone(state: { linked: boolean }) {
  const number = "+12025550163",
    code = "73019482";
  context.mocks.api(
    integrationsAgentPhoneContract.getLinkStatus,
    ({ respond }) => {
      return respond(
        200,
        state.linked
          ? {
              linked: true,
              phoneHandle: "+12025550114",
              agentPhoneNumber: number,
              configured: true,
            }
          : { linked: false, agentPhoneNumber: number, configured: true },
      );
    },
  );
  context.mocks.api(
    integrationsAgentPhoneContract.createLinkCode,
    ({ respond }) => {
      return respond(200, { code, expiresAt: "2026-09-10T12:15:00.000Z" });
    },
  );
  return { number, code };
}
test("get-started-entry-011 linking the phone closes its own dialog and credits the member quest", async () => {
  const state = { linked: false };
  phone(state);
  const data = rewards(["connector", "invite", "imessage", "checkin"]);
  serve(data);
  await home(false);
  const entry = await open();
  const dialog = await intro("imessage");
  await within(dialog).findByTestId("agentphone-link-qr");
  state.linked = true;
  Object.assign(record(data, "imessage"), {
    claimedCount: 1,
    canEarnMore: false,
    earnedCredits: 1000,
  });
  context.mocks.ably.trigger("agentphone:changed", {});
  context.mocks.ably.trigger(GET_STARTED_REWARDS_CHANGED_EVENT, {});
  await screen.findByText("Phone number connected");
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
    expect(entry).toHaveTextContent("3/4");
  });
});
test("get-started-entry-018 browsing connectors leaves the quest dialog for the full catalog", async () => {
  serve(rewards());
  await home();
  await open();
  const dialog = await intro("connector");
  await within(dialog).findByText(/Pick one and Okou starts working in it/);
  await within(dialog).findByText("Gmail");
  expect(location.pathname).toBe("/");
  click(await findFastControl("link", "Browse all connectors", dialog));
  await waitFor(() => {
    expect(location.pathname).toBe("/connectors");
    expect(dialog).not.toBeInTheDocument();
  });
  await screen.findByRole("heading", { name: "Connectors" });
});
function checkIn(
  data: GetStartedStatus,
  options: {
    statusGate?: Promise<void>;
    claimGate?: () => Promise<void>;
    pendingReview?: boolean;
    statusUnavailable?: boolean;
    retryClaim?: boolean;
  } = {},
) {
  let confirmed = false;
  const refreshed = context.mocks.deferred<void>();
  let retry = options.retryClaim;
  context.mocks.api(getStartedContract.status, async ({ respond }) => {
    if (confirmed) {
      if (!refreshed.settled()) {
        refreshed.resolve();
      }
      await options.statusGate;
      if (options.statusUnavailable) {
        return respond(503, {
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: "Rewards status unavailable",
          },
        });
      }
    }
    return respond(200, data);
  });
  context.mocks.api(getStartedContract.checkin, async ({ respond }) => {
    await options.claimGate?.();
    if (retry) {
      retry = false;
      return respond(503, {
        error: { code: "SERVICE_UNAVAILABLE", message: "Check-in unavailable" },
      });
    }
    confirmed = true;
    const row = record(data, "checkin");
    if (options.pendingReview) {
      row.pendingCount = 1;
      return respond(202, {
        status: "pending",
        requestId: crypto.randomUUID(),
      });
    }
    data.claimedToday = true;
    data.checkinStreak += 1;
    Object.assign(row, {
      claimedCount: 1,
      earnedCredits: 100,
      canEarnMore: false,
    });
    return respond(200, {
      id: crypto.randomUUID(),
      questKey: "checkin",
      status: "granted",
      rewardAmount: 100,
      rewardTarget: "user",
      reason: null,
      submittedAt: clock,
      grantedAt: clock,
      expiresAt: "2026-09-17T12:00:00.000Z",
    });
  });
  return refreshed;
}
function rewardReceipt() {
  return screen.findByRole("dialog", { name: "Checked in for today" });
}
test("get-started-entry-036 a ninth-day receipt shows the award and returns focus to the rewards entry", async () => {
  const data = rewards(["connector", "invite", "checkin"]);
  data.checkinStreak = 8;
  checkIn(data);
  await home(false);
  const entry = await open();
  click(await quest("checkin"));
  const receipt = await rewardReceipt();
  await within(receipt).findByText("9-day streak");
  expect(receipt).toHaveTextContent("+100 credits");
  click(await findFastControl("button", "Back to work", receipt));
  await waitFor(() => {
    expect(receipt).not.toBeInTheDocument();
    expect(entry).toHaveFocus();
  });
});
test("get-started-entry-037 the confirmed credit arrives before the refreshed ninth-day streak", async () => {
  const data = rewards(["connector", "checkin"]);
  data.checkinStreak = 8;
  const claim = context.mocks.deferred<void>(),
    approve = context.mocks.deferred<void>(),
    status = context.mocks.deferred<void>();
  const refreshing = checkIn(data, {
    statusGate: status.promise,
    claimGate: async () => {
      claim.resolve();
      await approve.promise;
    },
  });
  await home(false);
  const entry = await open();
  const row = await quest("checkin");
  click(row);
  await claim.promise;
  expect(row).toHaveAttribute("aria-busy", "true");
  expect(screen.queryByRole("dialog")).toBeNull();
  approve.resolve();
  const receipt = await rewardReceipt();
  await refreshing.promise;
  expect(receipt).toHaveTextContent("+100 credits");
  expect(receipt).not.toHaveTextContent("9-day streak");
  expect(row).not.toBeInTheDocument();
  status.resolve();
  await within(receipt).findByText("9-day streak");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(receipt).not.toBeInTheDocument();
    expect(entry).toHaveFocus();
  });
});
test("The first daily credit receipt leads back to a completed check-in", async () => {
  const data = rewards(["checkin", "connector"]);
  data.checkinStreak = 0;
  checkIn(data);
  await home(false);
  await open();
  click(await quest("checkin"));
  const receipt = await rewardReceipt();
  await within(receipt).findByText("1-day streak");
  expect(receipt).toHaveTextContent("+100 credits");
  click(await findFastControl("button", "Back to work", receipt));
  await waitFor(() => {
    expect(receipt).not.toBeInTheDocument();
  });
  await open();
  const completed = await quest("checkin");
  expect(completed).toHaveTextContent("Checked in");
  expect(completed).not.toHaveAttribute("role", "menuitem");
});
test("A member retries a rejected check-in and receives the credit confirmation", async () => {
  checkIn(rewards(["checkin", "connector"]), { retryClaim: true });
  await home(false);
  await open();
  click(await quest("checkin"));
  await screen.findByText("Check-in unavailable");
  expect(screen.queryByRole("dialog")).toBeNull();
  const retry = await quest("checkin");
  expect(retry).toHaveTextContent("Check in");
  click(retry);
  const receipt = await rewardReceipt();
  expect(receipt).toHaveTextContent("+100 credits");
});
test("Leaving an outstanding check-in keeps the reopened rewards menu usable after the claim settles", async () => {
  const request = context.mocks.deferred<void>(),
    finish = context.mocks.deferred<void>();
  checkIn(rewards(["checkin", "workflow", "connector"]), {
    claimGate: async () => {
      request.resolve();
      await finish.promise;
    },
  });
  await home(false);
  await open();
  click(await quest("checkin"));
  await request.promise;
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });
  await open();
  finish.resolve();
  const panel = await screen.findByRole("menu");
  await within(panel).findByText("Checked in");
  expect(screen.queryByRole("dialog")).toBeNull();
  click(await quest("workflow"));
  await screen.findByRole("dialog");
});
test("The claim receipt can be dismissed after the rewards status becomes unavailable", async () => {
  checkIn(rewards(["checkin", "invite"]), { statusUnavailable: true });
  await home(false);
  const entry = await open();
  click(await quest("checkin"));
  const receipt = await rewardReceipt();
  await waitFor(() => {
    expect(entry).not.toBeInTheDocument();
  });
  expect(receipt).toHaveTextContent("+100 credits");
  click(await findFastControl("button", "Back to work", receipt));
  await waitFor(() => {
    expect(receipt).not.toBeInTheDocument();
  });
});
test("get-started-entry-038 a check-in awaiting financial confirmation shows its review state", async () => {
  const data = rewards(["connector", "checkin"]);
  checkIn(data, { pendingReview: true });
  await home(false);
  await open();
  click(await quest("checkin"));
  const review = await screen.findByText("In review");
  expect(review).toBeVisible();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByText("Checked in")).toBeNull();
  await expect(quest("checkin")).resolves.not.toHaveAttribute(
    "role",
    "menuitem",
  );
});

test("get-started-entry-022 selecting Gmail starts its authorization on the local browser boundary and preserves chat", async () => {
  const auth = onboardingOAuth(context, "gmail", "Gmail");
  const item = onboardingSourceItem({
    slug: "gmail",
    label: "Gmail",
    description: "Local mail access",
    hasAccount: false,
  });
  context.mocks.api(connectorCatalogContract.oneClick, ({ respond }) => {
    return respond(200, { connectors: [connectorCatalogConnectItem(item)] });
  });
  serve(rewards());
  await home();
  const editor = await findComposerEditor();
  await fill(editor, "Keep the release checklist");
  await open();
  const picker = await intro("connector");
  click(await findFastControl("button", /Gmail/, picker));
  await expect(auth.started).resolves.toMatchObject({ slug: "gmail" });
  await waitFor(() => {
    return expect(auth.popup.location.href).toBe(auth.url);
  });
  expect(location.pathname).toBe("/");
  expect(editor.textContent).toBe("Keep the release checklist");
  expect(screen.queryByRole("dialog", { name: "Gmail" })).toBeNull();
  auth.popup.close();
});

test("Copying a pending invitation preserves its referral code and restores focus to the gift entry", async () => {
  const release = context.mocks.deferred<void>();
  serve(rewards([]));
  referral(() => {
    return true;
  }, release.promise);
  await home();
  const entry = await findFastControl("button", "Invite your friends");
  entry.focus();
  click(entry);
  const dialog = await screen.findByRole("dialog", { name: /invite friends/i });
  await expect(
    within(dialog).findByText(/buys a usage pack/i),
  ).resolves.toBeVisible();
  expect(
    within(dialog).getByRole("status", { name: /getting.*invitation link/i }),
  ).toBeVisible();
  expect(
    within(dialog).getByRole("heading", {
      name: "Invite friends, get $20 each",
    }),
  ).toBeVisible();
  expect(dialog).toHaveTextContent(
    "You get $20 in credits once a friend completes all 3 steps",
  );
  expect(
    within(dialog).getByText("Signs up with your invite link"),
  ).toBeVisible();
  expect(within(dialog).getByText("Upgrades to Pro or above")).toBeVisible();

  expect(dialog).toHaveTextContent(/expire 1 month/i);
  release.resolve();
  const keyboard = userEvent.setup();
  const copy = await findFastControl("button", "Copy invite link", dialog);
  click(copy);
  await waitFor(async () => {
    return await expect(navigator.clipboard.readText()).resolves.toBe(
      new URL("/sign-up?friend_referral=a7k2p9", location.origin).href,
    );
  });
  await keyboard.keyboard("{Escape}");
  expect(dialog).not.toBeInTheDocument();
  expect(entry).toHaveFocus();
});
test("The tenth claim makes the named connector quest non-actionable", async () => {
  const data = rewards(["connector", "workflow"]);
  Object.assign(record(data, "connector"), {
    claimedCount: 10,
    limit: 10,
    canEarnMore: false,
  });
  serve(data);
  await home();
  await open();
  const row = await quest("connector");
  expect(row).toHaveTextContent(/10\s*\/\s*10/);
  expect(within(row).getByText(/^Connect a connector$/i)).toBeVisible();
  expect(row).not.toHaveAttribute("role", "menuitem");
  expect(within(row).queryByText("Connect", { exact: true })).toBeNull();
});

test("get-started-entry-010 the member phone quest offers the earned credits, scannable SMS instructions and both copy controls", async () => {
  const { number, code } = phone({ linked: false });
  serve(rewards(["imessage", "workflow"]));
  await home(false);
  await open();
  const dialog = await intro("imessage");
  const content = within(dialog);
  const qr = await content.findByTestId("agentphone-link-qr");
  const image = await loadImage(
    Buffer.from(new XMLSerializer().serializeToString(qr)),
  );
  const canvas = createCanvas(408, 408);
  const paint = canvas.getContext("2d");
  paint.drawImage(image, 0, 0, canvas.width, canvas.height);
  const pixels = paint.getImageData(0, 0, canvas.width, canvas.height);
  const sms = jsQR(pixels.data, pixels.width, pixels.height);
  expect(sms?.data).toBe("sms:" + number + "?body=" + code);
  expect(qr).toBeVisible();
  expect(dialog).toHaveTextContent(/1,000/);
  expect(dialog).toHaveTextContent(/camera/i);
  expect(dialog).toHaveTextContent(/text/i);

  await expect(
    findFastControl("button", /copy.*code/i, dialog),
  ).resolves.toBeEnabled();
  await expect(
    findFastControl("button", /copy.*202.*555.*0163/i, dialog),
  ).resolves.toBeEnabled();
  await expect(
    findFastControl("button", /close/i, dialog),
  ).resolves.toBeEnabled();
});

test("get-started-entry-042 A connector chosen in the rewards picker reveals the authentication options from its detail response", async () => {
  const choice = publicStatusItem({
    connectorSlug: "github",
    label: "Choice connector",
    authMethods: ["Personal OAuth", "Workspace OAuth"].map((label, index) => {
      return {
        id: index === 0 ? "personal" : "workspace",
        grantKind: "auth-code",
        label,
        description: null,
        supportsRefresh: true,
        manualFields: [],
        startOptions: [],
      };
    }),
  });
  const release = context.mocks.deferred<void>();
  const selected = context.mocks.deferred<void>();
  context.mocks.api(
    connectorCatalogContract.get,
    async ({ params, respond }) => {
      if (params.connectorSlug !== choice.slug) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Connector unavailable" },
        });
      }
      selected.resolve();
      await release.promise;
      return respond(200, { connector: choice });
    },
  );
  context.mocks.api(connectorCatalogContract.oneClick, ({ respond }) => {
    return respond(200, { connectors: [connectorCatalogConnectItem(choice)] });
  });
  serve(rewards());
  await home();
  await open();
  const picker = await intro("connector");
  click(await findFastControl("button", /Choice connector/, picker));
  await selected.promise;
  expect(screen.queryByText("Workspace OAuth")).toBeNull();
  release.resolve();
  const dialog = await screen.findByRole("dialog", {
    name: "Choice connector",
  });
  await expect(
    within(dialog).findByText("Workspace OAuth"),
  ).resolves.toBeVisible();
  expect(within(dialog).getByText("Personal OAuth")).toBeVisible();
});
