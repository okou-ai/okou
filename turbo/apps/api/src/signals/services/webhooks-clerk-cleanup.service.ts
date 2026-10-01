import { backgroundJobs } from "@okouai/db/schema/background-job";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { artifacts } from "@okouai/db/schema/artifact";
import { browserUserActionRequests } from "@okouai/db/schema/browser-session";
import { chatAgentRunContext } from "@okouai/db/schema/chat-agent-run-context";
import { cliTokens } from "@okouai/db/schema/cli-tokens";
import { cloudflareAccessConfigs } from "@okouai/db/schema/cloudflare-access-config";
import { composeJobs } from "@okouai/db/schema/compose-job";
import { connectors } from "@okouai/db/schema/connector";
import { builtinConnectorExternalCodeSessions } from "@okouai/db/schema/connector-external-code-session";
import { builtinConnectorOauthDeviceAuthorizationSessions } from "@okouai/db/schema/connector-oauth-device-authorization-session";
import { deviceCodes } from "@okouai/db/schema/device-codes";
import { exportJobs } from "@okouai/db/schema/export-job";
import { githubUserLinks } from "@okouai/db/schema/github-user-link";
import { modelProviders } from "@okouai/db/schema/model-provider";
import { modelProviderAuthSessions } from "@okouai/db/schema/model-provider-auth-session";
import { morningBriefEnrollments } from "@okouai/db/schema/morning-brief-enrollment";
import { orgCache } from "@okouai/db/schema/org-cache";
import { orgConcurrencyEntitlements } from "@okouai/db/schema/org-concurrency-entitlement";
import { orgConcurrencySubscriptions } from "@okouai/db/schema/org-concurrency-subscription";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgModelPolicies } from "@okouai/db/schema/org-model-policy";
import { piMemoryStage1Days } from "@okouai/db/schema/pi-memory-stage1-schedule";
import { secrets } from "@okouai/db/schema/secret";
import { sharedThreads } from "@okouai/db/schema/shared-thread";
import { slackOrgConnections } from "@okouai/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
import { sshCredentials } from "@okouai/db/schema/ssh-credential";
import { storages } from "@okouai/db/schema/storage";
import { users } from "@okouai/db/schema/user";
import { userCache } from "@okouai/db/schema/user-cache";
import { userDisabledPaidTools } from "@okouai/db/schema/user-disabled-paid-tools";
import { userPermissionGrants } from "@okouai/db/schema/user-permission-grant";
import { variables } from "@okouai/db/schema/variable";
import { command } from "ccstate";
import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNotNull,
  like,
  sql,
} from "drizzle-orm";
import { pgTextDecoder } from "../../lib/db-structured-result";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import {
  SHARED_THREAD_ARTIFACT_LOGICAL_KEY_PREFIX,
  sharedThreadArtifactAuthorUserId,
} from "../../lib/shared-thread-artifact";
import { nowDate } from "../../lib/time";
import { clerk$, createClerkReadContext } from "../external/clerk";
import { writeDb$, type Db } from "../external/db";
import { publishCancelToRunnerGroup } from "../external/realtime";
import {
  storageObjectCleanupJobValues,
  executeStorageObjectCleanupWork$,
} from "./storage-object-cleanup.service";
import {
  getStripeClient,
  listAllStripeSubscriptions,
} from "../external/stripe-client";
import { settle, tapError } from "../utils";
import { scheduleReleasedSlotPicks$ } from "./agent-run-lifecycle.service";
import {
  releaseNeverStartedRunSlots,
  transitionAgentRunsToTerminal,
  type ReleasedRunSlot,
} from "./agent-run-terminal-transition.service";
import { cancelEmptyUsagePackSubscription$ } from "./billing-downgrade.service";
import {
  deleteClerkAgentLifecycleData$,
  deleteStableContextLifecycleAfterAuthorityRemoval$,
} from "./clerk-agent-lifecycle.service";
import {
  deleteBuiltinConnectorLocalState$,
  loadStoredBuiltinConnectorRuntimeSnapshot$,
} from "./connector-data.service";
import { deleteConnectorOwnerState } from "./connector-owner-cleanup.service";
import {
  deleteDiscordOrgData,
  deleteDiscordUserData,
} from "./discord-owner-cleanup.service";
import { revokeMorningBriefCollectionOwnership } from "./morning-brief-collection-occurrence.service";
import { revokeMorningBriefDeliveryOwnership } from "./morning-brief-delivery.service";
import { revokeMorningBriefScheduleOwnership } from "./morning-brief-schedule-claim.service";
import { cancelAndRefundOrgBillingForDeletion } from "./org-deletion-billing.service";
import { cleanupOrgMemberResources$ } from "./org-member-cleanup.service";
import { organizationAgentRunScopePredicate } from "./pi-inference-lifecycle.service";
import { deleteStoragesWithPiMemoryCandidates } from "./pi-memory-stage1-candidate.service";
import { cleanupSharedThreadArtifacts$ } from "./shared-thread-artifacts.service";
import { removeUsagePackMemberAllocation } from "./usage-pack-allocation-change.service";
import { refundUsagePackMemberCredits } from "./usage-pack-credit-refund.service";
import { eraseVncOwnerData$ } from "./vnc-owner-lifecycle.service";

