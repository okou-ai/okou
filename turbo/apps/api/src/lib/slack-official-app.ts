export const OFFICIAL_SLACK_APP_NAME = "Okou";
export const OFFICIAL_SLACK_PRIMARY_COMMAND = "/okou";

export function officialSlackBotMention(botUserId: string): string {
  return `<@${botUserId}>`;
}
