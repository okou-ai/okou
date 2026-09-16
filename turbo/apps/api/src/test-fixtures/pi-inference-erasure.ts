import { createHash } from "node:crypto";
import { asc, count, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { blobs } from "@okouai/db/schema/blob";
import { conversations } from "@okouai/db/schema/conversation";
import { agentRunInference } from "@okouai/db/schema/agent-run-inference";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { piInferenceObjects } from "@okouai/db/schema/pi-inference-object";
import { createPiSessionJsonl } from "@okouai/pi-agent-runtime/api";
import { db } from "../lib/db";
import { env } from "../lib/env";
import { nowDate } from "../lib/time";
import {
  deleteLockedRuns,
  deleteRunConversations,
  releaseDeletedConversationReferences,
} from "../signals/services/conversation-history-deletion.service";
import { settleIncludingAbort, throwIfAbort } from "../signals/utils";
import {
  publishPiInferenceObject,
  retainPiInferenceObject,
  deletePiObjectOrphansForOwner,
} from "../signals/services/pi-inference-object.service";
import { piDeferredH1Schema } from "../signals/services/pi-deferred-sandbox-contract";
import type { PiInferenceFixture } from "./pi-inference-lifecycle";

function historyHash(f: PiInferenceFixture) {
  return createHash("sha256").update(f.runId).digest("hex");
}

export async function seedPiErasureHistoryFixture(f: PiInferenceFixture) {
  await db()
    .insert(blobs)
    .values({
      hash: historyHash(f),
      rawSize: 1,
      encodedSize: 1,
      encoding: "identity",
      refCount: 1,
    });
  await db()
    .insert(conversations)
    .values({
      runId: f.runId,
      cliAgentType: "pi",
      cliAgentSessionId: f.sessionId,
      cliAgentSessionHistoryHash: historyHash(f),
    });
  if (f.launchSnapshot.schemaVersion === 4) {
    const sessionHistory = createPiSessionJsonl({
      cwd: "/home/user/workspace",
      sessionId: f.sessionId,
      timestamp: nowDate().toISOString(),
    });
    const hash = await publishPiInferenceObject(
      db(),
      f,
      "h1",
      piDeferredH1Schema,
      {
        schemaVersion: 1,
        manifestGeneration: 3,
        lastEventSequence: 4,
        sessionHistory,
        historyHash: createHash("sha256").update(sessionHistory).digest("hex"),
      },
    );
    await db().transaction(async (tx) => {
      await tx
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(eq(agentRuns.id, f.runId))
        .for("update");
      await retainPiInferenceObject(tx, { ...f, kind: "h1", hash });
    });
  }
}

export async function settlePiErasureUsageFixture(f: PiInferenceFixture) {
  await db()
    .update(agentRunInference)
    .set({ usageSettled: true })
    .where(eq(agentRunInference.runId, f.runId));
}

export async function removePiErasureEvidenceFixture(f: PiInferenceFixture) {
  // Run deletion deliberately SET NULLs usage.run_id; the fixture owns userId.
  await db().delete(usageEvent).where(eq(usageEvent.userId, f.userId));
  await db()
    .delete(blobs)
    .where(eq(blobs.hash, historyHash(f)));
  await deletePiObjectOrphansForOwner(db(), { userId: f.userId });
}

export async function readPiErasureEvidenceFixture(f: PiInferenceFixture) {
  const history = await db()
    .select({ count: count() })
    .from(conversations)
    .where(eq(conversations.runId, f.runId));
  const blob = await db()
    .select({ references: blobs.refCount })
    .from(blobs)
    .where(eq(blobs.hash, historyHash(f)));
  const usage = await db()
    .select({ runId: usageEvent.runId, quantity: usageEvent.quantity })
    .from(usageEvent)
    .where(eq(usageEvent.userId, f.userId));
  const objects = await db()
    .select({ count: count() })
    .from(piInferenceObjects)
    .where(eq(piInferenceObjects.userId, f.userId));
  return { history, blob, usage, objects };
}

/**
 * Infrastructure boundary: the API cannot supply nonexistent captured IDs or
 * create dormant Pi state. Exercise the real shared erasure with a padded set,
 * holding every existing target Run lock and retaining actual-row deletion.
 * Observe driver bindings without replacing the query builder or transport.
 */
export async function erasePiInferenceRunSetFixture(
  runIds: readonly string[],
  options: { readonly rollbackAfterRelease?: true } = {},
) {
  const client = new Client({ connectionString: env("DATABASE_URL") });
  const preflightParameters: unknown[][] = [];
  const objectReferenceParameters: unknown[][] = [];
  let deletionStatements = 0;
  const database = drizzle(client, {
    logger: {
      logQuery(query: string, parameters: unknown[]) {
        if (
          query.startsWith("select") &&
          query.includes('from "agent_run_inference"')
        ) {
          preflightParameters.push(parameters);
        }
        if (
          query.startsWith("select") &&
          query.includes('from "agent_run_inference_objects"')
        ) {
          objectReferenceParameters.push(parameters);
        }
        if (query.startsWith("delete") || query.includes("delete from")) {
          deletionStatements++;
        }
      },
    },
  });
  await client.connect();
  const result = await settleIncludingAbort(
    database.transaction(async (tx) => {
      const locked = await tx
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(eq(agentRuns.id, sql`ANY(${sql.param(runIds)}::uuid[])`))
        .orderBy(asc(agentRuns.id))
        .for("update");
      const removed = await deleteRunConversations(tx, runIds);
      await deleteLockedRuns(
        tx,
        locked.map((run) => {
          return run.id;
        }),
      );
      const receipt = await releaseDeletedConversationReferences(tx, removed);
      if (options.rollbackAfterRelease) {
        throw new Error("Synthetic failure after erasure release");
      }
      return receipt;
    }),
  );
  await client.end();
  if (!result.ok) {
    throwIfAbort(result.error);
  }
  return {
    result,
    preflightParameters,
    objectReferenceParameters,
    deletionStatements,
  };
}

export async function countPiErasureInferenceFixture(
  runIds: readonly string[],
) {
  return await db()
    .select({ count: count() })
    .from(agentRunInference)
    .where(eq(agentRunInference.runId, sql`ANY(${sql.param(runIds)}::uuid[])`));
}
