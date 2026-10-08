import { compareCreatedAt } from "./compare-created-at.ts";

/**
 * The newest instant an open thread has to be read through.
 *
 * A Run leaves a terminal event in the local projection. The server may have
 * observed a newer terminal event than the local projection, so read through
 * the later of the two timestamps.
 */
export function unreadThroughAt(
  latestRunFinishAt: string | undefined,
  serverUnreadAt: string | undefined,
): string | undefined {
  if (latestRunFinishAt === undefined) {
    return serverUnreadAt;
  }
  if (serverUnreadAt === undefined) {
    return latestRunFinishAt;
  }
  return compareCreatedAt(serverUnreadAt, latestRunFinishAt) > 0
    ? serverUnreadAt
    : latestRunFinishAt;
}
