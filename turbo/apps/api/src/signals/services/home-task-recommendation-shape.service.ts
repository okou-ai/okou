import {
  HOME_TASK_RECOMMENDATION_LIMIT,
  homeTaskRecommendationSchema,
  type HomeTaskRecommendation,
  type HomeTaskRecommendationTarget,
} from "@okouai/api-contracts/contracts/home-task-recommendations";

import type { HomeTaskEvidence } from "./home-task-recommendation-evidence.service";

/** A bounded, evidence-anchored unit for Jev to judge before any text model. */
export interface HomeTaskCandidateDraft {
  readonly id: string;
  readonly intent: string;
  readonly reason: string;
  readonly purpose: HomeTaskRecommendation["purpose"];
  readonly examples: readonly string[];
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

function patternTokens(value: string): ReadonlySet<string> {
  const tokens = new Set<string>();
  for (const match of value
    .toLowerCase()
    .matchAll(/[\p{Script=Han}]+|[\p{L}\p{N}]+/gu)) {
    const word = match[0];
    if (/^[\p{Script=Han}]+$/u.test(word)) {
      for (let index = 0; index < word.length - 1; index += 1) {
        tokens.add(word.slice(index, index + 2));
      }
    } else if (
      !/^(?:a|an|and|for|in|my|of|on|please|the|to|with|you)$/u.test(word) &&
      !/^\d+$/u.test(word)
    ) {
      tokens.add(word);
    }
  }
  return tokens;
}

function similarRequests(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  const shared = [...left].filter((token) => {
    return right.has(token);
  }).length;
  const union = left.size + right.size - shared;
  return shared >= 3 && union > 0 && shared / union >= 0.55;
}

function workflowCandidates(evidence: HomeTaskEvidence) {
  const groups: {
    readonly tokens: ReadonlySet<string>;
    readonly requests: { readonly threadRef: string; readonly text: string }[];
  }[] = [];
  for (const request of evidence.completedRequests) {
    const tokens = patternTokens(request.text);
    if (tokens.size < 3) {
      continue;
    }
    const group = groups.find((item) => {
      return similarRequests(item.tokens, tokens);
    });
    if (group) {
      group.requests.push(request);
    } else {
      groups.push({ tokens, requests: [request] });
    }
  }
  return groups
    .filter((group) => {
      return group.requests.length >= 3;
    })
    .sort((left, right) => {
      return right.requests.length - left.requests.length;
    })
    .slice(0, 2)
    .map((group) => {
      return {
        intent:
          "Ask this Agent to assess whether the repeated completed work should become a reusable Workflow.",
        reason: `This Agent completed ${group.requests.length.toString()} similar requests.`,
        purpose: "workflow" as const,
        examples: group.requests.slice(0, 3).map((request) => {
          return request.text;
        }),
        sourceRefs: [
          ...new Set(
            group.requests.map((request) => {
              return request.threadRef;
            }),
          ),
        ].slice(0, 4),
        threadRef: null,
        target: { kind: "new-thread" } as const,
        connectors: [],
      };
    });
}

/** Form source units deterministically; Jev decides which are real tasks. */
export function buildHomeTaskCandidates(
  evidence: HomeTaskEvidence,
  limit: number,
): HomeTaskCandidateDraft[] {
  const recurring = workflowCandidates(evidence);
  const threads = evidence.threads
    .flatMap((thread) => {
      const latestRequest = thread.messages.find((message) => {
        return message.role === "user";
      });
      const threadId = evidence.threadIdByRef.get(thread.ref);
      if (!latestRequest || !threadId) {
        return [];
      }
      const latestAnswer = thread.messages.find((message) => {
        return message.role === "assistant";
      });
      return [
        {
          intent: `Consider the next useful step for this user request: ${latestRequest.text}`,
          reason: latestAnswer?.text ?? thread.title ?? "Recent conversation",
          purpose: "task" as const,
          examples: [],
          sourceRefs: [thread.ref],
          threadRef: thread.ref,
          target: { kind: "existing-thread" as const, threadId },
          connectors: [],
          activityAt: thread.lastActivityAt,
        },
      ];
    })
    .slice(0, 5);
  const gmail = evidence.gmail.slice(0, 3).map((message) => {
    return {
      intent: `Consider the next useful step for this email from ${message.from}: ${message.subject}. ${message.snippet}`,
      reason: message.unread ? "Unread inbox message" : "Recent inbox message",
      purpose: "task" as const,
      examples: [],
      sourceRefs: [message.ref],
      threadRef: null,
      target: { kind: "new-thread" } as const,
      connectors: ["gmail"],
      activityAt: message.receivedAt ?? "",
    };
  });
  const tasks = [...threads, ...gmail]
    .sort((left, right) => {
      return right.activityAt.localeCompare(left.activityAt);
    })
    .slice(0, Math.max(0, limit - recurring.length));
  return [...tasks, ...recurring].slice(0, limit).map((candidate, index) => {
    return { ...candidate, id: `c${(index + 1).toString()}` };
  });
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
    const writerPrompt = boundedText(
      item.prompt,
      candidate.purpose === "workflow" ? 600 : 1000,
    );
    const prompt =
      candidate.purpose === "workflow" && writerPrompt !== null
        ? `${writerPrompt}\n\n${candidate.examples
            .slice(0, 3)
            .map((example, index) => {
              return `${(index + 1).toString()}. ${example.slice(0, 120)}`;
            })
            .join("\n")}`
        : writerPrompt;
    const parsed = homeTaskRecommendationSchema.safeParse({
      id: `r${(recommendations.length + 1).toString()}`,
      title: boundedText(item.title, 120),
      prompt,
      rationale: boundedText(item.rationale, 200) ?? "",
      actionability: candidate.actionability,
      purpose: candidate.purpose,
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
