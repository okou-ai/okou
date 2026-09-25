/**
 * Importing a user's local skills against the skill import service.
 *
 * A browser cannot read a skill directory, so nothing is uploaded from here.
 * An import opens a session, renders the prompt that session produces, and the
 * user pastes it into their own Codex or Claude Code session; that agent
 * writes the skills back through the upload route.
 *
 * What the browser can see of that work is the agent's own workflow list, so
 * an import takes a baseline when it is first entered and polls for what
 * appeared after it. The baseline and the session live as long as the signals
 * built here, so coming back to an import still shows the skills it brought in,
 * under the prompt the user was already given.
 *
 * The onboarding skills step and the workflows page's import dialog each build
 * their own set: they differ in where the tool comes from and in what they
 * report, not in how an import runs.
 */
import { command, computed, state, type Command, type Computed } from "ccstate";
import { skillImportSessionsContract } from "@okouai/api-contracts/contracts/skill-import";
import {
  workflowsCollectionContract,
  type WorkflowImportSource,
  type WorkflowSummary,
} from "@okouai/api-contracts/contracts/workflows";
import { buildSkillImportPrompt } from "@okouai/core/skill-import-prompt";
import { accept } from "../../lib/accept.ts";
import { ApiError } from "../../lib/api-error.ts";
import { now } from "../../lib/time.ts";
import { defaultAgentId$ } from "../agent.ts";
import { apiClient$ } from "../api-client.ts";
import { writeToClipboard } from "../okou-page/clipboard.ts";
import { setLoop, settle } from "../utils.ts";

/** The tool a prompt is written for, and that its imports are tagged with. */
export type SkillImportProvider = WorkflowImportSource;

/** How often an import asks what the user's agent has written so far. */
const POLL_INTERVAL_MS = 4000;
/** The same poll, paced so a test can watch a skill arrive without waiting. */
const POLL_TEST_INTERVAL_MS = 100;

/**
 * A session an import hands out has to outlive the paste that follows it, so
 * one close to its expiry is replaced rather than shown again.
 */
const SESSION_MIN_REMAINING_MS = 5 * 60 * 1000;

type SkillImportStatus = "preparing" | "ready" | "failed";

export interface SkillImportState {
  readonly status: SkillImportStatus;
  /** The prompt to paste, once the session that carries it is open. */
  readonly prompt: string | null;
  /** Whether this session's prompt has been copied from this browser. */
  readonly copied: boolean;
  /** Skills written to the agent since this import was first entered. */
  readonly imported: readonly WorkflowSummary[];
}

export interface SkillImportSignals {
  readonly state$: Computed<SkillImportState>;
  /**
   * Prepares the import: the baseline the imported list is read against, the
   * session the prompt is built from, and the poll that keeps the list
   * current while the given signal lives. A failure is reported through
   * `state$`, never thrown, so it cannot hold back whatever surrounds it.
   */
  readonly enter$: Command<Promise<void>, [AbortSignal]>;
  /**
   * Copies the prompt being shown. The prompt carries the session's token,
   * so it goes to the clipboard and nowhere else.
   */
  readonly copyPrompt$: Command<Promise<boolean>, [AbortSignal]>;
}

interface SkillImportOptions {
  /** The tool to write the prompt for; null while none is chosen. */
  readonly provider$: Computed<SkillImportProvider | null>;
  /**
   * Count only workflows the import tagged with a source. Without it, any
   * private workflow that appears after the baseline reads as imported.
   */
  readonly requireImportSource?: boolean;
  readonly onPromptShown$?: Command<void, []>;
  readonly onPromptCopied$?: Command<void, []>;
  /** Called once per new skill with how many the import had after it. */
  readonly onSkillImported$?: Command<void, [number]>;
}

interface SkillImportSession {
  readonly agentId: string;
  readonly provider: SkillImportProvider;
  readonly prompt: string;
  readonly expiresAt: number;
}

/**
 * Only a private workflow the agent did not have on entry belongs to an
 * import: that is what the upload route creates, and a public workflow
 * published meanwhile is not a skill this user brought.
 */
function importedSkills(
  workflows: readonly WorkflowSummary[],
  baseline: ReadonlySet<string>,
  requireImportSource: boolean,
): readonly WorkflowSummary[] {
  const arrived = workflows.filter((workflow) => {
    return (
      workflow.visibility === "private" &&
      !baseline.has(workflow.id) &&
      (!requireImportSource || Boolean(workflow.importSource))
    );
  });
  // Arrival order, so a skill keeps its place as the next ones land under it.
  return arrived.sort((left, right) => {
    return left.createdAt.localeCompare(right.createdAt);
  });
}

const listAgentWorkflows$ = command(
  async (
    { get },
    agentId: string,
    signal: AbortSignal,
  ): Promise<readonly WorkflowSummary[]> => {
    const client = get(apiClient$)(workflowsCollectionContract);
    const result = await accept(
      client.list({ query: { agentId }, fetchOptions: { signal } }),
      [200],
      signal,
      // The list is polled, so a failed round is retried by the loop rather
      // than announced again on every attempt.
      { showErrorToast: false },
    );
    return result.body;
  },
);

const createSkillImportSession$ = command(
  async (
    { get },
    agentId: string,
    provider: SkillImportProvider,
    signal: AbortSignal,
  ): Promise<SkillImportSession> => {
    const client = get(apiClient$)(skillImportSessionsContract);
    const result = await accept(
      client.create({ body: { provider }, fetchOptions: { signal } }),
      [200],
      signal,
    );
    return {
      agentId,
      provider,
      prompt: buildSkillImportPrompt({
        uploadUrl: result.body.uploadUrl,
        token: result.body.token,
        limits: result.body.limits,
        provider,
      }),
      expiresAt: Date.parse(result.body.expiresAt),
    };
  },
);

