import { v5 as uuidv5 } from "uuid";
import { and, eq } from "drizzle-orm";

import {
  claimErasureWork,
  executeErasureWork,
  finalizeErasureJob,
  projectErasureDecision,
  reviseErasureInventory,
  sealErasureCapture,
  yieldErasureLease,
  type ErasureHandler,
  type ErasureSink,
} from "@okouai/db/operations/account-erasure";
import {
  accountErasureSinks,
  accountErasureWork,
} from "@okouai/db/schema/account-erasure";

import { now } from "../../lib/time";
import type { Db } from "../external/db";
import { settle } from "../utils";
import {
  BACKGROUND_JOB_LEASE_MS,
  type ClaimedBackgroundJob,
} from "./background-job.service";
import {
  ARTIFACT_FILE_ERASURE_COLLECTOR_VERSION,
  createArtifactFileErasureCollector,
} from "./account-erasure-artifact-file-collector";
import {
  ARTIFACT_SHARE_ERASURE_COLLECTOR_VERSION,
  createArtifactShareErasureCollector,
} from "./account-erasure-artifact-share-collector";
import {
  BROWSER_PROFILE_ERASURE_COLLECTOR_VERSION,
  createBrowserProfileErasureCollector,
} from "./account-erasure-browser-profile-collector";
import {
  BROWSER_SESSION_ERASURE_COLLECTOR_VERSION,
  createBrowserSessionErasureCollector,
} from "./account-erasure-browser-session-collector";
import {
  CHAT_SNAPSHOT_ERASURE_COLLECTOR_VERSION,
  createChatSnapshotErasureCollector,
} from "./account-erasure-chat-snapshot-collector";
import {
  EXPORT_OBJECT_ERASURE_COLLECTOR_VERSION,
  createExportObjectErasureCollector,
} from "./account-erasure-export-object-collector";
import {
  HOSTED_SITE_ERASURE_COLLECTOR_VERSION,
  createHostedSiteErasureCollector,
} from "./account-erasure-hosted-site-collector";
import {
  RELATIONAL_ERASURE_COLLECTOR_VERSION,
  assertRelationalSweepComplete,
  createRelationalErasureCollector,
  planRelationalErasure,
} from "./account-erasure-relational-collector";
import {
  SHARED_BLOB_ERASURE_COLLECTOR_VERSION,
  createSharedBlobErasureCollector,
} from "./account-erasure-shared-blob-collector";
import {
  STORAGE_OBJECT_ERASURE_COLLECTOR_VERSION,
  createStorageObjectErasureCollector,
} from "./account-erasure-storage-object-collector";
import { encryptErasureSelector } from "./account-erasure-selector";

const NAMESPACE = "929b9a52-05dc-44ea-b0b6-b3bce89968ef";
const MAX_WORK_PER_INVOCATION = 64;
const WORK_BUDGET_MS = BACKGROUND_JOB_LEASE_MS - 20_000;
const DEADLINE_MS = 365 * 24 * 60 * 60 * 1000;
const REQUIRED_SERVER_CAPTURE = [
  "artifact_file",
  "artifact_share",
  "chat_snapshot",
  "hosted_site",
  "shared_blob",
  "storage_object",
  "relational",
  "export_object",
  "remote",
  "telemetry",
  "recovery",
] as const;

type SinkName =
  | "artifact_file"
  | "artifact_share"
  | "browser_profile"
  | "browser_session"
  | "chat_snapshot"
  | "export_object"
  | "hosted_site"
  | "shared_blob"
  | "storage_object"
  | "relational";