const L = logger("WebhookClerkCleanup");
const CLERK_ORG_MEMBERSHIP_PAGE_SIZE = 100;

async function publishCancelBestEffort(
  runnerGroup: string | null,
  runId: string,
): Promise<void> {
  if (!runnerGroup) {
    return;
  }
  await tapError(
    publishCancelToRunnerGroup(runnerGroup, runId, "hard"),
    (error) => {
      L.warn("failed to publish run cancellation", {
        runId,
        runnerGroup,
        error,
      });
    },
  );
}

/**
 * What a deletion's first committed transaction revokes beyond its own runs.
 *
 * `cascadeOwnedAgents` widens organization run cancellation to the owned Agent
 * cascade, and `revokeMorningBriefCollection` joins Morning Brief collection
 * ownership to that same commit. User deletion and bans only ever cancel the
 * user's own runs; members' runs on Agents the user owns continue.
 */
interface OrgRunCancellationScope {
  readonly cascadeOwnedAgents?: boolean;
  readonly revokeMorningBriefCollection?: boolean;
}

interface UserRunCancellationScope {
  readonly revokeMorningBriefCollection?: boolean;
}

type SlotsReleased = (slots: readonly ReleasedRunSlot[]) => void;

/** Collects released slots for a deletion that schedules their picks only
 * after the deleted owner's data, and with it the owner's queued threads, is
 * gone. */
function releasedSlotCollector(): {
  readonly slots: ReleasedRunSlot[];
  readonly collect: SlotsReleased;
} {
  const slots: ReleasedRunSlot[] = [];
  return {
    slots,
    collect(released) {
      slots.push(...released);
    },
  };
}

/** `onSlotsReleased` receives the released slots once the cancellation
 * commits, before the runner notifications. */
async function cancelOrgRuns(
  db: Db,
  orgId: string,
  onSlotsReleased: SlotsReleased,
  scope: OrgRunCancellationScope = {},
): Promise<void> {
  const revokedAt = nowDate();
  const { cancelled, releasedSlots } = await db.transaction(async (tx) => {
    const rows = await transitionAgentRunsToTerminal(tx, {
      values: {
        status: "cancelled",
        completedAt: nowDate(),
        runnerCancellationMode: "hard",
      },
      conditions: [
        scope.cascadeOwnedAgents
          ? organizationAgentRunScopePredicate(tx, orgId)
          : eq(agentRuns.orgId, orgId),
        inArray(agentRuns.status, ["pending", "running"]),
      ],
    });
    if (scope.revokeMorningBriefCollection) {
      await revokeMorningBriefCollectionOwnership(
        tx,
        { kind: "organization", orgId },
        revokedAt,
      );
      // Same transaction, same reason: an unsent native intent still holds the
      // recipient and the rendered brief.
      await revokeMorningBriefDeliveryOwnership(tx, {
        kind: "organization",
        orgId,
      });
    }
    const released = await releaseNeverStartedRunSlots(tx, rows);
    return { cancelled: rows, releasedSlots: released };
  });
  onSlotsReleased(releasedSlots);
  await Promise.all(
    cancelled.map((run) => {
      return publishCancelBestEffort(run.runnerGroup, run.runId);
    }),
  );
}

async function cancelLastAdminOrgsStripeSubscriptions(
  db: Db,
  userId: string,
): Promise<void> {
  const adminOrgs = await db
    .select({ orgId: orgMembersCache.orgId })
    .from(orgMembersCache)
    .where(
      and(
        eq(orgMembersCache.userId, userId),
        eq(orgMembersCache.role, "admin"),
      ),
    );

  for (const { orgId } of adminOrgs) {
    const [result] = await db
      .select({ adminCount: count() })
      .from(orgMembersCache)
      .where(
        and(
          eq(orgMembersCache.orgId, orgId),
          eq(orgMembersCache.role, "admin"),
        ),
      );

    if ((result?.adminCount ?? 0) <= 1) {
      await tapError(
        cancelStripeSubscriptionsForDeletedOrg(db, orgId),
        (error) => {
          L.warn(
            "failed to cancel stripe subscriptions for banned last admin",
            {
              userId,
              orgId,
              error,
            },
          );
        },
      );
    }
  }
}

