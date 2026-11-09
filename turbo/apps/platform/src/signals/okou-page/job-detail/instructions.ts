import { command, computed, state } from "ccstate";
import { agentInstructionsContract } from "@okouai/api-contracts/client/agents";
import { apiClient$ } from "../../api-client.ts";
import { accept } from "../../../lib/accept.ts";
import type { AgentInstructions } from "../agent-types.ts";
import { agentDetail$, reloadAgentDetail$ } from "./detail.ts";
import { watchInstructionsUpdates$ } from "../../instructions-updates.ts";

// ---------------------------------------------------------------------------
// Agent instructions — reactive async computed
// ---------------------------------------------------------------------------

const internalInstructionsReload$ = state(0);

const reloadAgentInstructions$ = command(({ set }) => {
  set(internalInstructionsReload$, (prev) => {
    return prev + 1;
  });
});

export const watchAgentInstructions$ = command(
  ({ set }, signal: AbortSignal) => {
    set(reloadAgentInstructions$);
    set(
      watchInstructionsUpdates$,
      {
        scope: "org",
        topic: "agentInstructionsChanged",
        reload$: reloadAgentInstructions$,
      },
      signal,
    );
  },
);

export const agentInstructions$ = computed(
  async (get): Promise<AgentInstructions | null> => {
    get(internalInstructionsReload$);
    const detail = await get(agentDetail$);
    if (!detail) {
      return null;
    }
    const client = get(apiClient$)(agentInstructionsContract);
    const result = await accept(
      client.get({ params: { id: detail.agentId } }),
      [200],
    );
    return result.body;
  },
);

// ---------------------------------------------------------------------------
// Instructions editing
// ---------------------------------------------------------------------------

const draft$ = state<{ content: string; savedContent: string } | null>(null);
const editorRevision$ = state(0);
const saveConflict$ = state(false);

export const agentInstructionsDraft$ = computed((get) => {
  return get(draft$);
});

export const agentInstructionsEditorRevision$ = computed((get) => {
  return get(editorRevision$);
});

export const agentInstructionsConflict$ = computed(async (get) => {
  const draft = get(draft$);
  if (!draft) {
    return false;
  }
  if (get(saveConflict$)) {
    return true;
  }
  const instructions = await get(agentInstructions$);
  return draft.savedContent !== (instructions?.content ?? "");
});

export const setAgentEditedContent$ = command(
  ({ get, set }, content: string, savedContent: string) => {
    const baseline = get(draft$)?.savedContent ?? savedContent;
    if (content.trim() === baseline.trim()) {
      set(draft$, null);
      set(saveConflict$, false);
      return;
    }
    set(draft$, { content, savedContent: baseline });
  },
);

export const discardAgentEdit$ = command(({ set }) => {
  set(draft$, null);
  set(saveConflict$, false);
  set(editorRevision$, (previous) => {
    return previous + 1;
  });
});

export const reloadLatestAgentInstructions$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(reloadAgentInstructions$);
    await get(agentInstructions$);
    signal.throwIfAborted();
    set(discardAgentEdit$);
  },
);

export const buildAgentInstructions$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const detail = await get(agentDetail$);
    signal.throwIfAborted();
    const draft = get(draft$);
    if (!detail?.agentId || !draft) {
      return false;
    }

    const client = get(apiClient$)(agentInstructionsContract);
    const response = await accept(
      client.update({
        params: { id: detail.agentId },
        body: { content: draft.content.trim(), ifContent: draft.savedContent },
        fetchOptions: { signal },
      }),
      [200, 409],
    );
    signal.throwIfAborted();
    if (response.status === 409) {
      set(saveConflict$, true);
      return false;
    }

    set(reloadAgentInstructions$);
    set(reloadAgentDetail$);
    await get(agentInstructions$);
    signal.throwIfAborted();
    set(discardAgentEdit$);
    return true;
  },
);