const sinkSpecs: readonly {
  readonly name: SinkName;
  readonly domain: ErasureSink["domain"];
  readonly version: string;
}[] = [
  {
    name: "artifact_file",
    domain: "objects",
    version: ARTIFACT_FILE_ERASURE_COLLECTOR_VERSION,
  },
  {
    name: "artifact_share",
    domain: "objects",
    version: ARTIFACT_SHARE_ERASURE_COLLECTOR_VERSION,
  },
  {
    name: "browser_profile",
    domain: "providers",
    version: BROWSER_PROFILE_ERASURE_COLLECTOR_VERSION,
  },
  {
    name: "browser_session",
    domain: "providers",
    version: BROWSER_SESSION_ERASURE_COLLECTOR_VERSION,
  },
  {
    name: "chat_snapshot",
    domain: "objects",
    version: CHAT_SNAPSHOT_ERASURE_COLLECTOR_VERSION,
  },
  {
    name: "export_object",
    domain: "objects",
    version: EXPORT_OBJECT_ERASURE_COLLECTOR_VERSION,
  },
  {
    name: "hosted_site",
    domain: "objects",
    version: HOSTED_SITE_ERASURE_COLLECTOR_VERSION,
  },
  {
    name: "shared_blob",
    domain: "objects",
    version: SHARED_BLOB_ERASURE_COLLECTOR_VERSION,
  },
  {
    name: "storage_object",
    domain: "objects",
    version: STORAGE_OBJECT_ERASURE_COLLECTOR_VERSION,
  },
  {
    name: "relational",
    domain: "relational",
    version: RELATIONAL_ERASURE_COLLECTOR_VERSION,
  },
];

function reference(parts: readonly unknown[]): string {
  return uuidv5(JSON.stringify(parts), NAMESPACE);
}

function sinkId(backgroundJobId: string, name: SinkName): string {
  return reference(["sink", backgroundJobId, name]);
}

function assertRequiredCaptureRegistered(): void {
  const registered = new Set<string>(
    sinkSpecs.map((spec) => {
      return spec.name;
    }),
  );
  const missing = REQUIRED_SERVER_CAPTURE.find((name) => {
    return !registered.has(name);
  });
  if (missing) {
    throw new Error(`account_erasure:required_capture_missing:${missing}`);
  }
}

async function ensureUserErasureJob(
  db: Db,
  backgroundJob: ClaimedBackgroundJob,
) {
  // The committed, idempotent user.deleted background row is the local
  // decision authority. Its immutable ID and createdAt survive webhook replay.
  const projected = await projectErasureDecision(db, {
    subjectKind: "user",
    subjectId: backgroundJob.userId,
    generation: 1,
    authorityId: reference(["authority", backgroundJob.id]),
    decisionRef: reference(["decision", backgroundJob.id]),
    decisionSequence: 1n,
    confirmationRef: reference(["confirmation", backgroundJob.id]),
    previousDecisionRef: null,
    dispositionVersion: 1,
    requestedAt: backgroundJob.createdAt,
    deadlineAt: new Date(backgroundJob.createdAt.getTime() + DEADLINE_MS),
  });
  const existing = await db
    .select()
    .from(accountErasureSinks)
    .where(eq(accountErasureSinks.jobId, projected.id));
  if (existing.length > 0) {
    if (
      existing.length !== sinkSpecs.length ||
      !sinkSpecs.every((spec) => {
        return existing.some((sink) => {
          return (
            sink.sinkId === sinkId(backgroundJob.id, spec.name) &&
            sink.domain === spec.domain &&
            sink.collectorVersion === spec.version
          );
        });
      })
    ) {
      throw new Error("Account erasure sink registry changed during replay");
    }
    return projected;
  }
  const selector = await encryptErasureSelector({
    version: 1,
    kind: "subject",
    subjectKind: "user",
    subjectId: backgroundJob.userId,
  });
  const required: ErasureSink[] = sinkSpecs.map((spec) => {
    return {
      sinkId: sinkId(backgroundJob.id, spec.name),
      domain: spec.domain,
      collectorVersion: spec.version,
      selector,
      dependencies: [],
    };
  });
  return await reviseErasureInventory(db, projected.id, projected, required);
}

async function handlers(db: Db) {
  const plan = await planRelationalErasure(db);
  const byName: Record<SinkName, ErasureHandler> = {
    artifact_file: createArtifactFileErasureCollector(db),
    artifact_share: createArtifactShareErasureCollector(db),
    browser_profile: createBrowserProfileErasureCollector(db),
    browser_session: createBrowserSessionErasureCollector(db),
    chat_snapshot: createChatSnapshotErasureCollector(db),
    export_object: createExportObjectErasureCollector(db),
    hosted_site: createHostedSiteErasureCollector(db),
    shared_blob: createSharedBlobErasureCollector(db),
    storage_object: createStorageObjectErasureCollector(db),
    relational: createRelationalErasureCollector(db, plan),
  };
  return { plan, byName };
}

