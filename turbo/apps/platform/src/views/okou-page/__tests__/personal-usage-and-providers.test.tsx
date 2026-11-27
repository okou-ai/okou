import {
  billingUsagePackCreditsContract,
  billingUsagePackCatalogContract,
  billingUsagePackManagementContract,
  type UsagePackCreditsResponse,
} from "@okouai/api-contracts/contracts/billing";
import {
  usageRecordContract,
  type UsageRecordRow,
} from "@okouai/api-contracts/contracts/usage-record";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import {
  setupPage,
  click,
  queryAllByRoleFast,
  fill,
} from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  action,
  billing,
  setBilling,
  packages,
} from "./workspace-billing-fixtures.ts";
import {
  createChatRunFixtures,
  RUN_PATH,
  RUN_THREAD_ID,
  promptEvent,
  assistantEvent,
  completedEvent,
} from "./chat-run-test-fixtures.ts";
import { getAction } from "./connector-integrations-test-helpers.ts";
import { claudeCodeDeviceAuthContract } from "@okouai/api-contracts/contracts/claude-code-device-auth";
import { personalModelProviderAccountsByIdContract as accounts } from "@okouai/api-contracts/contracts/personal-model-providers";
import {
  providerGroup,
  personalAccount,
  serveClaudeLogin,
  usageWindow,
} from "./personal-account-settings-fixtures.ts";

const context = testContext();

const march = "2026-03-21T12:00:00.000Z",
  expiry = "2026-04-01T14:00:00.000Z";