/** Same `onSlotsReleased` contract as `cancelOrgRuns`. */
async function cancelUserRuns(
  db: Db,
  userId: string,
  onSlotsReleased: SlotsReleased,
  scope: UserRunCancellationScope = {},
): Promise<void> {
  const revokedAt = nowDate();
  const { cancelled, releasedSlots } = await db.transaction(async (tx) => {
    const rows = await transitionAgentRunsToTerminal(tx, {
      values: {
        status: "cancelled",
        completedAt: nowDate(),
        runnerCancellationMode: "hard",
      },
      conditions: [
        eq(agentRuns.userId, userId),
        inArray(agentRuns.status, ["pending", "running"]),
      ],
    });
    if (scope.revokeMorningBriefCollection) {
      await revokeMorningBriefCollectionOwnership(
        tx,
        { kind: "user", userId },
        revokedAt,
      );
      await revokeMorningBriefDeliveryOwnership(tx, { kind: "user", userId });
    }
    const released = await releaseNeverStartedRunSlots(tx, rows);
    return { cancelled: rows, releasedSlots: released };
  });
  onSlotsReleased(releasedSlots);
  await Promise.all(
    cancelled.map((run) => {
      return publishCancelBestEffort(run.runnerGroup, run.runId);
    }),
  );
}

async function cleanupWorkspaceInstallation(
  db: Db,
  workspaceId: string,
): Promise<void> {
  await db
    .delete(slackOrgConnections)
    .where(eq(slackOrgConnections.slackWorkspaceId, workspaceId));
  await db
    .delete(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, workspaceId));
}

interface StripeSubscriptionCleanupTargets {
  readonly cancelNowSubscriptionIds: Set<string>;
  readonly cancelAtPeriodEndSubscriptionIds: Set<string>;
  readonly nonRenewingSubscriptionIds: Set<string>;
}

function queueStripeSubscriptionCleanup(
  targets: StripeSubscriptionCleanupTargets,
  subscription: {
    readonly id: string;
    readonly status: string | null;
    readonly cancel_at_period_end: boolean | null;
  },
): void {
  if (subscription.status === "canceled") {
    targets.nonRenewingSubscriptionIds.add(subscription.id);
    return;
  }

  if (subscription.status === "trialing") {
    targets.cancelNowSubscriptionIds.add(subscription.id);
    return;
  }

  if (subscription.cancel_at_period_end) {
    targets.nonRenewingSubscriptionIds.add(subscription.id);
    return;
  }

  targets.cancelAtPeriodEndSubscriptionIds.add(subscription.id);
}

function queueFallbackStripeSubscriptionCleanup(
  targets: StripeSubscriptionCleanupTargets,
  subscriptionId: string | null,
  subscriptionStatus: string | null,
): void {
  if (
    !subscriptionId ||
    subscriptionStatus === "canceled" ||
    targets.nonRenewingSubscriptionIds.has(subscriptionId) ||
    targets.cancelNowSubscriptionIds.has(subscriptionId) ||
    targets.cancelAtPeriodEndSubscriptionIds.has(subscriptionId)
  ) {
    return;
  }

  if (subscriptionStatus === "trialing") {
    targets.cancelNowSubscriptionIds.add(subscriptionId);
    return;
  }

  targets.cancelAtPeriodEndSubscriptionIds.add(subscriptionId);
}

async function cancelStripeSubscriptionsForDeletedOrg(
  db: Db,
  orgId: string,
): Promise<void> {
  const [meta] = await db
    .select({
      stripeCustomerId: orgMetadata.stripeCustomerId,
      stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
      subscriptionStatus: orgMetadata.subscriptionStatus,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);

  if (!meta?.stripeCustomerId && !meta?.stripeSubscriptionId) {
    return;
  }

  const stripe = getStripeClient();
  const targets: StripeSubscriptionCleanupTargets = {
    cancelNowSubscriptionIds: new Set<string>(),
    cancelAtPeriodEndSubscriptionIds: new Set<string>(),
    nonRenewingSubscriptionIds: new Set<string>(),
  };

  if (meta.stripeCustomerId) {
    const subscriptions = await listAllStripeSubscriptions(stripe, {
      customer: meta.stripeCustomerId,
      status: "all",
    });
    for (const subscription of subscriptions) {
      queueStripeSubscriptionCleanup(targets, subscription);
    }
  }

  queueFallbackStripeSubscriptionCleanup(
    targets,
    meta.stripeSubscriptionId,
    meta.subscriptionStatus,
  );

  for (const subscriptionId of targets.cancelNowSubscriptionIds) {
    await stripe.subscriptions.cancel(subscriptionId);
  }

  for (const subscriptionId of targets.cancelAtPeriodEndSubscriptionIds) {
    await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
    });
  }
}

