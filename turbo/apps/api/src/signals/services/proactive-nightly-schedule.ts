import type { ProactiveWorkflowOwner } from "./proactive-workflows-eligibility.service";
import { officialScheduleOwnerHash } from "./official-workflow-owner-schedule";

export type ProactiveNightlyKind = "learning" | "planning";

export interface ProactiveNightlyOccurrence {
  readonly kind: ProactiveNightlyKind;
  readonly reviewDate: string;
  readonly timezone: string;
  readonly scheduledAt: Date;
  readonly learningEnabled: boolean;
  readonly learningEventId: string | null;
  readonly learningMemoryVersion: string | null;
}

/** Paired owner minutes keep a one-hour nominal gap in the member's timezone. */
export function proactiveNightlyCron(
  kind: ProactiveNightlyKind,
  owner: ProactiveWorkflowOwner,
) {
  return `${officialScheduleOwnerHash(owner) % 30} ${kind === "learning" ? 2 : 3} * * *`;
}

export function proactiveReviewDate(at: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const values = new Map(
    parts.map((part) => {
      return [part.type, part.value];
    }),
  );
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}