function sessionUsable(
  session: SkillImportSession | null,
  agentId: string,
  provider: SkillImportProvider,
): session is SkillImportSession {
  return (
    session !== null &&
    session.agentId === agentId &&
    session.provider === provider &&
    session.expiresAt - now() > SESSION_MIN_REMAINING_MS
  );
}

function isRetryablePollError(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status >= 500;
}

/** What arrived after the baseline, and the funnel's count of each arrival. */
function createImportedSkills(
  requireImportSource: boolean,
  onSkillImported$: Command<void, [number]> | undefined,
) {
  /** Workflow IDs the agent already had, so only later ones read as imported. */
  const internalBaseline$ = state<ReadonlySet<string> | null>(null);
  const internalImported$ = state<readonly WorkflowSummary[]>([]);

  const recordImportedSkills$ = command(
    ({ get, set }, workflows: readonly WorkflowSummary[]): void => {
      const baseline = get(internalBaseline$);
      if (!baseline) {
        return;
      }
      const next = importedSkills(workflows, baseline, requireImportSource);
      const known = new Set(
        get(internalImported$).map((workflow) => {
          return workflow.id;
        }),
      );
      set(internalImported$, next);
      if (!onSkillImported$) {
        return;
      }
      // The list is in arrival order, so a new skill's position is how many
      // the import had once it arrived.
      for (const [index, workflow] of next.entries()) {
        if (!known.has(workflow.id)) {
          set(onSkillImported$, index + 1);
        }
      }
    },
  );

  return { internalBaseline$, internalImported$, recordImportedSkills$ };
}

export function createSkillImportSignals(
  options: SkillImportOptions,
): SkillImportSignals {
  const { provider$, onPromptShown$, onPromptCopied$ } = options;
  const { internalBaseline$, internalImported$, recordImportedSkills$ } =
    createImportedSkills(
      options.requireImportSource ?? false,
      options.onSkillImported$,
    );

  const internalSession$ = state<SkillImportSession | null>(null);
  const internalCopied$ = state(false);
  const internalFailed$ = state(false);

  const state$ = computed((get): SkillImportState => {
    const session = get(internalSession$);
    const provider = get(provider$);
    const imported = get(internalImported$);
    const copied = get(internalCopied$);
    if (session && session.provider === provider) {
      return { status: "ready", prompt: session.prompt, copied, imported };
    }
    return {
      status: get(internalFailed$) ? "failed" : "preparing",
      prompt: null,
      copied,
      imported,
    };
  });

  const openSession$ = command(
    async (
      { set },
      agentId: string,
      provider: SkillImportProvider,
      signal: AbortSignal,
    ): Promise<void> => {
      // A session that can no longer be handed out is dropped first, so a
      // failed replacement cannot leave the import showing a prompt it would
      // refuse. The copy belonged to that session, not to this one.
      set(internalSession$, null);
      set(internalCopied$, false);
      const session = await set(
        createSkillImportSession$,
        agentId,
        provider,
        signal,
      );
      signal.throwIfAborted();
      set(internalSession$, session);
    },
  );

  const prepare$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<string> => {
      const agentId = await get(defaultAgentId$);
      signal.throwIfAborted();
      if (agentId === null) {
        throw new Error("This workspace has no default agent to import into");
      }
      const provider = get(provider$);
      if (provider === null) {
        throw new Error("Select Codex or Claude Code before importing skills");
      }
      if (get(internalBaseline$) === null) {
        const existing = await set(listAgentWorkflows$, agentId, signal);
        signal.throwIfAborted();
        set(
          internalBaseline$,
          new Set(
            existing.map((workflow) => {
              return workflow.id;
            }),
          ),
        );
      }
      if (!sessionUsable(get(internalSession$), agentId, provider)) {
        await set(openSession$, agentId, provider, signal);
      }
      return agentId;
    },
  );

  const enter$ = command(
    async ({ set }, signal: AbortSignal): Promise<void> => {
      set(internalFailed$, false);
      const prepared = await settle(set(prepare$, signal), signal);
      if (!prepared.ok) {
        set(internalFailed$, true);
        return;
      }
      const agentId = prepared.value;
      if (onPromptShown$) {
        set(onPromptShown$);
      }
      setLoop(
        async (loopSignal) => {
          const workflows = await set(listAgentWorkflows$, agentId, loopSignal);
          loopSignal.throwIfAborted();
          set(recordImportedSkills$, workflows);
          return false;
        },
        POLL_INTERVAL_MS,
        signal,
        {
          // The prompt is what the import is for, and it stays whatever the
          // list does: a refused read only costs the arrivals showing up on
          // their own. A server or network failure is worth another round; an
          // answer that will not change is not.
          shouldRetryError: isRetryablePollError,
          testIntervalMs: POLL_TEST_INTERVAL_MS,
        },
      );
    },
  );

  const copyPrompt$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
      const session = get(internalSession$);
      const prompt =
        session?.provider === get(provider$) ? session?.prompt : undefined;
      if (prompt === undefined) {
        return false;
      }
      const copied = await writeToClipboard(prompt);
      signal.throwIfAborted();
      if (copied) {
        set(internalCopied$, true);
        if (onPromptCopied$) {
          set(onPromptCopied$);
        }
      }
      return copied;
    },
  );

  return { state$, enter$, copyPrompt$ };
}
