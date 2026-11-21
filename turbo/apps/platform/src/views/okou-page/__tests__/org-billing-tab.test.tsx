import userEvent from "@testing-library/user-event";
import {
  billingUsagePackManagementContract,
  billingUsagePackMigrationContract,
  billingConcurrencySubscriptionContract,
  type UsagePackUsd,
  type UsagePackManagementResponse,
  type UsagePackMigrationStateResponse,
  billingDowngradeContract,
  billingRestoreContract,
  billingConcurrencyCheckoutContract,
  billingUsagePackCheckoutContract,
} from "@okouai/api-contracts/contracts/billing";
import { screen, within, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  action,
  addParticipants,
  april,
  billing,
  findAction,
  openWorkspace,
  packages,
  setBilling,
} from "./workspace-billing-fixtures.ts";

const context = testContext();
const ending = billing("pro", {
  cancelAtPeriodEnd: true,
  currentPeriodEnd: april,
});
const restored = "Plan restored. Your subscription will renew normally.";
const checkout = "https://checkout.stripe.com/c/pay/local-finance";
async function compare() {
  await openWorkspace(context);
  click(await action("Compare all plans"));
  return screen.findByRole("dialog", { name: "Choose a plan" });
}
async function pick(name: string, value: RegExp | string) {
  click(await screen.findByRole("combobox", { name: "Usage for " + name }));
  click(await screen.findByRole("option", { name: value }));
}
test("org-billing-tab-002 An iPhone billing link opens the Billing section of Settings", async () => {
  context.mocks.browser.userAgent(
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
  );
  await openWorkspace(context, "/settings/billing");
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  await expect(
    within(settings).findByRole("heading", { name: "Billing" }),
  ).resolves.toBeInTheDocument();
});
test("org-billing-tab-003 Pro and Team show their starting prices before member configuration", async () => {
  setBilling(context, () => {
    return billing("limited-free-1");
  });
  packages(context);
  const chooser = await compare();
  const pro = await within(chooser).findByRole("article", { name: "Pro plan" });
  const team = within(chooser).getByRole("article", { name: "Team plan" });
  expect(pro).toHaveTextContent("3 tasks running at once");
  expect(pro).toHaveTextContent("Scheduled & app automations");
  expect(pro).toHaveTextContent("from $20/month");
  expect(pro).toHaveTextContent("Plan $0 · member packages $20–$200 each");
  expect(team).toHaveTextContent("from $180/month");
  expect(team).toHaveTextContent("Plan $160 · member packages $20–$200 each");
  expect(chooser).toHaveTextContent(
    "Choose a paid package for each member in the next step, or select No package.",
  );
  expect(within(chooser).queryByRole("combobox")).not.toBeInTheDocument();
});
function workspaceCheckout() {
  setBilling(context, () => {
    return billing("limited-free-1");
  });
  packages(context);
  addParticipants(context);
  context.mocks.api(
    billingUsagePackCheckoutContract.create,
    ({ body, respond }) => {
      return respond(200, {
        status: "preview",
        purchaseType: "usage_pack",
        tier: body.tier,
        immediateAmountCents: 6000,
        nextRecurringAmountCents: 6000,
        currency: "usd",
        expiresAt: "2031-01-01T00:00:00.000Z",
        previewToken: "finance-review",
      });
    },
  );
}
async function checkDefaultPackages() {
  for (const name of ["Alex", "Beck", "invite@example.org"]) {
    const select = await screen.findByRole("combobox", {
      name: "Usage for " + name,
    });
    expect(select).toBeEnabled();
    expect(select).toHaveTextContent("21,234 credits · 6% off");
    click(select);
    await expect(
      screen.findByRole("option", {
        name: "$20 · 21,234 credits · 6% off",
        selected: true,
      }),
    ).resolves.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
  }
}
test("org-billing-tab-004 A Pro review includes both members and the pending invitation and can be cancelled", async () => {
  workspaceCheckout();
  const chooser = await compare();
  click(await action("Start with Pro", chooser));
  await checkDefaultPackages();
  click(await action("Upgrade to Pro"));
  const review = await screen.findByRole("dialog", { name: "Order summary" });
  click(await action("Cancel", review));
  await waitFor(() => {
    return expect(review).not.toBeInTheDocument();
  });
  await expect(action("Upgrade to Pro")).resolves.toBeEnabled();
});
test("org-billing-tab-006 Editing Alex and the invited Team member updates both the bill and bonus", async () => {
  workspaceCheckout();
  const chooser = await compare();
  click(await action("Start with Team", chooser));
  await checkDefaultPackages();
  expect(
    screen.getByText(
      "Member packages are optional. Any overage uses pay-as-you-go credits.",
    ),
  ).toBeInTheDocument();
  await pick("Alex", /^\$50 ·/);
  await expect(screen.findByText("$250")).resolves.toBeInTheDocument();
  await pick("invite@example.org", /^\$100 ·/);
  await expect(screen.findByText("$330")).resolves.toBeInTheDocument();
  expect(
    screen.getByText("185,554 credits · 15,554 bonus"),
  ).toBeInTheDocument();
  for (const select of screen.getAllByRole("combobox")) {
    expect(select).toBeEnabled();
  }
  await expect(action("Upgrade to Team")).resolves.toBeEnabled();
});
test("org-billing-tab-010 Ending Atom Pro can configure its own package", async () => {
  setBilling(context, () => {
    return {
      ...ending,
      hasSubscription: false,
      subscriptionStatus: "atom_grant",
    };
  });
  packages(context);
  const chooser = await compare();
  const pro = await within(chooser).findByRole("article", { name: "Pro plan" });
  click(await action("Manage", pro));
  await expect(
    screen.findByRole("combobox", { name: "Usage for Alex" }),
  ).resolves.toHaveTextContent("21,234 credits");
  expect(screen.getByRole("group", { name: "Member usage" })).toHaveTextContent(
    "$20/month",
  );
  await expect(action("Configure member packages")).resolves.toBeEnabled();
  expect(findAction("Upgrade to Pro")).toBeUndefined();
});
test("org-billing-tab-031 Five slots have distinct quoted and payable amounts", async () => {
  setBilling(context, () => {
    return billing("team", {
      concurrencyPurchaseReviewAvailable: true,
      concurrencyUnitAmountCents: 4200,
    });
  });
  let purchased: number | undefined;
  context.mocks.api(
    billingConcurrencyCheckoutContract.preview,
    ({ respond, body }) => {
      return respond(200, {
        currentQuantity: 0,
        targetQuantity: body.quantity,
        immediateAmountCents: 12_000,
        nextRecurringAmountCents: 36_000,
        currency: "usd",
      });
    },
  );
  context.mocks.api(
    billingConcurrencyCheckoutContract.create,
    ({ respond, body }) => {
      purchased = body.quantity;
      return respond(200, { url: body.successUrl });
    },
  );
  await openWorkspace(context);
  click(await action("Buy concurrency"));
  const buy = await screen.findByRole("dialog", { name: "Buy concurrency" });
  const slots = within(buy).getByRole("textbox", { name: "Slots" });
  await fill(slots, "");
  await expect(action("Review purchase", buy)).resolves.toBeDisabled();
  await fill(slots, "5");
  expect(buy).toHaveTextContent("$210/month");
  click(await action("Review purchase", buy));
  const review = await screen.findByRole("dialog", {
    name: "Review concurrency purchase",
  });
  expect(review).toHaveTextContent("Due today$120.00");
  expect(review).toHaveTextContent("$360.00/month");
  click(await action("Pay and add slots", review));
  await expect(
    screen.findByText(
      "Concurrency added. Your new slots will become available after Stripe confirms the subscription.",
    ),
  ).resolves.toBeInTheDocument();
  expect(purchased).toBe(5);
  await waitFor(() => {
    return expect(review).not.toBeInTheDocument();
  });
});
test("org-billing-tab-035 Confirming cancellation hands the browser a checkout with the Pro cancellation return marker", async () => {
  const navigation = context.mocks.browser.locationAssign();
  let back: string | undefined;
  setBilling(context, () => {
    return billing("pro");
  });
  context.mocks.api(billingDowngradeContract.create, ({ body, respond }) => {
    back = body.returnUrl;
    return respond(200, {
      status: "payment_method_required",
      checkoutUrl: checkout,
    });
  });
  await openWorkspace(context);
  click(await action("Downgrade"));
  const cancel = await screen.findByRole("dialog", { name: "Downgrade plan" });
  click(await action("Cancel subscription", cancel));
  await waitFor(() => {
    return expect(navigation.calls).toContain(checkout);
  });
  expect(new URL(back ?? "").searchParams.get("billing_pending")).toBe(
    "downgrade-limited-free-1",
  );
  await waitFor(() => {
    return expect(cancel).not.toBeInTheDocument();
  });
});
test.each([
  [
    "org-billing-tab-036",
    "downgrade-limited-free-1",
    ending,
    "Cancellation scheduled. Your current plan stays active until Apr 1, 2026.",
  ],
  ["org-billing-tab-038", "restore", billing("pro"), restored],
] as const)(
  "%s Billing reconciles the %s return",
  async (_id, marker, status, notice) => {
    setBilling(context, () => {
      return status;
    });
    await openWorkspace(
      context,
      "/?settings=billing&billing_pending=" + marker,
    );
    await expect(screen.findByText(notice)).resolves.toBeInTheDocument();
    await expect(
      screen.findByRole("heading", { name: "Billing" }),
    ).resolves.toBeInTheDocument();
    const params = new URL(window.location.href).searchParams;
    expect(params.get("settings")).toBe("billing");
    expect(params.has("billing_pending")).toBeFalsy();
  },
);
test("org-billing-tab-037 Payment handoff precedes the restored-plan notification", async () => {
  let status = { ...ending, canRestorePlan: true };
  let back: string | undefined;
  setBilling(context, () => {
    return status;
  });
  const navigation = context.mocks.browser.locationAssign();
  context.mocks.api(billingRestoreContract.create, ({ body, respond }) => {
    back = body.returnUrl;
    return respond(200, {
      status: "payment_method_required",
      checkoutUrl: checkout,
    });
  });
  await openWorkspace(context);
  click(await action("Restore plan"));
  const confirm = await screen.findByRole("dialog", {
    name: "Restore Pro plan?",
  });
  click(await action("Restore plan", confirm));
  await waitFor(() => {
    return expect(navigation.calls).toContain(checkout);
  });
  expect(new URL(back ?? "").searchParams.get("billing_pending")).toBe(
    "restore",
  );
  await waitFor(() => {
    return expect(confirm).not.toBeInTheDocument();
  });
  expect(screen.queryByText(restored)).not.toBeInTheDocument();
  status = billing("pro");
  context.mocks.ably.trigger("billing:changed", {});
  await expect(screen.findByText(restored)).resolves.toBeInTheDocument();
});
test("org-billing-tab-039 A nonrestorable cancellation identifies the expiring Pro plan", async () => {
  setBilling(context, () => {
    return ending;
  });
  await openWorkspace(context);
  await expect(
    screen.findByText(
      "Your Pro plan has been cancelled and will end on Apr 1, 2026.",
    ),
  ).resolves.toBeInTheDocument();
  expect(findAction("Restore plan")).toBeUndefined();
});

