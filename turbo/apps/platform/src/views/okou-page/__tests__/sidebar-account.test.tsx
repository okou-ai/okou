import { chatThreadMetadataContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  setupAddAccountPage,
  openAccountMenu,
} from "./sidebar-account-test-helpers.ts";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { DetachedBrowserContext } from "happy-dom";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect, vi } from "vitest";
import { click, setupPage, startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  userPreferencesContract,
  type UserPreferencesResponse,
} from "@okouai/api-contracts/contracts/user-preferences";
import {
  findAction,
  getAction,
} from "./connector-integrations-test-helpers.ts";
import { billingUsagePackCreditsContract } from "@okouai/api-contracts/contracts/billing";
import { billing, setBilling } from "./workspace-billing-fixtures.ts";

const context = testContext();

test("sidebar-account-menu-006 Help offers the public documentation in a separate tab and opens the keyboard reference", async () => {
  context.mocks.http.get("https://www.okou.ai/en/docs", () => {
    return new Response("<title>Docs</title>", {
      headers: { "Content-Type": "text/html" },
    });
  });
  await setupPage({
    context,
    path: "/",
    host: "app.okou.ai",
    auth: { user: { id: "alex", fullName: "Alex Rivera" } },
  });
  const rail = await screen.findByTestId("labeled-nav-rail");
  const account = await within(rail).findByLabelText("Alex Rivera");
  const help = async () => {
    click(account);
    const root = await screen.findByRole("menu");
    await userEvent.click(within(root).getByText("Help"));
    return screen.findByText("Docs");
  };
  const docs = await help();
  const tabs = vi.spyOn(DetachedBrowserContext.prototype, "newPage");
  await userEvent.click(docs);
  await waitFor(() => {
    expect(
      tabs.mock.results.map(({ value }) => {
        return value.url;
      }),
    ).toContain("https://www.okou.ai/en/docs");
  });
  for (const { value: tab } of tabs.mock.results) {
    await tab.close();
  }
  await help();
  click(screen.getByText("Shortcuts"));
  const reference = await screen.findByRole("dialog", {
    name: "Keyboard Shortcuts",
  });
  expect(within(reference).getByText("Show shortcuts")).toBeInTheDocument();
});

test("sidebar-account-menu-004 adding another account uses a dark-theme hosted sign-in with a return to home", async () => {
  context.mocks.data.userPreferences({
    theme: "dark",
    colorTheme: "blue-horizon",
  });
  const sdk = context.mocks.clerk();
  await setupAddAccountPage(context);
  await openAccountMenu();
  click(await screen.findByText("Add account"));
  await waitFor(() => {
    return expect(mockedClerk.openSignIn.mock.lastCall?.[0]).toMatchObject({
      fallbackRedirectUrl: "/",
      forceRedirectUrl: "/",
      appearance: {
        theme: "simple",
        options: {
          logoImageUrl: expect.stringMatching(/okou-logo-wordmark-light.*svg$/),
          logoLinkUrl: "/",
        },
        elements: {
          formButtonPrimary: expect.stringContaining("bg-primary"),
          formFieldInput: expect.stringContaining("bg-input"),
        },
      },
    });
  });
  expect(sdk.uiRequests).toContain(
    "https://app.example.test/assets/clerk-ui-test.js",
  );
});