function emptyBalance() {
  return {
    totalCredits: 0,
    bonusCredits: 0,
    purchasedCredits: 0,
    creditGrants: [],
  };
}
function grant(
  grantType: "purchased" | "bonus",
  amount: number,
  remaining = amount,
) {
  return {
    grantType,
    id: grantType + "-march",
    amount,
    remaining,
    createdAt: "2026-03-02T12:00:00Z",
    expiresAt: expiry,
  };
}
function balances(body: UsagePackCreditsResponse) {
  context.mocks.api(billingUsagePackCreditsContract.get, ({ respond }) => {
    return respond(200, body);
  });
}
function settings(role: "member" | "admin", section = "usage", origin = "/") {
  mockNow(new Date(march), context.signal);
  const userId = role === "admin" ? "mira" : "theo";
  context.mocks.data.org({ id: "org_lighthouse", name: "Lighthouse", role });
  context.mocks.data.orgMembers({
    name: "Lighthouse",
    role,
    members: [
      {
        userId: "mira",
        firstName: "Mira",
        lastName: "Patel",
        email: "mira@example.org",
        role: "admin",
        imageUrl: "",
        joinedAt: march,
      },
      {
        userId: "theo",
        firstName: "Theo",
        lastName: "Green",
        email: "theo@example.org",
        role: "member",
        imageUrl: "",
        joinedAt: march,
      },
    ],
  });
  return setupPage({
    context,
    path: origin + "?settings=" + section,
    host: "app.okou.ai",
    auth: {
      user: {
        id: userId,
        fullName: role === "admin" ? "Mira Patel" : "Theo Green",
        email: userId + "@example.org",
      },
      organization: {
        activeOrg: { id: "org_lighthouse", name: "Lighthouse" },
        memberships: [{ id: "org_lighthouse", role: "org:" + role }],
      },
    },
  });
}
test("personal-usage-tab-001 Theo sees his own purchased and bonus additions with remaining balances", async () => {
  balances({
    purchasedCredits: 20_000,
    totalCredits: 20_400,
    bonusCredits: 400,
    hasUsagePack: true,
    creditGrants: [grant("purchased", 25_000, 20_000), grant("bonus", 400)],
  });
  setBilling(context, () => {
    return billing("pro", { credits: 12_500 });
  });
  await settings("member");
  const card = await screen.findByTestId("usage-pack-credit-card");
  await within(card).findByText("20,400");
  expect(
    within(card).getByTestId("usage-pack-credit-purchased"),
  ).toHaveAccessibleName(/Purchased.*20,000/u);
  expect(within(card).getByText("Credit additions")).toBeInTheDocument();
  for (const label of ["Date", "Credits", "Left"]) {
    expect(within(card).getByText(label)).toBeInTheDocument();
  }
  for (const [id, amount, left] of [
    ["purchased-march", "+25,000", "20,000"],
    ["bonus-march", "+400", "400"],
  ]) {
    const row = within(card).getByTestId("usage-pack-credit-grants-" + id);
    for (const text of ["Mar 2, 2026", amount, left]) {
      expect(within(row).getByText(text)).toBeInTheDocument();
    }
  }
  expect(screen.queryByTestId("credit-balance-info")).toBeNull();
  expect(screen.queryByTestId("credit-balance-see-usage")).toBeNull();
  expect(screen.queryByTestId("usage-pack-credit-configure")).toBeNull();
  expect(screen.queryByText("Team usage")).toBeNull();
  expect(screen.queryByText("Today")).toBeNull();
  expect(within(card).queryByText("Usage records")).toBeNull();
});
test("personal-usage-tab-007 Theo's one-time bonus remains available without a recurring package", async () => {
  balances({
    ...emptyBalance(),
    totalCredits: 10_000,
    bonusCredits: 10_000,
    hasUsagePack: false,
    creditGrants: [grant("bonus", 10_000)],
  });
  await settings("member");
  const card = await screen.findByTestId("usage-pack-credit-card");
  await expect(
    within(card).findByTestId("usage-pack-credit-bonus"),
  ).resolves.toHaveAccessibleName(/Bonus.*10,000/u);
  const row = within(card).getByTestId("usage-pack-credit-grants-bonus-march");
  expect(within(row).getByText("+10,000")).toBeInTheDocument();
  expect(within(row).getByText("10,000")).toBeInTheDocument();
});
test("personal-usage-tab-006 An Atom-granted Pro administrator can start choosing packages from an empty balance", async () => {
  balances({ ...emptyBalance(), hasUsagePack: false });
  setBilling(context, () => {
    return billing("pro", {
      subscriptionStatus: "atom_grant",
      hasSubscription: false,
    });
  });
  packages(context);
  await settings("admin");
  const card = await screen.findByTestId("usage-pack-credit-card");
  await expect(within(card).findByText("0")).resolves.toBeInTheDocument();
  click(await action("Configure member packages", card));
  await screen.findByRole("heading", { name: "Choose a plan" });
});
test("personal-usage-tab-008 An administrator sees Theo's assigned package and its actual discount on the member step", async () => {
  balances({ ...emptyBalance(), hasUsagePack: true });
  setBilling(context, () => {
    return billing("pro");
  });
  context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
    return respond(200, {
      supportsFreeMembers: true,
      usagePacks: [
        {
          usagePackUsd: 20,
          priceUsd: 20,
          purchasedCredits: 20_000,
          bonusCredits: 400,
          totalCredits: 20_400,
        },
      ],
    });
  });
  context.mocks.api(billingUsagePackManagementContract.get, ({ respond }) => {
    return respond(200, {
      tier: "pro",
      currentPeriodEnd: expiry,
      supportsFreeMembers: true,
      supportsMemberAdditions: true,
      allocations: [
        {
          id: crypto.randomUUID(),
          memberId: "theo",
          usagePackUsd: 20,
          currentPeriodEnd: expiry,
          pendingChange: null,
        },
      ],
    });
  });
  await settings("admin");
  click(
    await action(
      "Configure member packages",
      await screen.findByTestId("usage-pack-credit-card"),
    ),
  );
  await screen.findByText("Step 2 of 3");
  await expect(
    screen.findByRole("combobox", { name: "Usage for Theo Green" }),
  ).resolves.toHaveTextContent("20,400 credits · 2% off");
});
test("personal-usage-tab-009 Mira can distinguish a funded member, an unfunded member, and the organization balance", async () => {
  balances({
    ...emptyBalance(),
    memberCredits: [
      {
        memberId: "theo",
        totalCredits: 20_400,
        purchasedCredits: 20_000,
        bonusCredits: 400,
        creditGrants: [grant("purchased", 20_000), grant("bonus", 400)],
      },
    ],
  });
  setBilling(context, () => {
    return billing("pro", { credits: 12_500 });
  });
  await settings("admin");
  click(await action("View member balances"));
  const dialog = await screen.findByRole("dialog", {
    name: "Member usage pack credits",
  });
  for (const [id, name, amount] of [
    ["theo", "Theo Green", "20,400"],
    ["mira", "Mira Patel", "0"],
  ]) {
    const member = within(dialog).getByTestId("usage-pack-member-credit-" + id);
    for (const label of [name, id + "@example.org", amount]) {
      expect(within(member).getByText(label)).toBeInTheDocument();
    }
  }
  const theo = within(dialog).getByTestId("usage-pack-member-credit-theo");
  click(within(theo).getByTestId("usage-pack-member-theo-grants-toggle"));
  const row = await within(theo).findByText("+20,000");
  const entry = row.parentElement!;
  expect(within(entry).getByText("20,000")).toBeInTheDocument();
  expect(within(entry).getByText("Mar 2, 2026")).toBeInTheDocument();
  entry.focus();
  await screen.findByText("Purchased", {
    selector: "[data-slot=tooltip-content] *",
  });
  await screen.findByText("Expires Apr 1, 2026");
  click(await action("Close", dialog));
  await waitFor(() => {
    return expect(dialog).not.toBeInTheDocument();
  });
  expect(
    within(await screen.findByTestId("credit-balance-info")).getByText(
      "12,500",
    ),
  ).toBeInTheDocument();
});
function record(
  title: string,
  credits: number,
  date = march,
  threadId = crypto.randomUUID() as string,
): UsageRecordRow {
  return {
    title,
    threadId,
    credits,
    tokens: credits * 2,
    member: null,
    lastActivityAt: date,
    breakdown: [],
  };
}
test("personal-usage-tab-010 Theo's dated records regroup data search and load his seven-day range", async () => {
  const rows = [
    record("March planning", 1083),
    record("Slack recap", 1),
    ...Array.from({ length: 19 }, (_, index) => {
      return record("March check " + String(index + 1), 1);
    }),
  ];
  rows[0]!.breakdown = [
    {
      kind: "connector",
      credits: 480,
      providers: [
        {
          provider: "catalog",
          credits: 480,
          usageKinds: [{ kind: "commerce", credits: 480 }],
        },
      ],
    },
    {
      kind: "other",
      credits: 603,
      providers: [
        {
          provider: "archive",
          credits: 603,
          usageKinds: [
            { kind: "data-search", credits: 600 },
            { kind: "translation", credits: 3 },
          ],
        },
      ],
    },
  ];
  const week = record("March 18 forecast", 4, "2026-03-18T09:00:00Z"),
    audit = record("Feb 28 audit", 32, "2026-02-28T09:00:00Z");
  const source = [...rows, week, audit];
  context.mocks.api(usageRecordContract.get, ({ query, respond }) => {
    expect(query.scope).toBe("mine");
    const start = query.range === "7d" ? "2026-03-15" : "2026-03-21";
    const available = source.filter((row) => {
      return row.lastActivityAt >= start;
    });
    const offset = (query.page - 1) * query.pageSize;
    return respond(200, {
      period: { start, end: "2026-03-22" },
      rows: available.slice(offset, offset + query.pageSize),
      totalCredits: available.reduce((n, row) => {
        return n + row.credits;
      }, 0),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total: available.length,
      },
    });
  });
  await settings("member", "usage-records");
  await screen.findByText("March planning");
  await screen.findByText("Slack recap");
  expect(screen.getByText("21 threads").parentElement).toHaveTextContent(
    /1\.1K credits/u,
  );
  expect(screen.getAllByText("Mar 21").length).toBeGreaterThan(0);
  expect(screen.queryByText("Feb 28 audit")).toBeNull();
  const user = userEvent.setup({ delay: null });
  const connector = screen.getByTestId("usage-kind-segment-connector");
  await user.hover(connector);
  await screen.findByText("Connectors - 1,080");
  const data = await screen.findByText("Data Search");
  expect(data.nextElementSibling).toHaveTextContent(/^1,080$/u);
  expect(screen.queryByText("Translation")).toBeNull();
  await user.unhover(connector);
  const other = screen.getByTestId("usage-kind-segment-other");
  await user.hover(other);
  expect(
    (await screen.findByText("Translation")).nextElementSibling,
  ).toHaveTextContent(/^3$/u);
  await user.unhover(other);
  click(await action("Today"));
  click(
    await within(await screen.findByRole("menu")).findByText("Last 7 days"),
  );
  await action("Last 7 days");
  await screen.findByText("22 threads");
  click(await action("Load more"));
  await screen.findByText("March 18 forecast");
});
test.each([
  { id: "personal-usage-tab-011", activation: "click" },
  { id: "personal-usage-tab-012", activation: "Enter" },
])(
  "$id Theo uses $activation to leave Settings for the metered conversation",
  async ({ activation }) => {
    const runId = crypto.randomUUID();
    createChatRunFixtures(context).installRunChat({
      chatEvents: [
        promptEvent({
          id: crypto.randomUUID(),
          runId,
          seqId: 1,
          text: "Reconcile the variance",
        }),
        assistantEvent({
          id: crypto.randomUUID(),
          runId,
          seqId: 2,
          text: "Variance reconciled",
        }),
        completedEvent({ id: crypto.randomUUID(), runId, seqId: 3 }),
      ],
    });
    context.mocks.api(usageRecordContract.get, ({ query, respond }) => {
      expect(query.scope).toBe("mine");
      return respond(200, {
        period: null,
        rows: [record("Investigate variance", 19, march, RUN_THREAD_ID)],
        totalCredits: 19,
        pagination: { page: 1, pageSize: 20, total: 1 },
      });
    });
    // Native anchor activation in happy-dom uses the browsing context's Window.
    const tab = context.mocks.browser.authWindow();
    context.mocks.browser.open(tab);
    vi.spyOn(window.frames, "open").mockReturnValue(tab);
    await settings("member", "usage-records", "/workflows");
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    await within(dialog).findByText("Investigate variance");
    const link = queryAllByRoleFast("link", dialog).find((el) => {
      return el.textContent === "Investigate variance";
    })!;
    expect(link).toHaveAttribute("href", RUN_PATH);
    expect(location.pathname).toBe("/workflows");
    const user = userEvent.setup({ delay: null });
    const browserGestures = [
      "Meta",
      "Shift",
      "Alt",
      "Control",
      "MouseMiddle",
      "MouseRight",
    ] as const;
    for (const gesture of browserGestures) {
      if (gesture === "MouseMiddle" || gesture === "MouseRight") {
        await user.pointer({ target: link, keys: "[" + gesture + "]" });
      } else {
        await user.keyboard("{" + gesture + ">}");
        await user.pointer({ target: link, keys: "[MouseLeft]" });
        await user.keyboard("{/" + gesture + "}");
      }
      expect(
        within(dialog).getByText("Investigate variance"),
      ).toBeInTheDocument();
      expect(location.pathname).toBe("/workflows");
    }
    if (activation === "Enter") {
      link.focus();
      await user.keyboard("{Enter}");
    } else {
      click(link);
    }
    await screen.findByText("Variance reconciled");
    expect(location.pathname).toBe(RUN_PATH);
    expect(dialog).not.toBeInTheDocument();
  },
);

