interface AgentMentionTextSegment {
  readonly type: "text";
  readonly text: string;
}

interface AgentMentionSegment {
  readonly type: "mention";
  readonly agentId: string;
  readonly name: string;
}

type AgentMentionLineSegment = AgentMentionTextSegment | AgentMentionSegment;

// Matches `[name](/agents/<uuid>/chat)` where the name backslash-escapes
// `\`, `[` and `]`.
const AGENT_MENTION_PATTERN =
  /\[((?:\\[\\[\]]|[^[\]\\])+)\]\(\/agents\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/chat\)/g;

export function serializeAgentMention(agentId: string, name: string): string {
  const escapedName = name.replace(/[\\[\]]/g, String.raw`\$&`);
  return `[${escapedName}](/agents/${agentId}/chat)`;
}

export function splitAgentMentionSegments(
  line: string,
): readonly AgentMentionLineSegment[] {
  const segments: AgentMentionLineSegment[] = [];
  let lastIndex = 0;
  for (const match of line.matchAll(AGENT_MENTION_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      segments.push({ type: "text", text: line.slice(lastIndex, index) });
    }
    segments.push({
      type: "mention",
      agentId: match[2] ?? "",
      name: (match[1] ?? "").replace(/\\([\\[\]])/g, "$1"),
    });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < line.length) {
    segments.push({ type: "text", text: line.slice(lastIndex) });
  }
  return segments;
}
