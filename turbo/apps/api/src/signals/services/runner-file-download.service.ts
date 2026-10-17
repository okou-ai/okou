import { createHash, randomBytes } from "node:crypto";
import {
  runnerFileDownloadsContract,
  RUNNER_FILE_DOWNLOAD_TTL_SECONDS,
  RUNNER_FILE_DOWNLOAD_VERSION,
} from "@okouai/api-contracts/contracts/runner-file-downloads";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { runnerState } from "@okouai/db/runtime/runner-state";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { runnerFileDownloadGrants as grants } from "@okouai/db/schema/runner-file-download-grant";
import { command, computed } from "ccstate";
import { and, eq, exists, gt, inArray, like, lte, sql } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { organizationAuthContext$ } from "../auth/auth-context";
import { pathParamsOf } from "../context/request";
import { db$, writeDb$ } from "../external/db";
import { settle } from "../utils";
import {
  buildRunnerWssTargetQuery,
  runnerWssTargetFromRow,
} from "./runner-wss-target.service";

const databaseNow = sql`timezone('UTC', clock_timestamp())`;
const databaseFreshAfter = sql`${databaseNow} - interval '30 seconds'`;
const databaseLatest = sql`${databaseNow} + interval '5 seconds'`;

interface Target {
  readonly runId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly runnerId: string;
  readonly hostname: string;
  readonly origin: string;
}

/** Read its own database; routes carry only the decided authority values. */
export const fileDownloadTarget$ = computed(
  async (get): Promise<Target | null> => {
    const owner = get(organizationAuthContext$);
    const { runId } = get(pathParamsOf(runnerFileDownloadsContract.bootstrap));
    const now = nowDate();
    const query = buildRunnerWssTargetQuery({
      runId,
      owner,
      now,
      purpose: "issue",
    });
    const [row] = await get(db$)
      .select(query.selection)
      .from(agentRuns)
      .innerJoin(activeAgentRuns, query.activeRunJoin)
      .innerJoin(runnerState, query.runnerStateJoin)
      .where(
        and(
          query.where,
          eq(
            runnerState.fileDownloadServiceVersion,
            RUNNER_FILE_DOWNLOAD_VERSION,
          ),
          gt(
            runnerState.fileDownloadServiceSeenAt,
            new Date(now.getTime() - 30_000),
          ),
          lte(
            runnerState.fileDownloadServiceSeenAt,
            new Date(now.getTime() + 5000),
          ),
        ),
      );
    const target = runnerWssTargetFromRow(row);
    if (!row?.runnerHostname || !target) {
      return null;
    }
    return {
      runId,
      orgId: owner.orgId,
      userId: owner.userId,
      runnerId: target.runnerId,
      hostname: row.runnerHostname,
      origin: target.publicOrigin.replace(/^wss:/, "https:"),
    };
  },
);

export const issueFileDownload$ = command(
  async (
    { set },
    args: {
      readonly target: Target;
      readonly path: string[];
    },
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const { target, path } = args;
    const ticket = randomBytes(32).toString("base64url");
    const digest = createHash("sha256").update(ticket).digest("hex");
    const db = set(writeDb$);
    const query = buildRunnerWssTargetQuery({
      runId: target.runId,
      owner: target,
      now: nowDate(),
      purpose: "issue",
    });
    const expiresAt = sql`${databaseNow} + ${RUNNER_FILE_DOWNLOAD_TTL_SECONDS} * interval '1 second'`;
    const result = await settle(
      db
        .insert(grants)
        .select(
          db
            .select({
              digest: sql`${digest}`.mapWith(grants.digest).as("digest"),
              runId: agentRuns.id,
              orgId: agentRuns.orgId,
              userId: agentRuns.userId,
              runnerId: sql`${target.runnerId}::uuid`
                .mapWith(grants.runnerId)
                .as("runner_id"),
              origin: sql`${target.origin}`.mapWith(grants.origin).as("origin"),
              path: sql`${sql.param(path, grants.path)}::text[]`
                .mapWith(grants.path)
                .as("path"),
              createdAt: databaseNow.mapWith(grants.createdAt).as("created_at"),
              expiresAt: expiresAt.mapWith(grants.expiresAt).as("expires_at"),
            })
            .from(agentRuns)
            .innerJoin(activeAgentRuns, query.activeRunJoin)
            .innerJoin(runnerState, query.runnerStateJoin)
            .where(
              and(
                query.where,
                eq(agentRuns.runnerId, target.runnerId),
                eq(agentRuns.runnerHostname, target.hostname),
                eq(
                  runnerState.fileDownloadServiceVersion,
                  RUNNER_FILE_DOWNLOAD_VERSION,
                ),
                gt(runnerState.fileDownloadServiceSeenAt, databaseFreshAfter),
                lte(runnerState.fileDownloadServiceSeenAt, databaseLatest),
              ),
            ),
        )
        .onConflictDoUpdate({
          target: grants.runId,
          set: {
            digest,
            orgId: target.orgId,
            userId: target.userId,
            runnerId: target.runnerId,
            origin: target.origin,
            path,
            createdAt: databaseNow,
            expiresAt,
          },
          setWhere: lte(grants.expiresAt, databaseNow),
        })
        .returning({ expiresAt: grants.expiresAt }),
      signal,
    );
    if (!result.ok) {
      // Drizzle errors retain bound SQL params, including the private path.
      // Preserve a server failure without passing those params to telemetry.
      throw new Error("File download authorization store failed");
    }
    const [issued] = result.value;
    if (!issued) {
      return null;
    }
    return {
      downloadUrl: `${target.origin}/downloads/${target.runnerId}/${target.runId}/${ticket}`,
      expiresAt: issued.expiresAt.toISOString(),
    };
  },
);

