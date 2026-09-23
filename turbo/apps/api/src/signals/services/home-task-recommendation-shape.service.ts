import {
  HOME_TASK_RECOMMENDATION_LIMIT,
  homeTaskRecommendationSchema,
  type HomeTaskRecommendation,
  type HomeTaskRecommendationTarget,
} from "@okouai/api-contracts/contracts/home-task-recommendations";

import type { HomeTaskEvidence } from "./home-task-recommendation-evidence.service";

/** Untrusted candidate extraction after every evidence reference is resolved. */
export interface HomeTaskCandidateDraft {
  readonly id: string;
  readonly intent: string;
  readonly reason: string;
  readonly sourceRefs: readonly string[];
  /** Opaque evidence ref for Jev's destination check; never persisted. */
  readonly threadRef: string | null;
  readonly target: HomeTaskRecommendationTarget;
  readonly connectors: readonly string[];
}

/** Candidate whose score and confidence came only from Jev. */
export interface HomeTaskCandidate extends HomeTaskCandidateDraft {
  readonly actionability: number;
  readonly confidence: number;
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

function candidateSourceRefs(
  value: unknown,
  validRefs: ReadonlySet<string>,
): string[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const refs: string[] = [];
  for (const item of value) {
    const ref = boundedText(item, 16);
    if (ref === null || !validRefs.has(ref)) {
      return null;
    }
    if (!refs.includes(ref)) {
      refs.push(ref);
    }
    if (refs.length >= 4) {
      break;
    }
  }
  return refs.length === 0 ? null : refs;
}

/**
 * Candidate extraction is allowed to name only evidence refs it received.
 * Existing-thread destinations are resolved locally, so no model ever emits a
 * thread id and no invented destination can survive normalization.
 */
export function normalizeHomeTaskCandidateDrafts(
  value: unknown,
  evidence: HomeTaskEvidence,
  limit: number,
): HomeTaskCandidateDraft[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const validRefs = new Set([
    ...evidence.threads.map((thread) => {
      return thread.ref;
    }),
    ...evidence.gmail.map((message) => {
      return message.ref;
    }),
  ]);
  const candidates: HomeTaskCandidateDraft[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const intent = boundedText(item.intent, 300);
    const sourceRefs = candidateSourceRefs(item.sourceRefs, validRefs);
    if (intent === null || sourceRefs === null) {
      continue;
    }
    const threadRef =
      item.threadRef === null ? null : boundedText(item.threadRef, 16);
    if (
      item.threadRef !== null &&
      (threadRef === null || !sourceRefs.includes(threadRef))
    ) {
      continue;
    }
    const threadId =
      threadRef === null ? undefined : evidence.threadIdByRef.get(threadRef);
    if (threadRef !== null && threadId === undefined) {
      continue;
    }
    candidates.push({
      id: `c${(candidates.length + 1).toString()}`,
      intent,
      reason: boundedText(item.reason, 200) ?? "",
      sourceRefs,
      threadRef,
      target:
        threadId === undefined
          ? { kind: "new-thread" }
          : { kind: "existing-thread", threadId },
      connectors: sourceRefs.some((ref) => {
        return ref.startsWith("g");
      })
        ? ["gmail"]
        : [],
    });
    if (candidates.length >= limit) {
      break;
    }
  }
  return candidates;
}

/**
 * Normalize untrusted prose-writer output while preserving every accepted
 * candidate field owned by evidence resolution plus Jev.
 */
export function normalizeHomeTaskRecommendations(
  value: unknown,
  candidates: readonly HomeTaskCandidate[],
): HomeTaskRecommendation[] {
  if (!Array.isArray(value)) {
    return [];
  }

  // A prose model may omit, duplicate, invent, or reorder output items. Bind
  // copy back to the accepted intent by its opaque candidate id, then emit in
  // Jev's ranking order. Array position is not authority over a destination.
  const itemsByCandidateId = new Map<string, Record<string, unknown>>();
  const candidateIds = new Set(
    candidates.map((candidate) => {
      return candidate.id;
    }),
  );
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const candidateId = boundedText(item.candidateId, 64);
    if (
      candidateId !== null &&
      candidateIds.has(candidateId) &&
      !itemsByCandidateId.has(candidateId)
    ) {
      itemsByCandidateId.set(candidateId, item);
    }
  }

  const recommendations: HomeTaskRecommendation[] = [];
  for (const candidate of candidates) {
    const item = itemsByCandidateId.get(candidate.id);
    if (item === undefined) {
      continue;
    }
    const parsed = homeTaskRecommendationSchema.safeParse({
      id: `r${(recommendations.length + 1).toString()}`,
      title: boundedText(item.title, 120),
      prompt: boundedText(item.prompt, 1000),
      rationale: boundedText(item.rationale, 200) ?? "",
      actionability: candidate.actionability,
      target: candidate.target,
      connectors: [...candidate.connectors],
    });
    if (parsed.success) {
      recommendations.push(parsed.data);
    }
    if (recommendations.length >= HOME_TASK_RECOMMENDATION_LIMIT) {
      break;
    }
  }
  return recommendations;
}