const revokeOrgConnectorTokens$ = command(
  async ({ set }, orgId: string, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    const snapshot = await set(
      loadStoredBuiltinConnectorRuntimeSnapshot$,
      signal,
    );
    signal.throwIfAborted();
    const rows = await db
      .select({
        connectorId: connectors.id,
        userId: connectors.userId,
        connectorSlug: sql`${connectors.connectorSlug}`
          .mapWith(pgTextDecoder)
          .as("connector_slug"),
      })
      .from(connectors)
      .where(
        and(eq(connectors.orgId, orgId), isNotNull(connectors.connectorSlug)),
      );
    signal.throwIfAborted();

    for (const row of rows) {
      await set(
        deleteBuiltinConnectorLocalState$,
        {
          orgId,
          userId: row.userId,
          connectorSlug: row.connectorSlug,
          sourceId: row.connectorId,
          snapshot,
        },
        signal,
      );
    }
  },
);

const revokeUserConnectorTokens$ = command(
  async ({ set }, userId: string, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    const snapshot = await set(
      loadStoredBuiltinConnectorRuntimeSnapshot$,
      signal,
    );
    signal.throwIfAborted();
    const rows = await db
      .select({
        connectorId: connectors.id,
        orgId: connectors.orgId,
        connectorSlug: sql`${connectors.connectorSlug}`
          .mapWith(pgTextDecoder)
          .as("connector_slug"),
      })
      .from(connectors)
      .where(
        and(eq(connectors.userId, userId), isNotNull(connectors.connectorSlug)),
      );
    signal.throwIfAborted();

    for (const row of rows) {
      await set(
        deleteBuiltinConnectorLocalState$,
        {
          orgId: row.orgId,
          userId,
          connectorSlug: row.connectorSlug,
          sourceId: row.connectorId,
          snapshot,
        },
        signal,
      );
    }
  },
);

const cleanupOrgExternalServices$ = command(
  async (
    { set },
    orgId: string,
    required: boolean,
    signal: AbortSignal,
  ): Promise<void> => {
    const steps: readonly {
      readonly name: string;
      readonly run: () => Promise<void>;
    }[] = [
      {
        name: "connector tokens",
        run: () => {
          return set(revokeOrgConnectorTokens$, orgId, signal);
        },
      },
    ];

    for (const step of steps) {
      if (required) {
        await step.run();
      } else {
        await tapError(step.run(), (error) => {
          L.warn(`failed to cleanup ${step.name}`, { orgId, error });
        });
      }
      signal.throwIfAborted();
    }
  },
);

const cleanupUserExternalServices$ = command(
  async ({ set }, userId: string, signal: AbortSignal): Promise<void> => {
    await set(revokeUserConnectorTokens$, userId, signal);
    signal.throwIfAborted();
  },
);

async function emptyOrgIdsAfterDeletingUser(
  db: Db,
  clerk: ReturnType<typeof clerk$.read>,
  userId: string,
  signal: AbortSignal,
): Promise<readonly string[]> {
  const membershipRows = await db
    .select({ orgId: orgMembersCache.orgId })
    .from(orgMembersCache)
    .where(eq(orgMembersCache.userId, userId));
  const createdRows = await db
    .select({ orgId: orgCache.orgId })
    .from(orgCache)
    .where(eq(orgCache.createdBy, userId));

  const candidateOrgIds = new Set<string>();
  for (const row of membershipRows) {
    candidateOrgIds.add(row.orgId);
  }
  for (const row of createdRows) {
    candidateOrgIds.add(row.orgId);
  }

  const emptyOrgIds: string[] = [];
  for (const orgId of candidateOrgIds) {
    if (await isClerkOrgEmptyAfterDeletingUser(clerk, orgId, userId, signal)) {
      emptyOrgIds.push(orgId);
    }
  }

  return emptyOrgIds;
}

function isClerkNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  return (
    Reflect.get(error, "statusCode") === 404 ||
    Reflect.get(error, "code") === "NOT_FOUND" ||
    Reflect.get(error, "name") === "NotFoundError"
  );
}

async function isClerkOrgEmptyAfterDeletingUser(
  clerk: ReturnType<typeof clerk$.read>,
  orgId: string,
  userId: string,
  signal: AbortSignal,
): Promise<boolean> {
  const readContext = createClerkReadContext();
  for (let offset = 0; ; offset += CLERK_ORG_MEMBERSHIP_PAGE_SIZE) {
    const memberships = await settle(
      clerk.organizations.getOrganizationMembershipList(
        {
          organizationId: orgId,
          limit: CLERK_ORG_MEMBERSHIP_PAGE_SIZE,
          offset,
        },
        readContext,
        signal,
      ),
      signal,
    );
    signal.throwIfAborted();

    if (!memberships.ok) {
      if (isClerkNotFound(memberships.error)) {
        return true;
      }
      throw memberships.error;
    }

    for (const membership of memberships.value.data) {
      const memberUserId = membership.publicUserData?.userId;
      if (!memberUserId || memberUserId !== userId) {
        return false;
      }
    }

    if (memberships.value.data.length < CLERK_ORG_MEMBERSHIP_PAGE_SIZE) {
      return true;
    }
  }
}

