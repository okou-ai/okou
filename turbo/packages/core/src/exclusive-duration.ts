export interface ExclusiveDurationBreakdown {
  readonly totalMs: number;
  readonly completionMs: number;
  readonly residualMs: number;
  readonly overlapMs: number;
}

export function exclusiveDurationBreakdown(args: {
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  readonly callbackFinishedAtMs?: number;
  readonly leafDurationMs: number;
}): ExclusiveDurationBreakdown {
  const totalMs = Math.max(0, args.finishedAtMs - args.startedAtMs);
  const completionMs =
    args.callbackFinishedAtMs === undefined
      ? 0
      : Math.max(0, args.finishedAtMs - args.callbackFinishedAtMs);
  const unaccountedMs = totalMs - args.leafDurationMs - completionMs;
  return {
    totalMs,
    completionMs,
    residualMs: Math.max(0, unaccountedMs),
    overlapMs: Math.max(0, -unaccountedMs),
  };
}
