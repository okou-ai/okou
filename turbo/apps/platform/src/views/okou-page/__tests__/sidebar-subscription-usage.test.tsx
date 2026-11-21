import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { thirdPartySubscriptionsMainContract } from "@okouai/api-contracts/contracts/third-party-subscriptions";
import { personalModelProvidersByTypeContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockNow } from "../../../lib/time.ts";
import { action, billing, setBilling } from "./workspace-billing-fixtures.ts";
const context = testContext();
const ordinary = "Subscription usage",
  low = "Subscription usage: less than 20% remaining";
const timestamp = "2026-03-10T04:48:00Z";
function quota(
  remaining: number | null,
  hours: number,
  resetAt: string | null = null,
) {
  return {
    remainingPercent: remaining,
    usedPercent: remaining === null ? null : 100 - remaining,
    windowSeconds: 3600 * hours,
    resetAt,
  };
}
function account(
  provider: "ChatGPT" | "Claude",
  usage: ModelProviderResponse["subscriptionUsage"],
  extra: Partial<ModelProviderResponse> = {},
): ModelProviderResponse {
  return {
    id: crypto.randomUUID(),
    needsReconnect: false,
    lastRefreshErrorCode: null,
    type:
      provider === "Claude" ? "claude-code-oauth-token" : "codex-oauth-token",
    framework: provider === "Claude" ? "claude-code" : "codex",
    createdAt: timestamp,
    updatedAt: timestamp,
    accountEmail: "robin@example.org",
    subscriptionUsage: usage,
    ...extra,
  };
}
function visit() {
  return setupPage({
    context,
    host: "app.okou.ai",
    path: "/workflows",
    auth: {
      user: { id: "robin", fullName: "Robin", email: "robin@example.org" },
    },
  });
}
async function preview(label: string) {
  const rail = await action(label);
  click(rail);
  return { rail, panel: await screen.findByRole("dialog", { name: ordinary }) };
}
test.each([
  {
    id: "sidebar-subscription-usage-004",
    balance: 0,
    unlimited: false,
    label: "0",
  },
  {
    id: "sidebar-subscription-usage-006",
    balance: null,
    unlimited: true,
    label: "Unlimited",
  },
  {
    id: "sidebar-subscription-usage-007",
    balance: 0.0001,
    unlimited: false,
    label: "< 0.01",
  },
])(
  "$id Exhausted weekly ChatGPT usage reports provider credit $label",
  async ({ balance, unlimited, label }) => {
    context.mocks.data.personalModelProviders([
      account(
        "ChatGPT",
        { weekly: quota(0, 168), fiveHour: null },
        { subscriptionCredits: { balance, unlimited } },
      ),
    ]);
    await visit();
    const { panel } = await preview(low);
    const provider = within(panel).getByRole("region", {
      name: "ChatGPT usage",
    });
    expect(within(provider).getByRole("meter")).toHaveAttribute(
      "aria-valuenow",
      "0",
    );
    expect(
      within(provider).getByText("Credits").nextElementSibling?.textContent,
    ).toBe(label);
  },
);
test.each([
  { id: "sidebar-subscription-usage-016", provider: "ChatGPT" },
  { id: "sidebar-subscription-usage-017", provider: "Claude" },
] as const)(
  "$id $provider warns on its limiting quota and opens its settings",
  async ({ provider }) => {
    const windows =
      provider === "ChatGPT"
        ? { weekly: quota(12, 168), fiveHour: null }
        : { fiveHour: quota(12, 5), weekly: quota(85, 168) };
    context.mocks.data.personalModelProviders([account(provider, windows)]);
    await visit();
    const { rail, panel } = await preview(low);
    expect(rail).toHaveAccessibleDescription(provider + ": 12% left");
    expect(within(panel).getByText("12% left")).toBeInTheDocument();
    click(rail);
    await waitFor(() => {
      return expect(panel).not.toBeInTheDocument();
    });
    click(rail);
    click(
      await action(
        provider + " usage",
        await screen.findByRole("dialog", { name: ordinary }),
      ),
    );
    await screen.findByText("Use more models");
  },
);
test("sidebar-subscription-usage-020 An unknown Claude weekly percentage keeps its missing-value label", async () => {
  context.mocks.data.personalModelProviders([
    account("Claude", {
      weekly: quota(null, 168, "2026-03-13T19:00:00Z"),
      fiveHour: null,
    }),
  ]);
  await visit();
  const { rail, panel } = await preview(ordinary);
  expect(rail).toHaveAccessibleDescription("Claude: —");
  expect(within(panel).getByText("—")).toBeInTheDocument();
});
test("sidebar-subscription-usage-021 An exhausted five-hour window names its time to reset", async () => {
  mockNow(new Date("2026-03-10T00:48:00Z"), context.signal);
  context.mocks.data.personalModelProviders([
    account("Claude", {
      weekly: null,
      fiveHour: quota(0, 5, "2026-03-10T05:00:00Z"),
    }),
  ]);
  await visit();
  const { rail, panel } = await preview(low);
  expect(rail).toHaveAccessibleDescription("Claude: Limit reached");
  expect(within(panel).getByRole("meter")).toHaveAttribute(
    "aria-valuenow",
    "0",
  );
  expect(within(panel).getByText("Limit reached")).toBeInTheDocument();
  expect(within(panel).getByText("Resets in 4h 12m")).toBeInTheDocument();
});
test("sidebar-subscription-usage-012 Reset keeps confirmation locked until the refreshed weekly percentage arrives", async () => {
  const refresh = context.mocks.deferred<void>(),
    pending = context.mocks.deferred<void>();
  let reset = false;
  context.mocks.api(
    personalModelProvidersByTypeContract.resetSubscriptionUsage,
    ({ respond, params }) => {
      expect(params.type).toBe("codex-oauth-token");
      reset = true;
      return respond(200, { outcome: "reset" });
    },
  );
  const exhausted = account(
    "ChatGPT",
    { weekly: quota(0, 168), fiveHour: null },
    { subscriptionResetCredits: 2, subscriptionResetSupported: true },
  );
  context.mocks.api(
    thirdPartySubscriptionsMainContract.list,
    async ({ respond }) => {
      if (reset) {
        if (!pending.settled()) {
          pending.resolve();
        }
        await refresh.promise;
      }
      return respond(200, {
        subscriptions: [
          reset
            ? {
                ...exhausted,
                subscriptionUsage: { weekly: quota(100, 168), fiveHour: null },
                subscriptionResetCredits: 1,
              }
            : exhausted,
        ],
      });
    },
  );
  await visit();
  const { rail, panel } = await preview(low);
  click(await action("Reset usage", panel));
  const confirm = await screen.findByRole("dialog", {
    name: "Reset Codex usage?",
  });
  click(await action("Reset usage", confirm));
  await pending.promise;
  expect(confirm).toBeInTheDocument();
  await expect(action("Cancel", confirm)).resolves.toBeDisabled();
  refresh.resolve();
  await waitFor(() => {
    return expect(confirm).not.toBeInTheDocument();
  });
  expect(rail).toHaveFocus();
  click(rail);
  await screen.findByText("100% left");
});
test("sidebar-subscription-usage-001 Both accounts retain their own windows and New York reset dates across keyboard navigation", async () => {
  mockNow(new Date(timestamp), context.signal);
  const resolveOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(
    function (this: Intl.DateTimeFormat) {
      return { ...resolveOptions.call(this), timeZone: "America/New_York" };
    },
  );
  context.mocks.data.userPreferences({
    timezone: "America/New_York",
    locale: "en-US",
  });
  const thursday = "2026-03-12T15:00:00Z",
    friday = "2026-03-13T19:00:00Z";
  context.mocks.data.personalModelProviders([
    account("Claude", {
      fiveHour: quota(88, 5, thursday),
      weekly: quota(76, 168, friday),
    }),
    account("ChatGPT", { fiveHour: null, weekly: quota(55, 168, friday) }),
  ]);
  await visit();
  const { rail, panel } = await preview(ordinary);
  expect(rail).toHaveAccessibleDescription(/ChatGPT: 55% left/);
  expect(rail).toHaveAccessibleDescription(/Claude: 76% left/);
  const codex = within(panel).getByRole("region", { name: "ChatGPT usage" }),
    claude = within(panel).getByRole("region", { name: "Claude usage" });
  expect(within(codex).getByRole("meter")).toHaveAttribute(
    "aria-valuenow",
    "55",
  );
  expect(within(claude).getAllByRole("meter")).toHaveLength(2);
  expect(
    within(claude).getByRole("meter", {
      name: "Claude 5-hour limit remaining",
    }),
  ).toHaveAttribute("aria-valuenow", "88");
  expect(
    within(claude).getByRole("meter", {
      name: "Claude Weekly limit remaining",
    }),
  ).toHaveAttribute("aria-valuenow", "76");
  expect(within(codex).getByText("55% left")).toBeInTheDocument();
  expect(within(claude).getByText("88% left")).toBeInTheDocument();
  expect(within(claude).getByText("76% left")).toBeInTheDocument();
  const user = userEvent.setup({ delay: null });
  const codexTarget = await action("ChatGPT usage", codex);
  codexTarget.focus();
  await screen.findByText(/Mar 13, 2026.*3:00 PM EDT/u);
  const target = await action("Claude usage", claude);
  target.focus();
  await screen.findByText(/Mar 12, 2026.*11:00 AM EDT/u);
  await screen.findByText(/Mar 13, 2026.*3:00 PM EDT/u);
  click(target);
  await screen.findByText("Use more models");
  await user.keyboard("{Escape}");
  await waitFor(() => {
    return expect(rail).toHaveFocus();
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  await user.keyboard("{Enter}");
  await screen.findByRole("dialog", { name: ordinary });
  await user.keyboard("{Escape}");
  await waitFor(() => {
    return expect(rail).toHaveFocus();
  });
  await user.keyboard(" ");
  const again = await screen.findByRole("dialog", { name: ordinary });
  const chatgpt = await action("ChatGPT usage", again);
  chatgpt.focus();
  await user.keyboard("{Enter}");
  await screen.findByText("Use more models");
});
function robinBalance() {
  context.mocks.data.org({ role: "admin" });
  setBilling(context, () => {
    return billing("pro", { credits: 12_500 });
  });
}
test("sidebar-subscription-usage-015 Robin stays signed in on Workflows while provider usage rejects the saved session", async () => {
  robinBalance();
  context.mocks.data.userPreferences({ locale: null });
  mockedClerk.signOut.mockImplementation(() => {
    context.mocks.clerk().sessionSignedOut(true);
    return Promise.resolve();
  });
  const rejected = context.mocks.deferred<void>();
  context.mocks.api(thirdPartySubscriptionsMainContract.list, ({ respond }) => {
    if (!rejected.settled()) {
      rejected.resolve();
    }
    return respond(401, {
      error: { code: "UNAUTHORIZED", message: "Session expired at provider" },
    });
  });
  await visit();
  await rejected.promise;
  click(await action("Robin"));
  const menu = await screen.findByRole("menu");
  await within(menu).findByText("12,500 credits");
  expect(location.pathname).toBe("/workflows");
  click(within(menu).getByText("Settings"));
  await screen.findByRole("dialog", { name: "Settings" });
  expect(location.pathname).toBe("/workflows");
});
test("sidebar-subscription-usage-019 An account without linked providers still shows its 12,500-credit balance", async () => {
  robinBalance();
  context.mocks.data.personalModelProviders([]);
  await visit();
  click(await action("Robin"));
  const menu = await screen.findByRole("menu");
  const balance = await within(menu).findByText("12,500 credits");
  expect(balance).toBeInTheDocument();
});
