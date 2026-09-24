import { PUBLIC_BRAND_PRESENTATION } from "@okouai/core/public-brand";
import { sendAgentPhoneMessage } from "../external/agentphone-client";

const AGENTPHONE_CONTACT_CARD_URL =
  "https://static.vm0.io/agentphone-contact/a0a9471cbcf783bd04620f1be71dd8efaf0f49c6a23eb77e3cb4584e731fd685/okou.vcf";

interface AgentPhoneConnectedMessage {
  readonly body: string;
  readonly mediaUrls?: readonly string[];
}

export function agentPhoneConnectedMessages(): readonly AgentPhoneConnectedMessage[] {
  const { brandName } = PUBLIC_BRAND_PRESENTATION;
  return [
    {
      body: `Your phone number is now connected to ${brandName}.

You can text this number like a teammate and it will actually do the work: research something, draft and send emails, summarize long documents, update a spreadsheet, file or triage tickets, post to Slack, dig through your GitHub or Notion, and a lot more.`,
    },
    {
      body: `Save ${brandName} to your contacts so you can find this chat anytime.`,
      mediaUrls: [AGENTPHONE_CONTACT_CARD_URL],
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

export async function sendAgentPhoneConnectedMessages(
  target: {
    readonly agentphoneAgentId: string;
    readonly toNumber: string;
    readonly replyToMessageId?: string;
  },
  signal: AbortSignal,
): Promise<void> {
  // Send sequentially so the provider receives the messages in reading order;
  // only the first message threads onto the inbound connection code.
  for (const [index, message] of agentPhoneConnectedMessages().entries()) {
    await sendAgentPhoneMessage(
      {
        agentphoneAgentId: target.agentphoneAgentId,
        toNumber: target.toNumber,
        ...(index === 0 && target.replyToMessageId
          ? { replyToMessageId: target.replyToMessageId }
          : {}),
        body: message.body,
        ...(message.mediaUrls ? { mediaUrls: message.mediaUrls } : {}),
      },
      signal,
    );
    signal.throwIfAborted();
  }
}
