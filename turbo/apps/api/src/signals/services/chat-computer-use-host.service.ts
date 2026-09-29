import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { computerUseHosts } from "@okouai/db/schema/computer-use-host";
import { and, eq, isNull } from "drizzle-orm";

import { command } from "ccstate";
import { writeDb$ } from "../external/db";

export interface ComputerUseHostGrant {
  readonly hostId: string;
  readonly displayName: string;
}

export const loadComputerUseHostGrantForAutoSend$ = command(
  async (
    { set },
    args: {
      readonly threadId: string;
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<ComputerUseHostGrant | null> => {
    const db = set(writeDb$);
    const [host] = await db
      .select({
        hostId: computerUseHosts.id,
        displayName: computerUseHosts.displayName,
      })
      .from(chatThreads)
      .innerJoin(
        computerUseHosts,
        eq(chatThreads.computerUseHostId, computerUseHosts.id),
      )
      .where(
        and(
          eq(chatThreads.id, args.threadId),
          eq(chatThreads.userId, args.userId),
          eq(computerUseHosts.orgId, args.orgId),
          eq(computerUseHosts.userId, args.userId),
          isNull(computerUseHosts.revokedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return host ?? null;
  },
);
