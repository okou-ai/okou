const OFFICIAL_TEAMS_BOT_NAME = "Okou";

export function teamsBotDisplayName(
  botName: string | null | undefined,
): string {
  const normalized = botName?.trim();
  return normalized && normalized.length > 0
    ? normalized
    : OFFICIAL_TEAMS_BOT_NAME;
}
