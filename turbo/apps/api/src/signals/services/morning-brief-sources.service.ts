import { connectors } from "@okouai/db/schema/connector";
import { slackOrgConnections } from "@okouai/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { and, eq } from "drizzle-orm";

import type { Db } from "../external/db";
import { unreadChatThreadsQuery } from "./chat-thread-read-state-query";

export async function hasMorningBriefSources(
  db: Pick<Db, "select">,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly excludedThreadId: string | null;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const [connector] = await db
    .select({ id: connectors.id })
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        eq(connectors.needsReconnect, false),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (connector) {
    return true;
  }

  const [slackConnection] = await db
    .select({ id: slackOrgConnections.id })
    .from(slackOrgConnections)
    .innerJoin(
      slackOrgInstallations,
      eq(
        slackOrgInstallations.slackWorkspaceId,
        slackOrgConnections.slackWorkspaceId,
      ),
    )
    .where(
      and(
        eq(slackOrgInstallations.orgId, args.orgId),
        eq(slackOrgConnections.userId, args.userId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (slackConnection) {
    return true;
  }

  // A brief must not keep generating new briefs from its own unread result.
  const [unread] = await unreadChatThreadsQuery(db, args).limit(1);
  signal.throwIfAborted();
  return unread !== undefined;
}
