import {
  HOME_TASK_RECOMMENDATION_LIMIT,
  homeTaskRecommendationSchema,
  type HomeTaskRecommendation,
} from "@okouai/api-contracts/contracts/home-task-recommendations";

/**
 * Model output is untrusted text that happens to be shaped like JSON.
 *
 * Nothing here repairs a bad answer: a field that does not already satisfy the
 * published contract drops its item. The home page showing fewer cards is
 * always preferable to showing one the contract cannot describe, and the
 * persisted row is bounded by the same check the API response is.
 */

export interface HomeTaskCandidate {
  readonly intent: string;
  readonly reason: string;
  readonly actionability: number;
  readonly connectors: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, cap: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length === 0) {
    return null;
  }
  return text.length <= cap ? text : text.slice(0, cap);
}

function boundedScore(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.min(100, Math.max(0, Math.trunc(value)));
}

function connectorSlugs(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const slugs: string[] = [];
  for (const item of value) {
    const slug = boundedText(item, 64);
    if (slug !== null && !slugs.includes(slug)) {
      slugs.push(slug);
    }
    if (slugs.length >= 4) {
      break;
    }
  }
  return slugs;
}

/** Ranked intents from the ranking model, ordered by descending actionability. */
export function normalizeHomeTaskCandidates(
  value: unknown,
  limit: number,
): HomeTaskCandidate[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const candidates: HomeTaskCandidate[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const intent = boundedText(item.intent, 300);
    const actionability = boundedScore(item.actionability);
    if (intent === null || actionability === null) {
      continue;
    }
    candidates.push({
      intent,
      reason: boundedText(item.reason, 200) ?? "",
      actionability,
      connectors: connectorSlugs(item.connectors),
    });
    if (candidates.length >= limit) {
      break;
    }
  }
  return candidates.sort((left, right) => {
    return right.actionability - left.actionability;
  });
}

/**
 * Cards from the writer model, or the cards read back from the cache row.
 *
 * `candidates` is supplied when the writer produced these cards: the score and
 * the connector list stay owned by the ranking stage, so the writer cannot
 * raise its own card's actionability or claim a connector the member has not
 * connected. Reading a persisted row passes no candidates and the row's own
 * validated values are kept.
 */
export function normalizeHomeTaskRecommendations(
  value: unknown,
  candidates?: readonly HomeTaskCandidate[],
): HomeTaskRecommendation[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const recommendations: HomeTaskRecommendation[] = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      continue;
    }
    const candidate = candidates?.[index];
    if (candidates !== undefined && candidate === undefined) {
      // The writer returned more cards than it was given intents for. The extra
      // ones have no ranked evidence behind them and are dropped.
      break;
    }
    const parsed = homeTaskRecommendationSchema.safeParse({
      id: candidate === undefined ? item.id : `r${(index + 1).toString()}`,
      title: boundedText(item.title, 120),
      prompt: boundedText(item.prompt, 1000),
      rationale: boundedText(item.rationale, 200) ?? "",
      actionability:
        candidate === undefined
          ? boundedScore(item.actionability)
          : candidate.actionability,
      connectors:
        candidate === undefined
          ? connectorSlugs(item.connectors)
          : [...candidate.connectors],
    });
    if (!parsed.success) {
      continue;
    }
    recommendations.push(parsed.data);
    if (recommendations.length >= HOME_TASK_RECOMMENDATION_LIMIT) {
      break;
    }
  }
  return recommendations;
}
