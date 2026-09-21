import {
  CHAT_EVENT_CONTENT_TEXT_TYPES,
  CHAT_EVENT_USER_MESSAGE_TEXT_TYPES,
  chatEventCompatibilityRole,
  type ChatEventType,
} from "@okouai/api-contracts/contracts/chat-events";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  max,
  or,
  sql,
} from "drizzle-orm";

import { CONVERSATION_GUIDANCE } from "../../lib/conversation-guidance";
import type { Db } from "../external/db";
import { BEFORE_DISPATCH_CANCELLED_ERROR } from "./agent-run-create.service";
import type { ChatThreadSessionResolutionAction } from "./chat-session-continuity.service";
import { loadWebChatIncompleteContext } from "./chat-incomplete-context.service";
import { visibleChatEventCondition } from "./chat-event-shared.service";
import {
  chatEventTextCondition,
  chatEventTypeIn,
} from "./chat-event-type.service";
import {
  type ChatAgentRunSourceAnnotation,
  projectUserMessage,
  requiredUserMessageForEvent,
} from "./chat-user-message.service";
import {
  canonicalChatEventContent,
  canonicalChatEventUserMessage,
} from "./canonical-chat-event-read.service";

const RECENT_CHAT_RUN_LIMIT = 10;
const WEB_CHAT_PRIOR_MESSAGE_CHAR_CAP = 4000;

interface WebChatPriorRunEvent {
  readonly eventType: ChatEventType;
  readonly role: "user" | "assistant";
  readonly content: string | null;
  readonly userMessage: UserMessageDocument | null;
}

interface WebChatPriorRun {
  readonly runId: string;
  readonly status: string;
  readonly prompt: string;
  readonly events: readonly WebChatPriorRunEvent[];
}

export interface WebChatSessionPromptContext {
  readonly generationTemplatePrompt: string;
  readonly computerUseHostDisplayName: string | null;
  readonly triggerSource: "web" | "agent";
  readonly agentRunSource: ChatAgentRunSourceAnnotation | null;
  readonly integrationNote: string;
}

function buildWebChatPrompt(integrationNote: string): string {
  return [
    CONVERSATION_GUIDANCE,
    "# Current Integration\nYou are currently running inside: Web",
    "You are communicating with the user through the web chat UI.",
    integrationNote,
  ]
    .filter((part) => {
      return part.length > 0;
    })
    .join("\n\n");
}

/**
 * Coordinates for the thread this run belongs to. The prior-round transcript is
 * only replayed when the CLI session cannot carry it, so this block is what
 * lets a run reach the rest of the conversation on demand instead.
 */
function buildCurrentThreadContext(threadId: string): string {
  return [
    "# This Chat Thread",
    "",
    `- CHAT_THREAD_ID: ${threadId}`,
    "",
    "Reading this thread, each through OKOU_TOKEN:",
    `- \`okou chat messages --thread-id ${threadId} --output-dir threads\` synchronizes the raw snapshot and hot events into \`threads/${threadId}/\` (chat-event:read)`,
    `- \`rg -n '"seqId":<SEQ_ID>' threads/${threadId}/\` finds an event in the synchronized history`,
    '- `okou search "<query>" --source agent-session` prints both the Claude Code and Codex session-file locations so you can analyze those files directly',
  ].join("\n");
}

/**
 * Provenance for a run whose prompt references an agent run in another chat
 * thread. The source coordinates let the run inspect the originating context,
 * while the trigger source distinguishes a human Forward from agent delegation.
 *
 * These are facts about how the run was created, not instructions about what
 * to do with them. What the run needs from the source thread depends on the
 * message, so the commands are listed and the choice is left to the run.
 */
