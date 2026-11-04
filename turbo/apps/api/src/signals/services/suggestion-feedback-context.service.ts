import { array } from "zod";
import { computed, type Computed } from "ccstate";
import type { PickedThreadInputEvent } from "./thread-run-prompt/types";
import { and, asc, eq, gt } from "drizzle-orm";
import { agentSuggestions } from "@okouai/db/schema/agent-suggestion";
import {
  suggestionFeedbackSchema,
  type SuggestionFeedback,
} from "@okouai/api-contracts/contracts/suggestions";
import { nowDate } from "../../lib/time";
import { db$ } from "../external/db";
import { retainedSuggestionFeedback } from "./agent-suggestions-lifecycle";

const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const MAX_CONTEXT_BYTES = 65_536;
const DAY = 86_400_000;

type FeedbackEvidence = {
  readonly id: string;
  readonly suggestionId: string;
  readonly kind: Exclude<
    SuggestionFeedback["kind"],
    "undo" | "reason" | "dismissed"
  >;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly note: string;
  readonly optionLabel: string | null;
};
type FeedbackRecord = {
  readonly id: string;
  readonly title: string;
  readonly rationale: string;
  readonly scope: SuggestionFeedback["context"]["scope"];
  readonly evidence: readonly FeedbackEvidence[];
};

function effectiveCardFeedback(
  feedbacks: readonly SuggestionFeedback[],
  at: number,
) {
  const effective = new Map<string, SuggestionFeedback>();
  // The append-only array orders revisions, including equal-timestamp events.
  for (const feedback of feedbacks) {
    if (Date.parse(feedback.createdAt) > at) {
      continue;
    }
    if (feedback.kind === "undo") {
      if (feedback.targetId !== null) {
        effective.delete(feedback.targetId);
      }
    } else if (feedback.kind === "reason") {
      const target = effective.get(feedback.targetId ?? "");
      if (target) {
        effective.set(target.id, { ...target, note: feedback.note });
      }
    } else if (feedback.kind !== "dismissed") {
      effective.set(feedback.id, feedback);
    }
  }
  return effective.values();
}

function mergeCardFeedback(
  records: Map<string, FeedbackRecord>,
  suggestionId: string,
  feedbacks: readonly SuggestionFeedback[],
  at: number,
) {
  for (const feedback of effectiveCardFeedback(feedbacks, at)) {
    const kind = feedback.kind;
    if (kind === "undo" || kind === "reason" || kind === "dismissed") {
      continue;
    }
    const expiresAt =
      Date.parse(feedback.createdAt) +
      (kind === "less_like_this" ? 30 : 7) * DAY;
    if (expiresAt <= at) {
      continue;
    }
    const id =
      kind === "less_like_this"
        ? `preference:${feedback.context.scope.key}`
        : `${kind === "option_selected" || kind === "custom_sent" ? "direction" : "action"}:${suggestionId}`;
    const evidence = [
      ...(records.get(id)?.evidence ?? []),
      {
        id: feedback.id,
        suggestionId,
        kind,
        observedAt: feedback.createdAt,
        expiresAt: new Date(expiresAt).toISOString(),
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
    // Choose the newest canonical context independently of UUID scan order.
    const previous = records.get(id);
    const usePrevious =
      previous &&
      (evidence[0]?.id !== feedback.id ||
        evidence[0]?.suggestionId !== suggestionId);
    records.set(id, {
      id,
      title: usePrevious ? previous.title : feedback.context.title,
      rationale: usePrevious ? previous.rationale : feedback.context.rationale,
      scope: usePrevious ? previous.scope : feedback.context.scope,
      evidence,
    });
  }
}

/** A fresh, read-only projection for one prepared Run; never a Memory store. */
export function createSuggestionFeedbackContext(
  owner: { readonly orgId: string; readonly userId: string },
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
) {
  return computed(async (get) => {
    // A bootstrap can prepare several queued inputs; each needs fresh feedback.
    await get(pickedEvent$);
    const at = nowDate();
    const records = new Map<string, FeedbackRecord>();
    let after: string | undefined;
    let complete = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await get(db$)
        .select({
          id: agentSuggestions.id,
          feedbacks: agentSuggestions.feedbacks,
        })
        .from(agentSuggestions)
        .where(
          and(
            eq(agentSuggestions.orgId, owner.orgId),
            eq(agentSuggestions.userId, owner.userId),
            retainedSuggestionFeedback(at),
            after ? gt(agentSuggestions.id, after) : undefined,
          ),
        )
        .orderBy(asc(agentSuggestions.id))
        .limit(PAGE_SIZE + 1);
      const selected = rows.slice(0, PAGE_SIZE);
      for (const row of selected) {
        mergeCardFeedback(
          records,
          row.id,
          array(suggestionFeedbackSchema).max(100).parse(row.feedbacks),
          at.getTime(),
        );
      }
      if (rows.length <= PAGE_SIZE) {
        complete = true;
        break;
      }
      after = selected.at(-1)?.id;
    }
    const all = [...records.values()].sort((a, b) => {
      return (
        (b.evidence[0]?.observedAt ?? "").localeCompare(
          a.evidence[0]?.observedAt ?? "",
        ) || a.id.localeCompare(b.id)
      );
    });
    const context = {
      asOf: at.toISOString(),
      complete: complete && all.length <= 100,
      records: all.slice(0, 100),
    };
    while (
      new TextEncoder().encode(JSON.stringify(context)).length >
      MAX_CONTEXT_BYTES
    ) {
      context.records.pop();
      context.complete = false;
    }
    return context;
  });
}