type ClerkStorageCleanupScope =
  | { readonly kind: "organization"; readonly orgId: string }
  | { readonly kind: "user"; readonly userId: string };

async function deleteClerkStorageReferences(
  db: Db,
  scope: ClerkStorageCleanupScope,
  signal: AbortSignal,
): Promise<string[]> {
  return await db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: storages.id,
        orgId: storages.orgId,
        userId: storages.userId,
        s3Prefix: storages.s3Prefix,
      })
      .from(storages)
      .where(
        scope.kind === "organization"
          ? eq(storages.orgId, scope.orgId)
          : eq(storages.userId, scope.userId),
      )
      .orderBy(asc(storages.id));
    signal.throwIfAborted();
    if (rows.length === 0) {
      return [];
    }
    await deleteStoragesWithPiMemoryCandidates(
      tx,
      inArray(
        storages.id,
        rows.map((row) => {
          return row.id;
        }),
      ),
    );
    signal.throwIfAborted();
    const jobIds: string[] = [];
    for (const row of rows) {
      // Preserve the existing user-deletion boundary: legacy prefixes may be
      // shared. Org-owned instruction Storage belongs to retained Agents.
      if (scope.kind === "user" && row.s3Prefix !== `${row.orgId}/${row.id}`) {
        continue;
      }
      const receipt = storageObjectCleanupJobValues({
        bucket: env("R2_USER_STORAGES_BUCKET_NAME"),
        target: { kind: "prefix", value: row.s3Prefix },
        userId: row.userId,
        orgId: row.orgId,
      });
      await tx
        .insert(backgroundJobs)
        .values(receipt)
        .onConflictDoNothing({ target: backgroundJobs.id });
      signal.throwIfAborted();
      jobIds.push(receipt.id);
    }
    return jobIds;
  });
}

async function deleteClerkExportReferences(
  db: Db,
  scope: ClerkStorageCleanupScope,
  signal: AbortSignal,
): Promise<string[]> {
  return await db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: exportJobs.id,
        orgId: exportJobs.orgId,
        userId: exportJobs.userId,
        s3Key: exportJobs.s3Key,
      })
      .from(exportJobs)
      .where(
        scope.kind === "organization"
          ? eq(exportJobs.orgId, scope.orgId)
          : eq(exportJobs.userId, scope.userId),
      )
      .orderBy(asc(exportJobs.id));
    signal.throwIfAborted();
    if (rows.length === 0) {
      return [];
    }
    await tx.delete(exportJobs).where(
      inArray(
        exportJobs.id,
        rows.map((row) => {
          return row.id;
        }),
      ),
    );
    signal.throwIfAborted();
    const jobIds: string[] = [];
    for (const row of rows) {
      if (row.s3Key === null) {
        continue;
      }
      const receipt = storageObjectCleanupJobValues({
        bucket: env("R2_USER_STORAGES_BUCKET_NAME"),
        target: { kind: "key", value: row.s3Key },
        userId: row.userId,
        orgId: row.orgId,
      });
      await tx
        .insert(backgroundJobs)
        .values(receipt)
        .onConflictDoNothing({ target: backgroundJobs.id });
      signal.throwIfAborted();
      jobIds.push(receipt.id);
    }
    return jobIds;
  });
}

async function deleteClerkSshResources(
  db: Db,
  scope: ClerkStorageCleanupScope,
) {
  await db.transaction(async (tx) => {
    await tx
      .delete(sshConnections)
      .where(
        scope.kind === "organization"
          ? eq(sshConnections.orgId, scope.orgId)
          : eq(sshConnections.userId, scope.userId),
      );
    await tx
      .delete(sshCredentials)
      .where(
        scope.kind === "organization"
          ? eq(sshCredentials.orgId, scope.orgId)
          : eq(sshCredentials.userId, scope.userId),
      );
    await tx
      .delete(cloudflareAccessConfigs)
      .where(
        scope.kind === "organization"
          ? eq(cloudflareAccessConfigs.orgId, scope.orgId)
          : eq(cloudflareAccessConfigs.userId, scope.userId),
      );
  });
}

