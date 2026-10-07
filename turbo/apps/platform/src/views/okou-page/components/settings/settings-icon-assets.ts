import { platformStaticAssetUrl } from "../../../../lib/static-assets.ts";

const SETTINGS_ICON_ASSET_PATHS = {
  anthropic:
    "views/zero-page/components/settings/icons/anthropic-3fcfdf761a69.svg",
  chatglm: "views/zero-page/components/settings/icons/chatglm-7e6a9cb772fa.svg",
  "claude-code":
    "views/zero-page/components/settings/icons/claude-code-03a5132e24ca.svg",
  github: "views/zero-page/components/settings/icons/github-4a739019d805.svg",
  imessage:
    "views/zero-page/components/settings/icons/imessage-5275a5a9cb9a.svg",
  kimi: "views/zero-page/components/settings/icons/kimi-bd6d8b8d5390.svg",
  lark: "views/zero-page/components/settings/icons/lark-f5fdfb27067a.svg",
  "local-agent":
    "views/zero-page/components/settings/icons/local-agent-57c613146fc9.svg",
  "local-browser":
    "views/zero-page/components/settings/icons/local-browser-9a71e5c6fee7.svg",
  minimax: "views/zero-page/components/settings/icons/minimax-ec3b12fc26ff.svg",
  openai: "views/zero-page/components/settings/icons/openai-df8a3d9c4274.svg",
  openrouter:
    "views/zero-page/components/settings/icons/openrouter-82e9dead836b.svg",
  slack:
    "views/zero-page/components/settings/icons/slack-198390069136.svg?v=568fa471",
  teams: "views/zero-page/components/settings/icons/teams-0dc3a5275d31.svg",
  telegram:
    "views/zero-page/components/settings/icons/telegram-2d9ff5d01146.svg",
} as const;

type SettingsIconAssetKey = keyof typeof SETTINGS_ICON_ASSET_PATHS;

export function settingsIconAssetUrl(key: SettingsIconAssetKey): string {
  return platformStaticAssetUrl(SETTINGS_ICON_ASSET_PATHS[key]);
}
