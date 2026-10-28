import {
  array,
  iso,
  literal,
  object,
  string,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";
import {
  suggestionFeedbackSchema,
  suggestionFeedbackScopeSchema,
  type SuggestionFeedback,
} from "./suggestions";

export const SUGGESTION_MEMORY_PATH = "suggestions/feedback-memory.json";
export const SUGGESTION_MEMORY_MAX_BYTES = 65_536;
const DAY = 86_400_000;
const evidenceSchema = object({
  id: uuid(),
  suggestionId: uuid(),
  kind: zEnum([
    "already_done",
    "not_planned",
    "less_like_this",
    "option_selected",
    "custom_sent",
  ]),
  observedAt: iso.datetime(),
  expiresAt: iso.datetime(),
  note: string().max(512),
  optionLabel: string().max(80).nullable(),
}).refine((evidence) => {
  return (
    Date.parse(evidence.expiresAt) ===
    Date.parse(evidence.observedAt) +
      (evidence.kind === "less_like_this" ? 30 : 7) * DAY
  );
}, "Feedback memory must expire 7 or 30 days after the actual user feedback");
const recordSchema = object({
  id: string().max(128),
  title: string().max(120),
  rationale: string().max(200),
  scope: suggestionFeedbackScopeSchema,
  evidence: array(evidenceSchema).min(1).max(5),
});
export const suggestionMemorySchema = object({
  schemaVersion: literal(1),
  records: array(recordSchema).max(100),
  processedFeedback: array(
    object({ suggestionId: uuid(), feedbackId: uuid() }),
  ).max(100),
}).refine((document) => {
  return (
    new TextEncoder().encode(JSON.stringify(document)).length <=
    SUGGESTION_MEMORY_MAX_BYTES
  );
}, "Suggestion feedback memory exceeds 64 KiB");
export type SuggestionMemory = zInfer<typeof suggestionMemorySchema>;
export const suggestionLearningInputSchema = object({
  suggestionId: uuid(),
  feedbacks: array(suggestionFeedbackSchema).max(100),
});
export type SuggestionLearningInput = zInfer<
  typeof suggestionLearningInputSchema
>;

export function emptySuggestionMemory(): SuggestionMemory {
  return { schemaVersion: 1, records: [], processedFeedback: [] };
}

/** Expiration applies on every read, even before a later writer removes bytes. */
export function currentSuggestionMemory(
  memory: SuggestionMemory,
  at: number,
): SuggestionMemory {
  return {
    ...memory,
    records: memory.records.flatMap((record) => {
      const evidence = record.evidence.filter((item) => {
        return Date.parse(item.expiresAt) > at;
      });
      return evidence.length ? [{ ...record, evidence }] : [];
    }),
  };
}

/** A bounded, deterministic fold: model rereads never count as fresh evidence. */
export function learnSuggestionFeedback(
  previous: SuggestionMemory,
  inputs: readonly SuggestionLearningInput[],
  at: number,
): SuggestionMemory {
  const memory = currentSuggestionMemory(previous, at);
  const records = new Map(
    memory.records.map((record) => {
      return [record.id, record];
    }),
  );
  const processedFeedback: SuggestionMemory["processedFeedback"] = [];
  const events = inputs
    .flatMap((input) => {
      return input.feedbacks.map((feedback) => {
        return { suggestionId: input.suggestionId, feedback };
      });
    })
    .sort((a, b) => {
      return a.feedback.createdAt.localeCompare(b.feedback.createdAt);
    })
    .slice(0, 100);
  for (const { suggestionId, feedback } of events) {
    processedFeedback.push({ suggestionId, feedbackId: feedback.id });
    if (feedback.kind === "undo" || feedback.kind === "reason") {
      for (const [key, record] of records) {
        const evidence = record.evidence.flatMap((item) => {
          if (
            item.id !== feedback.targetId ||
            item.suggestionId !== suggestionId
          )
            return [item];
          return feedback.kind === "undo"
            ? []
            : [{ ...item, note: feedback.note }];
        });
        if (evidence.length) records.set(key, { ...record, evidence });
        else records.delete(key);
      }
      continue;
    }
    if (feedback.kind === "dismissed") continue;
    const kind = feedback.kind;
    const expiresAt = new Date(
      Date.parse(feedback.createdAt) +
        (kind === "less_like_this" ? 30 : 7) * DAY,
    ).toISOString();
    if (Date.parse(expiresAt) <= at) continue;
    const key =
      kind === "less_like_this"
        ? `preference:${feedback.context.scope.key}`
        : `${kind === "option_selected" || kind === "custom_sent" ? "direction" : "action"}:${suggestionId}`;
    const existing = records.get(key);
    const evidence = [
      ...(existing?.evidence ?? []).filter((item) => {
        return item.id !== feedback.id || item.suggestionId !== suggestionId;
      }),
      {
        id: feedback.id,
        suggestionId,
        kind,
        observedAt: feedback.createdAt,
        expiresAt,
        note: feedback.note,
        optionLabel: feedback.context.optionLabel,
      },
    ]
      .sort((a, b) => {
        return (
          b.observedAt.localeCompare(a.observedAt) || b.id.localeCompare(a.id)
        );
      })
      .slice(0, 5);
    records.set(key, {
      id: key,
      title: feedback.context.title,
      rationale: feedback.context.rationale,
      scope: feedback.context.scope,
      evidence,
    });
  }
  const result: SuggestionMemory = {
    schemaVersion: 1,
    records: [...records.values()]
      .sort((a, b) => {
        return (
          b.evidence
            .reduce((latest, item) => {
              return item.observedAt > latest ? item.observedAt : latest;
            }, "")
            .localeCompare(
              a.evidence.reduce((latest, item) => {
                return item.observedAt > latest ? item.observedAt : latest;
              }, ""),
            ) || a.id.localeCompare(b.id)
        );
      })
      .slice(0, 100),
    processedFeedback,
  };
  while (
    new TextEncoder().encode(JSON.stringify(result)).length >
    SUGGESTION_MEMORY_MAX_BYTES
  )
    result.records.pop();
  return suggestionMemorySchema.parse(result);
}

/** Return at most one bounded batch without hiding later unprocessed feedback. */
export function pendingSuggestionFeedback(
  entries: readonly {
    readonly id: string;
    readonly feedbacks: readonly SuggestionFeedback[];
  }[],
): SuggestionLearningInput[] {
  const events = entries
    .flatMap((item) => {
      return item.feedbacks
        .filter((feedback) => {
          return feedback.learnedAt === null;
        })
        .map((feedback) => {
          return { suggestionId: item.id, feedback };
        });
    })
    .sort((a, b) => {
      return a.feedback.createdAt.localeCompare(b.feedback.createdAt);
    })
    .slice(0, 100);
  return events.map((event) => {
    return { suggestionId: event.suggestionId, feedbacks: [event.feedback] };
  });
}
