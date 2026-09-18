/**
 * Read the admitted Agent's complete instruction text, under this pipeline's
 * bounds.
 *
 * Ordinary Runs mount the selected Agent's canonical instructions, so a brief
 * that ignored them could not honour an Agent configured to write in Simplified
 * Chinese. This reads the same canonical storage, path and legacy-frontmatter
 * semantics the application already uses, but not through `agentInstructions`:
 * that call has no size ceiling, and a scheduled pipeline with a 45-second
 * phase cannot adopt an unbounded download.
 *
 * The distinctions this module refuses to collapse are the point of it. Absence
 * and a valid empty file are usable answers. An inaccessible bucket, a corrupt
 * archive, a promised canonical target that is missing or duplicated, and an
 * oversized file are failures — turning any of them into "this owner configured
 * nothing" would send an English brief while claiming the owner had asked for
 * nothing else.
 *
 * Nothing here executes instructions or follows links, includes or imports
 * found inside them. The text is context for one model request.
 *
 * The rules are described in
 * [the composition contract](../../../../../../docs/morning-brief-composition.md).
 */

import { createHash } from "node:crypto";

import { getInstructionsFilename } from "@okouai/core/frameworks";
import { stripMetadataFrontmatter } from "@okouai/core/instructions-frontmatter";
import {
  getInstructionsStorageName,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import { agents } from "@okouai/db/schema/agent";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";

import { env } from "../../lib/env";
import { extractTarGzTargetOccurrences } from "../../lib/tar";
import { now } from "../../lib/time";
import { db$, type ReadonlyDb } from "../external/db";
import { downloadS3BufferWithMaxBytes } from "../external/s3";
import { safeJsonParse, settle, throwIfAbort } from "../utils";
import { APPLICATION_OWNED_AGENT_EXECUTION_PLAN } from "./agent-execution-plan";
import {
  MORNING_BRIEF_ARCHIVE_MAX_BYTES,
  MORNING_BRIEF_ARCHIVE_MAX_DECOMPRESSED_BYTES,
  MORNING_BRIEF_INSTRUCTIONS_MAX_BYTES,
  MORNING_BRIEF_MANIFEST_MAX_BYTES,
  MORNING_BRIEF_STORAGE_PHASE_MS,
} from "./morning-brief-language-bounds";
import type { MorningBriefCollectionOwner } from "./morning-brief-collection-occurrence.service";

/** Why the instruction text could not be read, distinctly from absence. */
type MorningBriefLanguageContextFailure =
  /** The Agent is gone, private to somebody else, or not this org's. */
  | "agent-unavailable"
  /** The promised version exists but its data does not, or is unreadable. */
  | "storage-unavailable"
  /** The archive did not decompress or did not parse as a TAR. */
  | "archive-corrupt"
  /** The manifest promised the canonical target more than once. */
  | "target-ambiguous"
  /** The manifest promised the canonical target and the archive lacked it. */
  | "target-missing"
  /** Manifest, archive or instruction file exceeded its ceiling. */
  | "too-large"
  /** The instruction file was not valid UTF-8. */
  | "not-utf8"
  /** The 5-second storage phase elapsed. */
  | "timed-out";

/**
 * The owner has no configured instructions, or a valid empty file.
 *
 * Both permit the locale/default path without asking a model to interpret
 * instruction text, and both are *proven* rather than assumed. `no-storage`
 * means no instructions volume was ever published, so there is no version to
 * revalidate; `no-target` and `empty-file` are answers *from* a resolved
 * version, and that version is what the pre-reservation recheck compares
 * against. Collapsing the three would lose the evidence that this absence was
 * read, and would let a first publication — or a replacement of the empty file
 * — go out under a plan that predates it.
 */
type MorningBriefLanguageAbsence =
  | { readonly kind: "absent"; readonly reason: "no-storage" }
  | {
      readonly kind: "absent";
      readonly reason: "no-target" | "empty-file";
      readonly versionId: string;
    };

/** A complete, valid, nonempty file that belongs in the sole request. */
interface MorningBriefLanguageAvailable {
  readonly kind: "available";
  readonly versionId: string;
  readonly digest: string;
  readonly bytes: number;
  /** Ephemeral: it travels into the request and is never persisted. */
  readonly text: string;
}

/**
 * A context an attempt may freeze into its request: never a failure.
 *
 * An unusable read is not one of these. It never reaches the plan, the
 * revalidation or the model, because "this could not be read" is not an answer
 * about which language the owner asked for.
 */
type MorningBriefFrozenLanguageContext =
  | MorningBriefLanguageAbsence
  | MorningBriefLanguageAvailable;

type MorningBriefLanguageContext =
  | MorningBriefFrozenLanguageContext
  | {
      readonly kind: "unavailable";
      readonly reason: MorningBriefLanguageContextFailure;
      /** The version the failure is about, when one was resolved. */
      readonly versionId: string | null;
    };

/**
 * What one attempt proved about the Agent's instructions, absence included.
 *
 * This is the contract the request assembly and every later consumer read: the
 * observed state and the exact version it was observed under. It carries no
 * instruction text, so it is safe to report and to keep beside a result.
 */
export type MorningBriefInstructionsProvenance =
  | {
      readonly state: "available";
      readonly versionId: string;
      readonly digest: string;
    }
  | { readonly state: "no-storage"; readonly versionId: null }
  | {
      readonly state: "no-target" | "empty-file";
      readonly versionId: string;
    };

export function morningBriefInstructionsProvenance(
  context: MorningBriefFrozenLanguageContext,
): MorningBriefInstructionsProvenance {
  if (context.kind === "available") {
    return {
      state: "available",
      versionId: context.versionId,
      digest: context.digest,
    };
  }
  if (context.reason === "no-storage") {
    return { state: "no-storage", versionId: null };
  }
  return { state: context.reason, versionId: context.versionId };
}

interface ManifestFileEntry {
  readonly path: string;
  readonly size: number;
}

interface StorageManifest {
  readonly files: readonly ManifestFileEntry[];
}

function normalizePath(path: string): string {
  return path.replace(/^\.\//, "");
}

/**
 * Decode the manifest strictly, because a replaced byte is not a missing file.
 *
 * `Buffer#toString` substitutes U+FFFD for bytes it cannot read, which turns a
 * promised canonical path into a path that matches nothing — and "matches
 * nothing" is absence, the one conclusion a damaged manifest must never
 * produce.
 */
function decodeManifest(buffer: Buffer): string | null {
  // eslint-disable-next-line no-restricted-syntax -- a fatal TextDecoder throws on invalid UTF-8
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (error) {
    throwIfAbort(error);
    return null;
  }
}

function parseManifest(buffer: Buffer): StorageManifest | null {
  const decoded = decodeManifest(buffer);
  if (decoded === null) {
    return null;
  }
  const parsed = safeJsonParse(decoded);
  if (typeof parsed !== "object" || parsed === null || !("files" in parsed)) {
    return null;
  }
  const { files } = parsed as { readonly files: unknown };
  if (!Array.isArray(files)) {
    return null;
  }
  const entries: ManifestFileEntry[] = [];
  for (const file of files) {
    if (typeof file !== "object" || file === null) {
      return null;
    }
    const candidate = file as {
      readonly path?: unknown;
      readonly size?: unknown;
    };
    if (typeof candidate.path !== "string") {
      return null;
    }
    entries.push({
      path: candidate.path,
      size: typeof candidate.size === "number" ? candidate.size : 0,
    });
  }
  return { files: entries };
}

/**
 * The immutable instruction version to read, resolved before any network call.
 *
 * Freezing the version first is what makes the read reproducible and what lets
 * a later instructions-only edit apply to the *next* occurrence instead of
 * silently changing the one already in flight.
 */
async function resolveMorningBriefInstructionsVersion(
  db: Pick<ReadonlyDb, "select">,
  owner: MorningBriefCollectionOwner,
  agentId: string,
): Promise<
  | { readonly kind: "agent-unavailable" }
  | { readonly kind: "absent" }
  | {
      readonly kind: "resolved";
      readonly versionId: string;
      readonly s3Key: string;
    }
> {
  const [agent] = await db
    .select({
      name: agents.name,
      orgId: agents.orgId,
      owner: agents.owner,
      visibility: agents.visibility,
    })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, owner.orgId)))
    .limit(1);
  if (
    !agent ||
    (agent.visibility === "private" && agent.owner !== owner.userId)
  ) {
    return { kind: "agent-unavailable" };
  }

  const [storage] = await db
    .select({ headVersionId: storages.headVersionId })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, agent.orgId),
        eq(storages.userId, VOLUME_ORG_USER_ID),
        eq(storages.name, getInstructionsStorageName(agent.name)),
      ),
    )
    .limit(1);
  if (!storage?.headVersionId) {
    // No instructions volume has ever been published for this Agent.
    return { kind: "absent" };
  }

  const [version] = await db
    .select({ id: storageVersions.id, s3Key: storageVersions.s3Key })
    .from(storageVersions)
    .where(eq(storageVersions.id, storage.headVersionId))
    .limit(1);
  if (!version) {
    // The head points at a version row that is gone: the promise exists and the
    // data does not, which is a failure rather than an absence.
    return { kind: "agent-unavailable" };
  }
  return { kind: "resolved", versionId: version.id, s3Key: version.s3Key };
}

