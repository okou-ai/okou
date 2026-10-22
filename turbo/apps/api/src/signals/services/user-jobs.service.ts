import { isDeepStrictEqual } from "node:util";
import { command } from "ccstate";
import {
  and,
  arrayContains,
  asc,
  eq,
  gt,
  isNull,
  ne,
  not,
  or,
  sql,
} from "drizzle-orm";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { userJobs } from "@okouai/db/schema/user-job";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { userPermissionGrants } from "@okouai/db/schema/user-permission-grant";
import {
  jobSchema,
  jobSummarySchema,
  type Job,
  type JobCreate,
  type JobUpdate,
  type JobInputCreate,
  type JobListQuery,
} from "@okouai/api-contracts/contracts/jobs";
import { conflict, notFound, resourceUnavailable } from "../../lib/error";
import {
  pgBooleanDecoder,
  pgIntegerDecoder,
} from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import { organizationAuthContext$ } from "../auth/auth-context";
import { db$, writeDb$ } from "../external/db";
import { publishUserJobsChangedSafely } from "../external/realtime";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";
import {
  jobOwnerCondition,
  jobListRankSql,
  pendingJobInputSql,
  runnableJobCondition,
  unseenJobResultSql,
  type JobOwner,
} from "./user-jobs-query";
import {
  wakeProactiveJobs$,
  sleepIdleProactiveJobs$,
} from "./proactive-jobs-wake.service";

export const jobAccess$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const features = await set(
    loadUserFeatureSwitchContext$,
    auth.orgId,
    auth.userId,
    signal,
  );
  if (!isFeatureEnabled(FeatureSwitchKey.ProactiveJobs, features)) {
    return resourceUnavailable("Jobs are not enabled.");
  }
  if (auth.tokenType === "agent") {
    const [run] = await get(db$)
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .innerJoin(
        orgMetadata,
        and(
          eq(orgMetadata.orgId, auth.orgId),
          eq(orgMetadata.defaultAgentId, agentRuns.agentId),
        ),
      )
      .where(
        and(
          eq(agentRuns.id, auth.runId),
          eq(agentRuns.orgId, auth.orgId),
          eq(agentRuns.userId, auth.userId),
          eq(agentRuns.status, "running"),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!run) {
      return resourceUnavailable(
        "Jobs are available only to a running primary Agent.",
      );
    }
  }
  return { orgId: auth.orgId, userId: auth.userId };
});