async function models() {
  await setupPage({ context, path: "/?settings=model" });
}

async function disconnect() {
  const section = await providerGroup("ChatGPT (Codex)");
  await section.findByText("member1@example.test");
  click(section.button("More options"));
  click(
    await within(await screen.findByRole("menu")).findByText(
      "Disconnect account",
      { exact: true },
    ),
  );
  return screen.findByRole("dialog", { name: /Disconnect member1/u });
}
test("personal-providers-tab-006 ChatGPT accounts occupy a labelled table before the empty Claude group", async () => {
  context.mocks.data.personalModelProviders([
    personalAccount("ChatGPT"),
    personalAccount("ChatGPT", 2),
  ]);
  await models();
  const codex = await providerGroup("ChatGPT (Codex)");
  const claude = await providerGroup("Claude");
  await codex.findByText("member2@example.test");
  const heading = codex.getByRole("heading", { name: "ChatGPT (Codex)" });
  expect(
    heading.compareDocumentPosition(claude.getByRole("heading")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  const table = codex.getByRole("table", { name: "ChatGPT (Codex)" });
  expect(table).toHaveAttribute("aria-labelledby", heading.id);
  expect(within(table).getByText("member1@example.test")).toBeVisible();
  expect(within(table).getByText("member2@example.test")).toBeVisible();
  expect(claude.getByText("No accounts connected.")).toBeVisible();
  expect(claude.queryByRole("table")).toBeNull();
});
test("personal-providers-tab-008 removing a saved account explains the provider subscription and confirms disconnection", async () => {
  context.mocks.data.personalModelProviders([personalAccount("ChatGPT")]);
  await models();
  const dialog = await disconnect();
  expect(
    within(dialog).getByText(
      "This removes the account from Okou. It won’t cancel your subscription with the provider.",
    ),
  ).toBeVisible();
  click(getAction("button", "Disconnect account", dialog));
  await screen.findByText("Account disconnected");
  await (
    await providerGroup("ChatGPT (Codex)")
  ).findByText("No accounts connected.");
  expect(screen.queryByText("member1@example.test")).toBeNull();
  expect(dialog).not.toBeInTheDocument();
});
test("personal-providers-tab-009 a failed disconnection keeps the account available for a confirmed retry", async () => {
  const member = personalAccount("ChatGPT");
  context.mocks.data.personalModelProviders([member]);
  const started = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  let failing = true;
  context.mocks.api(accounts.delete, async ({ params, respond }) => {
    if (failing) {
      started.resolve();
      await release.promise;
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Disconnect failed" },
      });
    }
    if (params.id === member.id) {
      context.mocks.data.personalModelProviders([]);
    }
    return respond(204);
  });
  await models();
  const dialog = await disconnect();
  click(getAction("button", "Disconnect account", dialog));
  await started.promise;
  expect(getAction("button", "Disconnecting…", dialog)).toBeDisabled();
  expect(getAction("button", "Cancel", dialog)).toBeDisabled();
  release.resolve();
  await screen.findByText("Disconnect failed");
  expect(dialog).toBeVisible();
  expect(screen.getByText("member1@example.test")).toBeInTheDocument();
  failing = false;
  click(getAction("button", "Disconnect account", dialog));
  await screen.findByText("Account disconnected");
  await (
    await providerGroup("ChatGPT (Codex)")
  ).findByText("No accounts connected.");
  expect(dialog).not.toBeInTheDocument();
  expect(screen.queryByText("member1@example.test")).toBeNull();
});
test("personal-providers-tab-010 switching ChatGPT accounts preserves both balances and opens exhausted usage", async () => {
  const usage = {
    fiveHour: usageWindow(0, 18_000),
    weekly: usageWindow(0, 604_800),
  };
  context.mocks.data.personalModelProviders([
    personalAccount("ChatGPT", 1, {
      subscriptionCredits: { balance: 1250.5, unlimited: false },
    }),
    personalAccount("ChatGPT", 2, {
      subscriptionCredits: { balance: 0, unlimited: false },
      subscriptionUsage: usage,
    }),
  ]);
  await models();
  const section = await providerGroup("ChatGPT (Codex)");
  await section.findByText("member2@example.test");
  const [a, b] = section.getAllByRole("row");
  const select = (row: HTMLElement) => {
    return within(row).getByLabelText(/^(Active|Use):/u, {
      selector: "button",
    });
  };
  expect(select(a!)).toHaveAttribute("aria-pressed", "true");
  click(select(b!));
  await waitFor(() => {
    return expect(select(b!)).toHaveAttribute("aria-pressed", "true");
  });
  expect(select(a!)).toHaveAttribute("aria-pressed", "false");
  expect(a).toHaveTextContent("1,250.5");
  expect(b).toHaveTextContent(/0 ChatGPT credits/u);
  await userEvent.setup().keyboard("{Escape}");
  await waitFor(() => {
    return expect(
      screen.queryByRole("dialog", { name: "Settings" }),
    ).toBeNull();
  });
  click(
    await screen.findByLabelText(/^Subscription usage/u, {
      selector: "button",
    }),
  );
  await screen.findByText("Limit reached");
  expect(screen.getByText("Credits", { exact: true })).toBeVisible();
  expect(screen.getByText("0", { exact: true })).toBeVisible();
});
test("personal-providers-tab-011 an external workspace member can connect either empty personal group", async () => {
  const org = { id: "org_guest", name: "Partner team" };
  context.mocks.data.org({ ...org, role: "member" });
  await setupPage({
    context,
    path: "/?settings=model",
    auth: {
      user: { id: "member_guest", fullName: "Grace Park" },
      organization: { activeOrg: org, memberships: [{ id: org.id }] },
    },
  });
  for (const name of ["Claude", "ChatGPT (Codex)"]) {
    const section = await providerGroup(name);
    await section.findByText("No accounts connected.");
    expect(section.button("Connect account")).toBeEnabled();
  }
});
test("personal-providers-tab-012 Claude add mode is personal and cancellation restores the group action", async () => {
  const request = serveClaudeLogin(context);
  await models();
  const area = await providerGroup("Claude");
  await area.findByText("No accounts connected.");
  click(area.button("Connect account"));
  const dialog = await screen.findByRole("dialog", { name: "Connect Claude" });
  await within(dialog).findByRole("textbox");
  expect(request()).toMatchObject({ scope: "personal", mode: "add" });
  expect(
    within(dialog).getByText(
      "Sign in with your Claude subscription to use Claude models with Claude Code-backed agents.",
    ),
  ).toBeVisible();
  click(getAction("button", "Close", dialog));
  await waitFor(() => {
    return expect(dialog).not.toBeInTheDocument();
  });
  expect(area.button("Connect account")).toBeEnabled();
});
test("personal-providers-tab-013 submitting the code adds the Pro identity and both usage windows", async () => {
  serveClaudeLogin(context);
  const member = personalAccount("Claude", 3, {
    subscriptionUsage: {
      fiveHour: usageWindow(88, 18_000),
      weekly: usageWindow(76, 604_800),
    },
  });
  context.mocks.api(
    claudeCodeDeviceAuthContract.complete,
    ({ body, respond }) => {
      if (body.authorizationCode === "local-approval") {
        context.mocks.data.personalModelProviders([member]);
      }
      return respond(200, {
        status: "complete",
        created: true,
        provider: member,
      });
    },
  );
  await models();
  const area = await providerGroup("Claude");
  await area.findByText("No accounts connected.");
  click(area.button("Connect account"));
  const dialog = await screen.findByRole("dialog", { name: "Connect Claude" });
  await fill(await within(dialog).findByRole("textbox"), "local-approval");
  click(getAction("button", "Connect", dialog));
  await screen.findByText("Claude connected");
  await area.findByText("member3@example.test");
  const row = within(area.getByRole("row"));
  expect(row.getByText("Pro")).toBeVisible();
  expect(
    row.getByRole("progressbar", { name: /5h remaining/u }),
  ).toHaveAttribute("aria-valuenow", "88");
  expect(
    row.getByRole("progressbar", { name: /Week remaining/u }),
  ).toHaveAttribute("aria-valuenow", "76");
});
