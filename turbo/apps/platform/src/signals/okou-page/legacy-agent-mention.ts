// Matches `[name](/agents/<uuid>/chat)` where the name backslash-escapes
// `\`, `[` and `]`.
const AGENT_MENTION_PATTERN =
  /\[((?:\\[\\[\]]|[^[\]\\])+)\]\(\/agents\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/chat\)/g;

export function legacyAgentMentionsToText(value: string): string {
  return value.replace(AGENT_MENTION_PATTERN, (_, name: string) => {
    return name.replace(/\\([\\[\]])/g, "$1");
  });
}
