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

type FeedbackRecord = {
  readonly kind: Exclude<
    SuggestionFeedback["kind"],
    "undo" | "reason" | "dismissed"
  >;
  readonly title: string;
  readonly rationale: string;
  readonly reason?: string;
  readonly choice?: string;
  readonly at: string;
  readonly until: string;
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

function feedbackRecord(
  feedback: SuggestionFeedback,
  at: number,
): FeedbackRecord[] {
  const kind = feedback.kind;
  if (kind === "undo" || kind === "reason" || kind === "dismissed") {
    return [];
  }
  const until =
    Date.parse(feedback.createdAt) + (kind === "less_like_this" ? 30 : 7) * DAY;
  if (until <= at) {
    return [];
  }
  const choice =
    kind === "custom_sent" ? feedback.choice : feedback.context.optionLabel;
  return [
    {
      kind,
      title: feedback.context.title,
      rationale: feedback.context.rationale,
      ...(feedback.note ? { reason: feedback.note } : {}),
      ...(choice ? { choice } : {}),
      at: feedback.createdAt,
      until: new Date(until).toISOString(),
    },
  ];
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
    const feedbacks: SuggestionFeedback[] = [];
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
        feedbacks.push(
          ...effectiveCardFeedback(
            array(suggestionFeedbackSchema).max(100).parse(row.feedbacks),
            at.getTime(),
          ),
        );
      }
      if (rows.length <= PAGE_SIZE) {
        complete = true;
        break;
      }
      after = selected.at(-1)?.id;
    }
    const all = feedbacks
      .sort((a, b) => {
        return (
          b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
        );
      })
      .flatMap((feedback) => {
        return feedbackRecord(feedback, at.getTime());
      });
    const context = {
      asOf: at.toISOString(),
      complete: complete && all.length <= 100,
      feedback: all.slice(0, 100),
    };
    while (
      new TextEncoder().encode(JSON.stringify(context)).length >
      MAX_CONTEXT_BYTES
    ) {
      context.feedback.pop();
      context.complete = false;
    }
    return context;
  });
}
