import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { gunzipSync } from "node:zlib";
import { create, Parser } from "tar";
import {
  WORKFLOW_ATTACHMENT_MAX_BYTES,
  WORKFLOW_ATTACHMENT_MAX_FILES,
  type WorkflowAttachments,
} from "@okouai/api-contracts/contracts/workflow-attachments";

export interface WorkflowAttachmentFile {
  readonly path: string;
  readonly content: Buffer;
}

export function workflowAttachmentPath(path: string): string {
  const normalized = posix.normalize(path);
  if (
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.length > 256
  ) {
    throw new Error("Unsafe Workflow attachment path");
  }
  return normalized;
}

export function workflowAttachmentHash(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function normalizeWorkflowAttachmentFiles(
  files: readonly WorkflowAttachmentFile[],
): readonly WorkflowAttachmentFile[] {
  const seen = new Map<string, WorkflowAttachmentFile>();
  let size = 0;
  // Preserve the legacy encoder's deterministic effective filesystem: raw
  // paths, then content hashes, determine the last write to a normalized path.
  for (const file of [...files].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    const left = workflowAttachmentHash(a.content),
      right = workflowAttachmentHash(b.content);
    return left < right ? -1 : left > right ? 1 : 0;
  })) {
    const path = workflowAttachmentPath(file.path);
    if (path === "SKILL.md")
      throw new Error("Reserved Workflow attachment path");
    seen.set(path, { path, content: file.content });
    size += file.content.length;
  }
  const normalized = [...seen.values()].sort((a, b) => {
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  if (
    size > WORKFLOW_ATTACHMENT_MAX_BYTES ||
    normalized.length > WORKFLOW_ATTACHMENT_MAX_FILES
  ) {
    throw new Error("Workflow attachments exceed the file or byte limit");
  }
  for (const { path } of normalized) {
    const parts = path.split("/");
    parts.pop();
    while (parts.length) {
      if (seen.has(parts.join("/")))
        throw new Error("Workflow attachment file conflicts with a directory");
      parts.pop();
    }
  }
  return normalized;
}

export function workflowAttachmentMetadata(
  input: readonly WorkflowAttachmentFile[],
) {
  return normalizeWorkflowAttachmentFiles(input).map((file) => {
    return {
      path: file.path,
      size: file.content.length,
      sha256: workflowAttachmentHash(file.content),
    };
  });
}

/** No provider I/O. A fresh key is owned exclusively by this preparation. */
export async function prepareWorkflowAttachmentBundle(
  orgId: string,
  workflowId: string,
  input: readonly WorkflowAttachmentFile[],
): Promise<{
  readonly descriptor: WorkflowAttachments;
  readonly archive: Buffer | null;
}> {
  const files = normalizeWorkflowAttachmentFiles(input);
  if (files.length === 0)
    return { descriptor: { kind: "empty" }, archive: null };
  if (
    orgId.length === 0 ||
    orgId.includes("/") ||
    orgId.includes("\\") ||
    orgId.includes("\0") ||
    !/^[a-f0-9-]{36}$/u.test(workflowId)
  ) {
    throw new Error("Invalid Workflow attachment owner");
  }
  const root = await mkdtemp(join(tmpdir(), "workflow-attachments-"));
  try {
    for (const file of files) {
      const target = join(root, "files", file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, { mode: 0o644 });
      await chmod(target, 0o644);
    }
    const archivePath = join(root, "archive.tar.gz");
    await create(
      {
        cwd: join(root, "files"),
        file: archivePath,
        gzip: { portable: true },
        portable: true,
        mtime: new Date(0),
      },
      files.map((file) => {
        return file.path;
      }),
    );
    const archive = await readFile(archivePath);
    const metadata = workflowAttachmentMetadata(files);
    return {
      descriptor: {
        kind: "bundle",
        objectKey: `workflow-attachments/${orgId}/${workflowId}/${randomUUID()}/archive.tar.gz`,
        contentHash: workflowAttachmentHash(JSON.stringify(metadata)),
        archiveSha256: workflowAttachmentHash(archive),
        archiveBytes: archive.length,
        files: metadata,
      },
      archive,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Bounded legacy reader used by migration; malformed sources never become empty. */
export function readLegacyWorkflowAttachments(
  archive: Buffer,
): readonly WorkflowAttachmentFile[] {
  return readArchiveFiles(archive, true);
}

export function verifyWorkflowAttachmentBundle(
  archive: Buffer,
  descriptor: Extract<WorkflowAttachments, { kind: "bundle" }>,
): readonly WorkflowAttachmentFile[] {
  if (
    archive.length !== descriptor.archiveBytes ||
    workflowAttachmentHash(archive) !== descriptor.archiveSha256
  )
    throw new Error("Workflow attachment archive integrity mismatch");
  const files = readArchiveFiles(archive, false);
  const metadata = workflowAttachmentMetadata(files);
  if (
    workflowAttachmentHash(JSON.stringify(metadata)) !==
      descriptor.contentHash ||
    JSON.stringify(metadata) !== JSON.stringify(descriptor.files)
  )
    throw new Error("Workflow attachment file integrity mismatch");
  return files;
}

function readArchiveFiles(
  archive: Buffer,
  legacy: boolean,
): readonly WorkflowAttachmentFile[] {
  const bytes = gunzipSync(archive, { maxOutputLength: 32 * 1024 * 1024 });
  const files: WorkflowAttachmentFile[] = [];
  const paths = new Set<string>();
  const materialized = new Map<string, Buffer>();
  let failure: unknown;
  const parser = new Parser({
    strict: true,
    onReadEntry(entry) {
      if (entry.type === "Directory") {
        entry.resume();
        return;
      }
      const path = workflowAttachmentPath(entry.path);
      if (
        (paths.has(path) && !legacy) ||
        !["File", "OldFile", "ContiguousFile"].includes(entry.type)
      ) {
        failure = new Error("Ambiguous or nonregular Workflow archive entry");
        entry.resume();
        return;
      }
      paths.add(path);
      const chunks: Buffer[] = [];
      entry.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      entry.on("end", () => {
        const content = Buffer.concat(chunks);
        const previous = materialized.get(path);
        // The legacy encoder archives its final filesystem once per raw input
        // path. Supported aliases/duplicates therefore repeat identical bytes.
        if (previous !== undefined && !previous.equals(content)) {
          failure = new Error("Ambiguous duplicate Workflow archive entry");
        } else if (previous === undefined) {
          materialized.set(path, content);
          if (path !== "SKILL.md") files.push({ path, content });
        }
      });
    },
  });
  parser.on("error", (error) => {
    failure = error;
  });
  parser.end(bytes);
  if (failure) throw failure;
  if (legacy && !paths.has("SKILL.md"))
    throw new Error("Legacy Workflow archive is missing SKILL.md");
  if (!legacy && paths.has("SKILL.md"))
    throw new Error("Attachment-only archive contains SKILL.md");
  return normalizeWorkflowAttachmentFiles(files);
}