test("sidebar-account-menu-001 A successful session switch releases the outgoing conversation while Clerk finishes selecting Jamie", async () => {
  const users = [
    { name: "Alex Rivera", session: "session_alex" },
    { name: "Jamie Chen", session: "session_jamie" },
  ];
  const chosen = context.mocks.deferred<string>();
  const approve = context.mocks.deferred<void>();
  const reading = context.mocks.deferred<AbortSignal>();
  const leave = context.mocks.deferred<void>();
  const reports = context.mocks.sentry();
  const redirects = context.mocks.browser.locationReplace();
  context.mocks.clerk();
  const sdk = mockedClerk.setActive.getMockImplementation()!;
  mockedClerk.setActive.mockImplementation(async (options) => {
    chosen.resolve(String(options.session));
    await approve.promise;
    await sdk(options);
  });
  context.mocks.api(
    chatThreadMetadataContract.get,
    async ({ request, respond }) => {
      if (!reading.settled()) {
        reading.resolve(request.signal);
      }
      await leave.promise;
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Conversation removed" },
      });
    },
  );
  const id = crypto.randomUUID();
  await startPage({
    context,
    host: "app.okou.ai",
    path: "/chats/" + id,
    cachedChatThreadEvents: { snapshot: null, events: [] },
    auth: {
      session: { id: "session_alex", token: "session-fixture" },
      user: {
        id: "alex",
        fullName: "Alex Rivera",
        clientSessions: users.map((person) => {
          return {
            id: person.session,
            status: "active",
            user: { fullName: person.name },
          };
        }),
      },
    },
  });
  const pending = await reading.promise;
  const rail = await screen.findByTestId("labeled-nav-rail");
  click(await within(rail).findByLabelText("Alex Rivera"));
  const user = userEvent.setup({ delay: null });
  await user.click(await screen.findByText("Switch account"));
  click(
    (await screen.findByText("Jamie Chen")).closest<HTMLElement>(
      '[role="menuitem"]',
    )!,
  );
  await expect(chosen.promise).resolves.toBe("session_jamie");
  await waitFor(() => {
    expect(rail).not.toBeInTheDocument();
    expect(pending.aborted).toBeTruthy();
  });
  expect(context.signal.aborted).toBeFalsy();
  expect(redirects.calls).toStrictEqual([]);
  leave.resolve();
  approve.resolve();
  await waitFor(() => {
    expect(redirects.calls).toContain("/");
  });
  expect(screen.queryByTestId("labeled-nav-rail")).toBeNull();
  expect(
    reports.reports.filter((r) => {
      return r.type === "exception";
    }),
  ).toStrictEqual([]);
});

async function accountSettings() {
  await setupPage({
    context,
    path: "/",
    auth: {
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex@example.test",
      },
    },
    featureSwitches: {
      [FeatureSwitchKey.OkouDebug]: true,
    },
  });
  click(await findAction("button", "Alex Rivera"));
  const menu = await screen.findByRole("menu");
  click(within(menu).getByText("Settings"));
  return screen.findByRole("dialog", { name: "Settings" });
}

test("sidebar-account-settings-001 Alex’s account menu opens focused preferences with the profile link and Morning Brief", async () => {
  context.mocks.data.userPreferences({
    timezone: "America/New_York",
    locale: "en-US",
  });
  const settings = await accountSettings();
  const view = within(settings);
  await view.findByRole("heading", { name: "Preference" });
  expect(
    view.getByRole("heading", { name: "Account & security" }),
  ).toBeInTheDocument();
  expect(view.getByText("Alex Rivera")).toBeInTheDocument();
  expect(view.getByText("alex@example.test")).toBeInTheDocument();
  const manage = getAction("link", "Manage", settings);
  expect(manage).toHaveAttribute("href", "https://accounts.example.test/user");
  expect(manage).toHaveAttribute("target", "_blank");
  expect(manage).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
  click(await findAction("button", "My Okou", settings));
  const proactive = await view.findByRole("region", { name: "Proactive" });
  await expect(
    within(proactive).findByRole("switch", { name: /Morning Brief/iu }),
  ).resolves.toBeInTheDocument();
  expect(settings.contains(document.activeElement)).toBeTruthy();
});