const changeId = "31f83f9d-d073-4f45-8de3-7b8ee0d63eb0";
function allocation(
  memberId: string,
  usagePackUsd: UsagePackUsd,
  pendingChange: UsagePackManagementResponse["allocations"][number]["pendingChange"] = null,
) {
  return {
    id:
      memberId === "alex"
        ? "ff83eae2-2408-49a7-b703-83f8abaff731"
        : "afc32d4d-cbe6-403c-acb5-49071c362ec9",
    memberId,
    usagePackUsd,
    currentPeriodEnd: april,
    pendingChange,
  };
}
function managedPackages(
  tier: "team" | "pro",
  read: () => UsagePackManagementResponse["allocations"],
  currentPeriodEnd: string,
) {
  context.mocks.api(billingUsagePackManagementContract.get, ({ respond }) => {
    return respond(200, {
      tier,
      currentPeriodEnd,
      supportsFreeMembers: true,
      allocations: read(),
    });
  });
}
function changes(
  tier: "pro" | "team",
  allocations: UsagePackManagementResponse["allocations"],
  status = billing(tier),
) {
  packages(context);
  setBilling(context, () => {
    return status;
  });
  let rows = allocations;
  let requested: UsagePackUsd | 0 | undefined;
  managedPackages(
    tier,
    () => {
      return rows;
    },
    april,
  );
  context.mocks.api(
    billingUsagePackManagementContract.previewSubscriptionChange,
    ({ body, respond }) => {
      requested = body.memberUsagePacks.find((p) => {
        return p.memberId === "alex";
      })?.usagePackUsd;
      return respond(200, {
        changeId,
        sourceTier: tier,
        targetTier: body.targetTier,
        immediateAmountCents: 0,
        nextRecurringAmountCents: (requested ?? 0) * 100,
        currency: "usd",
        effectiveAt: april,
        prorationDate: april,
        expiresAt: april,
      });
    },
  );
  context.mocks.api(
    billingUsagePackManagementContract.confirmSubscriptionChange,
    ({ body, respond }) => {
      const current = rows.find((p) => {
        return p.memberId === "alex";
      });
      if (body.changeId !== changeId || !requested || !current) {
        throw new Error("Missing reviewed package");
      }
      rows = [
        allocation(
          "alex",
          current.usagePackUsd,
          requested === current.usagePackUsd
            ? null
            : {
                id: changeId,
                kind: "downgrade",
                status: "scheduled",
                targetUsagePackUsd: requested,
                effectiveAt: april,
              },
        ),
      ];
      return respond(200, {
        status: "scheduled",
        effectiveAt: april,
        hostedInvoiceUrl: null,
      });
    },
  );
}
async function chooseCard(plan: string, choice: string) {
  const dialog = await compare();
  const card = await within(dialog).findByRole("article", {
    name: plan + " plan",
  });
  click(await action(choice, card));
  return screen.findByRole("dialog", { name: "Configure member packages" });
}
test("org-billing-tab-015 A retained removal for a departed member does not block Alex's package change", async () => {
  changes("pro", [
    allocation("alex", 20),
    allocation("former", 50, {
      id: changeId,
      kind: "removal",
      status: "scheduled",
      targetUsagePackUsd: null,
      effectiveAt: april,
    }),
  ]);
  const dialog = await chooseCard("Pro", "Manage");
  const alex = await within(dialog).findByRole("combobox", {
    name: "Usage for Alex",
  });
  expect(alex).toBeEnabled();
  expect(within(dialog).getAllByRole("combobox")).toHaveLength(1);
  expect(within(dialog).queryByText("former")).not.toBeInTheDocument();
  await pick("Alex", /^\$50 ·/);
  await expect(action("Confirm", dialog)).resolves.toBeEnabled();
});
function pendingPrice(current: UsagePackUsd) {
  changes("pro", [
    allocation("alex", current, {
      id: changeId,
      kind: "downgrade",
      status: "scheduled",
      targetUsagePackUsd: 50,
      effectiveAt: april,
    }),
  ]);
}
async function comparison(price: number) {
  const trigger = await action("Subscription comparison: $" + price + "/month");
  await userEvent.hover(trigger);
  return screen.findByRole("table", {
    name: "Current and new subscription comparison",
  });
}
function amounts(table: HTMLElement, label: string, from: string, to: string) {
  const row = within(table).getByText(label, { selector: "th" }).closest("tr")!;
  const values = queryAllByRoleFast("cell", row);
  expect(
    values.map((cell) => {
      return cell.textContent;
    }),
  ).toStrictEqual([from, to]);
}
test("org-billing-tab-016 Restoring Alex's original package clears the April downgrade", async () => {
  pendingPrice(100);
  const config = await chooseCard("Pro", "Manage");
  await expect(
    within(config).findByText("Downgrades to $50 on Apr 1, 2026."),
  ).resolves.toBeInTheDocument();
  expect(within(config).getByText("Downgrade scheduled")).toBeInTheDocument();
  expect(findAction("Restore", config)).toBeUndefined();
  expect(findAction("Confirm", config)).toBeUndefined();
  await pick("Alex", /^\$100 ·/);
  const table = await comparison(100);
  amounts(table, "Member packages", "$50", "$100");
  click(await action("Restore", config));
  const review = await screen.findByRole("dialog", {
    name: "Review package change",
  });
  click(await action("Confirm", review));
  await expect(
    screen.findByText("Subscription change confirmed."),
  ).resolves.toBeInTheDocument();
  const select = await screen.findByRole("combobox", {
    name: "Usage for Alex",
  });
  await waitFor(() => {
    return expect(select).toHaveTextContent("109,999 credits");
  });
  await waitFor(() => {
    return expect(
      screen.queryByText("Downgrade scheduled"),
    ).not.toBeInTheDocument();
  });
  expect(findAction("Restore")).toBeUndefined();
  expect(findAction("Confirm")).toBeUndefined();
});
test("org-billing-tab-017 A second selection replaces the scheduled amount for the same member", async () => {
  pendingPrice(200);
  const dialog = await chooseCard("Pro", "Manage");
  await expect(
    within(dialog).findByText("Downgrades to $50 on Apr 1, 2026."),
  ).resolves.toBeInTheDocument();
  await pick("Alex", /^\$20 ·/);
  await expect(
    within(dialog).findByText("Downgrades to $20 on Apr 1, 2026."),
  ).resolves.toBeInTheDocument();
  await pick("Alex", /^\$100 ·/);
  await expect(
    within(dialog).findByText("Downgrades to $100 on Apr 1, 2026."),
  ).resolves.toBeInTheDocument();
  expect(
    within(dialog).queryByText("Downgrades to $50 on Apr 1, 2026."),
  ).not.toBeInTheDocument();
  click(await action("Confirm", dialog));
  const review = await screen.findByRole("dialog", {
    name: "Review package change",
  });
  click(await action("Confirm", review));
  await expect(
    screen.findByText("Subscription change confirmed."),
  ).resolves.toBeInTheDocument();
  await expect(
    screen.findByText("Downgrade scheduled"),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByText("Downgrades to $100 on Apr 1, 2026."),
  ).toBeInTheDocument();
});
test("org-billing-tab-022 A sole member needs a paid package before Team can downgrade", async () => {
  changes("team", [allocation("alex", 20)]);
  const dialog = await chooseCard("Pro", "Downgrade");
  await pick("Alex", "No package");
  const requirement =
    "Select a paid package for at least one member to continue.";
  await expect(
    within(dialog).findByText(requirement),
  ).resolves.toBeInTheDocument();
  await expect(action("Confirm", dialog)).resolves.toBeDisabled();
  await pick("Alex", /^\$20 ·/);
  expect(within(dialog).queryByText(requirement)).not.toBeInTheDocument();
  click(await action("Confirm", dialog));
  await expect(
    screen.findByRole("dialog", { name: "Review package change" }),
  ).resolves.toBeInTheDocument();
});
test("org-billing-tab-023 Reviewing the April Team downgrade preserves the billing address on confirmation", async () => {
  changes(
    "team",
    [allocation("alex", 20)],
    billing("team", {
      currentPeriodEnd: april,
      scheduledChange: {
        type: "downgrade",
        targetTier: "pro",
        effectiveDate: april,
      },
    }),
  );
  const dialog = await chooseCard("Pro", "Downgrade");
  const url = window.location.href;
  const table = await comparison(20);
  amounts(table, "Monthly total", "$180/month", "$20/month");
  expect(
    within(dialog).getByText(
      "Lower package starts Apr 1, 2026 · Existing credits remain available until they expire",
    ),
  ).toBeInTheDocument();
  click(await action("Confirm", dialog));
  const review = await screen.findByRole("dialog", {
    name: "Review package change",
  });
  expect(within(review).queryByText("Due now")).not.toBeInTheDocument();
  expect(review).toHaveTextContent("$20/month");
  click(await action("Confirm", review));
  await expect(
    screen.findByText("Subscription change confirmed."),
  ).resolves.toBeInTheDocument();
  expect(window.location.href).toBe(url);
});
test("org-billing-tab-024 An ending Team plan can switch to Pro directly from plan selection", async () => {
  const may = "2026-05-01T12:00:00.000Z";
  setBilling(context, () => {
    return billing("team", { cancelAtPeriodEnd: true, currentPeriodEnd: may });
  });
  packages(context);
  managedPackages(
    "team",
    () => {
      return [allocation("alex", 20)];
    },
    may,
  );
  let target: string | undefined;
  context.mocks.api(billingDowngradeContract.create, ({ body, respond }) => {
    target = body.targetTier;
    return respond(200, { success: true, effectiveDate: may });
  });
  const chooser = await compare();
  const pro = await within(chooser).findByRole("article", { name: "Pro plan" });
  click(await action("Downgrade", pro));
  const confirm = await screen.findByRole("dialog", { name: "Downgrade plan" });
  expect(confirm).toHaveTextContent("Downgrade to Pro?");
  expect(
    screen.queryByRole("combobox", { name: "Usage for Alex" }),
  ).not.toBeInTheDocument();
  click(await action("Downgrade to Pro", confirm));
  await expect(
    screen.findByText(
      "Downgrade scheduled. Your current plan stays active until May 1, 2026.",
    ),
  ).resolves.toBeInTheDocument();
  expect(target).toBe("pro");
});

