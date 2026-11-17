import { getStartedClaims } from "@okouai/db/schema/get-started-claim";
import { randomUUID } from "node:crypto";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { command } from "ccstate";
import { eq, isNull, or, sql } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { env } from "../../lib/env";
import { writeDb$ } from "../external/db";
import { pendingSlackRewardSql } from "./slack-installation-reward";
import { ensureGetStartedRewardWallet$ } from "./get-started-wallet.service";
import { settleSlackWorkspaceRewards$ } from "./slack-reward.service";
import {
  MARKETING_REWARD_LINK_EVENT_HANDLER_VERSION,
  marketingRewardLinkEventInsert,
} from "./marketing-reward-event-publication";
import { startMarketingRewardEventDelivery$ } from "./marketing-reward-event-delivery.service";

type SlackInstallation = typeof slackOrgInstallations.$inferSelect;
interface SlackInstallationFields {
  readonly fields: Pick<
    SlackInstallation,
    "encryptedBotToken" | "botUserId" | "slackWorkspaceName" | "botScopes"
  >;
  readonly workspaceId: string;
}

type AnonymousSlackInstallationWrite = SlackInstallationFields & {
  readonly orgId: null;
  readonly userId: null;
  readonly mode: "install" | "reinstall";
};

type ConnectedSlackInstallationWrite = SlackInstallationFields & {
  readonly orgId: string;
  readonly userId: string;
  readonly mode: "connect";
};

type SlackInstallationWrite =
  AnonymousSlackInstallationWrite | ConnectedSlackInstallationWrite;

const commitAnonymousSlackInstallation$ = command(
  async (
    { set },
    args: AnonymousSlackInstallationWrite,
    signal: AbortSignal,
  ): Promise<SlackInstallation> => {
    const db = set(writeDb$);
    const [installed] =
      args.mode === "reinstall"
        ? await db
            .update(slackOrgInstallations)
            .set({ ...args.fields, updatedAt: nowDate() })
            .where(eq(slackOrgInstallations.slackWorkspaceId, args.workspaceId))
            .returning()
        : await db
            .insert(slackOrgInstallations)
            .values({
              ...args.fields,
              slackWorkspaceId: args.workspaceId,
              orgId: null,
              installedByUserId: null,
            })
            .onConflictDoUpdate({
              target: slackOrgInstallations.slackWorkspaceId,
              set: {
                ...args.fields,
                orgId: null,
                installedByUserId: null,
                updatedAt: nowDate(),
              },
              setWhere: sql`false`,
            })
            .returning();
    if (!installed) {
      throw new Error("Slack installation upsert did not return a row");
    }
    signal.throwIfAborted();
    return installed;
  },
);

/** Installation and its durable completion receipt commit in one statement. */
const commitSlackInstallation$ = command(
  async (
    { set },
    args: ConnectedSlackInstallationWrite,
    signal: AbortSignal,
  ): Promise<SlackInstallation> => {
    const db = set(writeDb$);
    const at = nowDate();
    const sourceEventId = randomUUID();
    const installed = db.$with("published_slack_installation").as(
      db
        .insert(slackOrgInstallations)
        .values({
          ...args.fields,
          slackWorkspaceId: args.workspaceId,
          orgId: args.orgId,
          installedByUserId: args.userId,
        })
        .onConflictDoUpdate({
          target: slackOrgInstallations.slackWorkspaceId,
          set: {
            ...args.fields,
            orgId: args.orgId,
            installedByUserId: args.userId,
            updatedAt: at,
          },
          setWhere: or(
            eq(slackOrgInstallations.orgId, args.orgId),
            isNull(slackOrgInstallations.orgId),
          ),
        })
        .returning(),
    );
    const receipt = db
      .$with("recorded_slack_installation_reward", { id: getStartedClaims.id })
      .as(
        pendingSlackRewardSql(
          args,
          at,
          db
            .select({ id: installed.slackWorkspaceId })
            .from(installed)
            .getSQL(),
        ),
      );
    const sourceEvent = db.$with("slack_installation_source_event", {}).as(
      marketingRewardLinkEventInsert(
        {
          id: sourceEventId,
          environment: env("ENV"),
          type: "slack.oauth-authorized",
          occurredAt: at.toISOString(),
          orgId: args.orgId,
          userId: args.userId,
        },
        db
          .select({
            id: sql`${installed.slackWorkspaceId}`
              .mapWith(slackOrgInstallations.slackWorkspaceId)
              .as("id"),
          })
          .from(installed)
          .getSQL(),
      ),
    );
    const [installation] = await db
      .with(installed, receipt, sourceEvent)
      .select()
      .from(installed);
    signal.throwIfAborted();
    if (!installation) {
      throw new Error("Slack installation upsert did not return a row");
    }
    set(
      startMarketingRewardEventDelivery$,
      {
        jobId: sourceEventId,
        handlerVersion: MARKETING_REWARD_LINK_EVENT_HANDLER_VERSION,
      },
      signal,
    );
    return installation;
  },
);

/** Financial settlement cannot roll back or serialize ordinary connection writes. */
export const persistSlackInstallation$ = command(
  async (
    { set },
    args: SlackInstallationWrite,
    signal: AbortSignal,
  ): Promise<SlackInstallation> => {
    if (args.orgId === null) {
      return await set(commitAnonymousSlackInstallation$, args, signal);
    }
    await set(ensureGetStartedRewardWallet$, args.orgId, signal);
    const installed = await set(commitSlackInstallation$, args, signal);
    await set(
      settleSlackWorkspaceRewards$,
      { orgId: args.orgId, workspaceId: args.workspaceId },
      signal,
    );
    return installed;
  },
);
