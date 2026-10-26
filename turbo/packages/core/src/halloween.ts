// The interval spans the November 1 daylight-saving transition in Los Angeles.
export const HALLOWEEN_START = Date.parse("2026-10-29T00:00:00-07:00");
export const HALLOWEEN_END = Date.parse("2026-11-05T00:00:00-08:00");

export function halloweenPhase(at: number): "upcoming" | "open" | "ended" {
  return at < HALLOWEEN_START
    ? "upcoming"
    : at < HALLOWEEN_END
      ? "open"
      : "ended";
}