const september = "2026-09-01T12:00:00.000Z";
function conversion(scheduled = false) {
  packages(context);
  setBilling(context, () => {
    return billing("team", { currentPeriodEnd: september });
  });
  context.mocks.data.orgMembers({
    members: [
      {
        userId: "beck",
        firstName: "Beck",
        lastName: null,
        email: "beck@example.org",
        imageUrl: "",
        role: "member",
        joinedAt: "2025-10-01T12:00:00Z",
      },
    ],
  });
  let state: UsagePackMigrationStateResponse = {
    tier: "team",
    targetTier: scheduled ? "team" : null,
    status: scheduled ? "scheduled" : "eligible",
    migrationId: scheduled ? changeId : null,
    effectiveAt: september,
    hostedInvoiceUrl: null,
    ...(scheduled
      ? {
          configuration: {
            tier: "team",
            memberUsagePacks: [
              { memberId: "alex", usagePackUsd: 20 },
              { memberId: "beck", usagePackUsd: 50 },
            ],
            currency: "usd",
            recurringAmountCents: 22_950,
          },
        }
      : {}),
  };
  const terms = (tier: "pro" | "team") => {
    return {
      migrationId: changeId,
      tier: "team" as const,
      targetTier: tier,
      currentRecurringAmountCents: 20_000,
      nextRecurringAmountCents: tier === "team" ? 22_950 : 7000,
      recurringDifferenceCents: tier === "team" ? 2950 : -13_000,
      currency: "usd",
      purchasedCredits: 70_000,
      bonusCredits: 5555,
      totalCredits: 75_555,
      effectiveAt: september,
      expiresAt: september,
    };
  };
  context.mocks.api(billingUsagePackMigrationContract.get, ({ respond }) => {
    return respond(200, state);
  });
  context.mocks.api(
    billingUsagePackMigrationContract.preview,
    ({ respond, body }) => {
      return respond(200, terms(body.targetTier));
    },
  );
  context.mocks.api(
    billingUsagePackMigrationContract.confirm,
    ({ respond, params }) => {
      if (params.migrationId !== changeId) {
        throw new Error("Unknown conversion");
      }
      state = {
        ...state,
        targetTier: "team",
        status: "scheduled",
        migrationId: changeId,
      };
      return respond(200, {
        status: "scheduled",
        effectiveAt: september,
        hostedInvoiceUrl: null,
      });
    },
  );
  context.mocks.api(
    billingUsagePackMigrationContract.previewRevision,
    ({ respond, body }) => {
      return respond(200, {
        ...terms(body.targetTier),
        previewToken: "revision-finance",
      });
    },
  );
  context.mocks.api(
    billingUsagePackMigrationContract.confirmRevision,
    ({ respond, body }) => {
      if (body.previewToken !== "revision-finance") {
        throw new Error("Missing revision preview");
      }
      state = {
        ...state,
        targetTier: body.targetTier,
        configuration: {
          tier: body.targetTier,
          memberUsagePacks: body.memberUsagePacks,
          recurringAmountCents: 7000,
          currency: "usd",
        },
      };
      return respond(200, {
        status: "scheduled",
        effectiveAt: september,
        hostedInvoiceUrl: null,
      });
    },
  );
}
test("org-billing-tab-011 Legacy Team compares each entitlement before reviewing the exact recurring bill", async () => {
  conversion();
  const config = await chooseCard("Team", "Convert plan");
  await pick("Alex", /^\$20 ·/);
  await pick("Beck", /^\$50 ·/);
  const table = await comparison(230);
  for (const [label, from, to] of [
    ["Plan", "TeamLegacy", "Team"],
    ["Member packages", "$0", "$70"],
    ["Concurrent slots", "10", "10"],
    ["Purchased credits", "120,000", "70,000"],
    ["Bonus credits", "0", "5,555"],
    ["Monthly total", "$200/month", "$230/month"],
  ]) {
    amounts(table, label, from, to);
  }
  click(await action("Review conversion", config));
  const review = await screen.findByRole("dialog", {
    name: "Review plan conversion",
  });
  for (const value of [
    "Team plan",
    "$160",
    "$70",
    "75,555",
    "5,555 bonus included",
    "10 concurrent runs",
    "$229.50",
    "Sep 1, 2026",
  ]) {
    expect(review).toHaveTextContent(value);
  }
  await expect(action("Confirm", review)).resolves.toBeEnabled();
});
test("org-billing-tab-012 Confirming a legacy conversion leaves the old plan in force until September", async () => {
  conversion();
  const config = await chooseCard("Team", "Convert plan");
  await pick("Alex", /^\$20 ·/);
  await pick("Beck", /^\$50 ·/);
  click(await action("Review conversion", config));
  const review = await screen.findByRole("dialog", {
    name: "Review plan conversion",
  });
  expect(review).toHaveTextContent("Sep 1, 2026");
  click(await action("Confirm", review));
  await expect(
    screen.findByText("Subscription change confirmed."),
  ).resolves.toBeInTheDocument();
  await expect(
    screen.findByText("Switches to Team on Sep 1, 2026"),
  ).resolves.toBeInTheDocument();
  expect(screen.getByText("Legacy")).toBeInTheDocument();
  expect(
    screen.queryByText(/^Conversion scheduled for/),
  ).not.toBeInTheDocument();
});
test("org-billing-tab-013 A scheduled Team conversion can be revised to Pro after leaving unchanged settings", async () => {
  conversion(true);
  const config = await chooseCard("Team", "Manage");
  await expect(
    within(config).findByRole("combobox", { name: "Usage for Beck" }),
  ).resolves.toHaveTextContent("54,321");
  expect(findAction("Review conversion", config)).toBeUndefined();
  expect(within(config).queryByText("Current plan")).not.toBeInTheDocument();
  click(await action("Back", config));
  const pro = await screen.findByRole("article", { name: "Pro plan" });
  click(await action("Downgrade", pro));
  const revision = await screen.findByRole("dialog", {
    name: "Configure member packages",
  });
  click(await action("Review conversion", revision));
  const review = await screen.findByRole("dialog", {
    name: "Review plan conversion",
  });
  expect(review).toHaveTextContent("Pro plan");
  click(await action("Confirm", review));
  await expect(
    screen.findByText("Switches to Pro on Sep 1, 2026"),
  ).resolves.toBeInTheDocument();
});
test("org-billing-tab-028 Restoring a scheduled slot reduction leaves the ending Team plan alone", async () => {
  const june = "2026-06-01T12:00:00.000Z";
  let scheduled: number | null = null;
  setBilling(context, () => {
    return billing("team", {
      cancelAtPeriodEnd: true,
      canRestorePlan: true,
      currentPeriodEnd: june,
      concurrencyUnitAmountCents: 4200,
      concurrencySubscriptions: [
        {
          id: "sub_capacity",
          quantity: 5,
          canReduce: false,
          canChangeInApp: true,
          cancelAtPeriodEnd: false,
          currentPeriodEnd: june,
          scheduledQuantity: scheduled,
          scheduledChangeAt: scheduled ? june : null,
        },
      ],
    });
  });
  context.mocks.api(
    billingConcurrencySubscriptionContract.previewChange,
    ({ respond, body }) => {
      return respond(200, {
        currentQuantity: 5,
        targetQuantity: body.quantity,
        immediateAmountCents: 4200,
        nextRecurringAmountCents: 25_200,
        currency: "usd",
      });
    },
  );
  context.mocks.api(
    billingConcurrencySubscriptionContract.restore,
    ({ respond }) => {
      scheduled = null;
      return respond(200, { success: true });
    },
  );
  await openWorkspace(context);
  click(await action("Change"));
  const edit = await screen.findByRole("dialog", {
    name: "Change concurrency",
  });
  await expect(
    action("Decrease additional concurrency quantity", edit),
  ).resolves.toBeDisabled();
  expect(findAction("Cancel entire subscription", edit)).toBeUndefined();
  click(await action("Increase additional concurrency quantity", edit));
  expect(within(edit).getByRole("textbox", { name: "Slots" })).toHaveValue("6");
  click(await action("Review change", edit));
  const review = await screen.findByRole("dialog", {
    name: "Review concurrency change",
  });
  expect(review).toHaveTextContent("$252");
  click(await action("Cancel", review));
  click(await action("Restore Team plan"));
  const plan = await screen.findByRole("dialog", {
    name: "Restore Team plan?",
  });
  expect(plan).toHaveTextContent(
    "Your paid concurrency (5 slots) will remain active and continue renewing with your plan.",
  );
  click(await action("Cancel", plan));
  await expect(action("Change")).resolves.toBeEnabled();
  scheduled = 3;
  context.mocks.ably.trigger("billing:changed", {});
  await expect(
    screen.findByText("Changes to 3 slots on Jun 1, 2026"),
  ).resolves.toBeInTheDocument();
  click(await action("Restore concurrency"));
  const confirm = await screen.findByRole("dialog", {
    name: "Restore concurrency subscription?",
  });
  click(await action("Restore concurrency", confirm));
  await expect(
    screen.findByText("Concurrency subscription restored."),
  ).resolves.toBeInTheDocument();
  await expect(action("Change")).resolves.toBeEnabled();
  expect(
    screen.getByText(
      "Your Team plan has been cancelled and will end on Jun 1, 2026.",
    ),
  ).toBeInTheDocument();
});
