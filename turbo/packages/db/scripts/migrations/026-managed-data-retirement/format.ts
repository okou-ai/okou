import { createHash } from "node:crypto";
import { z } from "zod";

export const tables = [
  "commerce_jobs",
  "data_search_jobs",
  "social_data_jobs",
  "socialkit_download_jobs",
] as const;
export const preparationCommit = "b220a504c5e633de162791f1216c4458188ffe72";
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const rowsSchema = z.array(
  z.object({ id: z.uuid(), document: z.string() }),
);
export const sourceSchema = z.object({
  host: z.string(),
  database: z.string(),
});
export const snapshotSchema = z.object({
  schema: z.string(),
  tables: z
    .array(z.object({ name: z.enum(tables), rows: rowsSchema }))
    .length(4),
});
export const archiveSchema = z.object({
  version: z.literal(1),
  createdAt: z.iso.datetime(),
  source: sourceSchema,
  snapshot: snapshotSchema,
  dumpSha256: digest,
});
export const receiptSchema = z.object({
  archiveSha256: digest,
  dumpSha256: digest,
  restoredAt: z.iso.datetime(),
  restoredTo: sourceSchema,
});
export const approvalSchema = z.object({
  archiveSha256: digest,
  retainedArchiveUri: z.string().min(1),
  retainedArchiveSha256: digest,
  retainedDumpSha256: digest,
  retainedCopyVerifiedAt: z.iso.datetime(),
  productionCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  cutoverAt: z.iso.datetime(),
  productionProofUrl: z.url(),
  platformAbsorbsUnconfirmedCost: z.literal(true),
  additionalUserCharge: z.literal(0),
  refundOrCompensation: z.literal(0),
  unknownJobId: z.uuid(),
  linkFailedJobIds: z.array(z.uuid()).length(9),
});
const jobSchema = z.object({
  id: z.uuid(),
  status: z.string(),
  charge: z.string().nullable(),
  reserved: z.string().nullable(),
  maxCredits: z.string().nullable(),
  actualCost: z.string().nullable(),
  completedAt: z.string().nullable(),
  upstream: z.string().nullable(),
});
export const jobsSchema = z.array(jobSchema);

export function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateUncertainJob(
  job: z.infer<typeof jobSchema>,
  approvedId: string,
): void {
  if (
    job.id !== approvedId ||
    job.charge !== null ||
    job.reserved !== "16" ||
    job.maxCredits !== "16" ||
    job.actualCost !== null ||
    job.completedAt !== null ||
    job.upstream !== null
  )
    throw new Error("UnapprovedUncertainJob");
}

function validateTerminalJob(
  table: string,
  job: z.infer<typeof jobSchema>,
): void {
  if (table === "commerce_jobs") {
    if (!["completed", "failed"].includes(job.status))
      throw new Error("UnapprovedCommerceState");
    return;
  }
  if (table === "socialkit_download_jobs") {
    if (
      !(job.status === "completed" && job.charge !== null) &&
      !(job.status === "provider_failed" && job.charge === null)
    )
      throw new Error("UnapprovedDownloadState");
    return;
  }
  if (
    !["completed", "failed", "cancelled"].includes(job.status) ||
    job.charge === null
  )
    throw new Error("UnapprovedLegacyJobState");
}

export function validatePolicy(
  jobs: ReadonlyMap<string, z.infer<typeof jobsSchema>>,
  approval: z.infer<typeof approvalSchema>,
): void {
  const unknownIds: string[] = [];
  const linkIds: string[] = [];
  let linkCharge = 0n;
  for (const [table, entries] of jobs) {
    for (const job of entries) {
      if (table === "data_search_jobs" && job.status === "unknown") {
        validateUncertainJob(job, approval.unknownJobId);
        unknownIds.push(job.id);
      } else if (
        table === "socialkit_download_jobs" &&
        job.status === "link_failed"
      ) {
        if (job.charge === null || !approval.linkFailedJobIds.includes(job.id))
          throw new Error("UnapprovedDeliveryFailure");
        linkIds.push(job.id);
        linkCharge += BigInt(job.charge);
      } else {
        validateTerminalJob(table, job);
      }
    }
  }
  if (
    unknownIds.length !== 1 ||
    linkIds.length !== 9 ||
    linkCharge !== 105n ||
    new Set(approval.linkFailedJobIds).size !== 9 ||
    approval.linkFailedJobIds.some((id) => {
      return !linkIds.includes(id);
    })
  )
    throw new Error("BusinessDispositionInventoryMismatch");
}

export function validateRetirementReceipts(
  archive: z.infer<typeof archiveSchema>,
  archiveSha256: string,
  receipt: z.infer<typeof receiptSchema>,
  approval: z.infer<typeof approvalSchema>,
  source: z.infer<typeof sourceSchema>,
): void {
  if (
    archive.source.host !== source.host ||
    archive.source.database !== source.database ||
    receipt.archiveSha256 !== archiveSha256 ||
    receipt.dumpSha256 !== archive.dumpSha256 ||
    approval.archiveSha256 !== archiveSha256 ||
    approval.retainedArchiveSha256 !== archiveSha256 ||
    approval.retainedDumpSha256 !== archive.dumpSha256 ||
    Date.now() < Date.parse(approval.cutoverAt) + 300_000 ||
    Date.parse(archive.createdAt) < Date.parse(approval.cutoverAt) + 300_000 ||
    Date.parse(approval.retainedCopyVerifiedAt) > Date.now()
  )
    throw new Error("RetirementReceiptsMismatch");
}
