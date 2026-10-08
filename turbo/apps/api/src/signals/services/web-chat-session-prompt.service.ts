import { CONVERSATION_GUIDANCE } from "../../lib/conversation-guidance";
import type { ChatAgentRunSourceAnnotation } from "./chat-user-message.service";

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
