import assert from "node:assert/strict";
import { resolve } from "node:path";
import { assertWorkerEntries } from "./worker-role-manifest.mjs";

const apiRoot = resolve(import.meta.dirname, "..");

// Partial capability probes, not an exhaustive routing or deployment inventory.
export const workerDomains = {
  threads: {
    entry: "src/worker-domains/threads.ts",
    groups: [
      "chatRelationsRoutes",
      "chatThreadIndicatorRoutes",
      "chatThreadSnapshotRoutes",
      "chatThreadDetailRoutes",
      "chatThreadArtifactRoutes",
      "chatThreadMessageReadRoutes",
      "chatThreadUsageRoutes",
      "chatThreadActivitySummaryRoutes",
      "chatThreadArchiveRoutes",
      "chatThreadMuteRoutes",
      "chatThreadsArtifactsSyncRoutes",
      "chatThreadComputerUseHostRoutes",
      "chatThreadConnectorSelectionRoutes",
      "chatThreadCreateRoutes",
      "chatThreadDeleteRoutes",
      "chatThreadDraftGetRoutes",
      "chatThreadGetRoutes",
      "chatThreadMarkAgentReadRoutes",
      "chatThreadMarkReadRoutes",
      "chatThreadMarkUnreadRoutes",
      "chatThreadModelSelectionRoutes",
      "chatThreadPatchRoutes",
      "chatThreadPinRoutes",
      "chatThreadPinOrderRoutes",
      "chatThreadRenameRoutes",
      "chatThreadUnpinRoutes",
      "welcomeChatThreadRoutes",
      "sharedThreadRoutes",
    ],
    initializeChatRunFinishedEvents: true,
  },
  chat: {
    entry: "src/worker-domains/chat.ts",
    groups: [
      "chatThreadCatchUpRoutes",
      "chatSearchRoutes",
      "chatInputStatusRoutes",
      "chatEventsRoutes",
    ],
    initializeChatRunFinishedEvents: true,
  },
  runs: {
    entry: "src/worker-domains/runs.ts",
    groups: ["runDetailRoutes", "runsRoutes", "runsCancelRoutes"],
    initializeChatRunFinishedEvents: true,
  },
  agents: {
    entry: "src/worker-domains/agents.ts",
    groups: [
      "agentDraftRoutes",
      "agentInstructionsRoutes",
      "agentsRoutes",
      "agentConnectorAccessRoutes",
      "agentSetupPromptRoutes",
    ],
    initializeChatRunFinishedEvents: false,
  },
  workflows: {
    entry: "src/worker-domains/workflows.ts",
    groups: ["workflowsRoutes", "workflowAutomationsRoutes"],
    initializeChatRunFinishedEvents: true,
  },
};

const domainRouteModules = {
  chatRelationsRoutes: "./routes/chat-relations",
  chatThreadIndicatorRoutes: "./routes/chat-thread-indicators",
  chatThreadSnapshotRoutes: "./routes/chat-thread-snapshots",
  chatThreadDetailRoutes: "./routes/chat-thread-details",
  chatThreadArtifactRoutes: "./routes/chat-thread-artifacts",
  chatThreadMessageReadRoutes: "./routes/chat-thread-message-reads",
  chatThreadUsageRoutes: "./routes/chat-threads-usage",
  chatThreadActivitySummaryRoutes: "./routes/chat-threads-activity-summary",
  chatThreadArchiveRoutes: "./routes/chat-threads-archive",
  chatThreadMuteRoutes: "./routes/chat-threads-mute",
  chatThreadsArtifactsSyncRoutes: "./routes/chat-threads-artifacts-sync",
  chatThreadComputerUseHostRoutes: "./routes/chat-threads-computer-use-host",
  chatThreadConnectorSelectionRoutes:
    "./routes/chat-threads-connector-selections",
  chatThreadCreateRoutes: "./routes/chat-threads-create",
  chatThreadDeleteRoutes: "./routes/chat-threads-delete",
  chatThreadDraftGetRoutes: "./routes/chat-threads-draft-get",
  chatThreadGetRoutes: "./routes/chat-threads-get",
  chatThreadMarkAgentReadRoutes: "./routes/chat-threads-mark-agent-read",
  chatThreadMarkReadRoutes: "./routes/chat-threads-mark-read",
  chatThreadMarkUnreadRoutes: "./routes/chat-threads-mark-unread",
  chatThreadModelSelectionRoutes: "./routes/chat-threads-model-selection",
  chatThreadPatchRoutes: "./routes/chat-threads-patch",
  chatThreadPinRoutes: "./routes/chat-threads-pin",
  chatThreadPinOrderRoutes: "./routes/chat-threads-pin-order",
  chatThreadRenameRoutes: "./routes/chat-threads-rename",
  chatThreadUnpinRoutes: "./routes/chat-threads-unpin",
  welcomeChatThreadRoutes: "./routes/welcome-chat-threads",
  sharedThreadRoutes: "./routes/shared-threads",
  chatThreadCatchUpRoutes: "./routes/chat-thread-catch-up",
  chatSearchRoutes: "./routes/chat-search",
  chatInputStatusRoutes: "./routes/chat-input-status",
  chatEventsRoutes: "./routes/chat-events",
  runDetailRoutes: "./routes/run-detail",
  runsRoutes: "./routes/runs",
  runsCancelRoutes: "./routes/runs-cancel",
  agentDraftRoutes: "./routes/agent-draft",
  agentInstructionsRoutes: "./routes/agent-instructions",
  agentsRoutes: "./routes/agents",
  agentConnectorAccessRoutes: "./routes/agent-connector-access",
  agentSetupPromptRoutes: "./routes/agent-setup-prompts",
  workflowsRoutes: "./routes/workflows",
  workflowAutomationsRoutes: "./routes/workflow-automations",
};

export const workerDomainRouteGroups = Object.entries(domainRouteModules).map(
  ([name, module]) => {
    return { name, module, exportName: name };
  },
);

export function assertWorkerDomainEntries(root = apiRoot) {
  const groups = new Set(Object.keys(domainRouteModules));
  const selected = new Set();
  for (const [domain, definition] of Object.entries(workerDomains)) {
    assert.ok(definition.groups.length > 0, `Empty business probe: ${domain}`);
    for (const group of definition.groups) {
      assert.ok(groups.has(group), `Unknown business route leaf: ${group}`);
      assert.ok(
        !selected.has(group),
        `Duplicate business route leaf: ${group}`,
      );
      selected.add(group);
    }
  }
  assert.equal(selected.size, groups.size, "Unselected business route leaf");
  return assertWorkerEntries(workerDomains, workerDomainRouteGroups, root);
}
