import { computed, type Computed } from "ccstate";
import {
  modelProviderCredentialScopeSchema,
  modelProviderTypeSchema,
} from "@okouai/api-contracts/contracts/model-providers";
import { modelProviderAccounts } from "@okouai/db/schema/model-provider-account";
import { formatRunBalanceError } from "@okouai/api-contracts/contracts/run-balance-errors";
import { isOrgTier, type OrgTier } from "@okouai/api-contracts/contracts/orgs";
import type {
  ConcurrencyMemberUsage,
  GetRunResponse,
  QueueResponse,
  RunStatus,
} from "@okouai/api-contracts/contracts/runs";
import {
  sandboxStartupPathSchema,
  type SandboxStartupPath,
} from "@okouai/api-contracts/contracts/runner-primitives";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { userCache } from "@okouai/db/schema/user-cache";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";

import { db$, type Db } from "../external/db";
import {
  activePaidConcurrencySlots,
  cappedBaseConcurrencyLimit,
  totalConcurrencyLimit,
} from "./org-concurrency-entitlements.service";
import { orgPlanCapabilities } from "./org-plan-entitlement-read.service";
import { personalSubscriptionAccountIdentity } from "./personal-subscription-recovery.service";

type ReadDb = Pick<Db, "select">;
type RunningTaskItem = QueueResponse["runningTasks"][number];
type RunSourceRow = Pick<
  typeof agentRuns.$inferSelect,
  | "modelProvider"
  | "modelRuntimeProvider"
  | "selectedModel"
  | "modelProviderCredentialScope"
  | "modelProviderId"
  | "modelProviderAccountIdentity"
>;

interface RunningRunRow {
  readonly id: string;
  readonly runUserId: string;
  readonly startedAt: Date | null;
  readonly agentName: string | null;
  readonly agentDisplayName: string | null;
}

function effectiveConcurrencyLimit(
  baseLimit: number,
  paidSlots: number,
): number {
  const cappedBaseLimit = cappedBaseConcurrencyLimit(baseLimit);
  const displayedBaseLimit = Number.isFinite(cappedBaseLimit)
    ? cappedBaseLimit
    : baseLimit;
  return totalConcurrencyLimit({
    baseLimit: displayedBaseLimit,
    paidSlots,
  });
}

/** One `active_agent_runs` row is one occupied slot; see the admission count. */
function concurrencyUsage(orgId: string): Computed<
  Promise<{
    readonly memberUsage: ConcurrencyMemberUsage[];
  }>
> {
  return computed(
    async (
      get,
    ): Promise<{
      readonly memberUsage: ConcurrencyMemberUsage[];
    }> => {
      const db = get(db$);
      const active = count();
      const rows = await db
        .select({ userId: activeAgentRuns.userId, active })
        .from(activeAgentRuns)
        .where(eq(activeAgentRuns.orgId, orgId))
        .groupBy(activeAgentRuns.userId)
        .orderBy(desc(active), asc(activeAgentRuns.userId));
      const users =
        rows.length > 0
          ? await db
              .select({
                userId: userCache.userId,
                name: userCache.name,
                email: userCache.email,
              })
              .from(userCache)
              .where(
                inArray(
                  userCache.userId,
                  rows.map((row) => {
                    return row.userId;
                  }),
                ),
              )
          : [];
      const displayNames = new Map(
        users.map((user) => {
          return [user.userId, user.name?.trim() || user.email] as const;
        }),
      );

      return {
        memberUsage: rows.map((row) => {
          return {
            userId: row.userId,
            displayName: displayNames.get(row.userId) || "unknown",
            active: row.active,
          };
        }),
      };
    },
  );
}

function runningRunRows(orgId: string): Computed<Promise<RunningRunRow[]>> {
  return computed(async (get): Promise<RunningRunRow[]> => {
    const db = get(db$);
    return await db
      .select({
        id: agentRuns.id,
        runUserId: agentRuns.userId,
        startedAt: agentRuns.startedAt,
        agentName: agents.name,
        agentDisplayName: agents.displayName,
      })
      .from(agentRuns)
      .leftJoin(agents, eq(agentRuns.agentId, agents.id))
      .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.status, "running")))
      .orderBy(asc(agentRuns.startedAt));
  });
}