test("sidebar-account-settings-002 Debug saves the capture allowance selected by click, Space and label", async () => {
  const preferences: UserPreferencesResponse = {
    timezone: "UTC",
    locale: "en-US",
    supportedLocales: ["en-US"],

    sendMode: "enter",
    cloudBrowserEnabledByDefault: true,
    chatResourcesEnabledByDefault: false,
    forYouCoverId: null,
    theme: "system",
    colorTheme: null,
    captureNetworkBodiesRemaining: 0,
    memoryInitialized: true,
  };
  context.mocks.api(userPreferencesContract.get, ({ respond }) => {
    return respond(200, preferences);
  });
  context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
    Object.assign(preferences, body);
    return respond(200, preferences);
  });
  const settings = await accountSettings();
  click(getAction("button", "Debug", settings));
  const toggle = await within(settings).findByRole("switch", {
    name: "Capture network bodies",
  });
  expect(toggle).not.toBeChecked();
  expect(toggle).toHaveAccessibleDescription("Disabled");
  const user = userEvent.setup();
  await user.click(toggle);
  await waitFor(() => {
    return expect(toggle).toHaveAccessibleDescription(
      "Enabled for the next 3 runs",
    );
  });
  expect(preferences.captureNetworkBodiesRemaining).toBe(3);
  expect(toggle).toHaveFocus();
  await user.keyboard(" ");
  await waitFor(() => {
    return expect(toggle).toHaveAccessibleDescription("Disabled");
  });
  expect(preferences.captureNetworkBodiesRemaining).toBe(0);
  click(
    within(settings).getByText("Capture network bodies", { selector: "label" }),
  );
  await waitFor(() => {
    return expect(toggle).toHaveAccessibleDescription(
      "Enabled for the next 3 runs",
    );
  });
  expect(preferences.captureNetworkBodiesRemaining).toBe(3);
});

function account(role: "member" | "admin") {
  const org = { id: "org_arc", name: "Arc Studio", role };
  context.mocks.data.org(org);
  return setupPage({
    context,
    path: "/",
    auth: {
      user: { id: "arc-emil", fullName: "Emil", email: "emil@arc.example" },
      organization: {
        activeOrg: org,
        memberships: [{ id: org.id, role: "org:" + role }],
      },
    },
  });
}

async function menu() {
  const rail = await screen.findByTestId("labeled-nav-rail");
  click(await within(rail).findByLabelText("Emil"));
  return screen.findByRole("menu");
}

function creditLedger(read: () => number) {
  context.mocks.api(billingUsagePackCreditsContract.get, ({ respond }) => {
    return respond(200, {
      totalCredits: read(),
      purchasedCredits: read(),
      bonusCredits: 0,
      creditGrants: [],
    });
  });
}

test("sidebar-account-credits-001 A member sees the refreshed package balance in the menu and its destination", async () => {
  let personal = 20_400;
  creditLedger(() => {
    return personal;
  });
  setBilling(context, () => {
    return billing("pro", { credits: 89_000 });
  });
  await account("member");
  const first = await menu();
  await expect(
    within(first).findByText("20,400 credits"),
  ).resolves.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    return expect(first).not.toBeInTheDocument();
  });
  personal = 500;
  const reopened = await menu();
  click(await within(reopened).findByText("500 credits"));
  await expect(
    screen.findByRole("heading", { name: "Credit balance" }),
  ).resolves.toBeInTheDocument();
  const card = await screen.findByTestId("usage-pack-credit-card");
  await expect(within(card).findByText(/500/)).resolves.toBeInTheDocument();
});

test("sidebar-account-credits-003 Negative workspace credit does not consume Emil's prepaid package", async () => {
  creditLedger(() => {
    return 50_000;
  });
  setBilling(context, () => {
    return billing("pro", { credits: -23_000 });
  });
  await account("admin");
  const panel = await menu();
  await expect(
    within(panel).findByText("50,000 credits"),
  ).resolves.toBeInTheDocument();
});

test("sidebar-account-credits-006 Following the workspace balance opens the funded balance card", async () => {
  setBilling(context, () => {
    return billing("pro", { credits: 12_500, showUsagePack: false });
  });
  await account("admin");
  click(await within(await menu()).findByText("12,500 credits"));
  const settings = await screen.findByRole("dialog");
  await expect(
    within(settings).findByRole("heading", { name: "Credit balance" }),
  ).resolves.toBeInTheDocument();
  await expect(
    within(
      await within(settings).findByTestId("credit-balance-info"),
    ).findByText("12,500"),
  ).resolves.toBeInTheDocument();
});
