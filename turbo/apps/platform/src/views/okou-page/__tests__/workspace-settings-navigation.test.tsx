import { test, expect } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  chatListThread,
  installChatListStream,
} from "./chat-list-test-helpers.ts";
import {
  findAction,
  getAction,
  queryAction,
} from "./connector-integrations-test-helpers.ts";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { thirdPartySubscriptionsMainContract } from "@okouai/api-contracts/contracts/third-party-subscriptions";
import { personalAccount } from "./personal-account-settings-fixtures.ts";
import { mockNow } from "../../../lib/time.ts";
import { defaultBillingStatus } from "../../../mocks/handlers/api-billing.ts";

const context = testContext();

test("settings-dialog-005 a workspace administrator switches from General to People inside Settings", async () => {
  context.mocks.data.org({ role: "admin" });
  await setupPage({ context, path: "/?settings=general" });
  const settings = await screen.findByRole("dialog");
  await within(settings).findByRole("heading", { name: "General" });
  click(await findAction("button", "People", settings));
  await waitFor(() => {
    return expect(
      within(settings).getByRole("heading", { name: "People" }),
    ).toBeVisible();
  });
  expect(settings).toBeVisible();
  expect(new URL(location.href).searchParams.get("settings")).toBe("people");
});

test("settings-dialog-004 workspace Indonesian wins over French and German until English is chosen", async () => {
  context.mocks.browser.language("de-DE");
  context.mocks.browser.cookie("__Secure-okou-locale=v1.fr-FR");
  context.mocks.data.userPreferences({ locale: "id-ID", timezone: "UTC" });
  await setupPage({
    context,
    host: "app.okou.ai",
    path: "/?settings=preference",
  });
  const settings = await screen.findByRole("dialog");
  const language = await within(settings).findByRole("combobox", {
    name: "Language",
  });
  await waitFor(() => {
    return expect(language).toHaveTextContent("Bahasa Indonesia");
  });
  expect(document.documentElement.lang).toBe("id-ID");
  click(language);
  click(await screen.findByRole("option", { name: "English" }));
  await waitFor(() => {
    return expect(document.documentElement.lang).toBe("en-US");
  });
  expect(language).toHaveTextContent("English");
});
test("settings-dialog-007 a member arriving through workspace Settings sees Theme and personal navigation", async () => {
  context.mocks.data.org({ role: "member" });
  await setupPage({ context, path: "/?settings=general" });
  const settings = await screen.findByRole("dialog");
  await expect(
    within(settings).findByText("Theme", { exact: true }),
  ).resolves.toBeVisible();
  const nav = within(settings).getByRole("navigation");
  expect(within(nav).queryByText("Workspace")).toBeNull();
  expect(queryAction("button", "General", nav)).toBeNull();
  expect(queryAction("button", "People", nav)).toBeNull();
});
test("settings-dialog-008 measuring a three-thread local snapshot reports its size and read duration", async () => {
  const snapshot = [
    "Interview notes",
    "Archive review",
    "Launch retrospective",
  ].map((title, index) => {
    return chatListThread(index + 1, title);
  });
  installChatListStream(context, { caseId: 61, snapshot });
  await setupPage({
    context,
    path: "/?settings=preference",
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
  });
  const settings = await screen.findByRole("dialog");
  click(await findAction("button", "Debug", settings));
  const details = await within(settings).findByText("IndexedDB storage", {
    selector: "summary span",
  });
  click(details);
  const snapshotStore = await within(settings).findByText(
    "chat_thread_snapshot",
    {
      selector: "dt",
    },
  );
  await waitFor(() => {
    return expect(snapshotStore.nextElementSibling).toHaveTextContent(/^1$/u);
  });
  const region = await within(settings).findByRole("region", {
    name: "Thread snapshot",
  });
  const view = within(region);
  expect(view.queryByText("Threads in snapshot")).toBeNull();
  click(getAction("button", "Measure snapshot", region));
  expect(getAction("button", "Measuring...", region)).toBeDisabled();
  await view.findByText("Threads in snapshot");
  expect(getAction("button", "Measure snapshot", region)).toBeEnabled();
  expect(
    view.getByText("Threads in snapshot").nextElementSibling,
  ).toHaveTextContent(/^3$/u);
  expect(
    view.getByText("Estimated payload").nextElementSibling,
  ).toHaveTextContent(
    /^(?:[1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)\s?KB$/u,
  );
  expect(
    view.getByText("IndexedDB read time").nextElementSibling,
  ).toHaveTextContent(/^[0-9]+(?:\.[0-9]+)?\s?ms$/u);
});

async function accountMenu() {
  click(await findAction("button", "Test User"));
  return screen.findByRole("menu");
}
test("settings-model-loading-003 a billing notification updates the reopened balance view and the account menu", async () => {
  let credits = 20_000;
  let paused = false;
  const reading = context.mocks.deferred<void>();
  const resume = context.mocks.deferred<void>();
  context.mocks.api(billingStatusContract.get, async ({ respond }) => {
    const balance = credits;
    if (paused) {
      reading.resolve();
      await resume.promise;
    }
    return respond(200, { ...defaultBillingStatus(), credits: balance });
  });
  await setupPage({ context, path: "/?settings=model" });
  const initial = await screen.findByRole("dialog", { name: "Settings" });
  await within(initial).findByRole("heading", { name: "Use more models" });
  click(getAction("button", "Close", initial));
  const menu = await accountMenu();
  await within(menu).findByText("20,000 credits");
  click(within(menu).getByText("Settings"));
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  click(await findAction("button", "Models", settings));
  await within(settings).findByRole("heading", { name: "Use more models" });
  paused = true;
  context.mocks.ably.trigger("billing:changed");
  await reading.promise;
  click(getAction("button", "Credit balance", settings));
  await within(settings).findByRole("heading", { name: "Credit balance" });
  paused = false;
  resume.resolve();
  await within(settings).findByText("20,000", { exact: true });
  credits = 25_000;
  context.mocks.ably.trigger("billing:changed");
  await expect(
    within(settings).findByText("25,000", { exact: true }),
  ).resolves.toBeVisible();
  click(getAction("button", "Close", settings));
  const after = await accountMenu();
  await expect(
    within(after).findByText("25,000 credits"),
  ).resolves.toBeVisible();
});

test.each(["billing", "subscriptions"] as const)(
  "Reopening Models waits for the subscription even when %s settles first",
  async (first) => {
    const resume = context.mocks.deferred<void>();
    const refreshing = context.mocks.deferred<void>();
    const accountRead = context.mocks.deferred<void>();
    const confirmAccount = context.mocks.deferred<void>();
    const member = personalAccount("ChatGPT", 4);
    let clock = new Date("2026-06-18T10:00:00Z").getTime();
    mockNow(() => {
      return clock;
    }, context.signal);
    let suspend = false;
    context.mocks.api(
      thirdPartySubscriptionsMainContract.list,
      async ({ respond }) => {
        if (!suspend) {
          return respond(200, { subscriptions: [] });
        }
        accountRead.resolve();
        await confirmAccount.promise;
        return respond(200, { subscriptions: [member] });
      },
    );
    context.mocks.api(billingStatusContract.get, async ({ respond }) => {
      if (suspend) {
        refreshing.resolve();
        await resume.promise;
      }
      return respond(200, defaultBillingStatus());
    });
    try {
      await setupPage({
        context,
        path: "/?settings=model",
        featureSwitches: { [FeatureSwitchKey.SubscriptionLinkingEntry]: true },
      });
      const dialog = await screen.findByRole("dialog", { name: "Settings" });
      await expect(
        findAction("button", "Connect account", dialog),
      ).resolves.toBeEnabled();
      click(getAction("button", "Close", dialog));
      clock += 120_000;
      suspend = true;
      const menu = await accountMenu();
      await accountRead.promise;
      click(within(menu).getByText("Settings"));
      const reopened = await screen.findByRole("dialog", { name: "Settings" });
      click(getAction("button", "Preference", reopened));
      await within(reopened).findByRole("heading", { name: "Preference" });
      context.mocks.ably.trigger("billing:changed");
      click(getAction("button", "Models", reopened));
      await refreshing.promise;
      expect(
        within(reopened).queryByRole("heading", { name: "Models" }),
      ).toBeNull();
      await expect(
        within(reopened).findByRole("heading", { name: "Use more models" }),
      ).resolves.toBeInTheDocument();
      await within(reopened).findByRole("status", {
        name: "Loading accounts…",
      });
      expect(within(reopened).queryByText("No accounts connected.")).toBeNull();
      expect(within(reopened).queryAllByText("Connect account")).toHaveLength(
        0,
      );
      if (first === "billing") {
        resume.resolve();
      }
      await within(reopened).findByRole("status", {
        name: "Loading accounts…",
      });
      expect(within(reopened).queryByText("No accounts connected.")).toBeNull();
      confirmAccount.resolve();
      await within(reopened).findByText("member4@example.test");
    } finally {
      if (!confirmAccount.settled()) {
        confirmAccount.resolve();
      }
      if (!resume.settled()) {
        resume.resolve();
      }
    }
  },
);

test("Returning to model settings presents account setup while the updated balance is held", async () => {
  const resume = context.mocks.deferred<void>();
  const refreshing = context.mocks.deferred<void>();
  let suspend = false;
  context.mocks.api(billingStatusContract.get, async ({ respond }) => {
    if (suspend) {
      refreshing.resolve();
      await resume.promise;
    }
    return respond(200, defaultBillingStatus());
  });
  try {
    await setupPage({ context, path: "/?settings=model" });
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    await expect(
      findAction("button", "Connect account", dialog),
    ).resolves.toBeEnabled();
    click(getAction("button", "Preference", dialog));
    await within(dialog).findByRole("heading", { name: "Preference" });
    suspend = true;
    context.mocks.ably.trigger("billing:changed");
    click(getAction("button", "Models", dialog));
    await refreshing.promise;
    expect(
      within(dialog).queryByRole("heading", { name: "Models" }),
    ).toBeNull();
    await expect(
      within(dialog).findByRole("heading", { name: "Use more models" }),
    ).resolves.toBeInTheDocument();
    await expect(
      findAction("button", "Connect account", dialog),
    ).resolves.toBeEnabled();
    for (const name of ["Claude", "ChatGPT (Codex)"]) {
      const provider = within(dialog).getByRole("heading", {
        name,
      }).parentElement!;
      expect(
        within(provider).getByText("No accounts connected."),
      ).toBeInTheDocument();
    }
  } finally {
    resume.resolve();
  }
});
