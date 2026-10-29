import { command, computed, state } from "ccstate";
import { agentInstructionsContract } from "@okouai/api-contracts/contracts/agents";
import { apiClient$ } from "../../api-client.ts";
import { accept } from "../../../lib/accept.ts";
import type { AgentInstructions } from "../agent-types.ts";
import { agentDetail$, reloadAgentDetail$ } from "./detail.ts";

// ---------------------------------------------------------------------------
// Agent instructions — reactive async computed
// ---------------------------------------------------------------------------

const internalInstructionsReload$ = state(0);

const reloadAgentInstructions$ = command(({ set }) => {
  set(internalInstructionsReload$, (prev) => {
    return prev + 1;
  });
});

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

const editedContent$ = state<string | null>(null);
const editorRevision$ = state(0);

export const agentEditedContent$ = computed((get) => {
  return get(editedContent$);
});

export const agentInstructionsEditorRevision$ = computed((get) => {
  return get(editorRevision$);
});

export const agentInstructionsDirty$ = computed(async (get) => {
  const edited = get(editedContent$);
  const instructions = await get(agentInstructions$);
  const savedBody = instructions?.content ?? "";
  return edited !== null && edited.trim() !== savedBody.trim();
});

export const setAgentEditedContent$ = command(({ set }, value: string) => {
  set(editedContent$, value);
});

export const discardAgentEdit$ = command(({ set }) => {
  set(editedContent$, null);
  set(editorRevision$, (previous) => {
    return previous + 1;
  });
});

export const buildAgentInstructions$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const detail = await get(agentDetail$);
    signal.throwIfAborted();
    const raw = get(editedContent$);
    if (!detail?.agentId || raw === null) {
      return;
    }
    const edited = raw.trim();

    const client = get(apiClient$)(agentInstructionsContract);
    await accept(
      client.update({
        params: { id: detail.agentId },
        body: { content: edited },
      }),
      [200],
    );
    signal.throwIfAborted();

    set(editedContent$, null);
    set(reloadAgentInstructions$);
    set(reloadAgentDetail$);
  },
);
