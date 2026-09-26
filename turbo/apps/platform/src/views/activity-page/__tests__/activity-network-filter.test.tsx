import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { logsByIdContract } from "@okouai/api-contracts/contracts/logs";
import {
  runAgentEventsContract,
  runNetworkLogsContract,
} from "@okouai/api-contracts/contracts/run-routes";
import type { NetworkLogEntry } from "@okouai/api-contracts/contracts/runs";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const RUN_ID = "a0000000-0000-4000-a000-000000035944";
const targets = {
  HTTP: "https://api.example.test/status",
  DNS: "dns.example.test:53",
  TCP: "db.example.test:5432",
} as const;

function networkLogs(): NetworkLogEntry[] {
  return [
    {
      timestamp: "2026-09-24T06:00:01Z",
      type: "http",
      action: "ALLOW",
      method: "GET",
      url: targets.HTTP,
      status: 200,
    },
    {
      timestamp: "2026-09-24T06:00:02Z",
      type: "dns",
      action: "ALLOW",
      host: "dns.example.test",
      port: 53,
    },
    {
      timestamp: "2026-09-24T06:00:03Z",
      type: "tcp",
      action: "ALLOW",
      host: "db.example.test",
      port: 5432,
    },
  ];
}

async function openNetworkActivity() {
  context.mocks.api(logsByIdContract.getById, ({ respond }) => {
    return respond(200, {
      id: RUN_ID,
      sessionId: "session-network-filter",
      agentId: "c0000000-0000-4000-a000-000000000001",
      displayName: "Network filter activity",
      framework: "claude-code",
      modelProvider: null,
      selectedModel: null,
      triggerSource: "web",
      status: "completed",
      prompt: "Inspect captured network traffic",
      appendSystemPrompt: null,
      error: null,
      createdAt: "2026-09-24T06:00:00Z",
      startedAt: "2026-09-24T06:00:00Z",
      completedAt: "2026-09-24T06:00:04Z",
      artifact: { name: null, version: null },
    });
  });
  context.mocks.api(runAgentEventsContract.getAgentEvents, ({ respond }) => {
    return respond(200, {
      events: [],
      hasMore: false,
      status: "completed",
      lastEventSequence: null,
    });
  });
  context.mocks.api(runNetworkLogsContract.getNetworkLogs, ({ respond }) => {
    return respond(200, { networkLogs: networkLogs(), hasMore: false });
  });

  await setupPage({
    context,
    path: `/activities/${RUN_ID}?tab=network`,
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
  });
  await expect(screen.findByText(targets.HTTP)).resolves.toBeInTheDocument();
  return {
    table: screen.getByRole("table"),
    trigger: screen.getByLabelText("Type filter"),
  };
}

function menuItem(
  menu: HTMLElement,
  name: string,
  role: "menuitem" | "menuitemcheckbox" = "menuitemcheckbox",
) {
  const item = queryAllByRoleFast(role, menu).find((element) => {
    return element.textContent?.trim() === name;
  });
  if (!item) {
    throw new Error(`Expected ${role} named "${name}"`);
  }
  return item;
}

function expectTypes(
  menu: HTMLElement,
  table: HTMLElement,
  selected: (keyof typeof targets)[],
) {
  for (const [type, target] of Object.entries(targets)) {
    const checked = selected.some((value) => {
      return value === type;
    });
    expect(menuItem(menu, type)).toHaveAttribute(
      "aria-checked",
      String(checked),
    );
    expect(within(table).queryByText(target) !== null).toBe(checked);
  }
  expect(menu).toBeInTheDocument();
}

test("Network type selections keep the menu open and reset the last deselection to all types", async () => {
  const user = userEvent.setup();
  const { table, trigger } = await openNetworkActivity();
  expect(trigger).toHaveTextContent("HTTP");

  await user.click(trigger);
  const menu = await screen.findByRole("menu");
  expectTypes(menu, table, ["HTTP"]);
  expect(menuItem(menu, "All types", "menuitem")).not.toHaveAttribute(
    "aria-checked",
  );

  await user.click(menuItem(menu, "DNS"));
  expectTypes(menu, table, ["HTTP", "DNS"]);
  expect(trigger).toHaveTextContent("2 types");

  await user.click(menuItem(menu, "HTTP"));
  expectTypes(menu, table, ["DNS"]);
  expect(trigger).toHaveTextContent("DNS");

  await user.click(menuItem(menu, "DNS"));
  expectTypes(menu, table, ["HTTP", "DNS", "TCP"]);
  expect(trigger).toHaveTextContent("All types");

  await user.click(menuItem(menu, "TCP"));
  expectTypes(menu, table, ["HTTP", "DNS"]);
  expect(trigger).toHaveTextContent("2 types");

  await user.click(menuItem(menu, "All types", "menuitem"));
  expectTypes(menu, table, ["HTTP", "DNS", "TCP"]);
  expect(trigger).toHaveTextContent("All types");
  expect(trigger).toHaveAttribute("aria-expanded", "true");

  await user.click(menuItem(menu, "All types", "menuitem"));
  expectTypes(menu, table, ["HTTP", "DNS", "TCP"]);
  expect(trigger).toHaveTextContent("All types");
});

test("Enter and Space each toggle a network type once, and Escape restores trigger focus", async () => {
  const user = userEvent.setup();
  const { table, trigger } = await openNetworkActivity();
  act(() => {
    trigger.focus();
  });
  await user.keyboard("{Enter}");
  const menu = await screen.findByRole("menu");
  await user.keyboard("{Home}{ArrowDown}{ArrowDown}");
  expect(menuItem(menu, "DNS")).toHaveFocus();

  await user.keyboard("{Enter}");
  expectTypes(menu, table, ["HTTP", "DNS"]);
  expect(menuItem(menu, "DNS")).toHaveFocus();
  expect(trigger).toHaveTextContent("2 types");

  await user.keyboard(" ");
  expectTypes(menu, table, ["HTTP"]);
  expect(menuItem(menu, "DNS")).toHaveFocus();
  expect(trigger).toHaveTextContent("HTTP");
  expect(trigger).toHaveAttribute("aria-expanded", "true");

  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
