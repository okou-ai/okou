/** Public App destinations; each provider owns its query and authorization state. */
export const INTEGRATION_SETTINGS_PATHS = {
  slack: "/settings/slack",
  discord: "/settings/discord",
  teams: "/settings/teams",
  telegram: "/settings/telegram",
  wechat: "/settings/wechat",
} as const;
