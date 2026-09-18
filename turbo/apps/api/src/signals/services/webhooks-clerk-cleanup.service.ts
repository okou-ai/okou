import { deletePiObjectOrphansForOwner } from "./pi-inference-object.service";
import {
  assertPiInferenceScopeErasureReady,
  piInferenceErasureScopePredicate,
} from "./pi-inference-lifecycle.service";
import { piMemoryStage1Days } from "@okouai/db/schema/pi-memory-stage1-schedule";
import { morningBriefEnrollments } from "@okouai/db/schema/morning-brief-enrollment";
import { cleanupSharedThreadArtifacts$ } from "./shared-thread-artifacts.service";
import { agents } from "@okouai/db/schema/agent";
import { agentRunQueue } from "@okouai/db/schema/agent-run-queue";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { artifacts } from "@okouai/db/schema/artifact";
import { cliTokens } from "@okouai/db/schema/cli-tokens";
import { composeJobs } from "@okouai/db/schema/compose-job";
import { connectorExternalCodeSessions } from "@okouai/db/schema/connector-external-code-session";
import { connectorOauthDeviceAuthorizationSessions } from "@okouai/db/schema/connector-oauth-device-authorization-session";
import { connectors } from "@okouai/db/schema/connector";
import { deviceCodes } from "@okouai/db/schema/device-codes";
import { exportJobs } from "@okouai/db/schema/export-job";
import { githubUserLinks } from "@okouai/db/schema/github-user-link";
import { modelProviderAuthSessions } from "@okouai/db/schema/model-provider-auth-session";
import { modelProviders } from "@okouai/db/schema/model-provider";
import { orgCache } from "@okouai/db/schema/org-cache";
import { orgConcurrencyEntitlements } from "@okouai/db/schema/org-concurrency-entitlement";
import { orgConcurrencySubscriptions } from "@okouai/db/schema/org-concurrency-subscription";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { userDisabledPaidTools } from "@okouai/db/schema/user-disabled-paid-tools";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { secrets } from "@okouai/db/schema/secret";
import { slackOrgConnections } from "@okouai/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { sharedThreads } from "@okouai/db/schema/shared-thread";
import { storages } from "@okouai/db/schema/storage";
import { telegramInstallations } from "@okouai/db/schema/telegram-installation";
import { telegramUserLinks } from "@okouai/db/schema/telegram-user-link";
import { userCache } from "@okouai/db/schema/user-cache";
import { users } from "@okouai/db/schema/user";
import { userPermissionGrants } from "@okouai/db/schema/user-permission-grant";
import { variables } from "@okouai/db/schema/variable";
import {
  getInstructionsStorageName,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import { command, computed, type Computed } from "ccstate";
import { and, count, eq, inArray, isNotNull, like, or, sql } from "drizzle-orm";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { pgTextDecoder } from "../../lib/db-structured-result";
import {
  sharedThreadArtifactAuthorUserId,
  SHARED_THREAD_ARTIFACT_LOGICAL_KEY_PREFIX,
} from "../../lib/shared-thread-artifact";
import { clerk$, createClerkReadContext } from "../external/clerk";
import { writeDb$, type Db } from "../external/db";
import {
  deleteS3Objects,
  listS3Objects,
  listS3ObjectsUnderPrefix,
} from "../external/s3";
import { nowDate } from "../../lib/time";
import { publishCancelToRunnerGroup } from "../external/realtime";
import { deleteWebhook } from "../external/telegram-client";
import {
  getStripeClient,
  listAllStripeSubscriptions,
} from "../external/stripe-client";
import { settle, tapError } from "../utils";
import { decryptPersistentSecretValue } from "./crypto.utils";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { cancelAndRefundOrgBillingForDeletion } from "./org-deletion-billing.service";
import { cleanupOrgMemberResources } from "./org-member-cleanup.service";
import { removeUsagePackMemberAllocation } from "./usage-pack-allocation-change.service";
import { refundUsagePackMemberCredits } from "./usage-pack-credit-refund.service";
import {
  deleteConnectorLocalState$,
  loadStoredConnectorRuntimeSnapshot,
} from "./connector-data.service";
import {
  AGENT_LIFECYCLE_LOCK_TIMEOUT,
  deleteClerkAgentLifecycleData,
} from "./agent-lifecycle.service";
import { deleteConnectorOwnerState } from "./connector-owner-cleanup.service";
import { revokeMorningBriefCollectionOwnership } from "./morning-brief-collection-occurrence.service";
import { revokeMorningBriefDeliveryOwnership } from "./morning-brief-delivery.service";
import { revokeMorningBriefScheduleOwnership } from "./morning-brief-schedule-claim.service";
import { deleteStoragesWithPiMemoryCandidates } from "./pi-memory-stage1-candidate.service";
import { transitionAgentRunsToTerminal } from "./agent-run-terminal-transition.service";
import { eraseVncOwnerData } from "./vnc-owner-lifecycle.service";

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
 * `cascadeOwnedAgents` widens run cancellation to the erasure scope, and
 * `revokeMorningBriefCollection` joins Morning Brief collection ownership to
 * that same commit. A ban is neither, so it keeps the narrow default.
 */
interface RunCancellationScope {
  readonly cascadeOwnedAgents?: boolean;
  readonly revokeMorningBriefCollection?: boolean;
}

async function cancelOrgRuns(
  db: Db,
  orgId: string,
  scope: RunCancellationScope = {},
): Promise<void> {
  const revokedAt = nowDate();
  const cancelled = await db.transaction(async (tx) => {
    const rows = await transitionAgentRunsToTerminal(tx, {
      values: {
        status: "cancelled",
        completedAt: nowDate(),
        runnerCancellationMode: "hard",
      },
      conditions: [
        scope.cascadeOwnedAgents
          ? piInferenceErasureScopePredicate(tx, {
              kind: "organization",
              orgId,
            })
          : eq(agentRuns.orgId, orgId),
        inArray(agentRuns.status, ["queued", "pending", "running"]),
      ],
    });
    await tx.delete(agentRunQueue).where(eq(agentRunQueue.orgId, orgId));
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
    return rows;
  });
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

async function cancelUserRuns(
  db: Db,
  userId: string,
  scope: RunCancellationScope = {},
): Promise<void> {
  const revokedAt = nowDate();
  const cancelled = await db.transaction(async (tx) => {
    const rows = await transitionAgentRunsToTerminal(tx, {
      values: {
        status: "cancelled",
        completedAt: nowDate(),
        runnerCancellationMode: "hard",
      },
      conditions: [
        scope.cascadeOwnedAgents
          ? piInferenceErasureScopePredicate(tx, { kind: "user", userId })
          : eq(agentRuns.userId, userId),
        inArray(agentRuns.status, ["queued", "pending", "running"]),
      ],
    });
    await tx.delete(agentRunQueue).where(eq(agentRunQueue.userId, userId));
    if (scope.revokeMorningBriefCollection) {
      await revokeMorningBriefCollectionOwnership(
        tx,
        { kind: "user", userId },
        revokedAt,
      );
      await revokeMorningBriefDeliveryOwnership(tx, { kind: "user", userId });
    }
    return rows;
  });
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

async function deregisterOrgTelegramWebhooks(
  db: Db,
  orgId: string,
): Promise<void> {
  const installations = await db
    .select({
      telegramBotId: telegramInstallations.telegramBotId,
      encryptedBotToken: telegramInstallations.encryptedBotToken,
      ownerUserId: telegramInstallations.ownerUserId,
    })
    .from(telegramInstallations)
    .where(eq(telegramInstallations.orgId, orgId));

  for (const installation of installations) {
    await tapError(
      deleteWebhook(
        await decryptPersistentSecretValue(
          installation.encryptedBotToken,
          await loadUserFeatureSwitchContext(
            db,
            orgId,
            installation.ownerUserId,
          ),
        ),
      ),
      (error) => {
        L.warn("failed to deregister telegram webhook", {
          telegramBotId: installation.telegramBotId,
          error,
        });
      },
    );
  }
}

async function deregisterOwnedTelegramWebhooks(
  db: Db,
  userId: string,
): Promise<void> {
  const installations = await db
    .select({
      telegramBotId: telegramInstallations.telegramBotId,
      encryptedBotToken: telegramInstallations.encryptedBotToken,
      orgId: telegramInstallations.orgId,
    })
    .from(telegramInstallations)
    .where(eq(telegramInstallations.ownerUserId, userId));

  for (const installation of installations) {
    await tapError(
      deleteWebhook(
        await decryptPersistentSecretValue(
          installation.encryptedBotToken,
          await loadUserFeatureSwitchContext(db, installation.orgId, userId),
        ),
      ),
      (error) => {
        L.warn("failed to deregister telegram webhook", {
          telegramBotId: installation.telegramBotId,
          error,
        });
      },
    );
  }
}

const revokeOrgConnectorTokens$ = command(
  async (
    { set },
    db: Db,
    orgId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const snapshot = await loadStoredConnectorRuntimeSnapshot(db);
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
        deleteConnectorLocalState$,
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
  async (
    { set },
    db: Db,
    userId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const snapshot = await loadStoredConnectorRuntimeSnapshot(db);
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
        deleteConnectorLocalState$,
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
    db: Db,
    orgId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const steps: readonly {
      readonly name: string;
      readonly run: () => Promise<void>;
    }[] = [
      {
        name: "telegram webhooks",
        run: () => {
          return deregisterOrgTelegramWebhooks(db, orgId);
        },
      },
      {
        name: "connector tokens",
        run: () => {
          return set(revokeOrgConnectorTokens$, db, orgId, signal);
        },
      },
    ];

    for (const step of steps) {
      await tapError(step.run(), (error) => {
        L.warn(`failed to cleanup ${step.name}`, { orgId, error });
      });
      signal.throwIfAborted();
    }
  },
);

const cleanupUserExternalServices$ = command(
  async (
    { set },
    db: Db,
    userId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const steps: readonly {
      readonly name: string;
      readonly run: () => Promise<void>;
    }[] = [
      {
        name: "connector tokens",
        run: () => {
          return set(revokeUserConnectorTokens$, db, userId, signal);
        },
      },
      {
        name: "telegram owned bots",
        run: () => {
          return deregisterOwnedTelegramWebhooks(db, userId);
        },
      },
    ];

    for (const step of steps) {
      await tapError(step.run(), (error) => {
        L.warn(`failed to cleanup ${step.name}`, { userId, error });
      });
      signal.throwIfAborted();
    }
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
      L.warn("failed to query Clerk organization memberships for deletion", {
        orgId,
        userId,
        error: memberships.error,
      });
      return false;
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

function deleteObjectsForPrefixes(
  bucket: string,
  prefixes: readonly string[],
): Computed<Promise<void>> {
  return computed(async (get): Promise<void> => {
    for (const prefix of prefixes) {
      const objects = await get(listS3Objects(bucket, prefix));
      if (objects.length === 0) {
        continue;
      }
      await get(
        deleteS3Objects(
          bucket,
          objects.map((object) => {
            return object.key;
          }),
        ),
      );
    }
  });
}

function deleteUserObjectsForPrefixesBestEffort(
  bucket: string,
  prefixes: readonly string[],
  userId: string,
): Computed<Promise<void>> {
  return computed(async (get): Promise<void> => {
    for (const prefix of prefixes) {
      const objects = await tapError(
        get(listS3ObjectsUnderPrefix(bucket, prefix)),
        (error) => {
          L.warn("failed to list user storage objects", {
            userId,
            prefix,
            error,
          });
        },
      );
      if (!objects) {
        continue;
      }

      if (objects.length === 0) {
        continue;
      }

      const keys = objects.map((object) => {
        return object.key;
      });
      await tapError(get(deleteS3Objects(bucket, keys)), (error) => {
        // The storage rows (and with them the version keys) are deleted
        // right after this best-effort pass, so log the full key list to
        // keep manual re-deletion possible.
        L.warn("failed to delete user storage objects", {
          userId,
          prefix,
          keys,
          error,
        });
      });
    }
  });
}

function deleteOrgS3Data(db: Db, orgId: string): Computed<Promise<void>> {
  return computed(async (get): Promise<void> => {
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const storageRows = await db
      .select({ s3Prefix: storages.s3Prefix })
      .from(storages)
      .where(eq(storages.orgId, orgId));
    await get(
      deleteObjectsForPrefixes(
        bucket,
        storageRows.map((row) => {
          return row.s3Prefix;
        }),
      ),
    );

    const exportRows = await db
      .select({ s3Key: exportJobs.s3Key })
      .from(exportJobs)
      .where(and(eq(exportJobs.orgId, orgId), isNotNull(exportJobs.s3Key)));
    const exportKeys = exportRows.flatMap((row) => {
      return row.s3Key ? [row.s3Key] : [];
    });
    await get(deleteS3Objects(bucket, exportKeys));
  });
}

function deleteUserS3Data(db: Db, userId: string): Computed<Promise<void>> {
  return computed(async (get): Promise<void> => {
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const userStorageRows = await db
      .select({ s3Prefix: storages.s3Prefix })
      .from(storages)
      .where(
        and(
          eq(storages.userId, userId),
          eq(
            storages.s3Prefix,
            sql`${storages.orgId} || '/' || ${storages.id}::text`,
          ),
        ),
      );

    const ownedAgents = await db
      .select({ name: agents.name, orgId: agents.orgId })
      .from(agents)
      .where(eq(agents.owner, userId));
    const agentStorageRows =
      ownedAgents.length === 0
        ? []
        : await db
            .select({ s3Prefix: storages.s3Prefix })
            .from(storages)
            .where(
              and(
                eq(storages.userId, VOLUME_ORG_USER_ID),
                or(
                  ...ownedAgents.map((agent) => {
                    return and(
                      eq(storages.orgId, agent.orgId),
                      eq(storages.name, getInstructionsStorageName(agent.name)),
                    );
                  }),
                ),
              ),
            );

    const prefixes = [
      ...new Set(
        [...userStorageRows, ...agentStorageRows].map((row) => {
          return row.s3Prefix;
        }),
      ),
    ];
    await get(deleteUserObjectsForPrefixesBestEffort(bucket, prefixes, userId));

    const exportRows = await db
      .select({ s3Key: exportJobs.s3Key })
      .from(exportJobs)
      .where(and(eq(exportJobs.userId, userId), isNotNull(exportJobs.s3Key)));
    const exportKeys = exportRows.flatMap((row) => {
      return row.s3Key ? [row.s3Key] : [];
    });
    await tapError(get(deleteS3Objects(bucket, exportKeys)), (error) => {
      L.warn("failed to delete user export objects", {
        userId,
        count: exportKeys.length,
        error,
      });
    });
  });
}

async function deleteOrgData(
  db: Db,
  orgId: string,
  signal: AbortSignal,
): Promise<void> {
  await cancelOrgRuns(db, orgId);

  const installations = await db
    .select({ slackWorkspaceId: slackOrgInstallations.slackWorkspaceId })
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.orgId, orgId));
  for (const installation of installations) {
    await cleanupWorkspaceInstallation(db, installation.slackWorkspaceId);
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
  await db.delete(artifacts).where(eq(artifacts.orgId, orgId));
  await deleteClerkAgentLifecycleData(db, { kind: "organization", orgId });
  await deleteConnectorOwnerState(db, { kind: "organization", orgId }, signal);
  await db.transaction(async (tx) => {
    await deleteStoragesWithPiMemoryCandidates(tx, eq(storages.orgId, orgId));
  });
  await db.delete(modelProviders).where(eq(modelProviders.orgId, orgId));
  await db
    .delete(modelProviderAuthSessions)
    .where(eq(modelProviderAuthSessions.orgId, orgId));
  await db.delete(secrets).where(eq(secrets.orgId, orgId));
  await db.delete(variables).where(eq(variables.orgId, orgId));
  await db
    .delete(connectorOauthDeviceAuthorizationSessions)
    .where(eq(connectorOauthDeviceAuthorizationSessions.orgId, orgId));
  await db
    .delete(connectorExternalCodeSessions)
    .where(eq(connectorExternalCodeSessions.orgId, orgId));
  await db.delete(exportJobs).where(eq(exportJobs.orgId, orgId));
  await db
    .delete(orgConcurrencyEntitlements)
    .where(eq(orgConcurrencyEntitlements.orgId, orgId));
  await db
    .delete(orgConcurrencySubscriptions)
    .where(eq(orgConcurrencySubscriptions.orgId, orgId));
  await db.delete(orgMembersCache).where(eq(orgMembersCache.orgId, orgId));
  await db
    .delete(orgMembersMetadata)
    .where(eq(orgMembersMetadata.orgId, orgId));
  await db
    .delete(userDisabledPaidTools)
    .where(eq(userDisabledPaidTools.orgId, orgId));
  await db.delete(orgCache).where(eq(orgCache.orgId, orgId));
  await db
    .delete(morningBriefEnrollments)
    .where(eq(morningBriefEnrollments.orgId, orgId));
  await db.delete(orgMetadata).where(eq(orgMetadata.orgId, orgId));
  await deletePiObjectOrphansForOwner(db, { orgId });
}

async function deleteUserData(
  db: Db,
  userId: string,
  signal: AbortSignal,
): Promise<void> {
  await cancelUserRuns(db, userId);

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('lock_timeout', ${AGENT_LIFECYCLE_LOCK_TIMEOUT}, true)`,
    );
  });

  await db
    .delete(slackOrgConnections)
    .where(eq(slackOrgConnections.userId, userId));
  await db.delete(githubUserLinks).where(eq(githubUserLinks.userId, userId));
  await db
    .delete(telegramUserLinks)
    .where(eq(telegramUserLinks.userId, userId));
  await db
    .delete(telegramInstallations)
    .where(eq(telegramInstallations.ownerUserId, userId));
  await db
    .delete(artifacts)
    .where(
      inArray(artifacts.authorUserId, [
        userId,
        sharedThreadArtifactAuthorUserId(userId),
      ]),
    );
  await db.delete(sharedThreads).where(eq(sharedThreads.userId, userId));
  await deleteClerkAgentLifecycleData(db, { kind: "user", userId });
  await db.transaction(async (tx) => {
    await deleteStoragesWithPiMemoryCandidates(tx, eq(storages.userId, userId));
  });
  await db
    .delete(piMemoryStage1Days)
    .where(eq(piMemoryStage1Days.userId, userId));
  await db.delete(modelProviders).where(eq(modelProviders.userId, userId));
  await db
    .delete(modelProviderAuthSessions)
    .where(eq(modelProviderAuthSessions.userId, userId));
  await deleteConnectorOwnerState(db, { kind: "user", userId }, signal);
  await db.delete(secrets).where(eq(secrets.userId, userId));
  await db.delete(variables).where(eq(variables.userId, userId));
  await db.delete(exportJobs).where(eq(exportJobs.userId, userId));
  await db.delete(cliTokens).where(eq(cliTokens.userId, userId));
  await db.delete(composeJobs).where(eq(composeJobs.userId, userId));
  await db
    .delete(connectorOauthDeviceAuthorizationSessions)
    .where(eq(connectorOauthDeviceAuthorizationSessions.userId, userId));
  await db
    .delete(connectorExternalCodeSessions)
    .where(eq(connectorExternalCodeSessions.userId, userId));
  await db.delete(deviceCodes).where(eq(deviceCodes.userId, userId));
  await db
    .delete(userPermissionGrants)
    .where(eq(userPermissionGrants.userId, userId));
  await db.delete(orgMembersCache).where(eq(orgMembersCache.userId, userId));
  await db
    .delete(morningBriefEnrollments)
    .where(eq(morningBriefEnrollments.userId, userId));
  await db
    .delete(orgMembersMetadata)
    .where(eq(orgMembersMetadata.userId, userId));
  await db
    .delete(userDisabledPaidTools)
    .where(eq(userDisabledPaidTools.userId, userId));
  await db.delete(userCache).where(eq(userCache.userId, userId));
  signal.throwIfAborted();
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('lock_timeout', ${AGENT_LIFECYCLE_LOCK_TIMEOUT}, true)`,
    );
    await tx.delete(users).where(eq(users.id, userId));
  });
  await deletePiObjectOrphansForOwner(db, { userId });
}

export const cleanupClerkDeletedOrg$ = command(
  async ({ get, set }, orgId: string, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    await eraseVncOwnerData(db, { kind: "organization", orgId });
    signal.throwIfAborted();
    await cancelOrgRuns(db, orgId, {
      cascadeOwnedAgents: true,
      revokeMorningBriefCollection: true,
    });
    signal.throwIfAborted();
    await revokeMorningBriefScheduleOwnership(db, {
      kind: "organization",
      orgId,
    });
    signal.throwIfAborted();
    await assertPiInferenceScopeErasureReady(db, {
      kind: "organization",
      orgId,
    });
    signal.throwIfAborted();
    await set(
      cleanupSharedThreadArtifacts$,
      { kind: "organization", orgId },
      signal,
    );
    await set(cleanupOrgExternalServices$, db, orgId, signal);
    signal.throwIfAborted();
    await get(deleteOrgS3Data(db, orgId));
    signal.throwIfAborted();
    await deleteOrgData(db, orgId, signal);
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
  async ({ get, set }, userId: string, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    await eraseVncOwnerData(db, { kind: "user", userId });
    signal.throwIfAborted();
    await cancelUserRuns(db, userId, {
      cascadeOwnedAgents: true,
      revokeMorningBriefCollection: true,
    });
    signal.throwIfAborted();
    await revokeMorningBriefScheduleOwnership(db, { kind: "user", userId });
    signal.throwIfAborted();
    await assertPiInferenceScopeErasureReady(db, { kind: "user", userId });
    signal.throwIfAborted();
    await set(cleanupSharedThreadArtifacts$, { kind: "user", userId }, signal);
    const emptyOrgIds = await emptyOrgIdsAfterDeletingUser(
      db,
      get(clerk$),
      userId,
      signal,
    );
    signal.throwIfAborted();

    await set(cleanupUserExternalServices$, db, userId, signal);
    signal.throwIfAborted();
    for (const orgId of emptyOrgIds) {
      await eraseVncOwnerData(db, { kind: "organization", orgId });
      signal.throwIfAborted();
      await cancelOrgRuns(db, orgId, {
        cascadeOwnedAgents: true,
        revokeMorningBriefCollection: true,
      });
      signal.throwIfAborted();
      await revokeMorningBriefScheduleOwnership(db, {
        kind: "organization",
        orgId,
      });
      signal.throwIfAborted();
      await assertPiInferenceScopeErasureReady(db, {
        kind: "organization",
        orgId,
      });
      signal.throwIfAborted();
      await set(
        cleanupSharedThreadArtifacts$,
        { kind: "organization", orgId },
        signal,
      );
      await tapError(
        cancelStripeSubscriptionsForDeletedOrg(db, orgId),
        (error) => {
          L.warn("failed to cleanup stripe subscriptions", { orgId, error });
        },
      );
      signal.throwIfAborted();
      await set(cleanupOrgExternalServices$, db, orgId, signal);
      signal.throwIfAborted();
    }

    await get(deleteUserS3Data(db, userId));
    signal.throwIfAborted();
    for (const orgId of emptyOrgIds) {
      await get(deleteOrgS3Data(db, orgId));
      signal.throwIfAborted();
    }

    await deleteUserData(db, userId, signal);
    signal.throwIfAborted();
    for (const orgId of emptyOrgIds) {
      await deleteOrgData(db, orgId, signal);
      signal.throwIfAborted();
    }
  },
);

async function commitClerkDeletedOrgMembershipCleanup(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly membershipId?: string;
  },
): Promise<void> {
  const commitSignal = new AbortController().signal;
  await removeUsagePackMemberAllocation(db, args, commitSignal);
  commitSignal.throwIfAborted();
  await refundUsagePackMemberCredits(db, args, commitSignal);
  commitSignal.throwIfAborted();
  await cleanupOrgMemberResources(db, args, commitSignal);
  commitSignal.throwIfAborted();
}

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
    const db = set(writeDb$);
    await commitClerkDeletedOrgMembershipCleanup(db, args);
    signal.throwIfAborted();
  },
);

export const cleanupClerkBannedUser$ = command(
  async ({ set }, userId: string, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    await cancelUserRuns(db, userId);
    signal.throwIfAborted();
    signal.throwIfAborted();
    await cancelLastAdminOrgsStripeSubscriptions(db, userId);
  },
);