function buildAgentRunSourceContext(
  source: ChatAgentRunSourceAnnotation,
  triggerSource: "web" | "agent",
): string {
  const triggerDescription =
    triggerSource === "web"
      ? "The message this run was created for was sent by a person who forwarded selected content from an agent run in another chat thread."
      : "The message this run was created for was sent by an agent run in another chat thread. A person did not type it here.";
  const carriedContextDescription =
    triggerSource === "web"
      ? "The message text contains the forwarded selection and any feedback that person chose to add. The source run's own instructions, surrounding conversation, and other findings stayed in the source thread and are not included above."
      : "The message text is everything that run chose to carry across the thread boundary. Its own instructions, the conversation it came from, and whatever it already found stayed in the source thread and are not included above.";
  return [
    "# This Run's Trigger",
    "",
    triggerDescription,
    "",
    `- SOURCE_RUN_ID: ${source.runId}`,
    `- SOURCE_THREAD_ID: ${source.threadId}`,
    `- SOURCE_AGENT_ID: ${source.agentId}`,
    `- SOURCE_THREAD_TITLE: ${source.titleSnapshot}`,
    "",
    carriedContextDescription,
    "",
    "Reading the source, each through OKOU_TOKEN:",
    `- \`okou chat messages --thread-id ${source.threadId} --output-dir threads\` synchronizes the source thread's raw snapshot and hot events into \`threads/${source.threadId}/\`; use \`rg -n '"seqId":<SEQ_ID>' threads/${source.threadId}/\` to inspect an event (chat-event:read)`,
    `- \`okou chat get --thread-id ${source.threadId}\` prints its title, agent, and model (chat-thread:read)`,
    `- \`okou search "${source.runId}" --source agent-session\` prints both the Claude Code and Codex session-file locations so you can analyze those files directly`,
    "",
    `This run's output is appended to this thread, where the user reads it. Nothing carries it back to the source run. \`okou chat send --thread-id ${source.threadId}\` posts a new message into the source thread, which starts a run there.`,
  ].join("\n");
}

function buildComputerUseSystemPrompt(displayName: string): string {
  return [
    "# Computer Use",
    `Computer Use is enabled for this run on ${displayName}.`,
    "Use Okou CLI computer-use commands to inspect apps, read app state, and perform desktop actions.",
    "The computer may go offline while this run is active. If a command reports that the computer is unavailable or offline, ask the user to reconnect Okou Computer Use on that computer, then retry.",
  ].join("\n");
}

export function buildWebChatAppendSystemPrompt(args: {
  readonly threadId: string;
  readonly incompleteContext: string;
  readonly priorContext: string;
  readonly context: WebChatSessionPromptContext;
}): string {
  return [
    buildWebChatPrompt(args.context.integrationNote),
    buildCurrentThreadContext(args.threadId),
    args.context.agentRunSource
      ? buildAgentRunSourceContext(
          args.context.agentRunSource,
          args.context.triggerSource,
        )
      : "",
    args.priorContext,
    args.incompleteContext,
    args.context.generationTemplatePrompt,
    args.context.computerUseHostDisplayName
      ? buildComputerUseSystemPrompt(args.context.computerUseHostDisplayName)
      : "",
  ]
    .filter((part) => {
      return part.length > 0;
    })
    .join("\n\n");
}

function truncatePrior(value: string): string {
  if (value.length <= WEB_CHAT_PRIOR_MESSAGE_CHAR_CAP) {
    return value;
  }
  return `${value.slice(0, WEB_CHAT_PRIOR_MESSAGE_CHAR_CAP)}...[truncated]`;
}

function formatPriorRunEvent(event: WebChatPriorRunEvent): string {
  const roleLabel = event.role === "user" ? "User" : "Assistant";
  const userMessage = requiredUserMessageForEvent(
    event.eventType,
    event.userMessage,
  );
  if (userMessage) {
    const prompt = projectUserMessage(userMessage).agentPrompt;
    return `${roleLabel}: ${truncatePrior(prompt) || "[empty message]"}`;
  }
  return `${roleLabel}: ${
    event.content === null
      ? "[empty message]"
      : truncatePrior(event.content) || "[empty message]"
  }`;
}

function buildWebChatPriorRunsContext(
  runs: readonly WebChatPriorRun[],
): string {
  if (runs.length === 0) {
    return "";
  }
  const total = runs.length;
  const blocks = runs.map((run, index) => {
    const relativeIndex = index - total + 1;
    const renderedEvents = run.events.map((event) => {
      return formatPriorRunEvent(event);
    });
    const hasUserEvent = run.events.some((event) => {
      return event.role === "user";
    });
    const hasAssistantEvent = run.events.some((event) => {
      return event.role === "assistant";
    });
    if (!hasUserEvent) {
      renderedEvents.unshift(
        `User: ${truncatePrior(run.prompt) || "[empty message]"}`,
      );
    }
    if (!hasAssistantEvent) {
      renderedEvents.push("Assistant: [no stored assistant message]");
    }
    return [
      "---",
      "",
      `- RELATIVE_INDEX: ${relativeIndex}`,
      `- RUN_ID: ${run.runId}`,
      `- RUN_STATUS: ${run.status}`,
      `- AGENT_SESSION_COMMAND: okou search "${run.runId}" --source agent-session`,
      "",
      ...renderedEvents,
    ].join("\n");
  });
  return [
    "# Web Chat Run Context",
    "",
    "The runs below are from the same web chat thread. When responding:",
    "- Runs closer to RELATIVE_INDEX 0 are more recent -- prioritize them.",
    "- Use the AGENT_SESSION_COMMAND for a run if you need more detailed agent session context.",
    "",
    blocks.join("\n\n"),
    "",
    "---",
  ].join("\n");
}

