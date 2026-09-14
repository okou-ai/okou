import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { feishuOrgConnections } from "@okouai/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";
import { agents } from "@okouai/db/schema/agent";

import { buildFeishuWelcomeMessage } from "../../lib/feishu-message-card";
import { sendFeishuMessage } from "../external/feishu-client";
import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../../lib/time";
import { logger } from "../../lib/log";
import { settle } from "../utils";

const L = logger("FeishuWelcome");
const WELCOME_RETRY_LIMIT = 20;

export async function notifyFeishuConnect(
  args: {
    readonly db: Db;
    readonly installationId: string;
    readonly connectionId: string;
    readonly openId: string;
  },
  signal: AbortSignal,
): Promise<void> {
  const [installation] = await args.db
    .select({
      agentName: agents.name,
      agentDisplayName: agents.displayName,
      botName: feishuOrgInstallations.botName,
      platform: feishuOrgInstallations.platform,
    })
    .from(feishuOrgConnections)
    .innerJoin(
      feishuOrgInstallations,
      eq(feishuOrgInstallations.id, feishuOrgConnections.installationId),
    )
    .leftJoin(agents, eq(agents.id, feishuOrgInstallations.defaultAgentId))
    .where(
      and(
        eq(feishuOrgConnections.id, args.connectionId),
        eq(feishuOrgConnections.installationId, args.installationId),
        eq(feishuOrgConnections.feishuOpenId, args.openId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!installation) {
    throw new Error("Feishu installation not found");
  }
  await sendFeishuMessage(
    {
      db: args.db,
      installationId: args.installationId,
      receiveIdType: "open_id",
      receiveId: args.openId,
      message: buildFeishuWelcomeMessage({
        platform: installation.platform,
        agentName: installation.agentDisplayName ?? installation.agentName,
        botName: installation.botName,
      }),
      idempotencyKey: args.connectionId,
    },
    signal,
  );
  signal.throwIfAborted();
  await args.db
    .update(feishuOrgConnections)
    .set({ dmWelcomeSent: true, updatedAt: nowDate() })
    .where(
      and(
        eq(feishuOrgConnections.id, args.connectionId),
        eq(feishuOrgConnections.installationId, args.installationId),
        eq(feishuOrgConnections.feishuOpenId, args.openId),
        eq(feishuOrgConnections.dmWelcomeSent, false),
      ),
    );
}

export const retryPendingFeishuConnectWelcomes$ = command(
  async ({ set }, signal: AbortSignal): Promise<number> => {
    const db = set(writeDb$);
    const rows = await db
      .select({
        connectionId: feishuOrgConnections.id,
        installationId: feishuOrgConnections.installationId,
        openId: feishuOrgConnections.feishuOpenId,
      })
      .from(feishuOrgConnections)
      .where(eq(feishuOrgConnections.dmWelcomeSent, false))
      .orderBy(feishuOrgConnections.createdAt)
      .limit(WELCOME_RETRY_LIMIT);
    signal.throwIfAborted();

    let delivered = 0;
    for (const row of rows) {
      const result = await settle(
        notifyFeishuConnect(
          {
            db,
            installationId: row.installationId,
            connectionId: row.connectionId,
            openId: row.openId,
          },
          signal,
        ),
        signal,
      );
      signal.throwIfAborted();
      if (result.ok) {
        delivered++;
      } else {
        L.warn("Failed to retry Feishu connect welcome", {
          connectionId: row.connectionId,
          error: result.error,
        });
      }
    }
    return delivered;
  },
);
