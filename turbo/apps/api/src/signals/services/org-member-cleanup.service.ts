import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { slackOrgConnections } from "@okouai/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { morningBriefEnrollments } from "@okouai/db/schema/morning-brief-enrollment";
import { nowDate } from "../../lib/time";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentRunQueue } from "@okouai/db/schema/agent-run-queue";
import { modelProviders } from "@okouai/db/schema/model-provider";
import { modelProviderAuthSessions } from "@okouai/db/schema/model-provider-auth-session";
import { secrets } from "@okouai/db/schema/secret";
import { logger } from "../../lib/log";
import { publishCancelToRunnerGroup } from "../external/realtime";
import { tapError } from "../utils";
import { transitionAgentRunsToTerminal } from "./agent-run-terminal-transition.service";
import { revokeMorningBriefCollectionOwnership } from "./morning-brief-collection-occurrence.service";
import { revokeMorningBriefDeliveryOwnership } from "./morning-brief-delivery.service";

import type { Db } from "../external/db";

export async function cleanupOrgMemberResources(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly membershipId?: string;
  },
  signal: AbortSignal,
): Promise<void> {
  await revokeOrgMemberRunAuthority(db, args, signal);
  signal.throwIfAborted();
  const currentTime = nowDate();
  await db
    .insert(morningBriefEnrollments)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      state: "departed",
      membershipId: args.membershipId,
      availableAt: currentTime,
      createdAt: currentTime,
      updatedAt: currentTime,
    })
    .onConflictDoUpdate({
      target: [morningBriefEnrollments.orgId, morningBriefEnrollments.userId],
      set: {
        state: "departed",
        // Deletion can arrive before enrollment or after a missing live lookup.
        // Retain its generation so a late created event cannot revive intent.
        membershipId: args.membershipId ?? morningBriefEnrollments.membershipId,
        updatedAt: currentTime,
      },
      setWhere: and(
        args.membershipId
          ? or(
              isNull(morningBriefEnrollments.membershipId),
              eq(morningBriefEnrollments.membershipId, args.membershipId),
            )
          : undefined,
        inArray(morningBriefEnrollments.state, [
          "checking",
          "pending",
          "ineligible",
          "departed",
        ]),
      ),
    });
  const [installation] = await db
    .select({ slackWorkspaceId: slackOrgInstallations.slackWorkspaceId })
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.orgId, args.orgId))
    .limit(1);
  signal.throwIfAborted();

  if (installation) {
    const connections = await db
      .select({ id: slackOrgConnections.id })
      .from(slackOrgConnections)
      .where(
        and(
          eq(slackOrgConnections.userId, args.userId),
          eq(
            slackOrgConnections.slackWorkspaceId,
            installation.slackWorkspaceId,
          ),
        ),
      );
    signal.throwIfAborted();

    if (connections.length > 0) {
      await db.delete(slackOrgConnections).where(
        inArray(
          slackOrgConnections.id,
          connections.map((connection) => {
            return connection.id;
          }),
        ),
      );
      signal.throwIfAborted();
    }
  }

  await db
    .delete(orgMembersCache)
    .where(
      and(
        eq(orgMembersCache.userId, args.userId),
        eq(orgMembersCache.orgId, args.orgId),
      ),
    );
  signal.throwIfAborted();

  await db
    .delete(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.userId, args.userId),
        eq(orgMembersMetadata.orgId, args.orgId),
      ),
    );
  signal.throwIfAborted();
}

async function revokeOrgMemberRunAuthority(
  db: Db,
  args: { readonly orgId: string; readonly userId: string },
  signal: AbortSignal,
): Promise<void> {
  // Membership revocation is a hard authority boundary, including credentials
  // retained by ordinary personal-settings disconnect. Commit revocation before
  // best-effort runner notification or the remaining member resource cleanup.
  const revokedAt = nowDate();
  const cancelled = await db.transaction(async (tx) => {
    const rows = await transitionAgentRunsToTerminal(tx, {
      values: {
        status: "cancelled",
        completedAt: nowDate(),
        runnerCancellationMode: "hard",
      },
      conditions: [
        eq(agentRuns.orgId, args.orgId),
        eq(agentRuns.userId, args.userId),
        inArray(agentRuns.status, ["queued", "pending", "running"]),
      ],
    });
    // A Morning Brief collection attempt is the same kind of authority, so it
    // is revoked here rather than surviving until the member row it hangs from
    // is removed further down this cleanup. The durable stamp this writes is
    // what also stops a claim admitted just before this commit, including when
    // there is no occurrence to delete yet.
    await revokeMorningBriefCollectionOwnership(
      tx,
      { kind: "membership", orgId: args.orgId, userId: args.userId },
      revokedAt,
    );
    // A delivered brief's unsent email intent is the same kind of authority and
    // still carries the recipient and the rendered body, so it leaves in this
    // same transaction rather than in a later one that a fault could skip.
    await revokeMorningBriefDeliveryOwnership(tx, {
      kind: "membership",
      orgId: args.orgId,
      userId: args.userId,
    });
    await tx
      .delete(agentRunQueue)
      .where(
        and(
          eq(agentRunQueue.orgId, args.orgId),
          eq(agentRunQueue.userId, args.userId),
        ),
      );
    await tx
      .delete(modelProviders)
      .where(
        and(
          eq(modelProviders.orgId, args.orgId),
          eq(modelProviders.userId, args.userId),
        ),
      );
    await tx
      .delete(modelProviderAuthSessions)
      .where(
        and(
          eq(modelProviderAuthSessions.orgId, args.orgId),
          eq(modelProviderAuthSessions.userId, args.userId),
        ),
      );
    await tx
      .delete(secrets)
      .where(
        and(
          eq(secrets.orgId, args.orgId),
          eq(secrets.userId, args.userId),
          eq(secrets.type, "model-provider"),
        ),
      );
    return rows;
  });
  signal.throwIfAborted();
  await Promise.all(
    cancelled.map(async (run) => {
      if (!run.runnerGroup) {
        return;
      }
      await tapError(
        publishCancelToRunnerGroup(run.runnerGroup, run.runId, "hard"),
        (error) => {
          logger("OrgMemberCleanup").warn(
            "Failed to publish membership-revoked run cancellation",
            { runId: run.runId, error },
          );
        },
      );
    }),
  );
  signal.throwIfAborted();
}