const deleteOrgData$ = command(
  async (
    { set },
    orgId: string,
    signal: AbortSignal,
  ): Promise<{
    readonly slots: readonly ReleasedRunSlot[];
    readonly cleanupJobIds: string[];
  }> => {
    const db = set(writeDb$);
    const released = releasedSlotCollector();
    await cancelOrgRuns(db, orgId, released.collect);
    signal.throwIfAborted();
    await deleteDiscordOrgData(db, orgId);
    signal.throwIfAborted();

    const installations = await db
      .select({ slackWorkspaceId: slackOrgInstallations.slackWorkspaceId })
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.orgId, orgId));
    signal.throwIfAborted();
    for (const installation of installations) {
      await cleanupWorkspaceInstallation(db, installation.slackWorkspaceId);
      signal.throwIfAborted();
    }

    await db.delete(sharedThreads).where(
      inArray(
        sharedThreads.id,
        db
          .select({ id: artifacts.entityId })
          .from(artifacts)
          .where(
            and(
              eq(artifacts.orgId, orgId),
              like(
                artifacts.logicalKey,
                `${SHARED_THREAD_ARTIFACT_LOGICAL_KEY_PREFIX}%`,
              ),
            ),
          ),
      ),
    );
    signal.throwIfAborted();
    await db.delete(artifacts).where(eq(artifacts.orgId, orgId));
    signal.throwIfAborted();
    await db
      .delete(browserUserActionRequests)
      .where(eq(browserUserActionRequests.orgId, orgId));
    signal.throwIfAborted();
    await db
      .delete(chatAgentRunContext)
      .where(eq(chatAgentRunContext.sourceOrgId, orgId));
    signal.throwIfAborted();
    await set(
      deleteClerkAgentLifecycleData$,
      { kind: "organization", orgId },
      signal,
    );
    signal.throwIfAborted();
    // VNC references were removed at the start of organization cleanup. Remove
    // Access rows before SSH hosts: rotation takes config then host locks.
    // Delete hosts before credentials and configs for the restrictive FK.
    await deleteClerkSshResources(db, { kind: "organization", orgId });
    signal.throwIfAborted();
    await deleteConnectorOwnerState(
      db,
      { kind: "organization", orgId },
      signal,
    );
    signal.throwIfAborted();
    const cleanupJobIds = await deleteClerkStorageReferences(
      db,
      { kind: "organization", orgId },
      signal,
    );
    signal.throwIfAborted();
    for (const table of [
      modelProviders,
      modelProviderAuthSessions,
      secrets,
      variables,
      builtinConnectorOauthDeviceAuthorizationSessions,
      builtinConnectorExternalCodeSessions,
    ]) {
      await db.delete(table).where(eq(table.orgId, orgId));
      signal.throwIfAborted();
    }
    cleanupJobIds.push(
      ...(await deleteClerkExportReferences(
        db,
        { kind: "organization", orgId },
        signal,
      )),
    );
    await db
      .delete(orgConcurrencyEntitlements)
      .where(eq(orgConcurrencyEntitlements.orgId, orgId));
    signal.throwIfAborted();
    await db
      .delete(orgConcurrencySubscriptions)
      .where(eq(orgConcurrencySubscriptions.orgId, orgId));
    signal.throwIfAborted();
    await db.delete(orgMembersCache).where(eq(orgMembersCache.orgId, orgId));
    signal.throwIfAborted();
    // Membership is the durable stable-context admission parent. Re-run only
    // stable-context cleanup after removing it so a request that raced the early
    // pass cannot recreate state or repeat unrelated usage/billing lifecycle.
    await set(
      deleteStableContextLifecycleAfterAuthorityRemoval$,
      { kind: "organization", orgId },
      signal,
    );
    signal.throwIfAborted();
    await db
      .delete(orgMembersMetadata)
      .where(eq(orgMembersMetadata.orgId, orgId));
    signal.throwIfAborted();
    await db
      .delete(userDisabledPaidTools)
      .where(eq(userDisabledPaidTools.orgId, orgId));
    signal.throwIfAborted();
    await db.delete(orgCache).where(eq(orgCache.orgId, orgId));
    signal.throwIfAborted();
    await db
      .delete(morningBriefEnrollments)
      .where(eq(morningBriefEnrollments.orgId, orgId));
    signal.throwIfAborted();
    await db.delete(orgModelPolicies).where(eq(orgModelPolicies.orgId, orgId));
    signal.throwIfAborted();
    await db.delete(orgMetadata).where(eq(orgMetadata.orgId, orgId));
    signal.throwIfAborted();
    return { slots: released.slots, cleanupJobIds };
  },
);

