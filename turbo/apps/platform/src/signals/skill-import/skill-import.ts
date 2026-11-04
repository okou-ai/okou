/** Session credentials and server-owned results have independent lifetimes. */
import { command, computed, state, type Command } from "ccstate";
import { skillImportSessionsContract } from "@okouai/api-contracts/client/skill-import";
import type { WorkflowImportSource } from "@okouai/api-contracts/contracts/workflows";
import { buildSkillImportPrompt } from "@okouai/core/skill-import-prompt";
import { accept } from "../../lib/accept.ts";
import { now } from "../../lib/time.ts";
import { defaultAgentId$ } from "../agent.ts";
import { apiClient$ } from "../api-client.ts";
import { writeToClipboard } from "../okou-page/clipboard.ts";
import { setAblyInvalidationLoop$ } from "../realtime.ts";
import { onRef, settle } from "../utils.ts";

export type SkillImportProvider = WorkflowImportSource;
const SESSION_MIN_REMAINING_MS = 5 * 60 * 1000;

interface SkillImportOptions {
  readonly provider: SkillImportProvider | null;
  readonly onPromptShown$?: Command<void, []>;
  readonly onPromptCopied$?: Command<void, []>;
}

/** Create once in the dialog/flow's identity-scoped owner, outside render. */
export function createSkillImportSignals(options: SkillImportOptions) {
  const sessionVersion$ = state(0);
  const resultsVersion$ = state(0);

  const session$ = computed(async (get) => {
    get(sessionVersion$);
    const provider = options.provider;
    const agentId = await get(defaultAgentId$);
    if (!agentId || !provider) {
      throw new Error(
        "Select an import tool in a workspace with a default agent",
      );
    }
    const result = await accept(
      get(apiClient$)(skillImportSessionsContract).create({
        body: { provider },
      }),
      [200],
    );
    return {
      id: result.body.sessionId,
      expiresAt: Date.parse(result.body.expiresAt),
      prompt: buildSkillImportPrompt({ ...result.body, provider }),
    };
  });

  const imported$ = computed(async (get) => {
    get(resultsVersion$);
    const session = await get(session$);
    const result = await accept(
      get(apiClient$)(skillImportSessionsContract).listSkills({
        params: { sessionId: session.id },
      }),
      [200],
    );
    return result.body;
  });

  const renewSession$ = command(({ set }) => {
    set(sessionVersion$, (version) => {
      return version + 1;
    });
  });
  const reloadImported$ = command(({ set }) => {
    set(resultsVersion$, (version) => {
      return version + 1;
    });
  });
  const copyPrompt$ = command(async ({ get, set }, signal: AbortSignal) => {
    const session = await get(session$);
    signal.throwIfAborted();
    const copied = await writeToClipboard(session.prompt);
    signal.throwIfAborted();
    if (copied && options.onPromptCopied$) {
      set(options.onPromptCopied$);
    }
    return copied;
  });
  const promptDisplayed$ = onRef(
    command(({ set }, _element: HTMLPreElement, signal: AbortSignal) => {
      signal.throwIfAborted();
      if (options.onPromptShown$) {
        set(options.onPromptShown$);
      }
    }),
  );
  const watch$ = command(async ({ get, set }, signal: AbortSignal) => {
    // Closing or navigating away aborts only this subscription. A copied
    // credential stays valid, and reopening resyncs the whole same-session list.
    set(reloadImported$);
    set(
      setAblyInvalidationLoop$,
      {
        scope: "user",
        topic: "skillImportChanged",
        invalidations: [reloadImported$],
        options: { runOnSubscribe: true },
      },
      signal,
    );
    // Views independently read session$ and own its loading/error UI.
    // eslint-disable-next-line ccstate/no-settle -- Legacy 20261029: existing settle only; do not add new usages.
    const session = await settle(get(session$), signal);
    if (
      session.ok &&
      session.value.expiresAt - now() <= SESSION_MIN_REMAINING_MS
    ) {
      set(renewSession$);
    }
  });
  // The dialog's mounted content owns this subscription. Ref cleanup also
  // handles identity/provider replacement, beyond explicit Close and Escape.
  const dialogRef$ = onRef(
    command(async ({ set }, _element: HTMLDivElement, signal: AbortSignal) => {
      await set(watch$, signal);
    }),
  );
  return {
    session$,
    imported$,
    reloadImported$,
    copyPrompt$,
    promptDisplayed$,
    watch$,
    dialogRef$,
  };
}

export type SkillImportSignals = ReturnType<typeof createSkillImportSignals>;
