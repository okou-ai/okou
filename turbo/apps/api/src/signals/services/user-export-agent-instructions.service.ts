import { createHash } from "node:crypto";

import { storageManifestFilesSchema } from "@okouai/api-contracts/contracts/storages";
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
import { z } from "zod";

import { extractBinaryFilesFromTarGz } from "../../lib/tar";
import type { Db } from "../external/db";
import { downloadS3BufferWithMaxBytes } from "../external/s3";
import { APPLICATION_OWNED_AGENT_EXECUTION_PLAN } from "./agent-execution-plan";
import { readPiResourceVersionIndexes } from "./pi-resource-version-index.service";

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_LEGACY_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_LEGACY_EXPANDED_BYTES = 64 * 1024 * 1024;
const manifestSchema = z.object({ files: storageManifestFilesSchema });

interface InstructionsArgs {
  readonly db: Db;
  readonly bucket: string;
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
}

async function instructionSource(args: InstructionsArgs, signal: AbortSignal) {
  const [agent] = await args.db
    .select({ name: agents.name })
    .from(agents)
    .where(
      and(
        eq(agents.id, args.agentId),
        eq(agents.orgId, args.orgId),
        eq(agents.owner, args.userId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!agent) {
    throw new Error("Agent became unavailable during export");
  }
  const [source] = await args.db
    .select({
      storageId: storages.id,
      versionId: storageVersions.id,
      s3Key: storageVersions.s3Key,
      archiveSize: storageVersions.archiveSize,
    })
    .from(storages)
    .innerJoin(
      storageVersions,
      and(
        eq(storageVersions.storageId, storages.id),
        eq(storageVersions.id, storages.headVersionId),
      ),
    )
    .where(
      and(
        eq(storages.orgId, args.orgId),
        eq(storages.userId, VOLUME_ORG_USER_ID),
        eq(storages.name, getInstructionsStorageName(agent.name)),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!source) {
    throw new Error("Agent instructions are unavailable");
  }
  return source;
}

function normalizePath(path: string): string {
  return path.replace(/^\.\//, "");
}

function canonicalContent(bytes: Buffer): string {
  const content = bytes.toString("utf8");
  return content.includes("[AGENT_PROFILE]") ||
    content.includes("<!-- ZERO_PROFILE")
    ? stripMetadataFrontmatter(content)
    : content;
}

/** Exact-version instruction reads with finite legacy decoding bounds. */
export const readUserExportAgentInstructions$ = command(
  async (
    { get },
    args: InstructionsArgs,
    signal: AbortSignal,
  ): Promise<string> => {
    const source = await instructionSource(args, signal);
    const filename = getInstructionsFilename(
      APPLICATION_OWNED_AGENT_EXECUTION_PLAN.framework.fallback,
    );
    const manifestBytes = await get(
      downloadS3BufferWithMaxBytes(
        args.bucket,
        `${source.s3Key}/manifest.json`,
        MAX_MANIFEST_BYTES,
        signal,
      ),
    );
    signal.throwIfAborted();
    const manifest = manifestSchema.parse(
      JSON.parse(manifestBytes.toString("utf8")),
    );
    const instruction = manifest.files.find((file) => {
      return normalizePath(file.path) === normalizePath(filename);
    });
    if (!instruction) {
      throw new Error("Canonical agent instruction document is missing");
    }
    const { indexes } = await readPiResourceVersionIndexes(
      args.db,
      [source.versionId],
      signal,
    );
    signal.throwIfAborted();
    const indexed = indexes.get(source.versionId);
    if (
      indexed &&
      (indexed.storageId !== source.storageId ||
        indexed.archiveSize !== source.archiveSize)
    ) {
      throw new Error(
        "Agent instruction index does not match its source version",
      );
    }
    const indexedFile = indexed?.projection.files.find((file) => {
      return normalizePath(file.path) === normalizePath(filename);
    });
    let bytes: Buffer;
    if (indexedFile?.text?.kind === "text") {
      bytes = Buffer.from(indexedFile.text.value, "utf8");
    } else {
      if (source.archiveSize > MAX_LEGACY_ARCHIVE_BYTES) {
        throw new Error(
          "Unindexed agent instructions exceed the 32 MiB archive limit",
        );
      }
      const archive = await get(
        downloadS3BufferWithMaxBytes(
          args.bucket,
          `${source.s3Key}/archive.tar.gz`,
          MAX_LEGACY_ARCHIVE_BYTES,
          signal,
        ),
      );
      signal.throwIfAborted();
      if (archive.length !== source.archiveSize) {
        throw new Error(
          "Agent instruction archive size does not match its source version",
        );
      }
      const file = extractBinaryFilesFromTarGz(
        archive,
        [instruction.path],
        MAX_LEGACY_EXPANDED_BYTES,
      ).find((candidate) => {
        return candidate.path === normalizePath(instruction.path);
      });
      signal.throwIfAborted();
      if (!file) {
        throw new Error(
          "Canonical agent instruction document is missing from its archive",
        );
      }
      bytes = file.content;
    }
    if (
      bytes.length !== instruction.size ||
      createHash("sha256").update(bytes).digest("hex") !== instruction.hash
    ) {
      throw new Error(
        "Agent instruction bytes do not match the source manifest",
      );
    }
    return canonicalContent(bytes);
  },
);