export const consumeFileDownload$ = command(
  async (
    { set },
    args: {
      readonly runId: string;
      readonly runnerId: string;
      readonly origin: string;
      readonly ticket: string;
    },
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const digest = createHash("sha256").update(args.ticket).digest("hex");
    const db = set(writeDb$);
    // Correlated authority predicates are part of the atomic consume statement.
    const live = db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .innerJoin(
        activeAgentRuns,
        and(
          eq(activeAgentRuns.runId, agentRuns.id),
          eq(activeAgentRuns.orgId, agentRuns.orgId),
          eq(activeAgentRuns.userId, agentRuns.userId),
        ),
      )
      .innerJoin(
        runnerState,
        and(
          eq(runnerState.runnerId, agentRuns.runnerId),
          eq(runnerState.runnerGroup, agentRuns.runnerGroup),
        ),
      )
      .where(
        and(
          eq(agentRuns.id, grants.runId),
          eq(agentRuns.orgId, grants.orgId),
          eq(agentRuns.userId, grants.userId),
          eq(agentRuns.runnerId, grants.runnerId),
          eq(agentRuns.status, "running"),
          eq(
            sql`'https://' || ${agentRuns.runnerHostname} || ':443'`,
            grants.origin,
          ),
          like(agentRuns.runnerGroup, "vm0/%"),
          inArray(runnerState.mode, ["running", "draining"]),
          gt(runnerState.lastSeenAt, databaseFreshAfter),
          lte(runnerState.lastSeenAt, databaseLatest),
          eq(
            runnerState.fileDownloadServiceVersion,
            RUNNER_FILE_DOWNLOAD_VERSION,
          ),
          gt(runnerState.fileDownloadServiceSeenAt, databaseFreshAfter),
          lte(runnerState.fileDownloadServiceSeenAt, databaseLatest),
        ),
      );
    const [grant] = await db
      .delete(grants)
      .where(
        and(
          eq(grants.digest, digest),
          eq(grants.runId, args.runId),
          eq(grants.runnerId, args.runnerId),
          eq(grants.origin, args.origin),
          gt(grants.expiresAt, databaseNow),
          exists(live),
        ),
      )
      .returning({
        runId: grants.runId,
        runnerId: grants.runnerId,
        orgId: grants.orgId,
        userId: grants.userId,
        origin: grants.origin,
        digest: grants.digest,
        path: grants.path,
      });
    signal.throwIfAborted();
    return grant ?? null;
  },
);

/** Bounded opportunistic expiry; no credential or file data is returned. */
export const expireFileDownloads$ = command(
  async ({ set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const db = set(writeDb$);
    await db
      .delete(grants)
      .where(
        inArray(
          grants.digest,
          db
            .select({ digest: grants.digest })
            .from(grants)
            .where(lte(grants.expiresAt, databaseNow))
            .orderBy(grants.expiresAt)
            .limit(100),
        ),
      );
    signal.throwIfAborted();
  },
);
