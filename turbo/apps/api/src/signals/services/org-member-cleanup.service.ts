import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { orgMembersMetadata } from "@okouai/db/runtime/org-members-metadata";
import { userDisabledPaidTools } from "@okouai/db/schema/user-disabled-paid-tools";
import { slackOrgConnections } from "@okouai/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { morningBriefEnrollments } from "@okouai/db/schema/morning-brief-enrollment";
import { nowDate } from "../../lib/time";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { modelProviders } from "@okouai/db/schema/model-provider";
import { modelProviderAuthSessions } from "@okouai/db/schema/model-provider-auth-session";
import { secrets } from "@okouai/db/schema/secret";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { googleFormsAutomationCursors } from "@okouai/db/schema/google-forms-event";
import { logger } from "../../lib/log";
import { publishCancelToRunnerGroup } from "../external/realtime";
import { tapError } from "../utils";
import {
  releaseNeverStartedRunSlots,
  transitionAgentRunsToTerminal,
  type ReleasedRunSlot,
} from "./agent-run-terminal-transition.service";
import { revokeMorningBriefScheduleOwnership } from "./morning-brief-schedule-claim.service";
import { eraseVncOwnerData$ } from "./vnc-owner-lifecycle.service";
import { deleteDiscordOrgMemberData$ } from "./discord-owner-cleanup.service";
import { eraseMailNotifications$ } from "./mail-notification.service";

import { command } from "ccstate";
import { writeDb$, type Db } from "../external/db";

interface OrgMemberCleanupInput {
  readonly orgId: string;
  readonly userId: string;
  readonly membershipId?: string;
}

const disableDepartedMemberAutomations$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly currentTime: Date;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0219; new non-billing transactions are prohibited.
    await db.transaction(async (tx) => {
      // Disabled Forms may be preparing a re-enable outside the database.
      // Touch their observation too so departure rejects that stale publication.
      const disabled = await tx
        .update(workflowAutomations)
        .set({ enabled: false, updatedAt: args.currentTime })
        .where(
          and(
            eq(workflowAutomations.orgId, args.orgId),
            eq(workflowAutomations.ownerUserId, args.userId),
            isNull(workflowAutomations.officialBlueprintKey),
          ),
        )
        .returning({
          id: workflowAutomations.id,
          eventType: workflowAutomations.eventType,
        });
      const formsIds = disabled
        .filter((row) => {
          return row.eventType === "google-forms-response-submitted";
        })
        .map((row) => {
          return row.id;
        });
      if (formsIds.length > 0) {
        await tx
          .delete(googleFormsAutomationCursors)
          .where(inArray(googleFormsAutomationCursors.automationId, formsIds));
      }
      signal.throwIfAborted();
    });
    signal.throwIfAborted();
  },
);

/** `onSlotsReleased` receives the slots the revoked runs released as soon as
 * the revocation commits, before any other effect of this cleanup. */
export const cleanupOrgMemberResources$ = command(
  async (
    { set },
    args: OrgMemberCleanupInput,
    onSlotsReleased: (slots: readonly ReleasedRunSlot[]) => void,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    await set(
      eraseVncOwnerData$,
      { kind: "owner", orgId: args.orgId, userId: args.userId },
      signal,
    );
    signal.throwIfAborted();
    await revokeOrgMemberRunAuthority(db, args, onSlotsReleased, signal);
    signal.throwIfAborted();
    await set(eraseMailNotifications$, args, signal);
    signal.throwIfAborted();
    await set(deleteDiscordOrgMemberData$, args, signal);
    signal.throwIfAborted();
    const currentTime = nowDate();
    // Automations execute as their owner. Only the schedule poller gates on
    // membership, and it does so lazily, at an automation's next due time; event
    // dispatchers select on `enabled`, `kind` and their own event match, so
    // nothing disarms those at all. Departure is the authoritative moment, so
    // both kinds lose their arming here. Disabling rather than deleting keeps
    // the configuration for a deliberate re-enable or reassignment, and an
    // explicit enable recomputes the schedule, so the `next_run_at` left behind
    // cannot fire on its own.
    //
    // An official installation is excluded because it does not own its enabled
    // bit: official reconciliation drives it from `official_intended_enabled`,
    // and this same cleanup already ends the installation's authority above by
    // marking the Morning Brief enrollment `departed` and revoking its Official
    // schedule, collection and delivery ownership. Disabling the row here would
    // both contend with that reconciler and silently pause the brief of a member
    // who rejoins.
    await set(
      disableDepartedMemberAutomations$,
      { ...args, currentTime },
      signal,
    );
    signal.throwIfAborted();
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
          membershipId:
            args.membershipId ?? morningBriefEnrollments.membershipId,
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
    signal.throwIfAborted();
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

    await db
      .delete(userDisabledPaidTools)
      .where(
        and(
          eq(userDisabledPaidTools.userId, args.userId),
          eq(userDisabledPaidTools.orgId, args.orgId),
        ),
      );
    signal.throwIfAborted();
  },
);

async function revokeOrgMemberRunAuthority(
  db: Db,
  args: { readonly orgId: string; readonly userId: string },
  onSlotsReleased: (slots: readonly ReleasedRunSlot[]) => void,
  signal: AbortSignal,
): Promise<void> {
  // Membership revocation is a hard authority boundary, including credentials
  // retained by ordinary personal-settings disconnect. Commit revocation before
  // best-effort runner notification or the remaining member resource cleanup.
  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0220; new non-billing transactions are prohibited.
  const { cancelled, releasedSlots } = await db.transaction(async (tx) => {
    const rows = await transitionAgentRunsToTerminal(tx, {
      values: {
        status: "cancelled",
        completedAt: nowDate(),
        runnerCancellationMode: "hard",
      },
      conditions: [
        eq(agentRuns.orgId, args.orgId),
        eq(agentRuns.userId, args.userId),
        inArray(agentRuns.status, ["pending", "running"]),
      ],
    });

    // The departing member's legacy schedule occurrences lose the same
    // authority here, before the rows they hang from are torn down.
    await revokeMorningBriefScheduleOwnership(tx, {
      kind: "membership",
      orgId: args.orgId,
      userId: args.userId,
    });

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
    const released = await releaseNeverStartedRunSlots(tx, rows);
    return { cancelled: rows, releasedSlots: released };
  });
  onSlotsReleased(releasedSlots);
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
