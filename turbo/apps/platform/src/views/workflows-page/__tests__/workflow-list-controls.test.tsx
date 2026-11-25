import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  workflowAutomationsContract,
  type WorkflowAutomationSummary,
} from "@okouai/api-contracts/contracts/workflows";
import {
  click,
  fill,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { findAction } from "../../okou-page/__tests__/connector-integrations-test-helpers.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { salesWorkflow, serveWorkflows } from "./workflow-boundary.ts";

const context = testContext();

function schedule(
  nextRunAt: string,
  enabled = true,
): WorkflowAutomationSummary {
  return {
    id: crypto.randomUUID(),
    ownerUserId: "test-user-123",
    enabled,
    kind: "schedule",
    chatThreadId: null,
    lastRunAt: null,
    nextRunAt,
    official: null,
    schedule: { type: "cron", cronExpression: "0 9 * * *", timezone: "UTC" },
    scheduleSummary: "Daily",
  };
}

function directory() {
  const workflows = [
    salesWorkflow(context, {
      id: crypto.randomUUID(),
      name: "alpha-sales",
      displayName: "Alpha sales",
      visibility: "public",
      createdAt: "2026-11-01T00:00:00Z",
      description: "Prepare outreach",
      automations: [schedule("2026-12-05T09:00:00Z")],
    }),
    salesWorkflow(context, {
      id: crypto.randomUUID(),
      name: "bravo-ops",
      displayName: "Bravo ops",
      createdAt: "2026-11-02T00:00:00Z",
      automations: [schedule("2026-12-01T09:00:00Z", false)],
    }),
    salesWorkflow(context, {
      id: crypto.randomUUID(),
      name: "charlie-launch",
      displayName: "Charlie launch",
      createdAt: "2026-11-04T00:00:00Z",
      description: "Review approvals",
    }),
    salesWorkflow(context, {
      id: crypto.randomUUID(),
      name: "delta-research",
      displayName: "Delta research",
      createdAt: "2026-11-03T00:00:00Z",
      automations: [
        schedule("2026-12-07T09:00:00Z"),
        schedule("2026-12-03T09:00:00Z"),
      ],
    }),
  ];
  serveWorkflows(context, () => {
    return workflows;
  });
  context.mocks.api(
    workflowAutomationsContract.listWorkspace,
    ({ respond }) => {
      return respond(
        200,
        workflows.flatMap((workflow) => {
          return workflow.automations.map((automation) => {
            return {
              workflow,
              automation,
            };
          });
        }),
      );
    },
  );
}

function menuChoice(role: "menuitem" | "menuitemradio", label: string) {
  const item = queryAllByRoleFast(role).find((node) => {
    return node.textContent?.trim() === label;
  });
  if (!item) {
    throw new Error(`Missing menu choice: ${label}`);
  }
  return item;
}

function titles() {
  return queryAllByRoleFast("link", screen.getByRole("main")).map((link) => {
    return link.getAttribute("aria-label");
  });
}

async function expectTitles(expected: string[]) {
  await waitFor(() => {
    expect(titles()).toStrictEqual(
      expected.map((title) => {
        return `Open ${title}`;
      }),
    );
  });
}

test("workflow directory combines visibility and automation filters and restores the unfiltered list", async () => {
  const user = userEvent.setup();
  directory();
  await setupPage({ context, path: "/workflows" });
  await expectTitles([
    "Charlie launch",
    "Delta research",
    "Bravo ops",
    "Alpha sales",
  ]);
  const filter = await findAction("button", "Filter workflows");
  click(filter);
  click(menuChoice("menuitemradio", "Private"));
  click(menuChoice("menuitemradio", "With automations"));
  await expectTitles(["Delta research", "Bravo ops"]);
  expect(filter).toHaveTextContent("2");
  expect(new URLSearchParams(location.search).get("filter")).toBe("private");
  expect(new URLSearchParams(location.search).get("automation")).toBe(
    "automated",
  );
  await user.keyboard("{Escape}");
  expect(filter).toHaveFocus();
  click(filter);
  click(menuChoice("menuitemradio", "Workspace shared"));
  click(menuChoice("menuitemradio", "Without automations"));
  await user.keyboard("{Escape}");
  await screen.findByText("No matching workflows");
  click(await findAction("button", "Clear filters"));
  await expectTitles([
    "Charlie launch",
    "Delta research",
    "Bravo ops",
    "Alpha sales",
  ]);
  expect(location.search).toBe("");
});

test("workflow search restores URL state and preserves both filters and sorting", async () => {
  directory();
  await setupPage({
    context,
    path: "/workflows?filter=private&automation=without&sort=alphabetical&q=APPROVALS",
  });
  await expectTitles(["Charlie launch"]);
  const input = screen.getByRole("searchbox", { name: "Search workflows…" });
  expect(input).toHaveValue("APPROVALS");
  await fill(input, " /charlie-launch ");
  await expectTitles(["Charlie launch"]);
  await fill(input, "outreach");
  await screen.findByText("No matching workflows");
  click(await findAction("button", "Clear search"));
  await expectTitles(["Charlie launch"]);
  expect(input).toHaveValue("");
  expect(new URLSearchParams(location.search).get("automation")).toBe(
    "without",
  );
  click(await findAction("button", "Filter workflows"));
  click(menuChoice("menuitem", "Clear filters"));
  await expectTitles([
    "Alpha sales",
    "Bravo ops",
    "Charlie launch",
    "Delta research",
  ]);
  expect(location.search).toBe("?sort=alphabetical");
  click(await findAction("button", "Sort workflows"));
  click(menuChoice("menuitemradio", "Newest created"));
  await expectTitles([
    "Charlie launch",
    "Delta research",
    "Bravo ops",
    "Alpha sales",
  ]);
  expect(location.search).toBe("");
});

test("next run orders by the earliest enabled schedule and leaves unscheduled workflows accessible", async () => {
  directory();
  await setupPage({
    context,
    path: "/workflows?sort=next-run&filter=automated",
  });
  await expectTitles(["Delta research", "Alpha sales", "Bravo ops"]);
  click(await findAction("button", "Filter workflows"));
  expect(menuChoice("menuitemradio", "With automations")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  click(menuChoice("menuitemradio", "Private"));
  await expectTitles(["Delta research", "Bravo ops"]);
  expect(new URLSearchParams(location.search).get("automation")).toBe(
    "automated",
  );
  click(menuChoice("menuitem", "Clear filters"));
  await expectTitles([
    "Delta research",
    "Alpha sales",
    "Bravo ops",
    "Charlie launch",
  ]);
  expect(location.search).toBe("?sort=next-run");
});