function presentJob(row: typeof userJobs.$inferSelect) {
  return jobSchema.parse({
    ...row,
    hasPendingInput: row.inputs.length > row.work.processedInputIds.length,
    hasUnseenResult:
      row.work.currentResultId !== null &&
      !row.viewedResultIds.includes(row.work.currentResultId),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export const readUserJob$ = command(
  async ({ get }, owner: JobOwner, id: string, signal: AbortSignal) => {
    const [row] = await get(db$)
      .select()
      .from(userJobs)
      .where(and(jobOwnerCondition(owner), eq(userJobs.id, id)))
      .limit(1);
    signal.throwIfAborted();
    return row
      ? { status: 200 as const, body: presentJob(row) }
      : notFound("Job not found");
  },
);

export const listUserJobs$ = command(
  async (
    { get },
    owner: JobOwner,
    query: JobListQuery,
    signal: AbortSignal,
  ) => {
    const rank = jobListRankSql(query.filter);
    const [cursor] = query.after
      ? await get(db$)
          .select({
            id: userJobs.id,
            rank: rank.mapWith(pgIntegerDecoder),
            updatedAt: userJobs.updatedAt,
          })
          .from(userJobs)
          .where(and(jobOwnerCondition(owner), eq(userJobs.id, query.after)))
          .limit(1)
      : [];
    signal.throwIfAborted();
    if (query.after && !cursor) {
      return conflict(
        "The list cursor is unavailable. Restart this Jobs view.",
      );
    }
    const filter =
      query.filter === "runnable"
        ? runnableJobCondition()
        : query.filter === "archived"
          ? eq(userJobs.status, "archived")
          : query.filter === "history"
            ? and(
                eq(userJobs.status, "completed"),
                sql`NOT (${unseenJobResultSql()})`,
              )
            : query.filter === "home"
              ? and(
                  ne(userJobs.status, "archived"),
                  sql`(${userJobs.status} <> 'completed' OR ${pendingJobInputSql()} OR ${unseenJobResultSql()})`,
                )
              : undefined;
    const rows = await get(db$)
      .select({
        id: userJobs.id,
        title: userJobs.title,
        objective: userJobs.objective,
        sourceReferences: userJobs.sourceReferences,
        status: userJobs.status,
        work: userJobs.work,
        hasPendingInput: pendingJobInputSql().mapWith(pgBooleanDecoder),
        hasUnseenResult: unseenJobResultSql().mapWith(pgBooleanDecoder),
        createdAt: userJobs.createdAt,
        updatedAt: userJobs.updatedAt,
      })
      .from(userJobs)
      .where(
        and(
          jobOwnerCondition(owner),
          filter,
          cursor
            ? sql`(${rank}, ${userJobs.updatedAt}, ${userJobs.id}) > (${cursor.rank}, ${sql.param(cursor.updatedAt, userJobs.updatedAt)}::timestamp, ${cursor.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(asc(rank), asc(userJobs.updatedAt), asc(userJobs.id))
      .limit(query.limit + 1);
    signal.throwIfAborted();
    const page = rows.slice(0, query.limit);
    return {
      status: 200 as const,
      body: {
        jobs: page.map((row) => {
          return jobSummarySchema.parse({
            ...row,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
          });
        }),
        nextAfter: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
      },
    };
  },
);

export const createUserJob$ = command(
  async ({ set }, owner: JobOwner, input: JobCreate, signal: AbortSignal) => {
    const [row] = await set(writeDb$)
      .insert(userJobs)
      .values({ ...input, orgId: owner.orgId, ownerUserId: owner.userId })
      .onConflictDoNothing()
      .returning();
    signal.throwIfAborted();
    if (row) {
      await set(wakeProactiveJobs$, owner, signal);
      await publishUserJobsChangedSafely(owner);
      signal.throwIfAborted();
      return { status: 200 as const, body: presentJob(row) };
    }
    const existing = await set(readUserJob$, owner, input.id, signal);
    if (
      existing.status === 200 &&
      existing.body.title === input.title &&
      existing.body.objective === input.objective &&
      isDeepStrictEqual(existing.body.sourceReferences, input.sourceReferences)
    ) {
      return existing;
    }
    return conflict(
      "Job identity already exists with different content. Reuse the original file or choose a new ID for a new delegation.",
    );
  },
);

function jobUpdateReferenceConflict(job: Job, input: JobUpdate) {
  const processed = input.work.processedInputIds;
  if (
    processed.length < job.work.processedInputIds.length ||
    processed.length > job.inputs.length ||
    !processed.every((value, index) => {
      return value === job.inputs[index]?.id;
    })
  ) {
    return conflict(
      "Acknowledge only the exact input prefix you inspected. Read the Job again.",
    );
  }
  if (
    input.work.currentResultId !== null &&
    !job.results.some((value) => {
      return value.id === input.work.currentResultId;
    }) &&
    input.result?.id !== input.work.currentResultId
  ) {
    return conflict("The current Result must exist on this Job.");
  }
  return null;
}

export const updateUserJob$ = command(
  async (
    { set },
    owner: JobOwner,
    id: string,
    input: JobUpdate,
    signal: AbortSignal,
  ) => {
    const read = await set(readUserJob$, owner, id, signal);
    if (read.status !== 200) {
      return read;
    }
    const job = read.body;
    if (job.status === "archived") {
      return conflict("This Job is archived.");
    }
    const invalid = jobUpdateReferenceConflict(job, input);
    if (invalid) {
      return invalid;
    }
    const request = input.work.authorization;
    const previousRequest = request
      ? job.authorizationRequests.find((value) => {
          return value.id === request.id;
        })
      : undefined;
    if (previousRequest && !isDeepStrictEqual(previousRequest, request)) {
      return conflict(
        "Authorization request identity already exists with different action or scope.",
      );
    }
    const previousResult = input.result
      ? job.results.find((value) => {
          return value.id === input.result?.id;
        })
      : undefined;
    if (
      previousResult &&
      input.result &&
      !isDeepStrictEqual(
        {
          id: previousResult.id,
          text: previousResult.text,
          references: previousResult.references,
        },
        input.result,
      )
    ) {
      return conflict("Result identity already exists with different content.");
    }
    const result = input.result
      ? (previousResult ?? {
          ...input.result,
          publishedAt: nowDate().toISOString(),
        })
      : undefined;
    const [row] = await set(writeDb$)
      .update(userJobs)
      .set({
        ...(request && !previousRequest
          ? {
              authorizationRequests: sql`${userJobs.authorizationRequests} || ${sql.param(JSON.stringify([request]))}::jsonb`,
            }
          : {}),
        status: input.status,
        work: input.work,
        updatedAt: nowDate(),
        ...(result && !previousResult
          ? {
              results: sql`${userJobs.results} || ${sql.param(JSON.stringify([result]))}::jsonb`,
            }
          : {}),
      })
      .where(
        and(
          jobOwnerCondition(owner),
          eq(userJobs.id, id),
          ne(userJobs.status, "archived"),
          eq(userJobs.status, input.expected.status),
          eq(userJobs.work, input.expected.work),
        ),
      )
      .returning();
    signal.throwIfAborted();
    if (!row) {
      return conflict(
        "Job progress changed. Read the current Job before deciding the next action.",
      );
    }
    await set(sleepIdleProactiveJobs$, owner, signal);
    await set(wakeProactiveJobs$, owner, signal);
    await publishUserJobsChangedSafely(owner);
    signal.throwIfAborted();
    return { status: 200 as const, body: presentJob(row) };
  },
);

export const appendUserJobInput$ = command(
  async (
    { get, set },
    owner: JobOwner,
    id: string,
    input: JobInputCreate,
    signal: AbortSignal,
  ) => {
    const read = await set(readUserJob$, owner, id, signal);
    if (read.status !== 200) {
      return read;
    }
    const job = read.body;
    const existing = job.inputs.find((value) => {
      return value.id === input.id;
    });
    if (existing) {
      const {
        authorUserId: _author,
        createdAt: _created,
        ...content
      } = existing;
      return isDeepStrictEqual(content, input)
        ? read
        : conflict("Input identity already exists with different content.");
    }
    if (job.status === "archived") {
      return conflict("Archived Jobs do not accept new input.");
    }
    const request = job.work.authorization;
    if (input.kind === "authorization") {
      if (!request || request.id !== input.requestId) {
        return conflict("This authorization request is no longer current.");
      }
      if (input.outcome === "granted") {
        const [grant] = await get(db$)
          .select({ id: userPermissionGrants.id })
          .from(userPermissionGrants)
          .innerJoin(
            orgMetadata,
            and(
              eq(orgMetadata.orgId, owner.orgId),
              eq(orgMetadata.defaultAgentId, request.agentId),
            ),
          )
          .where(
            and(
              eq(userPermissionGrants.orgId, owner.orgId),
              eq(userPermissionGrants.userId, owner.userId),
              eq(userPermissionGrants.agentId, request.agentId),
              eq(userPermissionGrants.connectorSlug, request.connector),
              eq(userPermissionGrants.permission, request.permission),
              eq(userPermissionGrants.action, "allow"),
              or(
                isNull(userPermissionGrants.expiresAt),
                gt(userPermissionGrants.expiresAt, nowDate()),
              ),
            ),
          )
          .limit(1);
        signal.throwIfAborted();
        if (!grant) {
          return conflict(
            "Grant the current Agent's actual permission before saving an authorization response.",
          );
        }
      }
    }
    const entry = {
      ...input,
      authorUserId: owner.userId,
      createdAt: nowDate().toISOString(),
    };
    const [row] = await set(writeDb$)
      .update(userJobs)
      .set({
        inputs: sql`${userJobs.inputs} || ${sql.param(JSON.stringify([entry]))}::jsonb`,
        updatedAt: nowDate(),
      })
      .where(
        and(
          jobOwnerCondition(owner),
          eq(userJobs.id, id),
          ne(userJobs.status, "archived"),
          not(
            arrayContains(
              userJobs.inputs,
              sql`${sql.param(JSON.stringify([{ id: input.id }]))}::jsonb`,
            ),
          ),
          input.kind === "authorization"
            ? sql`${userJobs.work}->'authorization'->>'id' = ${input.requestId}`
            : undefined,
        ),
      )
      .returning();
    signal.throwIfAborted();
    if (!row) {
      const current = await set(readUserJob$, owner, id, signal);
      const saved =
        current.status === 200
          ? current.body.inputs.find((value) => {
              return value.id === input.id;
            })
          : undefined;
      if (saved) {
        const {
          authorUserId: _author,
          createdAt: _created,
          ...content
        } = saved;
        if (isDeepStrictEqual(content, input)) {
          return current;
        }
      }
      return conflict("The Job or input identity changed. Reload the Job.");
    }
    await set(wakeProactiveJobs$, owner, signal);
    await publishUserJobsChangedSafely(owner);
    signal.throwIfAborted();
    return { status: 200 as const, body: presentJob(row) };
  },
);

export const acknowledgeUserJobResult$ = command(
  async (
    { set },
    owner: JobOwner,
    id: string,
    resultId: string,
    signal: AbortSignal,
  ) => {
    const [row] = await set(writeDb$)
      .update(userJobs)
      .set({
        viewedResultIds: sql`CASE WHEN ${userJobs.viewedResultIds} @> ${sql.param(JSON.stringify([resultId]))}::jsonb THEN ${userJobs.viewedResultIds} ELSE ${userJobs.viewedResultIds} || ${sql.param(JSON.stringify([resultId]))}::jsonb END`,
      })
      .where(
        and(
          jobOwnerCondition(owner),
          eq(userJobs.id, id),
          arrayContains(
            userJobs.results,
            sql`${sql.param(JSON.stringify([{ id: resultId }]))}::jsonb`,
          ),
        ),
      )
      .returning();
    signal.throwIfAborted();
    if (!row) {
      return notFound("Job Result not found");
    }
    await publishUserJobsChangedSafely(owner);
    signal.throwIfAborted();
    return { status: 200 as const, body: presentJob(row) };
  },
);

export const archiveUserJob$ = command(
  async ({ set }, owner: JobOwner, id: string, signal: AbortSignal) => {
    const [row] = await set(writeDb$)
      .update(userJobs)
      .set({ status: "archived", updatedAt: nowDate() })
      .where(and(jobOwnerCondition(owner), eq(userJobs.id, id)))
      .returning();
    signal.throwIfAborted();
    if (!row) {
      return notFound("Job not found");
    }
    await set(sleepIdleProactiveJobs$, owner, signal);
    await publishUserJobsChangedSafely(owner);
    signal.throwIfAborted();
    return { status: 200 as const, body: presentJob(row) };
  },
);
