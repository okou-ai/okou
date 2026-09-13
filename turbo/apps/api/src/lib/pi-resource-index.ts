import { trace } from "@opentelemetry/api";
import { createHash } from "node:crypto";
import { posix } from "node:path";

import { parseSkillFrontmatter } from "@okouai/core";
import type {
  PiDiscoveryText,
  PiResourceIndexFile,
  PiResourceVersionIndex,
} from "@okouai/db/jsonb-contracts/pi-resource-version-index";
import { z } from "zod";

import { safeSync } from "../signals/utils";
import { extractBinaryFilesFromTarGz } from "./tar";

export const PI_RESOURCE_EXTRACTOR_VERSION = 1;
export const RESOURCE_ARCHIVE_MAX_BYTES = 32 * 1024 * 1024;
const RESOURCE_ARCHIVE_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
// Larger projections keep the authoritative archive read path. This bounds DB
// amplification without reducing the set of archives Pi can otherwise discover.
const RESOURCE_INDEX_MAX_BYTES = 16 * 1024 * 1024;
const RESOURCE_INDEX_MAX_FILES = 100_000;

export const CONTEXT_FILE_NAMES = [
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
] as const;
export const IGNORE_FILE_NAMES = [
  ".gitignore",
  ".ignore",
  ".fdignore",
] as const;

const textSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), value: z.string() }),
  z.object({ kind: z.literal("invalid_utf8") }),
]);
const skillSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("skill"),
    name: z.string().optional(),
    description: z.string().optional(),
    disableModelInvocation: z.boolean().optional(),
  }),
  z.object({ kind: z.literal("invalid_utf8") }),
  z.object({ kind: z.literal("invalid_frontmatter") }),
]);
export const piResourceVersionIndexSchema = z.object({
  schemaVersion: z.literal(1),
  files: z.array(
    z.object({
      path: z.string(),
      text: textSchema.optional(),
      skill: skillSchema.optional(),
    }),
  ),
});

function discoveryText(content: Buffer): PiDiscoveryText {
  const decoded = safeSync(() => {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  });
  return "error" in decoded
    ? { kind: "invalid_utf8" }
    : { kind: "text", value: decoded.ok };
}

function indexPiResourceFiles(
  files: readonly { readonly path: string; readonly content: Buffer }[],
): PiResourceVersionIndex {
  return {
    schemaVersion: 1,
    files: files.map((file): PiResourceIndexFile => {
      const name = posix.basename(posix.normalize(file.path));
      const needsText = [...CONTEXT_FILE_NAMES, ...IGNORE_FILE_NAMES].some(
        (candidate) => {
          return candidate === name;
        },
      );
      const needsSkill = name.endsWith(".md");
      if (!needsText && !needsSkill) {
        return { path: file.path };
      }
      const text = discoveryText(file.content);
      const base = { path: file.path, ...(needsText ? { text } : {}) };
      if (!needsSkill) {
        return base;
      }
      if (text.kind === "invalid_utf8") {
        return { ...base, skill: { kind: "invalid_utf8" } };
      }
      const parsed = safeSync(() => {
        return parseSkillFrontmatter(text.value);
      });
      return {
        ...base,
        skill:
          "error" in parsed
            ? { kind: "invalid_frontmatter" }
            : { kind: "skill", ...parsed.ok },
      };
    }),
  };
}

export function indexPiResourceArchive(
  archive: Buffer,
): PiResourceVersionIndex {
  return indexPiResourceFiles(
    extractBinaryFilesFromTarGz(
      archive,
      undefined,
      RESOURCE_ARCHIVE_MAX_OUTPUT_BYTES,
    ),
  );
}

export function piResourceIndexHash(
  projection: PiResourceVersionIndex,
): string {
  return createHash("sha256")
    .update(JSON.stringify(piResourceVersionIndexSchema.parse(projection)))
    .digest("hex");
}

export function piResourceIndexFits(
  projection: PiResourceVersionIndex,
): boolean {
  return (
    projection.files.length <= RESOURCE_INDEX_MAX_FILES &&
    Buffer.byteLength(JSON.stringify(projection), "utf8") <=
      RESOURCE_INDEX_MAX_BYTES
  );
}

export function readPiDiscoveryText(file: PiResourceIndexFile): string {
  if (!file.text) {
    throw new Error("Pi resource index is missing selected discovery text");
  }
  if (file.text.kind === "invalid_utf8") {
    throw new TypeError("The encoded data was not valid for encoding utf-8");
  }
  return file.text.value;
}

/** A valid Storage can exceed Pi discovery limits without invalidating its write. */
export function preparePiResourceIndex(
  archive: Buffer,
): PiResourceVersionIndex | undefined {
  const span = trace
    .getTracer("pi-resource-index")
    .startSpan("pi.resource_index.prepare", {
      attributes: { "pi.archive_bytes": archive.length },
    });
  if (archive.length > RESOURCE_ARCHIVE_MAX_BYTES) {
    span.setAttribute("pi.outcome", "unindexable");
    span.end();
    return undefined;
  }
  const indexed = safeSync(() => {
    return indexPiResourceArchive(archive);
  });
  const projection = "ok" in indexed ? indexed.ok : undefined;
  span.setAttribute(
    "pi.outcome",
    projection && piResourceIndexFits(projection) ? "ready" : "unindexable",
  );
  span.end();
  return projection;
}
