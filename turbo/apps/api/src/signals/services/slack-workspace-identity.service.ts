import { command, computed, type Computed } from "ccstate";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { slackOrgConnections } from "@okouai/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { and, eq, exists, isNull, ne, or } from "drizzle-orm";

import { db$, writeDb$ } from "../external/db";
import {
  createUserFeatureSwitchContext,
  loadUserFeatureSwitchContext$,
} from "./feature-switches.service";

interface SlackAccountOwner {
  readonly orgId: string;
  readonly userId: string;
}

export function slackWorkspaceIdentityEnabled(
  identity$: Computed<SlackAccountOwner | Promise<SlackAccountOwner>>,
) {
  const resolvedIdentity$ = computed(async (get) => {
    return await get(identity$);
  });
  const context$ = createUserFeatureSwitchContext(resolvedIdentity$);
  return computed(async (get) => {
    return isFeatureEnabled(
      FeatureSwitchKey.SlackWorkspaceIdentity,
      await get(context$),
    );
  });
}

/** A verified account selects its own workspace, never the entry bot's workspace. */
export function slackAccountConnection(
  identity$: Computed<SlackAccountOwner | Promise<SlackAccountOwner>>,
) {
  return computed(async (get) => {
    const identity = await get(identity$);
    const rows = await get(db$)
      .select({
        connection: slackOrgConnections,
        installation: slackOrgInstallations,
      })
      .from(slackOrgConnections)
      .leftJoin(
        slackOrgInstallations,
        eq(
          slackOrgInstallations.slackWorkspaceId,
          slackOrgConnections.slackWorkspaceId,
        ),
      )
      .where(
        and(
          eq(slackOrgConnections.userId, identity.userId),
          or(
            eq(slackOrgConnections.orgId, identity.orgId),
            and(
              isNull(slackOrgConnections.orgId),
              eq(slackOrgInstallations.orgId, identity.orgId),
            ),
          ),
        ),
      )
      .limit(2);
    // Multiple accounts require an explicit account switch; never pick a token.
    return rows.length === 1 ? rows[0] : undefined;
  });
}

export const connectSlackAccount$ = command(
  async (
    { set },
    args: SlackAccountOwner & {
      readonly workspaceId: string;
      readonly workspaceName: string;
      readonly slackUserId: string;
      readonly replace: boolean;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const organizationConnections = or(
      eq(slackOrgConnections.orgId, args.orgId),
      and(
        isNull(slackOrgConnections.orgId),
        exists(
          db
            .select({ workspaceId: slackOrgInstallations.slackWorkspaceId })
            .from(slackOrgInstallations)
            .where(
              and(
                eq(
                  slackOrgInstallations.slackWorkspaceId,
                  slackOrgConnections.slackWorkspaceId,
                ),
                eq(slackOrgInstallations.orgId, args.orgId),
              ),
            ),
        ),
      ),
    );
    const current = await db
      .select()
      .from(slackOrgConnections)
      .where(
        or(
          and(
            eq(slackOrgConnections.slackWorkspaceId, args.workspaceId),
            eq(slackOrgConnections.slackUserId, args.slackUserId),
          ),
          and(
            organizationConnections,
            eq(slackOrgConnections.userId, args.userId),
          ),
        ),
      );
    signal.throwIfAborted();
    if (
      current.some((row) => {
        return row.userId !== args.userId;
      })
    ) {
      return {
        kind: "forbidden",
        message: "This Slack account is already connected to another user.",
      } as const;
    }
    if (
      !args.replace &&
      current.some((row) => {
        return (
          (row.orgId === args.orgId || row.orgId === null) &&
          (row.slackWorkspaceId !== args.workspaceId ||
            row.slackUserId !== args.slackUserId)
        );
      })
    ) {
      return {
        kind: "forbidden",
        message:
          "Switch your connected Slack account before using another identity.",
      } as const;
    }
    const [connection] = await db
      .insert(slackOrgConnections)
      .values({
        slackWorkspaceId: args.workspaceId,
        slackWorkspaceName: args.workspaceName,
        slackUserId: args.slackUserId,
        userId: args.userId,
        orgId: args.orgId,
      })
      .onConflictDoUpdate({
        target: [
          slackOrgConnections.slackUserId,
          slackOrgConnections.slackWorkspaceId,
        ],
        set: { orgId: args.orgId, slackWorkspaceName: args.workspaceName },
        setWhere: eq(slackOrgConnections.userId, args.userId),
      })
      .returning();
    signal.throwIfAborted();
    if (!connection) {
      return {
        kind: "forbidden",
        message: "This Slack account is already connected to another user.",
      } as const;
    }
    if (args.replace) {
      await db
        .delete(slackOrgConnections)
        .where(
          and(
            organizationConnections,
            eq(slackOrgConnections.userId, args.userId),
            ne(slackOrgConnections.id, connection.id),
          ),
        );
      signal.throwIfAborted();
    }
    return { kind: "ok", connection } as const;
  },
);

/** Account connections survive bot removal; legacy links retain their lifecycle. */
export const removeSlackWorkspaceInstallation$ = command(
  async ({ set }, workspaceId: string, signal: AbortSignal) => {
    const db = set(writeDb$);
    const [installation] = await db
      .select()
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.slackWorkspaceId, workspaceId))
      .limit(1);
    signal.throwIfAborted();
    if (installation?.orgId) {
      const legacy = await db
        .select()
        .from(slackOrgConnections)
        .where(
          and(
            eq(slackOrgConnections.slackWorkspaceId, workspaceId),
            isNull(slackOrgConnections.orgId),
          ),
        );
      signal.throwIfAborted();
      for (const connection of legacy) {
        const features = await set(
          loadUserFeatureSwitchContext$,
          installation.orgId,
          connection.userId,
          signal,
        );
        if (
          isFeatureEnabled(FeatureSwitchKey.SlackWorkspaceIdentity, features)
        ) {
          await db
            .update(slackOrgConnections)
            .set({
              orgId: installation.orgId,
              slackWorkspaceName: installation.slackWorkspaceName,
            })
            .where(
              and(
                eq(slackOrgConnections.id, connection.id),
                isNull(slackOrgConnections.orgId),
              ),
            );
          signal.throwIfAborted();
        }
      }
    }
    await db
      .delete(slackOrgConnections)
      .where(
        and(
          eq(slackOrgConnections.slackWorkspaceId, workspaceId),
          isNull(slackOrgConnections.orgId),
        ),
      );
    signal.throwIfAborted();
    await db
      .delete(slackOrgInstallations)
      .where(eq(slackOrgInstallations.slackWorkspaceId, workspaceId));
    signal.throwIfAborted();
  },
);
