import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { computerUseHosts } from "@okouai/db/schema/computer-use-host";
import { and, eq, isNull } from "drizzle-orm";

import type { Db } from "../external/db";

export async function loadComputerUseHostGrantForAutoSend(args: {
  readonly db: Db;
  readonly threadId: string;
  readonly orgId: string;
  readonly userId: string;
}): Promise<{
  readonly hostId: string;
  readonly displayName: string;
} | null> {
  const [host] = await args.db
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
  return host ?? null;
}