async function driveWork(
  db: Db,
  backgroundJob: ClaimedBackgroundJob,
  erasureJobId: string,
  phase: "inventory" | "verification",
  signal: AbortSignal,
): Promise<number> {
  const stopAt = now() + WORK_BUDGET_MS;
  const { byName } = await handlers(db);
  const byId = new Map(
    sinkSpecs.map((spec) => {
      return [sinkId(backgroundJob.id, spec.name), byName[spec.name]];
    }),
  );
  let processed = 0;
  while (processed < MAX_WORK_PER_INVOCATION && now() < stopAt) {
    signal.throwIfAborted();
    // A single lease bounds the outstanding work when the parent invocation
    // reaches its deadline. Preclaiming pages can exhaust retry attempts for
    // untouched rows after repeated process restarts.
    const leases = await claimErasureWork(db, erasureJobId, phase, 1);
    if (leases.length === 0) {
      break;
    }
    for (const lease of leases) {
      signal.throwIfAborted();
      await executeErasureWork(db, lease, byId.get(lease.item.sinkId), signal);
      if (phase === "inventory") {
        await yieldErasureLease(db, lease);
      }
      processed += 1;
    }
  }
  return processed;
}

export async function captureUserErasureWork(
  db: Db,
  backgroundJob: ClaimedBackgroundJob,
  signal: AbortSignal,
): Promise<boolean> {
  const job = await ensureUserErasureJob(db, backgroundJob);
  if (job.sealedCaptureRevision === job.captureRevision) {
    assertRequiredCaptureRegistered();
    return true;
  }
  await driveWork(db, backgroundJob, job.id, "inventory", signal);
  const [incomplete] = await db
    .select({ id: accountErasureWork.id })
    .from(accountErasureWork)
    .where(
      and(
        eq(accountErasureWork.jobId, job.id),
        eq(accountErasureWork.kind, "inventory"),
        eq(accountErasureWork.captureComplete, false),
      ),
    )
    .limit(1);
  if (incomplete) {
    return false;
  }
  const { plan } = await handlers(db);
  // A currently unattributable descendant stops before the legacy cleanup
  // can remove an owner row that its future selector will need.
  assertRelationalSweepComplete(plan);
  assertRequiredCaptureRegistered();
  await sealErasureCapture(
    db,
    job.id,
    job,
    {
      verify: () => {
        return Promise.resolve({
          jobId: job.id,
          generation: job.generation,
          captureRevision: job.captureRevision,
          inventoryRevision: job.inventoryRevision,
          reference: reference([
            "sealed-capture",
            backgroundJob.id,
            job.captureRevision,
            job.inventoryRevision,
          ]),
        });
      },
    },
    signal,
  );
  return true;
}

export async function verifyUserErasureWork(
  db: Db,
  backgroundJob: ClaimedBackgroundJob,
  signal: AbortSignal,
): Promise<boolean> {
  const job = await ensureUserErasureJob(db, backgroundJob);
  assertRequiredCaptureRegistered();
  if (job.sealedCaptureRevision !== job.captureRevision) {
    throw new Error("Account erasure capture was not sealed");
  }
  await driveWork(db, backgroundJob, job.id, "verification", signal);
  const [unresolved] = await db
    .select({ id: accountErasureWork.id })
    .from(accountErasureWork)
    .where(
      and(
        eq(accountErasureWork.jobId, job.id),
        eq(accountErasureWork.generation, job.generation),
        eq(accountErasureWork.captureComplete, false),
        eq(accountErasureWork.kind, "inventory"),
      ),
    )
    .limit(1);
  if (unresolved) {
    return false;
  }
  // The B1 transaction remains the sole completion authority. In particular,
  // work_unresolved is not converted to a successful background job.
  const finalized = await settle(finalizeErasureJob(db, job.id, job), signal);
  if (finalized.ok) {
    return true;
  }
  if (
    finalized.error instanceof Error &&
    finalized.error.message === "account_erasure:work_unresolved"
  ) {
    return false;
  }
  throw finalized.error;
}
