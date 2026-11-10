import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { OFFICIAL_TELEGRAM_BOT_ID } from "@okouai/api-contracts/validators/integrations-telegram";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { slackOrgData$ } from "../okou-page/slack.ts";
import { teamsOrgData$ } from "../okou-page/teams.ts";
import { discordOrgData$ } from "../okou-page/discord.ts";
import { githubIntegrationData$ } from "../okou-page/github.ts";
import { telegramBots$ } from "../okou-page/telegram.ts";
import { agentPhoneLinkStatus$ } from "../okou-page/agentphone.ts";
import { emailLinkStatus$ } from "../okou-page/email.ts";
import { whatsappLinkStatus$ } from "../okou-page/whatsapp.ts";
import { wechatStatus$ } from "../okou-page/wechat.ts";

export type WorksChannel =
  | "slack"
  | "teams"
  | "discord"
  | "github"
  | "feishu"
  | "lark"
  | "telegram"
  | "phone"
  | "email"
  | "whatsapp"
  | "wechat";

const WORKS_CHANNEL_ORDER: readonly WorksChannel[] = [
  "slack",
  "teams",
  "discord",
  "github",
  "feishu",
  "lark",
  "telegram",
  "phone",
  "email",
  "whatsapp",
  "wechat",
];

function channelFeatureSwitch(
  channel: WorksChannel,
): FeatureSwitchKey | undefined {
  switch (channel) {
    case "feishu": {
      return FeatureSwitchKey.FeishuIntegration;
    }
    case "lark": {
      return FeatureSwitchKey.LarkIntegration;
    }
    case "email": {
      return FeatureSwitchKey.EmailIntegration;
    }
    case "whatsapp": {
      return FeatureSwitchKey.WhatsappIntegration;
    }
    case "wechat": {
      return FeatureSwitchKey.WechatIntegration;
    }
    default: {
      return undefined;
    }
  }
}

export const worksChannels$ = computed((get) => {
  const features = get(featureSwitch$);
  return WORKS_CHANNEL_ORDER.filter((channel) => {
    const key = channelFeatureSwitch(channel);
    return key === undefined || (features[key] ?? false);
  });
});

// Placement is taken once per page visit, so a card does not jump between
// sections while the user connects or disconnects it on the page. A revisit
// keeps the previous placement until the refreshed statuses arrive.
const internalConnectedChannels$ = state<readonly WorksChannel[] | null>(null);

export const worksConnectedChannels$ = computed((get) => {
  return get(internalConnectedChannels$);
});

export const settleWorksChannelPlacement$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const checks: Record<WorksChannel, (() => Promise<boolean>) | null> = {
      slack: async () => {
        return (await get(slackOrgData$)).isConnected;
      },
      teams: async () => {
        return (await get(teamsOrgData$)).isConnected;
      },
      discord: async () => {
        return (await get(discordOrgData$)).isConnected;
      },
      github: async () => {
        return (await get(githubIntegrationData$)).isConnected;
      },
      // Feishu and Lark open their settings page; the card has no connection.
      feishu: null,
      lark: null,
      telegram: async () => {
        const bots = await get(telegramBots$);
        return bots.some((bot) => {
          return bot.id === OFFICIAL_TELEGRAM_BOT_ID && bot.isConnected;
        });
      },
      phone: async () => {
        return (await get(agentPhoneLinkStatus$)).linked;
      },
      email: async () => {
        return (await get(emailLinkStatus$)).emails.length > 0;
      },
      whatsapp: async () => {
        return (await get(whatsappLinkStatus$)).linked;
      },
      wechat: async () => {
        return (await get(wechatStatus$))?.status === "active";
      },
    };
    const channels = get(worksChannels$);
    // A failed status lookup leaves the channel with the unconnected ones,
    // where its own card reports the failure.
    const results = await Promise.allSettled(
      channels.map((channel) => {
        return checks[channel]?.() ?? Promise.resolve(false);
      }),
    );
    signal.throwIfAborted();
    set(
      internalConnectedChannels$,
      channels.filter((_, index) => {
        const result = results[index];
        return result?.status === "fulfilled" && result.value;
      }),
    );
  },
);