function userEmailMap(
  runningRuns$: Computed<Promise<RunningRunRow[]>>,
): Computed<Promise<ReadonlyMap<string, string>>> {
  return computed(async (get): Promise<ReadonlyMap<string, string>> => {
    const runningRuns = await get(runningRuns$);
    const db = get(db$);
    const userIds = [
      ...new Set(
        runningRuns.map((run) => {
          return run.runUserId;
        }),
      ),
    ];
    const rows =
      userIds.length > 0
        ? await db
            .select({ userId: userCache.userId, email: userCache.email })
            .from(userCache)
            .where(inArray(userCache.userId, userIds))
        : [];
    return new Map(
      rows.map((row) => {
        return [row.userId, row.email] as const;
      }),
    );
  });
}

function runningTaskItem(
  run: RunningRunRow,
  userId: string,
  emails: ReadonlyMap<string, string>,
): RunningTaskItem {
  const isOwner = run.runUserId === userId;
  return {
    runId: isOwner ? run.id : null,
    agentName: run.agentName ?? "unknown",
    agentDisplayName: run.agentDisplayName ?? null,
    userEmail: emails.get(run.runUserId) ?? "unknown",
    startedAt: run.startedAt?.toISOString() ?? null,
    isOwner,
  };
}

async function persistedRunSource(
  db: ReadDb,
  run: RunSourceRow,
  owner: { readonly userId: string; readonly orgId: string },
): Promise<NonNullable<GetRunResponse["source"]>> {
  let account: NonNullable<GetRunResponse["source"]>["account"] = {
    status: "unknown",
  };
  if (
    run.modelProviderCredentialScope === "member" &&
    run.modelProviderId &&
    run.modelProviderAccountIdentity &&
    (run.modelProvider === "codex-oauth-token" ||
      run.modelProvider === "claude-code-oauth-token")
  ) {
    const [captured] = await db
      .select({
        id: modelProviderAccounts.id,
        type: modelProviderAccounts.type,
        externalAccountId: modelProviderAccounts.externalAccountId,
        accountEmail: modelProviderAccounts.accountEmail,
        workspaceName: modelProviderAccounts.workspaceName,
        disconnectedAt: modelProviderAccounts.disconnectedAt,
      })
      .from(modelProviderAccounts)
      .where(
        and(
          eq(modelProviderAccounts.id, run.modelProviderId),
          eq(modelProviderAccounts.orgId, owner.orgId),
          eq(modelProviderAccounts.userId, owner.userId),
          eq(modelProviderAccounts.type, run.modelProvider),
        ),
      )
      .limit(1);
    account =
      !captured || captured.disconnectedAt
        ? { status: "unavailable" }
        : personalSubscriptionAccountIdentity(captured) ===
            run.modelProviderAccountIdentity
          ? { status: "connected", id: captured.id }
          : { status: "unknown" };
  }

  return {
    providerType: run.modelProvider
      ? (modelProviderTypeSchema.safeParse(run.modelProvider).data ?? null)
      : null,
    runtimeProviderType: run.modelRuntimeProvider
      ? (modelProviderTypeSchema.safeParse(run.modelRuntimeProvider).data ??
        null)
      : null,
    model: run.selectedModel,
    credentialScope: run.modelProviderCredentialScope
      ? (modelProviderCredentialScopeSchema.safeParse(
          run.modelProviderCredentialScope,
        ).data ?? null)
      : null,
    account,
  };
}