const deleteUserData$ = command(
  async (
    { set },
    userId: string,
    signal: AbortSignal,
  ): Promise<{
    readonly slots: readonly ReleasedRunSlot[];
    readonly cleanupJobIds: string[];
  }> => {
    const db = set(writeDb$);
    const released = releasedSlotCollector();
    await cancelUserRuns(db, userId, released.collect);
    signal.throwIfAborted();
    await deleteDiscordUserData(db, userId);
    signal.throwIfAborted();

    await db
      .delete(slackOrgConnections)
      .where(eq(slackOrgConnections.userId, userId));
    signal.throwIfAborted();
    await db.delete(githubUserLinks).where(eq(githubUserLinks.userId, userId));
    signal.throwIfAborted();
    await db
      .delete(artifacts)
      .where(
        inArray(artifacts.authorUserId, [
          userId,
          sharedThreadArtifactAuthorUserId(userId),
        ]),
      );
    signal.throwIfAborted();
    await db.delete(sharedThreads).where(eq(sharedThreads.userId, userId));
    signal.throwIfAborted();
    await db
      .delete(browserUserActionRequests)
      .where(eq(browserUserActionRequests.userId, userId));
    signal.throwIfAborted();
    await db
      .delete(chatAgentRunContext)
      .where(eq(chatAgentRunContext.sourceUserId, userId));
    signal.throwIfAborted();
    await set(deleteClerkAgentLifecycleData$, { kind: "user", userId }, signal);
    // VNC references were removed before user cleanup. Delete only this user's
    // SSH resources and personal Access configurations; organization Access
    // configurations have no user owner and must survive creator deletion.
    // Take config locks first to match token rotation's config-then-host order.
    await deleteClerkSshResources(db, { kind: "user", userId });
    signal.throwIfAborted();
    const cleanupJobIds = await deleteClerkStorageReferences(
      db,
      { kind: "user", userId },
      signal,
    );
    signal.throwIfAborted();
    await db
      .delete(piMemoryStage1Days)
      .where(eq(piMemoryStage1Days.userId, userId));
    signal.throwIfAborted();
    await db.delete(modelProviders).where(eq(modelProviders.userId, userId));
    signal.throwIfAborted();
    await db
      .delete(modelProviderAuthSessions)
      .where(eq(modelProviderAuthSessions.userId, userId));
    signal.throwIfAborted();
    await deleteConnectorOwnerState(db, { kind: "user", userId }, signal);
    await db.delete(secrets).where(eq(secrets.userId, userId));
    signal.throwIfAborted();
    await db.delete(variables).where(eq(variables.userId, userId));
    signal.throwIfAborted();
    cleanupJobIds.push(
      ...(await deleteClerkExportReferences(
        db,
        { kind: "user", userId },
        signal,
      )),
    );
    signal.throwIfAborted();
    await db.delete(cliTokens).where(eq(cliTokens.userId, userId));
    signal.throwIfAborted();
    await db.delete(composeJobs).where(eq(composeJobs.userId, userId));
    signal.throwIfAborted();
    await db
      .delete(builtinConnectorOauthDeviceAuthorizationSessions)
      .where(
        eq(builtinConnectorOauthDeviceAuthorizationSessions.userId, userId),
      );
    signal.throwIfAborted();
    await db
      .delete(builtinConnectorExternalCodeSessions)
      .where(eq(builtinConnectorExternalCodeSessions.userId, userId));
    signal.throwIfAborted();
    await db.delete(deviceCodes).where(eq(deviceCodes.userId, userId));
    signal.throwIfAborted();
    await db
      .delete(userPermissionGrants)
      .where(eq(userPermissionGrants.userId, userId));
    signal.throwIfAborted();
    await db.delete(orgMembersCache).where(eq(orgMembersCache.userId, userId));
    signal.throwIfAborted();
    // Close the initialization interval between the early Agent cleanup and the
    // authoritative membership removal. Future initialization now fails its
    // parent lock; this narrow second pass removes any state created before it.
    await set(
      deleteStableContextLifecycleAfterAuthorityRemoval$,
      { kind: "user", userId },
      signal,
    );
    signal.throwIfAborted();
    await db
      .delete(morningBriefEnrollments)
      .where(eq(morningBriefEnrollments.userId, userId));
    signal.throwIfAborted();
    await db
      .delete(orgMembersMetadata)
      .where(eq(orgMembersMetadata.userId, userId));
    signal.throwIfAborted();
    await db
      .delete(userDisabledPaidTools)
      .where(eq(userDisabledPaidTools.userId, userId));
    signal.throwIfAborted();
    await db.delete(userCache).where(eq(userCache.userId, userId));
    signal.throwIfAborted();
    await db.delete(users).where(eq(users.id, userId));
    signal.throwIfAborted();
    return { slots: released.slots, cleanupJobIds };
  },
);

export const cleanupClerkDeletedOrg$ = command(
  async ({ set }, orgId: string, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    const released = releasedSlotCollector();
    await set(eraseVncOwnerData$, { kind: "organization", orgId }, signal);
    signal.throwIfAborted();
    await cancelOrgRuns(db, orgId, released.collect, {
      cascadeOwnedAgents: true,
      revokeMorningBriefCollection: true,
    });
    signal.throwIfAborted();
    await revokeMorningBriefScheduleOwnership(db, {
      kind: "organization",
      orgId,
    });
    signal.throwIfAborted();
    await set(
      cleanupSharedThreadArtifacts$,
      { kind: "organization", orgId },
      signal,
    );
    await set(cleanupOrgExternalServices$, orgId, false, signal);
    signal.throwIfAborted();
    const removed = await set(deleteOrgData$, orgId, signal);
    released.collect(removed.slots);
    signal.throwIfAborted();
    // Picked only once the data is gone: deleting the organization's Agents
    // cascaded its chat threads and their queued rows, so nothing launches.
    set(scheduleReleasedSlotPicks$, released.slots, signal);
    await set(
      executeStorageObjectCleanupWork$,
      { jobIds: removed.cleanupJobIds },
      signal,
    );
  },
);

