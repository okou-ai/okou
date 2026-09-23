/**
 * The source-first onboarding skills step, against the skill import service.
 *
 * A browser cannot read a skill directory, so nothing is uploaded from here.
 * The step opens an import session, renders the prompt that session produces,
 * and the user pastes it into their own Codex or Claude Code session; that
 * agent writes the skills back through the upload route.
 *
 * What the step can see of that work is the agent's own workflow list, so it
 * takes a baseline when the run reaches the step and polls for what appeared
 * after it. The baseline and the session both live as long as the flow draft —
 * one application start — so coming back through Back still shows the skills
 * this run imported, under the prompt the user was already given.
 */
import { command, computed, state } from "ccstate";
import { skillImportSessionsContract } from "@okouai/api-contracts/contracts/skill-import";
import {
  workflowsCollectionContract,
  type WorkflowSummary,
} from "@okouai/api-contracts/contracts/workflows";
import { buildSkillImportPrompt } from "@okouai/core/skill-import-prompt";
import { accept } from "../../lib/accept.ts";
import { ApiError } from "../../lib/api-error.ts";
import { now } from "../../lib/time.ts";
import { defaultAgentId$ } from "../agent.ts";
import { apiClient$ } from "../api-client.ts";
import {
  captureSourceOnboardingImportPromptShown$,
  captureSourceOnboardingPromptCopied$,
  captureSourceOnboardingSkillImported$,
} from "../bootstrap/source-onboarding-telemetry.ts";
import { writeToClipboard } from "../okou-page/clipboard.ts";
import { setLoop, settle } from "../utils.ts";
import {
  sourcesFirstDraft$,
  type SubscriptionProvider,
} from "./onboarding-sources-first-state.ts";

/** How often the step asks what the user's agent has written so far. */
const POLL_INTERVAL_MS = 4000;
/** The same poll, paced so a test can watch a skill arrive without waiting. */
const POLL_TEST_INTERVAL_MS = 100;

/**
 * A session the step hands out has to outlive the paste that follows it, so
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
  /** Skills written to the agent since this run reached the step. */
  readonly imported: readonly WorkflowSummary[];
}

interface SkillImportSession {
  readonly agentId: string;
  readonly provider: SubscriptionProvider;
  readonly prompt: string;
  readonly expiresAt: number;
}

const internalSession$ = state<SkillImportSession | null>(null);
const internalCopied$ = state(false);
const internalFailed$ = state(false);
/** Workflow IDs the agent already had, so only later ones read as imported. */
const internalBaseline$ = state<ReadonlySet<string> | null>(null);
const internalImported$ = state<readonly WorkflowSummary[]>([]);

export const sourcesFirstSkillImport$ = computed((get): SkillImportState => {
  const session = get(internalSession$);
  const provider = get(sourcesFirstDraft$).provider;
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

/**
 * Only a private workflow the agent did not have on entry belongs to this
 * import: that is what the upload route creates, and a public workflow
 * published meanwhile is not a skill this user brought.
 */
function importedSkills(
  workflows: readonly WorkflowSummary[],
  baseline: ReadonlySet<string>,
): readonly WorkflowSummary[] {
  const arrived = workflows.filter((workflow) => {
    return workflow.visibility === "private" && !baseline.has(workflow.id);
  });
  // Arrival order, so a skill keeps its place as the next ones land under it.
  return arrived.sort((left, right) => {
    return left.createdAt.localeCompare(right.createdAt);
  });
}

const recordImportedSkills$ = command(
  ({ get, set }, workflows: readonly WorkflowSummary[]): void => {
    const baseline = get(internalBaseline$);
    if (!baseline) {
      return;
    }
    const next = importedSkills(workflows, baseline);
    const known = new Set(
      get(internalImported$).map((workflow) => {
        return workflow.id;
      }),
    );
    set(internalImported$, next);
    // One event per skill, reported as how many the step had after it
    // arrived. A skill's name is something the user wrote, so the funnel
    // counts them instead of naming them. The list is in arrival order, so a
    // new skill's position is that count.
    for (const [index, workflow] of next.entries()) {
      if (!known.has(workflow.id)) {
        set(captureSourceOnboardingSkillImported$, index + 1);
      }
    }
  },
);

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

const openSkillImportSession$ = command(
  async (
    { get, set },
    agentId: string,
    provider: SubscriptionProvider,
    signal: AbortSignal,
  ): Promise<void> => {
    // A session that can no longer be handed out is dropped first, so a failed
    // replacement cannot leave the step showing a prompt it would refuse. The
    // copy belonged to that session, not to this one.
    set(internalSession$, null);
    set(internalCopied$, false);
    const client = get(apiClient$)(skillImportSessionsContract);
    const result = await accept(
      client.create({ fetchOptions: { signal } }),
      [200],
      signal,
    );
    signal.throwIfAborted();
    set(internalSession$, {
      agentId,
      provider,
      prompt: buildSkillImportPrompt({
        uploadUrl: result.body.uploadUrl,
        token: result.body.token,
        limits: result.body.limits,
        provider,
      }),
      expiresAt: Date.parse(result.body.expiresAt),
    });
  },
);

function sessionUsable(
  session: SkillImportSession | null,
  agentId: string,
  provider: SubscriptionProvider,
): session is SkillImportSession {
  return (
    session !== null &&
    session.agentId === agentId &&
    session.provider === provider &&
    session.expiresAt - now() > SESSION_MIN_REMAINING_MS
  );
}

const prepareSkillImport$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<string> => {
    const agentId = await get(defaultAgentId$);
    signal.throwIfAborted();
    if (agentId === null) {
      throw new Error("This workspace has no default agent to import into");
    }
    const provider = get(sourcesFirstDraft$).provider;
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
      await set(openSkillImportSession$, agentId, provider, signal);
    }
    return agentId;
  },
);

/**
 * Prepares the step: the baseline the imported list is read against, the
 * session the prompt is built from, and the poll that keeps the list current.
 *
 * Nothing here can hold the flow back. A failure leaves the step offering its
 * own retry while Continue and Skip keep working.
 */
export const enterSkillImport$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    set(internalFailed$, false);
    const prepared = await settle(set(prepareSkillImport$, signal), signal);
    if (!prepared.ok) {
      set(internalFailed$, true);
      return;
    }
    const agentId = prepared.value;
    set(captureSourceOnboardingImportPromptShown$);
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
        // The prompt is what the step is for, and it stays whatever the list
        // does: a refused read only costs the arrivals showing up on their
        // own. A server or network failure is worth another round; an answer
        // that will not change is not.
        shouldRetryError: isRetryablePollError,
        testIntervalMs: POLL_TEST_INTERVAL_MS,
      },
    );
  },
);

function isRetryablePollError(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status >= 500;
}

/**
 * Copies the prompt the step is showing. The prompt carries this session's
 * token, so it goes to the clipboard and nowhere else: the funnel records that
 * a copy happened, never what was copied.
 */
export const copySkillImportPrompt$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
    const session = get(internalSession$);
    const prompt =
      session?.provider === get(sourcesFirstDraft$).provider
        ? session?.prompt
        : undefined;
    if (prompt === undefined) {
      return false;
    }
    const copied = await writeToClipboard(prompt);
    signal.throwIfAborted();
    if (copied) {
      set(internalCopied$, true);
      set(captureSourceOnboardingPromptCopied$);
    }
    return copied;
  },
);