export function agentRunById(args: {
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
}): Computed<Promise<GetRunResponse | null>> {
  return computed(async (get): Promise<GetRunResponse | null> => {
    const [run] = await get(db$)
      .select({
        id: agentRuns.id,
        launchSnapshot: agentRuns.launchSnapshot,
        status: agentRuns.status,
        prompt: agentRuns.prompt,
        appendSystemPrompt: agentRuns.appendSystemPrompt,
        vars: agentRuns.vars,
        sandboxId: agentRuns.sandboxId,
        result: agentRuns.result,
        error: agentRuns.error,
        failureReason: agentRuns.failureReason,
        createdAt: agentRuns.createdAt,
        startedAt: agentRuns.startedAt,
        completedAt: agentRuns.completedAt,
        modelProvider: agentRuns.modelProvider,
        modelRuntimeProvider: agentRuns.modelRuntimeProvider,
        selectedModel: agentRuns.selectedModel,
        modelProviderCredentialScope: agentRuns.modelProviderCredentialScope,
        modelProviderId: agentRuns.modelProviderId,
        modelProviderAccountIdentity: agentRuns.modelProviderAccountIdentity,
      })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, args.runId),
          eq(agentRuns.userId, args.userId),
          eq(agentRuns.orgId, args.orgId),
        ),
      )
      .limit(1);

    if (!run) {
      return null;
    }

    const source = await persistedRunSource(get(db$), run, args);

    return {
      runId: run.id,
      status: run.status as RunStatus,
      prompt: run.prompt,
      appendSystemPrompt: run.appendSystemPrompt,
      vars:
        run.vars === null ? undefined : (run.vars as Record<string, string>),
      sandboxId: run.sandboxId || undefined,
      result:
        run.result === null
          ? undefined
          : (run.result as GetRunResponse["result"]),
      error: run.error
        ? (formatRunBalanceError({
            failureReason: run.failureReason,
            modelProvider: run.modelProvider,
          }) ?? run.error)
        : undefined,
      createdAt: run.createdAt.toISOString(),
      startedAt: run.startedAt?.toISOString(),
      completedAt: run.completedAt?.toISOString(),
      source,
    };
  });
}

export function agentRunRunner(args: {
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
}): Computed<
  Promise<{
    readonly sandboxStartupPath: SandboxStartupPath | null;
    readonly runnerHostname: string | null;
    readonly runnerVersion: string | null;
    readonly runnerId: string | null;
    readonly runnerHeartbeatGeneration: number | null;
  } | null>
> {
  return computed(async (get) => {
    const [row] = await get(db$)
      .select({
        sandboxStartupPath: agentRuns.sandboxStartupPath,
        runnerHostname: agentRuns.runnerHostname,
        runnerVersion: agentRuns.runnerVersion,
        runnerId: agentRuns.runnerId,
        runnerHeartbeatGeneration: agentRuns.runnerHeartbeatGeneration,
      })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, args.runId),
          eq(agentRuns.userId, args.userId),
          eq(agentRuns.orgId, args.orgId),
        ),
      )
      .limit(1);

    if (!row) {
      return null;
    }

    return {
      sandboxStartupPath: sandboxStartupPathSchema
        .nullable()
        .parse(row.sandboxStartupPath),
      runnerHostname: row.runnerHostname,
      runnerVersion: row.runnerVersion,
      runnerId: row.runnerId,
      runnerHeartbeatGeneration: row.runnerHeartbeatGeneration,
    };
  });
}

export function organizationTier(orgId: string): Computed<Promise<OrgTier>> {
  return computed(async (get): Promise<OrgTier> => {
    const [row] = await get(db$)
      .select({ tier: orgMetadata.tier })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .limit(1);

    if (isOrgTier(row?.tier)) {
      return row.tier;
    }
    return "limited-free-1";
  });
}

export function agentRunQueueStatus(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly orgTier: OrgTier;
}): Computed<Promise<QueueResponse>> {
  const usage$ = concurrencyUsage(args.orgId);
  const runningRuns$ = runningRunRows(args.orgId);
  const paidSlots$ = activePaidConcurrencySlots(args.orgId);
  const capabilities$ = orgPlanCapabilities(args.orgId);
  const emails$ = userEmailMap(runningRuns$);
  return computed(async (get): Promise<QueueResponse> => {
    const [usage, runningRuns, paidSlots, capabilities] = await Promise.all([
      get(usage$),
      get(runningRuns$),
      get(paidSlots$),
      get(capabilities$),
    ]);
    const { memberUsage } = usage;
    const limit = effectiveConcurrencyLimit(
      capabilities?.baseConcurrencyLimit ?? 0,
      paidSlots,
    );
    const active = memberUsage.reduce((total, member) => {
      return total + member.active;
    }, 0);
    const emails = await get(emails$);

    return {
      concurrency: {
        tier: args.orgTier,
        limit,
        active,
        available: limit === 0 ? -1 : Math.max(0, limit - active),
        memberUsage,
      },
      runningTasks: runningRuns.map((run) => {
        return runningTaskItem(run, args.userId, emails);
      }),
    };
  });
}