export const cleanupClerkDeletedOrgBilling$ = command(
  async ({ set }, orgId: string, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    await cancelAndRefundOrgBillingForDeletion(db, orgId, signal);
    signal.throwIfAborted();
  },
);

export const cleanupClerkDeletedUser$ = command(
  async (
    { get, set },
    args: {
      readonly userId: string;
      readonly emptyOrgIds?: readonly string[];
      readonly checkpointEmptyOrgIds: (
        orgIds: readonly string[],
        signal: AbortSignal,
      ) => Promise<void>;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const { userId } = args;
    const db = set(writeDb$);
    const released = releasedSlotCollector();
    await set(eraseVncOwnerData$, { kind: "user", userId }, signal);
    signal.throwIfAborted();
    // Only the user's own runs: members' runs on Agents the user owns continue.
    await cancelUserRuns(db, userId, released.collect, {
      revokeMorningBriefCollection: true,
    });
    signal.throwIfAborted();
    await revokeMorningBriefScheduleOwnership(db, { kind: "user", userId });
    signal.throwIfAborted();
    await set(cleanupSharedThreadArtifacts$, { kind: "user", userId }, signal);
    const emptyOrgIds =
      args.emptyOrgIds ??
      (await emptyOrgIdsAfterDeletingUser(db, get(clerk$), userId, signal));
    signal.throwIfAborted();
    if (args.emptyOrgIds === undefined) {
      await args.checkpointEmptyOrgIds(emptyOrgIds, signal);
      signal.throwIfAborted();
    }

    await set(cleanupUserExternalServices$, userId, signal);
    signal.throwIfAborted();
    for (const orgId of emptyOrgIds) {
      signal.throwIfAborted();
      await set(eraseVncOwnerData$, { kind: "organization", orgId }, signal);
      signal.throwIfAborted();
      await cancelOrgRuns(db, orgId, released.collect, {
        cascadeOwnedAgents: true,
        revokeMorningBriefCollection: true,
      });
      signal.throwIfAborted();
      await revokeMorningBriefScheduleOwnership(db, {
        kind: "organization",
        orgId,
      });
      signal.throwIfAborted();
      await set(
        cleanupSharedThreadArtifacts$,
        { kind: "organization", orgId },
        signal,
      );
      await cancelStripeSubscriptionsForDeletedOrg(db, orgId);
      signal.throwIfAborted();
      await set(cleanupOrgExternalServices$, orgId, true, signal);
      signal.throwIfAborted();
    }

    const removed = await set(deleteUserData$, userId, signal);
    released.collect(removed.slots);
    const cleanupJobIds = removed.cleanupJobIds;
    signal.throwIfAborted();
    for (const orgId of emptyOrgIds) {
      const removedOrg = await set(deleteOrgData$, orgId, signal);
      released.collect(removedOrg.slots);
      cleanupJobIds.push(...removedOrg.cleanupJobIds);
      signal.throwIfAborted();
    }
    // Picked only once the user's data is gone, so the slots go to other
    // members' waiting threads.
    set(scheduleReleasedSlotPicks$, released.slots, signal);
    await set(
      executeStorageObjectCleanupWork$,
      { jobIds: cleanupJobIds },
      signal,
    );
  },
);

const commitClerkDeletedOrgMembershipCleanup$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly membershipId?: string;
    },
    onSlotsReleased: SlotsReleased,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    const db = set(writeDb$);
    const emptyCancellation = await removeUsagePackMemberAllocation(
      db,
      args,
      signal,
    );
    signal.throwIfAborted();
    if (emptyCancellation) {
      await set(cancelEmptyUsagePackSubscription$, emptyCancellation, signal);
      signal.throwIfAborted();
    }
    await refundUsagePackMemberCredits(db, args, signal);
    signal.throwIfAborted();
    await set(cleanupOrgMemberResources$, args, onSlotsReleased, signal);
    signal.throwIfAborted();
  },
);

export const cleanupClerkDeletedOrgMembership$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly membershipId?: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    await set(
      commitClerkDeletedOrgMembershipCleanup$,
      args,
      (slots) => {
        set(scheduleReleasedSlotPicks$, slots, signal);
      },
      new AbortController().signal,
    );

    signal.throwIfAborted();
  },
);

export const cleanupClerkBannedUser$ = command(
  async ({ set }, userId: string, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    await cancelUserRuns(db, userId, (slots) => {
      set(scheduleReleasedSlotPicks$, slots, signal);
    });
    signal.throwIfAborted();
    await cancelLastAdminOrgsStripeSubscriptions(db, userId);
  },
);
