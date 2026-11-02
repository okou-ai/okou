import { getStartedClaims } from "@okouai/db/schema/get-started-claim";
import { slackOrgConnections } from "@okouai/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { command } from "ccstate";
import { and, eq, exists, sql } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { isForeignKeyViolation } from "../../lib/pg-errors";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";
import { ensureGetStartedRewardWallet$ } from "./get-started-wallet.service";
import { pendingSlackRewardSql } from "./slack-installation-reward";
import { settleSlackWorkspaceRewards$ } from "./slack-reward.service";
import {
  connectedSlackWorkspace,
  slackConnectionAdmission,
  slackConnectionValues,
  slackWorkspaceAdmission,
  slackWorkspaceBindingValues,
  type SlackWorkspaceConnection,
  type SlackWorkspaceConnectionResult,
} from "./slack-workspace-write-plan";

function isDeletedInstallationReference(error: unknown): boolean {
  return (
    isForeignKeyViolation(error) &&
    error instanceof Error &&
    typeof error.cause === "object" &&
    error.cause !== null &&
    "constraint" in error.cause &&
    error.cause.constraint ===
      "slack_org_connections_slack_workspace_id_slack_org_installation"
  );
}

const commitSlackWorkspaceConnection$ = command(
  async (
    { set },
    args: SlackWorkspaceConnection,
    signal: AbortSignal,
  ): Promise<SlackWorkspaceConnectionResult> => {
    const db = set(writeDb$);
    const [currentInstallation] = await db
      .select()
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.slackWorkspaceId, args.workspaceId));
    signal.throwIfAborted();
    const admission = slackWorkspaceAdmission(args, currentInstallation);
    if (admission.kind !== "allowed") return admission;
    const plan = slackConnectionValues(args);
    const current = await db
      .select(plan.currentSelection)
      .from(slackOrgConnections)
      .where(plan.currentWhere);
    signal.throwIfAborted();
    const denied = slackConnectionAdmission(args, current);
    if (denied) return denied;
    const at = nowDate();
    // An initial bind is a real state transition, not a tuple stamp. A losing
    // binder publishes neither a connection nor a reward receipt.
    const installation = db.$with("connected_slack_installation").as(
      admission.installation.orgId === null
        ? db
            .update(slackOrgInstallations)
            .set(slackWorkspaceBindingValues(args, at))
            .where(plan.bindWhere)
            .returning()
        : db
            .select()
            .from(slackOrgInstallations)
            .where(
              and(
                eq(slackOrgInstallations.slackWorkspaceId, args.workspaceId),
                eq(slackOrgInstallations.orgId, args.orgId),
              ),
            ),
    );
    // Retain the partial insert target list and its database-generated identity.
    const connection = db.$with("connected_slack_member", {
      id: slackOrgConnections.id,
    }).as(sql`
      INSERT INTO ${slackOrgConnections} (slack_user_id, slack_workspace_id, user_id)
      SELECT ${args.slackUserId}, ${args.workspaceId}, ${args.userId} FROM ${installation} WHERE true
      ON CONFLICT (slack_user_id, slack_workspace_id) DO UPDATE SET user_id = ${args.userId}
      WHERE ${eq(slackOrgConnections.userId, args.userId)} RETURNING id
    `);
    const replaced = db.$with("replaced_slack_member").as(
      db
        .delete(slackOrgConnections)
        .where(
          and(
            plan.staleWhere,
            exists(db.select({ id: connection.id }).from(connection)),
          ),
        )
        .returning({ slackUserId: slackOrgConnections.slackUserId }),
    );
    const receipt = db
      .$with("recorded_slack_connection_reward", { id: getStartedClaims.id })
      .as(
        pendingSlackRewardSql(
          args,
          at,
          db
            .select({ id: installation.slackWorkspaceId })
            .from(installation)
            .where(
              and(
                sql`${admission.installation.orgId === null}`,
                exists(db.select({ id: connection.id }).from(connection)),
              ),
            )
            .getSQL(),
        ),
      );
    const rows = await db
      .with(installation, connection, replaced, receipt)
      .select({
        installation: {
          slackWorkspaceId: installation.slackWorkspaceId,
          slackWorkspaceName: installation.slackWorkspaceName,
          orgId: installation.orgId,
          encryptedBotToken: installation.encryptedBotToken,
          botUserId: installation.botUserId,
          installedByUserId: installation.installedByUserId,
          botScopes: installation.botScopes,
          createdAt: installation.createdAt,
          updatedAt: installation.updatedAt,
        },
        connectionId: connection.id,
        replacedSlackUserId: replaced.slackUserId,
      })
      .from(installation)
      .crossJoin(connection)
      .leftJoin(replaced, sql`true`);
    signal.throwIfAborted();
    const published = rows[0];
    if (!published)
      return {
        kind: "forbidden",
        message:
          "The Slack workspace or account changed. Please connect again.",
      };
    return connectedSlackWorkspace(
      args,
      published.installation,
      published.connectionId,
      rows.flatMap((row) => {
        return row.replacedSlackUserId === null
          ? []
          : [{ slackUserId: row.replacedSlackUserId }];
      }),
    );
  },
);

/** Connection and durable completion commit before the independent reward owner. */
export const connectSlackWorkspace$ = command(
  async (
    { set },
    args: SlackWorkspaceConnection,
    signal: AbortSignal,
  ): Promise<SlackWorkspaceConnectionResult> => {
    await set(ensureGetStartedRewardWallet$, args.orgId, signal);
    const result = await settle(
      set(commitSlackWorkspaceConnection$, args, signal),
    );
    signal.throwIfAborted();
    if (!result.ok) {
      if (isDeletedInstallationReference(result.error))
        return {
          kind: "not_found",
          message: "Workspace not found. Please install the Slack app first.",
        };
      throw result.error;
    }
    if (result.value.kind === "ok") {
      await set(
        settleSlackWorkspaceRewards$,
        { orgId: args.orgId, workspaceId: args.workspaceId },
        signal,
      );
    }
    return result.value;
  },
);