/**
 * Read one resolved version's canonical instruction file within the bounds.
 *
 * Manifest and archive are read with explicit ceilings rather than downloaded
 * and measured afterwards, and the decompressed size is bounded by gunzip
 * itself, so an archive bomb fails before it is materialized.
 */
export const readMorningBriefLanguageContext$ = command(
  async (
    { get },
    args: {
      readonly owner: MorningBriefCollectionOwner;
      readonly agentId: string;
      readonly deadlineAt: Date;
    },
    signal: AbortSignal,
  ): Promise<MorningBriefLanguageContext> => {
    const db = get(db$);
    // One absolute deadline, started before the work it bounds. The phase is
    // the tighter of its own five seconds and whatever is left of the
    // collection budget, and reaching it is already expired: a successful
    // response that arrives at the deadline is as unusable as one that never
    // arrives, and its timer may not have run yet.
    const expiresAt = Math.min(
      now() + MORNING_BRIEF_STORAGE_PHASE_MS,
      args.deadlineAt.getTime(),
    );
    const expired = (): boolean => {
      return now() >= expiresAt;
    };
    if (expired()) {
      // An exhausted budget buys nothing by asking storage anything at all.
      return { kind: "unavailable", reason: "timed-out", versionId: null };
    }
    const phaseSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(expiresAt - now()),
    ]);

    const resolved = await resolveMorningBriefInstructionsVersion(
      db,
      args.owner,
      args.agentId,
    );
    signal.throwIfAborted();
    if (resolved.kind === "agent-unavailable") {
      return {
        kind: "unavailable",
        reason: "agent-unavailable",
        versionId: null,
      };
    }
    if (expired()) {
      return {
        kind: "unavailable",
        reason: "timed-out",
        versionId: resolved.kind === "resolved" ? resolved.versionId : null,
      };
    }
    if (resolved.kind === "absent") {
      return { kind: "absent", reason: "no-storage" };
    }
    const { versionId, s3Key } = resolved;

    const filename = getInstructionsFilename(
      APPLICATION_OWNED_AGENT_EXECUTION_PLAN.framework.fallback,
    );
    const target = normalizePath(filename);

    const manifestDownload = await settle(
      get(
        downloadS3BufferWithMaxBytes(
          env("R2_USER_STORAGES_BUCKET_NAME"),
          `${s3Key}/manifest.json`,
          MORNING_BRIEF_MANIFEST_MAX_BYTES,
          phaseSignal,
        ),
      ),
    );
    signal.throwIfAborted();
    if (!manifestDownload.ok) {
      return {
        kind: "unavailable",
        reason: storageFailure(manifestDownload.error, phaseSignal, expired()),
        versionId,
      };
    }
    if (expired()) {
      return { kind: "unavailable", reason: "timed-out", versionId };
    }

    const manifest = parseManifest(manifestDownload.value);
    if (manifest === null) {
      // Unreadable metadata about the promised version, not a configuration.
      return { kind: "unavailable", reason: "storage-unavailable", versionId };
    }
    const promised = manifest.files.filter((file) => {
      return normalizePath(file.path) === target;
    });
    if (promised.length === 0) {
      // The volume exists and simply carries no instructions file.
      return { kind: "absent", reason: "no-target", versionId };
    }
    if (promised.length > 1) {
      return { kind: "unavailable", reason: "target-ambiguous", versionId };
    }
    const [entry] = promised;
    if (
      entry !== undefined &&
      entry.size > MORNING_BRIEF_INSTRUCTIONS_MAX_BYTES
    ) {
      // The manifest already proves it cannot fit, so the archive is not fetched.
      return { kind: "unavailable", reason: "too-large", versionId };
    }

    const archiveDownload = await settle(
      get(
        downloadS3BufferWithMaxBytes(
          env("R2_USER_STORAGES_BUCKET_NAME"),
          `${s3Key}/archive.tar.gz`,
          MORNING_BRIEF_ARCHIVE_MAX_BYTES,
          phaseSignal,
        ),
      ),
    );
    signal.throwIfAborted();
    if (!archiveDownload.ok) {
      return {
        kind: "unavailable",
        reason: storageFailure(archiveDownload.error, phaseSignal, expired()),
        versionId,
      };
    }
    if (expired()) {
      return { kind: "unavailable", reason: "timed-out", versionId };
    }

    const extracted = extractInstructionText(
      archiveDownload.value,
      target,
      versionId,
    );
    signal.throwIfAborted();
    // Decompression and extraction are synchronous and unbounded by the timer,
    // so the clock is read once more before anything is released.
    if (expired()) {
      return { kind: "unavailable", reason: "timed-out", versionId };
    }
    return extracted;
  },
);

