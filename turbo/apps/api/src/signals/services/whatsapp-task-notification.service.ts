import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { webUrl } from "../../lib/web-url";
import {
  isAgentPhoneWhatsappWindowClosed,
  sendAgentPhoneMessage,
  type AgentPhoneSentMessage,
} from "../external/agentphone-client";
import { db$ } from "../external/db";
import { settle } from "../utils";

export interface WhatsappCompletedTask {
  readonly name: string;
  readonly resultUrl: string;
}

export const loadWhatsappCompletedTask$ = command(
  async (
    { get },
    args: {
      readonly runId: string;
      readonly userId: string;
      readonly orgId: string;
    },
    signal: AbortSignal,
  ): Promise<WhatsappCompletedTask | undefined> => {
    const [thread] = await get(db$)
      .select({ id: chatThreads.id, title: chatThreads.title })
      .from(agentRuns)
      .innerJoin(chatThreads, eq(chatThreads.id, agentRuns.chatThreadId))
      .where(
        and(
          eq(agentRuns.id, args.runId),
          eq(agentRuns.userId, args.userId),
          eq(agentRuns.orgId, args.orgId),
          eq(chatThreads.userId, args.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!thread) {
      return undefined;
    }
    return {
      name: (thread.title?.trim() || "Okou task").replace(/\s+/gu, " "),
      resultUrl: `${webUrl()}/chats/${thread.id}`,
    };
  },
);

export async function sendWhatsappTextWithTaskFallback(
  args: {
    readonly agentphoneAgentId: string;
    readonly toNumber: string;
    readonly replyToMessageId?: string;
    readonly body: string;
    readonly completedTask?: WhatsappCompletedTask;
  },
  signal: AbortSignal,
): Promise<{
  readonly message: AgentPhoneSentMessage;
  readonly body: string;
  readonly template: "okou_task_completed" | undefined;
}> {
  const sent = await settle(
    sendAgentPhoneMessage({ ...args, channel: "whatsapp" }, signal),
    signal,
  );
  if (sent.ok) {
    return { message: sent.value, body: args.body, template: undefined };
  }
  if (!args.completedTask || !isAgentPhoneWhatsappWindowClosed(sent.error)) {
    throw sent.error;
  }
  const { name, resultUrl } = args.completedTask;
  const template = "okou_task_completed" as const;
  const body = `Your requested Okou task "${name}" is complete. Open ${resultUrl} to view the result.`;
  // A template cannot quote the rejected message. This is a single notification,
  // not a retry of the answer or an attempt to reopen the free-form window.
  const message = await sendAgentPhoneMessage(
    {
      agentphoneAgentId: args.agentphoneAgentId,
      toNumber: args.toNumber,
      channel: "whatsapp",
      body,
      template: {
        name: template,
        language: "en_US",
        variables: [name, resultUrl],
      },
    },
    signal,
  );
  return { message, body, template };
}
