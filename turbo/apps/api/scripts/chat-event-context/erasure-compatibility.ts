import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import {
  accountErasureJobs,
  accountErasureSinks,
  accountErasureWork,
} from "@okouai/db/schema/account-erasure";
import { chatAgentRunContext } from "@okouai/db/schema/chat-agent-run-context";
import { reviseErasureInventory } from "@okouai/db/operations/account-erasure";
import type { Db } from "../../src/signals/external/db";
import {
  claimBackgroundJob,
  enqueueBackgroundJob,
  type ClaimedBackgroundJob,
} from "../../src/signals/services/background-job.service";
import {
  captureUserErasureWork,
  verifyUserErasureWork,
} from "../../src/signals/services/account-erasure-user-executor";
import { encryptErasureSelector } from "../../src/signals/services/account-erasure-selector";
import { PRE_SPLIT_RELATIONAL_ERASURE_COLLECTOR_VERSION } from "../../src/signals/services/account-erasure-relational-collector";
import { cleanupLateChatContent } from "../../src/signals/services/chat-content-erasure-cleanup.service";
import { withSecretKmsClientForTest } from "../../src/lib/secret-kms-client";

/** Capture the actual old collector contract, then replay it after deployment. */
export async function assertLegacyErasureReplay(db: Db): Promise<void> {
  const key = randomBytes(32);
  // Only the external key service is synthetic. Selector encryption, capture,
  // leasing, proof validation and relational cleanup use production code.
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
      await assertHistoricalCapture(db);
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

async function assertHistoricalCapture(db: Db): Promise<void> {
  const signal = AbortSignal.timeout(60_000);
  const userId = `legacy_erasure_${randomUUID()}`;
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
  const sinks = await db
    .select()
    .from(accountErasureSinks)
    .where(eq(accountErasureSinks.jobId, initial.id));
  const relational = sinks.find((sink) => {
    return sink.domain === "relational";
  });
  assert.ok(relational);
  const selector = await encryptErasureSelector({
    version: 1,
    kind: "subject",
    subjectKind: "user",
    subjectId: userId,
  });
  // No source deletion has happened. The supported revision API creates a
  // real historical capture with the old collector, including its proofs.
  await reviseErasureInventory(
    db,
    initial.id,
    initial,
    sinks.map((sink) => {
      return {
        sinkId: sink.sinkId,
        domain: sink.domain,
        collectorVersion:
          sink.domain === "relational"
            ? PRE_SPLIT_RELATIONAL_ERASURE_COLLECTOR_VERSION
            : sink.collectorVersion,
        selector,
        dependencies: [],
      };
    }),
  );
  assert.equal(await captureUserErasureWork(db, background, signal), true);
  const [captured] = await db
    .select()
    .from(accountErasureJobs)
    .where(eq(accountErasureJobs.id, initial.id));
  assert.ok(captured);
  const contextId = randomUUID();
  await db.insert(chatAgentRunContext).values({
    id: contextId,
    sourceChatThreadId: randomUUID(),
    sourceAgentId: randomUUID(),
    sourceUserId: userId,
    sourceOrgId: `org_${randomUUID()}`,
  });
  assert.equal(await captureUserErasureWork(db, background, signal), true);
  assert.equal(await verifyUserErasureWork(db, background, signal), true);
  const [finished] = await db
    .select()
    .from(accountErasureJobs)
    .where(eq(accountErasureJobs.id, initial.id));
  assert.equal(finished?.captureRevision, captured.captureRevision);
  assert.equal(finished?.state, "verified_no_applicable_data");
  const [retained] = await db
    .select()
    .from(accountErasureSinks)
    .where(
      and(
        eq(accountErasureSinks.jobId, initial.id),
        eq(accountErasureSinks.sinkId, relational.sinkId),
      ),
    );
  assert.equal(
    retained?.collectorVersion,
    PRE_SPLIT_RELATIONAL_ERASURE_COLLECTOR_VERSION,
  );
  assert.equal(
    await cleanupLateChatContent(
      db,
      { subjectKind: "user", subjectId: userId },
      signal,
    ),
    1,
  );
  assert.deepEqual(
    await db
      .select()
      .from(chatAgentRunContext)
      .where(eq(chatAgentRunContext.id, contextId)),
    [],
  );
  await assertOtherSinkDriftRejected(db, initial.id, background, signal);
}

async function assertOtherSinkDriftRejected(
  db: Db,
  jobId: string,
  background: ClaimedBackgroundJob,
  signal: AbortSignal,
): Promise<void> {
  // The narrow replay exception must not turn other registry drift into an
  // implicit migration of captured provider obligations.
  const [unrelated] = await db
    .select({ sinkId: accountErasureSinks.sinkId })
    .from(accountErasureSinks)
    .where(
      and(
        eq(accountErasureSinks.jobId, jobId),
        ne(accountErasureSinks.domain, "relational"),
      ),
    )
    .limit(1);
  assert.ok(unrelated);
  await db
    .update(accountErasureSinks)
    .set({ collectorVersion: randomUUID() })
    .where(
      and(
        eq(accountErasureSinks.jobId, jobId),
        eq(accountErasureSinks.sinkId, unrelated.sinkId),
      ),
    );
  await assert.rejects(
    captureUserErasureWork(db, background, signal),
    /sink registry changed during replay/,
  );
}