/**
 * Take the canonical instruction file out of a bounded archive.
 *
 * The archive is already size-checked; gunzip enforces the decompressed ceiling
 * itself, and strict UTF-8 decoding rejects a file that is not text rather than
 * replacing the bytes it cannot read.
 */
function extractInstructionText(
  archiveBuffer: Buffer,
  target: string,
  versionId: string,
): MorningBriefLanguageContext {
  const extracted = safeExtractInstructionFile(archiveBuffer, target);
  if (!extracted.ok) {
    return { kind: "unavailable", reason: extracted.reason, versionId };
  }
  // The manifest promising the target once does not mean the archive resolves
  // it once. A TAR can legally carry the same path twice, and it can carry a
  // symlink or a directory beside the file — counting only regular entries
  // would turn that ambiguity into a silent choice between two different
  // instruction sources. Every claim on the path is counted, and a conflict is
  // a conflict rather than a preference.
  const claims = extracted.entries.filter((candidate) => {
    return normalizePath(candidate.path) === target;
  });
  if (claims.length > 1) {
    return { kind: "unavailable", reason: "target-ambiguous", versionId };
  }
  const claim = claims[0];
  if (claim === undefined || claim.content === null) {
    // Either the archive does not contain the promised target, or what it
    // contains there is not a regular file and is never followed. Missing data
    // under an existing promised version is never absence.
    return { kind: "unavailable", reason: "target-missing", versionId };
  }

  const decoded = decodeInstructionFile(claim.content);
  if (decoded === null) {
    return { kind: "unavailable", reason: "not-utf8", versionId };
  }
  const raw = decoded;
  if (Buffer.byteLength(raw, "utf8") > MORNING_BRIEF_INSTRUCTIONS_MAX_BYTES) {
    return { kind: "unavailable", reason: "too-large", versionId };
  }
  const hasLegacyBlocks =
    raw.includes("[AGENT_PROFILE]") || raw.includes("<!-- ZERO_PROFILE");
  const text = hasLegacyBlocks ? stripMetadataFrontmatter(raw) : raw;
  if (text.trim() === "") {
    // A valid empty file is a real answer: the owner configured no
    // instructions, so the locale/default path applies without a model
    // interpreting anything. The version still travels, because "read this
    // version and found it empty" is a different fact from "found nothing".
    return { kind: "absent", reason: "empty-file", versionId };
  }
  return {
    kind: "available",
    versionId,
    digest: createHash("sha256").update(text, "utf8").digest("hex"),
    bytes: Buffer.byteLength(text, "utf8"),
    text,
  };
}

