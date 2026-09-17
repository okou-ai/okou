import type { FeishuPlatform } from "@okouai/api-contracts/contracts/feishu-platform";
import { FeatureSwitchKey } from "./feature-switch-key";

export type { FeishuPlatform } from "@okouai/api-contracts/contracts/feishu-platform";

/** Feishu and Lark share a protocol, but never an application identity. */
export const FEISHU_PLATFORMS = {
  feishu: {
    name: "Feishu",
    apiOrigin: "https://open.feishu.cn",
    developerConsoleUrl:
      "https://open.feishu.cn/page/launcher?from=backend_oneclick",
    accountsOrigin: "https://accounts.feishu.cn",
    appLinkOrigin: "https://applink.feishu.cn",
    settingsPath: "/settings/feishu",
    callbackPath: "/connectors/feishu/callback",
    featureSwitch: FeatureSwitchKey.FeishuIntegration,
  },
  lark: {
    name: "Lark",
    apiOrigin: "https://open.larksuite.com",
    developerConsoleUrl: "https://open.larksuite.com/app",
    accountsOrigin: "https://accounts.larksuite.com",
    appLinkOrigin: "https://applink.larksuite.com",
    settingsPath: "/settings/lark",
    callbackPath: "/integrations/lark/callback",
    featureSwitch: FeatureSwitchKey.LarkIntegration,
  },
} as const;

export function feishuPlatformFromTokenUrl(tokenUrl: string): FeishuPlatform {
  if (
    tokenUrl ===
    `${FEISHU_PLATFORMS.lark.apiOrigin}/open-apis/authen/v2/oauth/token`
  ) {
    return "lark";
  }
  if (
    tokenUrl ===
    `${FEISHU_PLATFORMS.feishu.apiOrigin}/open-apis/authen/v2/oauth/token`
  ) {
    return "feishu";
  }
  throw new Error("Unsupported Feishu/Lark OAuth token URL");
}
