import type { ChatRecommendedFollowup } from "@okouai/api-contracts/contracts/chat-threads";

type RecommendedFollowupGenerationType = NonNullable<
  ChatRecommendedFollowup["generationType"]
>;

export const RECOMMENDED_FOLLOWUP_LIMIT = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeFollowupPrompt(raw: string): string | null {
  const text = raw
    .replace(/^\s*(?:[-*]|\d+[.)])\s+/, "")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .trim();
  if (text.length === 0) {
    return null;
  }
  return text;
}

function isRecommendedFollowupGenerationType(
  value: unknown,
): value is RecommendedFollowupGenerationType {
  return value === "image" || value === "presentation" || value === "website";
}

function isJsonSyntaxPromptFragment(prompt: string): boolean {
  let fieldStart = 0;
  let onlyJsonPunctuation = true;
  for (let index = 0; index < prompt.length; index += 1) {
    const char = prompt.charAt(index);
    if (
      char !== "[" &&
      char !== "]" &&
      char !== "{" &&
      char !== "}" &&
      char !== "," &&
      char.trim() !== ""
    ) {
      onlyJsonPunctuation = false;
      fieldStart = index;
      break;
    }
  }
  if (onlyJsonPunctuation) {
    return true;
  }

  return /^"?(?:prompt|kind|generationType)"\s*:/.test(
    prompt.slice(fieldStart),
  );
}

export function normalizeRecommendedFollowups(
  value: unknown,
): ChatRecommendedFollowup[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const followups: ChatRecommendedFollowup[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.prompt !== "string") {
      continue;
    }
    if (item.kind !== "talk" && item.kind !== "generate") {
      continue;
    }

    const prompt = sanitizeFollowupPrompt(item.prompt);
    if (
      prompt === null ||
      isJsonSyntaxPromptFragment(prompt) ||
      seen.has(prompt)
    ) {
      continue;
    }
    seen.add(prompt);

    followups.push({
      prompt,
      kind: item.kind,
      ...(item.kind === "generate" &&
      isRecommendedFollowupGenerationType(item.generationType)
        ? { generationType: item.generationType }
        : {}),
    });
    if (followups.length >= RECOMMENDED_FOLLOWUP_LIMIT) {
      break;
    }
  }

  return followups;
}
