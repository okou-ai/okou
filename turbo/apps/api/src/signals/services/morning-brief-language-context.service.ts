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
import { extractFilesFromTarGz } from "../../lib/tar";
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

type MorningBriefLanguageContext =
  /**
   * The owner has no configured instructions, or a valid empty file.
   *
   * Both permit the locale/default path without asking a model to interpret
   * instruction text.
   */
  | {
      readonly kind: "absent";
      /**
       * Why there is nothing to steer with, and under which version.
       *
       * `no-storage` means no instructions volume was ever published, so there
       * is no version to revalidate. `no-target` and `empty-file` are answers
       * *from* a resolved version, and that version is what the
       * pre-reservation recheck compares against — collapsing the three would
       * lose the evidence that this absence was read rather than assumed.
       */
      readonly reason: "no-storage" | "no-target" | "empty-file";
      readonly versionId: string | null;
    }
  /** A complete, valid, nonempty file that belongs in the sole request. */
  | {
      readonly kind: "available";
      readonly versionId: string;
      readonly digest: string;
      readonly bytes: number;
      /** Ephemeral: it travels into the request and is never persisted. */
      readonly text: string;
    }
  | {
      readonly kind: "unavailable";
      readonly reason: MorningBriefLanguageContextFailure;
      /** The version the failure is about, when one was resolved. */
      readonly versionId: string | null;
    };

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

function parseManifest(buffer: Buffer): StorageManifest | null {
  const parsed = safeJsonParse(buffer.toString("utf8"));
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
export async function resolveMorningBriefInstructionsVersion(
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
    if (resolved.kind === "absent") {
      return { kind: "absent", reason: "no-storage", versionId: null };
    }
    const { versionId, s3Key } = resolved;

    const phaseMs = Math.min(
      MORNING_BRIEF_STORAGE_PHASE_MS,
      Math.max(0, args.deadlineAt.getTime() - now()),
    );
    if (phaseMs === 0) {
      return { kind: "unavailable", reason: "timed-out", versionId };
    }
    const phaseSignal = AbortSignal.any([signal, AbortSignal.timeout(phaseMs)]);
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
        reason: storageFailure(manifestDownload.error, phaseSignal),
        versionId,
      };
    }

    const manifest = parseManifest(manifestDownload.value);
    if (manifest === null) {
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
        reason: storageFailure(archiveDownload.error, phaseSignal),
        versionId,
      };
    }

    return extractInstructionText(archiveDownload.value, target, versionId);
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
  // The manifest promising the target once does not mean the archive contains
  // it once. `extractFilesFromTarGz` returns every matching regular entry, and
  // a TAR can legally carry the same path twice; taking the first would pick
  // one of two conflicting instruction files at random. A duplicate is a
  // conflict, not a preference.
  const matches = extracted.files.filter((candidate) => {
    return normalizePath(candidate.path) === target;
  });
  if (matches.length > 1) {
    return { kind: "unavailable", reason: "target-ambiguous", versionId };
  }
  const file = matches[0];
  if (file === undefined) {
    // The manifest promised it and the archive does not contain it: missing
    // data under an existing promised version is never absence.
    return { kind: "unavailable", reason: "target-missing", versionId };
  }

  const raw = file.content;
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
): MorningBriefLanguageContextFailure {
  if (signal.aborted) {
    return "timed-out";
  }
  return error instanceof Error && error.name === "S3ObjectSizeLimitError"
    ? "too-large"
    : "storage-unavailable";
}

/**
 * Decompress and parse the archive without letting a malformed one throw.
 *
 * A gzip bomb, a truncated TAR and a non-UTF-8 file are all rejections rather
 * than absences, so each keeps its own reason.
 */
function safeExtractInstructionFile(
  archiveBuffer: Buffer,
  target: string,
):
  | {
      readonly ok: true;
      readonly files: readonly {
        readonly path: string;
        readonly content: string;
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
      files: extractFilesFromTarGz(
        archiveBuffer,
        [target],
        MORNING_BRIEF_ARCHIVE_MAX_DECOMPRESSED_BYTES,
        { strictUtf8: true },
      ),
    };
  } catch (error) {
    throwIfAbort(error);
    return {
      ok: false,
      reason: error instanceof TypeError ? "not-utf8" : "archive-corrupt",
    };
  }
}
