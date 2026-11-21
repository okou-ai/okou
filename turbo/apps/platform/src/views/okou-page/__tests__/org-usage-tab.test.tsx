import {
  usageMembersContract,
  type MemberUsage,
} from "@okouai/api-contracts/contracts/usage";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  action,
  april,
  billing,
  openWorkspace,
  setBilling,
} from "./workspace-billing-fixtures.ts";
const context = testContext();

test("org-usage-tab-001 Finance's credit history shows the grant date, addition and remaining amount together", async () => {
  setBilling(context, () => {
    return billing("pro", {
      credits: 12_000,
      creditGrants: [
        {
          id: "march-grant",
          source: "monthly",
          label: "March internal grant",
          amount: 10_000,
          remaining: 8000,
          createdAt: "2026-03-01T12:00:00Z",
          expiresAt: april,
        },
      ],
    });
  });
  await openWorkspace(context, "/?settings=usage");
  const card = await screen.findByTestId("credit-balance-info");
  expect(within(card).getByText("Org credits")).toBeInTheDocument();
  expect(within(card).getByText("12,000")).toBeInTheDocument();
  const grant = within(card).getByTestId("credit-grants-march-grant");
  expect(grant).toHaveTextContent("Mar 1, 2026");
  expect(grant).toHaveTextContent("+10,000");
  expect(grant).toHaveTextContent("8,000");
  for (const label of [
    "March internal grant",
    "Pro credits",
    "Purchased credits",
  ]) {
    expect(within(card).queryByText(label)).not.toBeInTheDocument();
  }
});
test("org-usage-tab-005 Hovering Finance's purchased balance identifies its value", async () => {
  setBilling(context, () => {
    return billing("pro", {
      credits: 12_000,
      creditBreakdown: [
        { category: "payAsYouGo", credits: 12_000, label: "Purchased credits" },
      ],
    });
  });
  await openWorkspace(context);
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  click(await action("Credit balance", settings));
  const balance = await within(settings).findByTestId("credit-balance-info");
  expect(within(balance).getByText("12,000")).toBeInTheDocument();
  const segment = within(balance).getByTestId(
    "credit-balance-segment-payAsYouGo",
  );
  expect(
    screen.queryByText("Purchased credits — 12,000"),
  ).not.toBeInTheDocument();
  await userEvent.hover(segment);
  await expect(
    screen.findByText("Purchased credits — 12,000"),
  ).resolves.toBeInTheDocument();
});
function member(id: string, models: number, connectors: number): MemberUsage {
  const breakdown: MemberUsage["breakdown"] = [
    {
      kind: "model",
      credits: models,
      providers: [{ provider: "usage-model", credits: models, usageKinds: [] }],
    },
  ];
  if (connectors) {
    breakdown.push({
      kind: "connector",
      credits: connectors,
      providers: [{ provider: "slack", credits: connectors, usageKinds: [] }],
    });
  }
  return {
    userId: id,
    email: id + "@example.org",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    creditsCharged: models + connectors,
    breakdown,
  };
}
function orgReport() {
  context.mocks.data.orgMembers({
    members: ["Alice", "Bob"].map((name) => {
      const userId = name.toLowerCase();
      return {
        userId,
        email: userId + "@example.org",
        firstName: name,
        lastName: null,
        imageUrl: "",
        role: "member",
        joinedAt: "2025-10-01T12:00:00Z",
      };
    }),
  });

  context.mocks.api(usageMembersContract.get, ({ query, respond }) => {
    const week = query.range === "7d";
    return respond(200, {
      period: { start: "2026-03-01", end: april },
      members: [
        member("alice", week ? 6100 : 6000, 1500),
        member("bob", week ? 2200 : 2100, 0),
      ],
    });
  });
}
async function teamReport() {
  await openWorkspace(context, "/?settings=usage-records");
  click(await screen.findByText("Team usage"));
  return screen.findByTestId("member-usage-alice");
}
test("org-usage-tab-006 The billing period attributes model and connector usage to their owners", async () => {
  orgReport();
  const alice = await teamReport();
  const bob = screen.getByTestId("member-usage-bob");
  await expect(within(alice).findByText("Alice")).resolves.toBeInTheDocument();
  expect(alice).toHaveTextContent("alice@example.org");
  expect(alice).toHaveTextContent("7,500");
  expect(bob).toHaveTextContent("Bob");
  expect(bob).toHaveTextContent("bob@example.org");
  expect(bob).toHaveTextContent("2,100");
  for (const [id, kind, amount] of [
    ["alice", "model", "6,000"],
    ["alice", "connector", "1,500"],
    ["bob", "model", "2,100"],
  ]) {
    const segment = screen.getByTestId("member-usage-kind-" + id + "-" + kind);
    await userEvent.hover(segment);
    await expect(
      screen.findByText(
        (kind === "model" ? "Models" : "Connectors") + " - " + amount,
      ),
    ).resolves.toBeInTheDocument();
    await userEvent.unhover(segment);
  }
});
test("org-usage-tab-009 The seven-day view replaces both members' period totals and Alice's model tooltip", async () => {
  orgReport();
  const alice = await teamReport();
  expect(alice).toHaveTextContent("7,500");
  expect(screen.getByTestId("member-usage-bob")).toHaveTextContent("2,100");
  click(await action("Billing period"));
  click(await screen.findByText("Last 7 days"));
  await expect(within(alice).findByText("7,600")).resolves.toBeInTheDocument();
  expect(screen.getByTestId("member-usage-bob")).toHaveTextContent("2,200");
  await userEvent.hover(
    within(alice).getByTestId("member-usage-kind-alice-model"),
  );
  await expect(
    screen.findByText("Models - 6,100"),
  ).resolves.toBeInTheDocument();
});
