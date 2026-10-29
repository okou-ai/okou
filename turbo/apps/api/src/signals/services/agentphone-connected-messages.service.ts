import { BRAND_PRESENTATION } from "@okouai/core/brand-presentation";
import { command } from "ccstate";
import { optionalEnv } from "../../lib/env";
import { sendAgentPhoneMessage } from "../external/agentphone-client";
import { prepareAgentPhoneContactCard$ } from "./agentphone-contact-card.service";
import {
  agentPhoneChannelForLinkedHandle,
  storeOutboundAgentPhoneMessage$,
  type AgentPhoneChannel,
} from "./agentphone-shared.service";

interface AgentPhoneConnectedMessage {
  readonly body: string;
}

function agentPhoneConnectedMessages(
  channel: AgentPhoneChannel,
): readonly AgentPhoneConnectedMessage[] {
  const { brandName } = BRAND_PRESENTATION;
  return [
    {
      body: `Your ${channel === "whatsapp" ? "WhatsApp account" : "phone number"} is now connected to ${brandName}.

You can text this number like a teammate and it will actually do the work: research something, draft and send emails, summarize long documents, update a spreadsheet, file or triage tickets, post to Slack, dig through your GitHub or Notion, and a lot more.`,
    },
    {
      body: "It is most useful once you connect the tools you already use. The ones people hook up most often are GitHub, Gmail, Notion, Google Drive / Sheets / Docs / Calendar, Slack, Sentry, and X. There are 100+ more available, and you can connect any of them whenever you need.",
    },
    {
      body: `A few things to try right now:
- "Summarize my unread Gmail from today"
- "What's on my Google Calendar tomorrow?"
- "List the open issues in my GitHub repo"
- "Find my meeting notes in Notion"
- "Catch me up on my unread Slack messages"
- "Triage my latest Sentry error and open a GitHub PR to fix it"
- "What's trending on X about [topic]?"

No tool connected yet? Just ask me anything and I'll still help, then point you to whatever I need access to.

What would you like to start with?`,
    },
  ];
}

export const sendAgentPhoneConnectedMessages$ = command(
  async (
    { set },
    target: {
      readonly userLinkId: string;
      readonly agentphoneAgentId: string;
      readonly toNumber: string;
      readonly replyToMessageId?: string;
      readonly channel?: AgentPhoneChannel;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const channel =
      target.channel ?? agentPhoneChannelForLinkedHandle(target.toNumber);
    // Send sequentially so the provider receives the messages in reading order;
    // only the first message threads onto the inbound connection code.
    for (const [index, message] of agentPhoneConnectedMessages(
      channel,
    ).entries()) {
      const sent = await sendAgentPhoneMessage(
        {
          agentphoneAgentId: target.agentphoneAgentId,
          ...(channel === "whatsapp" ? { channel: "whatsapp" as const } : {}),
          toNumber: target.toNumber,
          ...(index === 0 && target.replyToMessageId
            ? { replyToMessageId: target.replyToMessageId }
            : {}),
          body: message.body,
        },
        signal,
      );
      if (channel === "whatsapp") {
        await set(storeOutboundAgentPhoneMessage$, {
          agentphoneMessageId: sent.id,
          conversationId: null,
          agentphoneAgentId: target.agentphoneAgentId,
          userLinkId: target.userLinkId,
          phoneHandle: target.toNumber,
          fromNumber:
            sent.fromNumber ?? optionalEnv("AGENTPHONE_PHONE_NUMBER") ?? "",
          toNumber: sent.toNumber,
          body: message.body,
          channel: sent.channel ?? channel,
          userChannel: channel,
          visibilityRecipients: [],
        });
      }
      signal.throwIfAborted();
    }
    if (channel !== "whatsapp") {
      await set(prepareAgentPhoneContactCard$, target.userLinkId, signal);
    }
  },
);
