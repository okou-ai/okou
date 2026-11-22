import {
  workflowAutomationsContract,
  type WorkflowAutomationsListEntry,
} from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
const context = testContext();
function entry(official: boolean): WorkflowAutomationsListEntry {
  const ownerUserId = "harbor-reader";
  const id = crypto.randomUUID();
  return {
    workflow: {
      id: crypto.randomUUID(),
      name: "proactive-learning",
      displayName: "Learning",
      description: "Learning schedule",
      ownerUserId,
      canManage: true,
      canPublish: false,
      visibility: "private",
      createdAt: "2026-09-10T12:00:00.000Z",
      official: official
        ? {
            definitionName: "proactive-learning",
            installationState: "installed",
            definitionLifecycle: "active",
            readOnly: true,
          }
        : null,
      importSource: null,
    },
    automation: {
      id,
      ownerUserId,
      enabled: false,
      kind: "schedule",
      schedule: { type: "cron", cronExpression: "0 2 * * *", timezone: "UTC" },
      scheduleSummary: "Nightly",
      chatThreadId: crypto.randomUUID(),
      nextRunAt: null,
      lastRunAt: null,
      official: official
        ? {
            blueprintKey: "nightly-learning",
            appliedFingerprint: "e".repeat(64),
            reconciliationStatus: "current",
            intendedEnabled: false,
            parameterBindings: [],
          }
        : null,
    },
  };
}
async function visit(entries: WorkflowAutomationsListEntry[]) {
  context.mocks.api(
    workflowAutomationsContract.listWorkspace,
    ({ respond }) => {
      return respond(200, entries);
    },
  );
  await setupPage({
    context,
    path: "/?settings=debug",
    host: "app.okou.ai",
    featureSwitches: {
      [FeatureSwitchKey.AgentSuggestion]: true,
      [FeatureSwitchKey.OkouDebug]: true,
    },
  });
  return await findFastControl("button", "Run learning");
}
test("debug-learning-002 a custom workflow named Learning cannot start the official learning job", async () => {
  const run = await visit([entry(false)]);
  await screen.findByText(
    "Enable Learning in Preferences before running it here.",
  );
  expect(run).toBeDisabled();
});
test("debug-learning-004 closing Debug aborts the pending Learning run", async () => {
  const official = entry(true),
    started = context.mocks.deferred<void>(),
    aborted = context.mocks.deferred<void>();
  context.mocks.api(
    workflowAutomationsContract.run,
    async ({ request, params, respond }) => {
      expect(params.id).toBe(official.automation.id);
      request.signal.addEventListener(
        "abort",
        () => {
          aborted.resolve();
        },
        { once: true },
      );
      started.resolve();
      await aborted.promise;
      return respond(409, {
        error: { code: "CONFLICT", message: "Request closed" },
      });
    },
  );
  const run = await visit([official]);
  await waitFor(() => {
    expect(run).toBeEnabled();
  });
  click(run);
  await started.promise;
  await waitFor(() => {
    expect(run).toBeDisabled();
  });
  const dialog = await screen.findByRole("dialog");
  await userEvent.keyboard("{Escape}");
  await aborted.promise;
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
});
