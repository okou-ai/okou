import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, ne, type SQL } from "drizzle-orm";
import {
  accountErasureJobs,
  accountErasureSinks,
  accountErasureWork,
} from "@okouai/db/schema/account-erasure";
import type { Db } from "../../src/signals/external/db";
import {
  claimBackgroundJob,
  enqueueBackgroundJob,
  type ClaimedBackgroundJob,
} from "../../src/signals/services/background-job.service";
import { captureUserErasureWork } from "../../src/signals/services/account-erasure-user-executor";
import { withSecretKmsClientForTest } from "../../src/lib/secret-kms-client";

/** Capture with the deployed collectors, then prove replay rejects any drift. */
export async function assertErasureReplayRejectsDrift(db: Db): Promise<void> {
  const key = randomBytes(32);
  // Only the external key service is synthetic. Selector encryption, capture,
  // leasing and proof validation use production code.
  await withSecretKmsClientForTest(
    {
      generateDataKey: (request) => {
        return Promise.resolve({
          keyId: request.keyId,
          plaintext: key,
          encryptedDataKey: Buffer.from("synthetic-key"),
        });
      },
      decrypt: () => {
        return Promise.resolve(key);
      },
    },
    async () => {
      await assertCapturedVersionsPinned(db);
    },
  );
}

async function assertInitialCapture(
  db: Db,
  background: ClaimedBackgroundJob,
  signal: AbortSignal,
): Promise<void> {
  const capturedInitially = await captureUserErasureWork(
    db,
    background,
    signal,
  );
  assert.equal(
    capturedInitially,
    true,
    JSON.stringify(
      await db
        .select({
          sink: accountErasureWork.sinkId,
          kind: accountErasureWork.kind,
          complete: accountErasureWork.captureComplete,
          state: accountErasureWork.state,
          error: accountErasureWork.errorCode,
        })
        .from(accountErasureWork),
    ),
  );
}

async function assertCapturedVersionsPinned(db: Db): Promise<void> {
  const signal = AbortSignal.timeout(60_000);
  const userId = `erasure_replay_${randomUUID()}`;
  const backgroundId = randomUUID();
  await enqueueBackgroundJob(
    db,
    {
      id: backgroundId,
      kind: "clerk-user-deletion",
      handlerVersion: 1,
      userId,
      orgId: "",
      input: {},
    },
    signal,
  );
  const background = await claimBackgroundJob(
    db,
    {
      jobId: backgroundId,
      kind: "clerk-user-deletion",
      handlerVersion: 1,
    },
    signal,
  );
  assert.ok(background);
  await assertInitialCapture(db, background, signal);
  const [initial] = await db
    .select()
    .from(accountErasureJobs)
    .where(eq(accountErasureJobs.subjectId, userId));
  assert.ok(initial);
  // A sealed capture replays against the unchanged registry.
  assert.equal(await captureUserErasureWork(db, background, signal), true);
  await assertSinkDriftRejected(
    db,
    initial.id,
    background,
    signal,
    eq(accountErasureSinks.domain, "relational"),
  );
  await assertSinkDriftRejected(
    db,
    initial.id,
    background,
    signal,
    ne(accountErasureSinks.domain, "relational"),
  );
}

async function assertSinkDriftRejected(
  db: Db,
  jobId: string,
  background: ClaimedBackgroundJob,
  signal: AbortSignal,
  domain: SQL,
): Promise<void> {
  // A captured collector version, relational included, is never migrated
  // implicitly: replay fails instead of dropping a captured obligation.
  const [sink] = await db
    .select({
      sinkId: accountErasureSinks.sinkId,
      collectorVersion: accountErasureSinks.collectorVersion,
    })
    .from(accountErasureSinks)
    .where(and(eq(accountErasureSinks.jobId, jobId), domain))
    .limit(1);
  assert.ok(sink);
  const target = and(
    eq(accountErasureSinks.jobId, jobId),
    eq(accountErasureSinks.sinkId, sink.sinkId),
  );
  await db
    .update(accountErasureSinks)
    .set({ collectorVersion: randomUUID() })
    .where(target);
  await assert.rejects(
    captureUserErasureWork(db, background, signal),
    /sink registry changed during replay/,
  );
  await db
    .update(accountErasureSinks)
    .set({ collectorVersion: sink.collectorVersion })
    .where(target);
}
