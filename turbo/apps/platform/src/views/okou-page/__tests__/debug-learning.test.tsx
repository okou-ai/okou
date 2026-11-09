import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import {
  workflowAutomationsContract,
  type WorkflowAutomationsListEntry,
} from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const AUTOMATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const THREAD_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function learningEntry(): WorkflowAutomationsListEntry {
  return {
    workflow: {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      agentId: DEFAULT_AGENT_ID,
      agentName: "okou",
      agentDisplayName: "Okou",
      name: "proactive-learning",
      displayName: "Proactive Learning",
      description: "Review recent activity and maintain personal memory.",
      visibility: "private",
      ownerUserId: "test-user-123",
      createdAt: "2026-11-09T00:00:00.000Z",
      canManage: false,
      canPublish: false,
      importSource: null,
      official: {
        definitionName: "proactive-learning",
        installationState: "installed",
        definitionLifecycle: "active",
        readOnly: true,
      },
    },
    automation: {
      id: AUTOMATION_ID,
      kind: "schedule",
      ownerUserId: "test-user-123",
      enabled: false,
      chatThreadId: null,
      nextRunAt: null,
      lastRunAt: null,
      schedule: {
        type: "cron",
        cronExpression: "0 2 * * *",
        timezone: "Asia/Shanghai",
      },
      scheduleSummary: "Every night at 02:00",
      official: {
        blueprintKey: "nightly-learning",
        appliedFingerprint: "a".repeat(64),
        reconciliationStatus: "current",
        intendedEnabled: false,
        parameterBindings: [{ key: "cron", value: "0 2 * * *" }],
      },
    },
  };
}

function customLearningEntry(): WorkflowAutomationsListEntry {
  const entry = learningEntry();
  return {
    workflow: {
      ...entry.workflow,
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      official: null,
    },
    automation: {
      ...entry.automation,
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      official: null,
    },
  };
}

function runButton() {
  const card = screen.getByRole("region", { name: "Learning" });
  const button = queryAllByRoleFast("button", card).find((candidate) => {
    return candidate.textContent?.trim() === "Run learning";
  });
  if (!button) {
    throw new Error("Expected the Learning run button");
  }
  return button;
}

async function openDebug(learning = true) {
  context.mocks.data.onboardingStatus({ defaultAgentId: DEFAULT_AGENT_ID });
  await setupPage({
    context,
    path: "/agents?settings=debug",
    featureSwitches: {
      [FeatureSwitchKey.OkouDebug]: true,
      [FeatureSwitchKey.ProactiveLearning]: learning,
    },
  });
  await screen.findByRole("heading", { name: "Debug" });
}

test("runs the current default agent's official Learning while its nightly schedule is paused", async () => {
  const unrelated = learningEntry();
  const formerDefault = learningEntry();
  context.mocks.api(
    workflowAutomationsContract.listWorkspace,
    ({ respond }) => {
      return respond(200, [
        customLearningEntry(),
        {
          ...formerDefault,
          workflow: {
            ...formerDefault.workflow,
            id: "33333333-3333-4333-8333-333333333333",
            agentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          },
          automation: {
            ...formerDefault.automation,
            id: "44444444-4444-4444-8444-444444444444",
          },
        },
        {
          ...unrelated,
          workflow: {
            ...unrelated.workflow,
            id: "11111111-1111-4111-8111-111111111111",
            official: {
              definitionName: "proactive-suggestions",
              installationState: "installed",
              definitionLifecycle: "active",
              readOnly: true,
            },
          },
          automation: {
            ...unrelated.automation,
            id: "22222222-2222-4222-8222-222222222222",
          },
        },
        learningEntry(),
      ]);
    },
  );
  context.mocks.api(workflowAutomationsContract.run, ({ params, respond }) => {
    expect(params.id).toBe(AUTOMATION_ID);
    return respond(201, { chatThreadId: THREAD_ID, runId: null });
  });
  await openDebug();
  await screen.findByRole("region", { name: "Learning" });
  const run = runButton();
  await waitFor(() => {
    expect(run).toBeEnabled();
  });
  click(run);
  await screen.findByText("Learning queued.");
  expect(run).toBeDisabled();
});

test("explains the installation prerequisite instead of running a same-name custom workflow", async () => {
  context.mocks.api(
    workflowAutomationsContract.listWorkspace,
    ({ respond }) => {
      return respond(200, [customLearningEntry()]);
    },
  );
  await openDebug();
  await screen.findByText(
    "Enable Learning in Preferences before running it here.",
  );
  expect(runButton()).toBeDisabled();
});

test("keeps an uncertain submission disabled rather than replaying it", async () => {
  context.mocks.api(
    workflowAutomationsContract.listWorkspace,
    ({ respond }) => {
      return respond(200, [learningEntry()]);
    },
  );
  // A lost response has no contract status; intercept the transport boundary.
  context.mocks.http.post("*/api/workflow-automations/:id/run", () => {
    return HttpResponse.error();
  });
  await openDebug();
  await screen.findByRole("region", { name: "Learning" });
  const run = runButton();
  await waitFor(() => {
    expect(run).toBeEnabled();
  });
  click(run);
  const card = screen.getByRole("region", { name: "Learning" });
  const alert = await within(card).findByRole("alert");
  expect(alert).toHaveTextContent("The request could not be confirmed.");
  expect(run).toBeDisabled();
});

test("dismissal cancels a pending Learning request", async () => {
  const requested = context.mocks.deferred<void>();
  const response = context.mocks.deferred<void>();
  let requestSignal: AbortSignal | undefined;
  context.mocks.api(
    workflowAutomationsContract.listWorkspace,
    ({ respond }) => {
      return respond(200, [learningEntry()]);
    },
  );
  context.mocks.api(
    workflowAutomationsContract.run,
    async ({ request, respond }) => {
      requestSignal = request.signal;
      requested.resolve();
      await response.promise;
      return respond(201, { chatThreadId: THREAD_ID, runId: null });
    },
  );
  await openDebug();
  await screen.findByRole("region", { name: "Learning" });
  const run = runButton();
  await waitFor(() => {
    expect(run).toBeEnabled();
  });
  click(run);
  await requested.promise;
  expect(run).toBeDisabled();
  const user = userEvent.setup({ delay: null });
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(requestSignal?.aborted).toBeTruthy();
  });
  response.resolve();
});

test("dismissal also cancels Learning discovery", async () => {
  const requested = context.mocks.deferred<void>();
  const response = context.mocks.deferred<void>();
  let requestSignal: AbortSignal | undefined;
  context.mocks.api(
    workflowAutomationsContract.listWorkspace,
    async ({ request, respond }) => {
      requestSignal = request.signal;
      requested.resolve();
      await response.promise;
      return respond(200, [learningEntry()]);
    },
  );
  await openDebug();
  await requested.promise;
  expect(runButton()).toBeDisabled();
  const user = userEvent.setup({ delay: null });
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(requestSignal?.aborted).toBeTruthy();
  });
  response.resolve();
});

test("does not offer Learning outside its rollout", async () => {
  await openDebug(false);
  expect(
    screen.queryByRole("region", { name: "Learning" }),
  ).not.toBeInTheDocument();
});