function storageFailure(
  error: unknown,
  signal: AbortSignal,
  timedOut: boolean,
): MorningBriefLanguageContextFailure {
  if (signal.aborted || timedOut) {
    return "timed-out";
  }
  return error instanceof Error && error.name === "S3ObjectSizeLimitError"
    ? "too-large"
    : "storage-unavailable";
}

/**
 * Decode one instruction file strictly.
 *
 * A file that is not text is a rejection, never an empty one: replacing the
 * bytes it cannot read would let a binary blob pass as an owner who configured
 * nothing.
 */
function decodeInstructionFile(content: Buffer): string | null {
  // eslint-disable-next-line no-restricted-syntax -- a fatal TextDecoder throws on invalid UTF-8
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch (error) {
    throwIfAbort(error);
    return null;
  }
}

/** gunzip refusing to grow past the ceiling this pipeline asked it to hold. */
function exceededDecompressedCeiling(error: unknown): boolean {
  return (
    error instanceof RangeError &&
    "code" in error &&
    error.code === "ERR_BUFFER_TOO_LARGE"
  );
}

/**
 * Decompress and parse the archive without letting a malformed one throw.
 *
 * A truncated TAR and an archive that decompresses past the ceiling are both
 * rejections, and they are different rejections: the ceiling is a size limit
 * this pipeline imposes, and reporting it as corruption would blame the
 * owner's data for a bound of ours.
 */
