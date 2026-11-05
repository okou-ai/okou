import { command, computed, state } from "ccstate";
import type { Tone } from "../../../views/okou-page/tone-constants.ts";
import {
  copyWorkflow$,
  currentAgentVisibleWorkflows$,
} from "../../workflows-page/workflows-signals.ts";
import { deleteAgentAndReturnToList$ } from "../job-detail/actions.ts";

interface SettingsFormValues {
  name: string;
  description: string;
  tone: Tone;
  avatarUrl: string | null;
  visibility: "public" | "private";
}

interface SettingsFormDraft {
  readonly agentId: string;
  readonly patch: Partial<SettingsFormValues>;
}

const internalSettingsFormDraft$ = state<SettingsFormDraft | null>(null);

export const settingsFormDraft$ = computed((get) => {
  return get(internalSettingsFormDraft$);
});

export const patchSettingsForm$ = command(
  (
    { set },
    input: {
      readonly agentId: string;
      readonly patch: Partial<SettingsFormValues>;
    },
  ) => {
    set(internalSettingsFormDraft$, (draft) => {
      if (!draft || draft.agentId !== input.agentId) {
        return { agentId: input.agentId, patch: input.patch };
      }
      return { ...draft, patch: { ...draft.patch, ...input.patch } };
    });
  },
);

export const resetSettingsForm$ = command(({ set }) => {
  set(internalSettingsFormDraft$, null);
});

// ---------------------------------------------------------------------------
// Delete agent command
// ---------------------------------------------------------------------------

export interface AgentDeleteWorkflow {
  readonly id: string;
  readonly title: string;
}

export interface AgentDeleteSession {
  readonly id: string;
  readonly agentId: string;
  readonly owner: AbortSignal;
  readonly open: boolean;
  readonly choices: Record<string, string>;
  readonly workflows: readonly AgentDeleteWorkflow[];
}

const internalAgentDeleteSession$ = state<AgentDeleteSession | null>(null);
export const agentDeleteSession$ = computed((get) => {
  return get(internalAgentDeleteSession$);
});

/** Each confirmation owns its workflow choices until it is dismissed. */
export const setAgentDeleteDialogOpen$ = command(
  (
    { get, set },
    {
      agentId,
      workflows,
    }: {
      agentId: string;
      workflows: readonly AgentDeleteWorkflow[] | undefined;
    },
    open: boolean,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const previous = get(internalAgentDeleteSession$);
    const sameOwner =
      previous?.agentId === agentId && previous.owner === signal;
    if (!open) {
      if (sameOwner) {
        set(internalAgentDeleteSession$, {
          ...previous,
          open: false,
          choices: {},
        });
        return true;
      }
      return false;
    }
    if (sameOwner && previous.open) {
      return true;
    }
    if (previous?.owner !== signal) {
      signal.addEventListener(
        "abort",
        () => {
          if (get(internalAgentDeleteSession$)?.owner === signal) {
            set(internalAgentDeleteSession$, null);
          }
        },
        { once: true },
      );
    }
    set(internalAgentDeleteSession$, {
      id: crypto.randomUUID(),
      agentId,
      owner: signal,
      open: true,
      choices: {},
      workflows: workflows ?? (sameOwner ? previous.workflows : []),
    });
    return true;
  },
);

export const setAgentDeleteCopyChoices$ = command(
  (
    { get, set },
    sessionId: string,
    choices: Record<string, string>,
    workflows: readonly AgentDeleteWorkflow[],
  ) => {
    const session = get(internalAgentDeleteSession$);
    if (session?.id === sessionId && session.open) {
      set(internalAgentDeleteSession$, { ...session, choices, workflows });
    }
  },
);

/**
 * Copies the chosen workflows onto other agents, then deletes the agent and
 * returns to the agent list.
 */
export const deleteAgent$ = command(
  async (
    { get, set },
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    const session = get(internalAgentDeleteSession$);
    if (
      session?.id !== sessionId ||
      session.owner !== signal ||
      !session.open
    ) {
      return;
    }
    // Never start a rescue from an unavailable source-workflow list, and only
    // workflows belonging to this agent can be copied before deletion.
    const workflows = await get(currentAgentVisibleWorkflows$);
    signal.throwIfAborted();
    const rescues = Object.entries(session.choices).filter(
      ([workflowId, toAgentId]) => {
        return (
          toAgentId !== "__delete_with_agent__" &&
          workflows.some((workflow) => {
            return workflow.id === workflowId;
          })
        );
      },
    );
    for (const [workflowId, toAgentId] of rescues) {
      await set(copyWorkflow$, { workflowId, toAgentId }, signal);
      signal.throwIfAborted();
      const current = get(internalAgentDeleteSession$);
      if (current?.id !== sessionId) {
        return;
      }
      // Settle the updated workflow list before another copy or deletion.
      await get(currentAgentVisibleWorkflows$);
      signal.throwIfAborted();
    }
    const current = get(internalAgentDeleteSession$);
    if (current?.id !== sessionId) {
      return;
    }
    await set(deleteAgentAndReturnToList$, signal);
    signal.throwIfAborted();
    const completed = get(internalAgentDeleteSession$);
    if (completed?.id === sessionId) {
      set(internalAgentDeleteSession$, { ...completed, choices: {} });
    }
  },
);

// ---------------------------------------------------------------------------
// Destructive-action confirmation state
// ---------------------------------------------------------------------------

/** Whether the public → private confirmation dialog is open. */
const internalDemoteConfirmOpen$ = state<boolean>(false);
export const agentDemoteConfirmOpen$ = computed((get) => {
  return get(internalDemoteConfirmOpen$);
});
export const setAgentDemoteConfirmOpen$ = command(({ set }, open: boolean) => {
  set(internalDemoteConfirmOpen$, open);
});
