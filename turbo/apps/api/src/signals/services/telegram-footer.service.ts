import { computed, type Computed } from "ccstate";
import { getRunModelDisplayName } from "@okouai/core/model-display-name";
import {
  getFrameworkForType,
  modelProviderTypeSchema,
} from "@okouai/api-contracts/contracts/model-providers";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { modelProviders } from "@okouai/db/schema/model-provider";
import { telegramInstallations } from "@okouai/db/schema/telegram-installation";
import { telegramUserLinks } from "@okouai/db/schema/telegram-user-link";
import { and, eq } from "drizzle-orm";

import { isOfficialTelegramBotId } from "../external/telegram-official";
import { db$, type ReadonlyDb } from "../external/db";
import { escapeHtml } from "../../lib/telegram-format";
import { resolveRunModelSelection } from "./run-model-selection.service";

const ORG_SENTINEL_USER_ID = "__org__";

function telegramUserMention(telegramUserId: string, label: string): string {
  const href = `tg://user?id=${encodeURIComponent(telegramUserId)}`;
  return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

function telegramUserLabel(
  telegramUsername: string | null | undefined,
  telegramDisplayName: string | null | undefined,
  telegramUserId: string,
): string {
  const username = telegramUsername?.trim().replace(/^@+/, "");
  if (username) {
    return `@${username}`;
  }
  const displayName = telegramDisplayName?.trim();
  return displayName || `Telegram user ${telegramUserId}`;
}

function displayLabel(row: {
  agentDisplayName: string | null;
  agentName: string;
}): string {
  const displayName = row.agentDisplayName?.trim();
  if (displayName) {
    return displayName;
  }
  return row.agentName;
}

async function resolveComposeLabel(
  db: ReadonlyDb,
  composeId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({
      agentDisplayName: agents.displayName,
      agentName: agents.name,
    })
    .from(agents)
    .where(eq(agents.id, composeId))
    .limit(1);
  return row ? displayLabel(row) : undefined;
}

async function resolveTelegramRespondedByLabel(args: {
  readonly db: ReadonlyDb;
  readonly installationId: string;
  readonly composeId: string;
}): Promise<string | undefined> {
  if (isOfficialTelegramBotId(args.installationId)) {
    return undefined;
  }

  const [installation] = await args.db
    .select({ defaultAgentId: telegramInstallations.defaultAgentId })
    .from(telegramInstallations)
    .where(eq(telegramInstallations.telegramBotId, args.installationId))
    .limit(1);

  if (installation?.defaultAgentId === args.composeId) {
    return undefined;
  }

  const label = await resolveComposeLabel(args.db, args.composeId);
  return label ? `Responded by ${escapeHtml(label)}` : undefined;
}

async function resolveOrgDefaultModelProviderSelectedModel(
  db: ReadonlyDb,
  orgId: string,
): Promise<string | undefined> {
  const rows = await db
    .select({
      type: modelProviders.type,
      selectedModel: modelProviders.selectedModel,
    })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
        eq(modelProviders.isDefault, true),
      ),
    );
  const row = rows.find((candidate) => {
    const parsed = modelProviderTypeSchema.safeParse(candidate.type);
    return parsed.success && getFrameworkForType(parsed.data) === "claude-code";
  });
  return row?.selectedModel ?? undefined;
}

async function resolveAgentReplyModelLabel(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly runId: string;
}): Promise<string | undefined> {
  const runModel = await resolveRunModelSelection(args.db, args.runId);
  const model =
    runModel?.selectedModel ??
    (await resolveOrgDefaultModelProviderSelectedModel(args.db, args.orgId));

  return model
    ? escapeHtml(getRunModelDisplayName(model, runModel?.codexServiceTier))
    : undefined;
}

export async function resolveTelegramAgentReplyFooterText(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly runId: string;
  readonly installationId: string;
  readonly agentId: string;
}): Promise<string | undefined> {
  const [respondedBy, modelLabel] = await Promise.all([
    resolveTelegramRespondedByLabel({
      db: args.db,
      installationId: args.installationId,
      composeId: args.agentId,
    }),
    resolveAgentReplyModelLabel({
      db: args.db,
      orgId: args.orgId,
      runId: args.runId,
    }),
  ]);

  const parts: string[] = [];
  if (respondedBy) {
    parts.push(respondedBy);
  }
  if (modelLabel) {
    parts.push(modelLabel);
  }

  return parts.length > 0 ? parts.join(" · ") : undefined;
}

async function resolveRunAgentLabel(
  db: ReadonlyDb,
  runId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({
      agentDisplayName: agents.displayName,
      agentName: agents.name,
    })
    .from(agentRuns)
    .innerJoin(agentSessions, eq(agentRuns.sessionId, agentSessions.id))
    .innerJoin(agents, eq(agentSessions.agentId, agents.id))
    .where(eq(agentRuns.id, runId))
    .limit(1);
  return row ? displayLabel(row) : undefined;
}

async function resolveRunUserLabel(
  db: ReadonlyDb,
  args: { readonly runId: string; readonly botId: string },
): Promise<string | undefined> {
  const [row] = await db
    .select({
      telegramUserId: telegramUserLinks.telegramUserId,
      telegramUsername: telegramUserLinks.telegramUsername,
      telegramDisplayName: telegramUserLinks.telegramDisplayName,
    })
    .from(agentRuns)
    .innerJoin(
      telegramUserLinks,
      and(
        eq(telegramUserLinks.userId, agentRuns.userId),
        eq(telegramUserLinks.installationId, args.botId),
      ),
    )
    .where(eq(agentRuns.id, args.runId))
    .limit(1);
  if (!row) {
    return undefined;
  }
  const label = telegramUserLabel(
    row.telegramUsername,
    row.telegramDisplayName,
    row.telegramUserId,
  );
  return telegramUserMention(row.telegramUserId, label);
}

/**
 * Resolve the attribution footer text appended to user-initiated Telegram messages.
 *
 * Preserves the legacy footer semantics for agent, automation, triggering user,
 * and selected model labels. Returns undefined when authRunId is undefined
 * (auth source has no run context) or when none of the four data points are
 * available.
 */
export function telegramMessageSendFooterText(args: {
  readonly authRunId: string | undefined;
  readonly botId: string;
}): Computed<Promise<string | undefined>> {
  return computed(async (get): Promise<string | undefined> => {
    if (!args.authRunId) {
      return undefined;
    }
    const db = get(db$);

    const [agentLabel, userLabel, runModel] = await Promise.all([
      resolveRunAgentLabel(db, args.authRunId),
      resolveRunUserLabel(db, {
        runId: args.authRunId,
        botId: args.botId,
      }),
      resolveRunModelSelection(db, args.authRunId),
    ]);

    const parts: string[] = [];
    if (agentLabel) {
      parts.push(`Sent via ${escapeHtml(agentLabel)}`);
    }
    if (userLabel) {
      parts.push(`Triggered by ${userLabel}`);
    }
    if (runModel?.selectedModel) {
      parts.push(
        escapeHtml(
          getRunModelDisplayName(
            runModel.selectedModel,
            runModel.codexServiceTier,
          ),
        ),
      );
    }

    return parts.length > 0 ? parts.join(" · ") : undefined;
  });
}
