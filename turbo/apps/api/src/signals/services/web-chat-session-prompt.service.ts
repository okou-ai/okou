import { buildCurrentThreadContext } from "./chat-thread-prompt";
import { CONVERSATION_GUIDANCE } from "../../lib/conversation-guidance";
import type {
  ChatAgentRunSourceAnnotation,
  UserMessageReferences,
} from "./chat-user-message.service";

export interface WebChatSessionPromptContext {
  readonly singleAgent: boolean;
  readonly projectContext: string;
  readonly generationTemplatePrompt: string;
  readonly computerUseHostDisplayName: string | null;
  readonly triggerSource: "web" | "agent";
  readonly agentRunSource: ChatAgentRunSourceAnnotation | null;
  readonly references: UserMessageReferences;
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
 * Agents and chat threads the user linked in the current message. The links
 * only carry IDs, so this states that delegated work does not report back and
 * points at the event-driven alternative to polling for its result.
 */
function buildReferencesContext(
  references: UserMessageReferences,
  singleAgent: boolean,
): string {
  if (references.agents.length === 0 && references.chatThreads.length === 0) {
    return "";
  }
  return [
    singleAgent
      ? "# Referenced conversations"
      : "# Referenced Agents and Threads",
    "",
    "The current message links:",
    ...references.agents.map((agent) => {
      return singleAgent
        ? `- Retained configuration reference ${JSON.stringify(agent.nameSnapshot)}: ${agent.agentId}. This reference does not select an executor or authorize shared configuration changes.`
        : `- Agent ${JSON.stringify(agent.nameSnapshot)}: AGENT_ID=${agent.agentId}`;
    }),
    ...references.chatThreads.map((thread) => {
      return `- Chat thread ${JSON.stringify(thread.titleSnapshot)}: CHAT_THREAD_ID=${thread.threadId}`;
    }),
    "",
    singleAgent
      ? "Work sent to another chat with `okou chat send` runs independently and does not report back here. Use an authorized chat-run-finished Workflow automation when completion notifications are needed."
      : "Work sent to another agent or thread with `okou chat send` runs on its own and does not report back to this run. If you need its result, consider a `chat-run-finished` automation on that thread instead of polling. Automations of a workflow created from this chat run here when the watched run finishes.",
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
  singleAgent: boolean,
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
    `- \`okou chat messages --thread-id ${source.threadId} --output-dir /tmp/okou-chat-history\` synchronizes the source thread's raw snapshot and hot events into \`/tmp/okou-chat-history/${source.threadId}/\`; use \`rg -n '"seqId":<SEQ_ID>' /tmp/okou-chat-history/${source.threadId}/\` to inspect an event (chat-event:read)`,
    `- \`okou chat get --thread-id ${source.threadId}\` prints its title, ${singleAgent ? "" : "agent, and "}model (chat-thread:read)`,
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
    args.context.projectContext,
    buildReferencesContext(args.context.references, args.context.singleAgent),
    args.context.agentRunSource
      ? buildAgentRunSourceContext(
          args.context.agentRunSource,
          args.context.triggerSource,
          args.context.singleAgent,
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
