import { command, computed, state } from "ccstate";
import {
  workflowAutomationsContract,
  workflowsDetailContract,
} from "@okouai/api-contracts/client/workflows";
import type {
  WorkflowAutomationAccountConflict,
  WorkflowSummary,
} from "@okouai/api-contracts/contracts/workflows";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { currentOrgInfo$ } from "../auth.ts";
import { localStorageSignals } from "../external/local-storage.ts";
import {
  allVisibleWorkflows$,
  reloadWorkflows$,
  singleAgentWorkflows$,
} from "./workflows-signals.ts";

/** How long migrated workflows keep their "From agent" label. */
const MIGRATION_BADGE_MS = 30 * 24 * 60 * 60 * 1000;

/** The migration label a workflow row shows, or null once it has expired. */
export function workflowMigrationBadge(
  workflow: Pick<WorkflowSummary, "migration">,
  now: Date,
): { readonly fromAgent: true } | { readonly agent: string } | null {
  const migration = workflow.migration;
  if (!migration) {
    return null;
  }
  if (now.getTime() - Date.parse(migration.migratedAt) >= MIGRATION_BADGE_MS) {
    return null;
  }
  return migration.source === "agent"
    ? { fromAgent: true }
    : { agent: migration.agentDisplayName };
}

export interface MigratedAgentWorkflow {
  readonly title: string;
  readonly slug: string;
}

/** Workflows that legacy agents themselves became, as the member sees them. */
export const migratedAgentWorkflows$ = computed(
  async (get): Promise<readonly MigratedAgentWorkflow[]> => {
    if (!(await get(singleAgentWorkflows$))) {
      return [];
    }
    const workflows = await get(allVisibleWorkflows$);
    return workflows
      .filter((workflow) => {
        return workflow.migration?.source === "agent";
      })
      .map((workflow) => {
        return {
          title: workflow.displayName ?? workflow.name,
          slug: workflow.name,
        };
      });
  },
);

// Dismissal is per workspace: a member can belong to several migrated ones.
const dismissedNoticeStorage = localStorageSignals(
  "agent-migration-notice-dismissed",
);

function dismissedOrgIds(raw: string | null): readonly string[] {
  return raw ? raw.split(",") : [];
}

export const agentMigrationNoticeVisible$ = computed(async (get) => {
  const migrated = await get(migratedAgentWorkflows$);
  if (migrated.length === 0) {
    return false;
  }
  const org = await get(currentOrgInfo$);
  if (!org) {
    return false;
  }
  return !dismissedOrgIds(get(dismissedNoticeStorage.get$)).includes(org.id);
});

export const dismissAgentMigrationNotice$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const org = await get(currentOrgInfo$);
    signal.throwIfAborted();
    if (!org) {
      return;
    }
    const dismissed = dismissedOrgIds(set(dismissedNoticeStorage.readFresh$));
    if (dismissed.includes(org.id)) {
      return;
    }
    set(dismissedNoticeStorage.set$, [...dismissed, org.id].join(","));
  },
);

const internalHowWorkflowsWorkOpen$ = state(false);

export const howWorkflowsWorkOpen$ = computed((get) => {
  return get(internalHowWorkflowsWorkOpen$);
});

export const setHowWorkflowsWorkOpen$ = command(({ set }, open: boolean) => {
  set(internalHowWorkflowsWorkOpen$, open);
});

export interface AccountConflictTarget {
  readonly automationId: string;
  readonly workflowTitle: string;
  readonly conflict: WorkflowAutomationAccountConflict;
}

const internalAccountConflictTarget$ = state<AccountConflictTarget | null>(
  null,
);
const internalSelectedConnectionId$ = state<string | null>(null);

export const accountConflictTarget$ = computed((get) => {
  return get(internalAccountConflictTarget$);
});

/** The account picked in the dialog; defaults to the first option. */
export const selectedConflictConnectionId$ = computed((get) => {
  const target = get(internalAccountConflictTarget$);
  if (!target) {
    return null;
  }
  return (
    get(internalSelectedConnectionId$) ??
    target.conflict.options[0]?.connectionId ??
    null
  );
});

export const selectConflictConnection$ = command(
  ({ set }, connectionId: string) => {
    set(internalSelectedConnectionId$, connectionId);
  },
);

export const openAccountConflict$ = command(
  ({ set }, target: AccountConflictTarget) => {
    set(internalSelectedConnectionId$, null);
    set(internalAccountConflictTarget$, target);
  },
);

export const closeAccountConflict$ = command(({ set }) => {
  set(internalAccountConflictTarget$, null);
  set(internalSelectedConnectionId$, null);
});

export const resolveAccountConflict$ = command(
  async (
    { get, set },
    input: { readonly automationId: string; readonly connectionId: string },
    signal: AbortSignal,
  ) => {
    const client = get(apiClient$)(workflowAutomationsContract);
    await accept(
      client.resolveAccountConflict({
        params: { id: input.automationId },
        body: { connectionId: input.connectionId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(closeAccountConflict$);
    set(reloadWorkflows$);
  },
);

export const removeWorkflowInclude$ = command(
  async (
    { get, set },
    input: { readonly workflowId: string; readonly includeName: string },
    signal: AbortSignal,
  ) => {
    const client = get(apiClient$)(workflowsDetailContract);
    await accept(
      client.removeInclude({
        params: {
          workflowId: input.workflowId,
          includeName: input.includeName,
        },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadWorkflows$);
  },
);
