import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { feishuOrgConnections } from "@okouai/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";
import { teamsOrgConnections } from "@okouai/db/schema/teams-org-connection";
import { teamsOrgInstallations } from "@okouai/db/schema/teams-org-installation";

import { db$ } from "../external/db";
import type { TeamsMentionEntity } from "../external/teams-bot-client";
import { escapeHtml } from "../../lib/telegram-format";
import { escapeMarkdownFooterLabel } from "../../lib/integration-message-footer";
import { teamsAccountOwnerCondition } from "./teams-workspace-identity.service";
import {
  integrationMessageSendLabels$,
  integrationMessageSendUserLabel$,
  integrationMessageSendFooterText,
} from "./integration-message-context.service";

export const resolveFeishuMessageSendFooter$ = command(
  async (
    { get },
    args: { readonly installationId: string; readonly format: "text" | "card" },
    signal: AbortSignal,
  ) => {
    const labels = await get(integrationMessageSendLabels$);
    signal.throwIfAborted();
    if (!labels.runOwner) {
      return undefined;
    }
    const [sender] = await get(db$)
      .select({
        openId: feishuOrgConnections.feishuOpenId,
        name: feishuOrgConnections.feishuUserName,
      })
      .from(feishuOrgConnections)
      .innerJoin(
        feishuOrgInstallations,
        eq(feishuOrgInstallations.id, feishuOrgConnections.installationId),
      )
      .where(
        and(
          eq(feishuOrgConnections.installationId, args.installationId),
          eq(feishuOrgConnections.userId, labels.runOwner.userId),
          eq(feishuOrgInstallations.orgId, labels.runOwner.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    const name =
      sender?.name?.trim().replace(/\s+/gu, " ") ||
      (await get(integrationMessageSendUserLabel$));
    signal.throwIfAborted();
    const mention = sender
      ? args.format === "card"
        ? `<at id=${escapeHtml(sender.openId)}></at>`
        : `<at user_id="${escapeHtml(sender.openId)}">${name ? escapeHtml(name) : ""}</at>`
      : name
        ? escapeHtml(name)
        : undefined;
    return integrationMessageSendFooterText({
      agentLabel:
        args.format === "card"
          ? escapeMarkdownFooterLabel(labels.agentLabel)
          : labels.agentLabel
            ? escapeHtml(labels.agentLabel)
            : undefined,
      userLabel: mention,
    });
  },
);

export const resolveTeamsMessageSendPresentation$ = command(
  async ({ get }, tenantId: string, signal: AbortSignal) => {
    const labels = await get(integrationMessageSendLabels$);
    signal.throwIfAborted();
    const entities: TeamsMentionEntity[] = [];
    if (!labels.runOwner) {
      return { footerText: undefined, entities };
    }
    const rows = await get(db$)
      .select({
        id: teamsOrgConnections.teamsAadObjectId,
        botUserId: teamsOrgConnections.teamsUserId,
        name: teamsOrgConnections.teamsUserDisplayName,
      })
      .from(teamsOrgConnections)
      .leftJoin(
        teamsOrgInstallations,
        eq(
          teamsOrgInstallations.teamsTenantId,
          teamsOrgConnections.teamsTenantId,
        ),
      )
      .where(
        and(
          teamsAccountOwnerCondition(labels.runOwner),
          eq(teamsOrgConnections.teamsTenantId, tenantId),
        ),
      )
      .limit(2);
    signal.throwIfAborted();
    const sender = rows.length === 1 ? rows[0] : undefined;
    const id = sender?.id ?? sender?.botUserId;
    const name =
      sender?.name?.trim().replace(/\s+/gu, " ") ||
      (await get(integrationMessageSendUserLabel$));
    signal.throwIfAborted();
    const mention = id && name ? `<at>${escapeHtml(name)}</at>` : undefined;
    if (id && name && mention) {
      entities.push({
        type: "mention",
        text: mention,
        mentioned: { id, name },
      });
    }
    return {
      footerText: integrationMessageSendFooterText({
        ...labels,
        agentLabel: escapeMarkdownFooterLabel(labels.agentLabel),
        userLabel: mention ?? escapeMarkdownFooterLabel(name),
      }),
      entities,
    };
  },
);