function safeExtractInstructionFile(
  archiveBuffer: Buffer,
  target: string,
):
  | {
      readonly ok: true;
      readonly entries: readonly {
        readonly path: string;
        readonly content: Buffer | null;
      }[];
    }
  | {
      readonly ok: false;
      readonly reason: MorningBriefLanguageContextFailure;
    } {
  // eslint-disable-next-line no-restricted-syntax -- the archive helpers are synchronous and throw on malformed input
  try {
    return {
      ok: true,
      entries: extractTarGzTargetOccurrences(
        archiveBuffer,
        [target],
        MORNING_BRIEF_ARCHIVE_MAX_DECOMPRESSED_BYTES,
      ),
    };
  } catch (error) {
    throwIfAbort(error);
    return {
      ok: false,
      reason: exceededDecompressedCeiling(error)
        ? "too-large"
        : "archive-corrupt",
    };
  }
}

/**
 * Prove the frozen instruction context still describes live configuration.
 *
 * Every state has something to revalidate, and each one is a different
 * question: an available or empty-file answer must still be that immutable
 * version, a missing target must still be missing *under that version*, and
 * "nothing was ever published" must still be true. Checking only the available
 * case would let a first publication, or a replacement of an empty file, be
 * summarized under a locale plan that was decided before either existed.
 */
export async function morningBriefInstructionsUnchanged(
  db: Pick<ReadonlyDb, "select">,
  owner: MorningBriefCollectionOwner,
  agentId: string,
  context: MorningBriefFrozenLanguageContext,
): Promise<boolean> {
  const current = await resolveMorningBriefInstructionsVersion(
    db,
    owner,
    agentId,
  );
  if (context.kind === "absent" && context.reason === "no-storage") {
    return current.kind === "absent";
  }
  return current.kind === "resolved" && current.versionId === context.versionId;
}
