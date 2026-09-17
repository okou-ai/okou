import { compareCreatedAt } from "./compare-created-at.ts";

/**
 * The newest instant an open thread has to be read through.
 *
 * A Run leaves a terminal event in the local projection, so its timestamp is
 * available without asking the server. A native Morning Brief delivery has no
 * Run and no terminal event at all, so its unread state exists only in the
 * server watermark. Taking the later of the two covers a thread whose only
 * unread is native, a second native delivery arriving while the thread is
 * open, and a Run finishing after a native delivery.
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