/**
 * Sequence id of each run's final assistant message. A single agentic run can
 * emit dozens of intermediate assistant messages, and replaying its narration
 * tells the next run nothing the final answer does not already say.
 */
function lastRunMessageSeqIds(
  db: Pick<Db, "select">,
  threadId: string,
  runIds: readonly string[],
) {
  return db
    .select({ seqId: max(chatEvents.seqId) })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.chatThreadId, threadId),
        chatEventTypeIn(CHAT_EVENT_CONTENT_TEXT_TYPES),
        isNotNull(canonicalChatEventContent()),
        inArray(chatEvents.runId, [...runIds]),
        visibleChatEventCondition(db),
      ),
    )
    .groupBy(chatEvents.runId);
}

async function getLatestRunsByThreadId(
  db: Db,
  threadId: string,
): Promise<WebChatPriorRun[]> {
  const runRows = await db
    .select({
      runId: agentRuns.id,
      status: agentRuns.status,
      prompt: agentRuns.prompt,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.chatThreadId, threadId),
        isNotNull(agentRuns.triggerSource),
        or(
          sql`${agentRuns.status} IS DISTINCT FROM ${"cancelled"}`,
          sql`${agentRuns.error} IS DISTINCT FROM ${BEFORE_DISPATCH_CANCELLED_ERROR}`,
        ),
      ),
    )
    .orderBy(desc(agentRuns.createdAt))
    .limit(RECENT_CHAT_RUN_LIMIT);

  const orderedRuns = runRows.reverse();
  const runIds = orderedRuns.map((run) => {
    return run.runId;
  });
  if (runIds.length === 0) {
    return [];
  }

  const eventRows = await db
    .select({
      runId: chatEvents.runId,
      eventType: chatEvents.eventType,
      content: canonicalChatEventContent(),
      userMessage: canonicalChatEventUserMessage(),
    })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.chatThreadId, threadId),
        chatEventTextCondition(),
        inArray(chatEvents.runId, runIds),
        visibleChatEventCondition(db),
        or(
          chatEventTypeIn(CHAT_EVENT_USER_MESSAGE_TEXT_TYPES),
          inArray(chatEvents.seqId, lastRunMessageSeqIds(db, threadId, runIds)),
        ),
      ),
    )
    .orderBy(asc(chatEvents.seqId));

  const eventsByRunId = new Map<string, WebChatPriorRunEvent[]>();
  for (const row of eventRows) {
    if (row.runId === null) {
      continue;
    }
    const existing = eventsByRunId.get(row.runId) ?? [];
    existing.push({
      eventType: row.eventType,
      role: chatEventCompatibilityRole(row.eventType),
      content: row.content,
      userMessage: row.userMessage,
    });
    eventsByRunId.set(row.runId, existing);
  }

  return orderedRuns.map((run) => {
    return {
      runId: run.runId,
      status: run.status,
      prompt: run.prompt,
      events: eventsByRunId.get(run.runId) ?? [],
    };
  });
}

/**
 * A rotated session starts the CLI conversation over, so the prior rounds have
 * to be replayed in the prompt. Every other action keeps the session the runner
 * resumes, which already carries them; replaying them there only duplicates the
 * conversation. Rounds whose run never completed are absent from the session
 * either way, so they keep their own block.
 */
export async function resolveWebChatSessionPrompt(args: {
  readonly db: Db;
  readonly threadId: string;
  readonly sessionAction: ChatThreadSessionResolutionAction;
  readonly context: WebChatSessionPromptContext;
}): Promise<string> {
  const rotated = args.sessionAction === "rotated";
  const incompleteContext = rotated
    ? ""
    : await loadWebChatIncompleteContext(args.db, args.threadId);
  const priorContext = rotated
    ? buildWebChatPriorRunsContext(
        await getLatestRunsByThreadId(args.db, args.threadId),
      )
    : "";
  return buildWebChatAppendSystemPrompt({
    threadId: args.threadId,
    incompleteContext,
    priorContext,
    context: args.context,
  });
}
