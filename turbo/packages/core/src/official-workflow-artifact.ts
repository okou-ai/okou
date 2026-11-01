import { list } from "tar";
import type { OfficialWorkflowDefinitionRevisionPayload } from "@okouai/api-contracts/contracts/official-workflow-catalog";
import {
  computeContentHashFromHashes,
  hashFileContent,
} from "@okouai/api-contracts/contracts/storage-content-hash";
import { synthesizeWorkflowSkillMd } from "./skill-document";

export const OFFICIAL_WORKFLOW_DEFINITION_MANIFEST_PATH =
  ".vm0/official-workflow-definition.json";

interface ArtifactFile {
  readonly path: string;
  readonly content: string;
}

interface PublishedArtifact {
  readonly storageId: string;
  readonly storageVersion: string;
  readonly definitionManifest: string;
}

function fileEntry(file: ArtifactFile) {
  const content = Buffer.from(file.content, "utf8");
  return {
    path: file.path,
    hash: hashFileContent(content),
    size: content.length,
  };
}

/** Execution bytes exclude catalog/revision metadata and Blueprint definitions. */
export function officialWorkflowExecutionFiles(
  definition: Pick<
    OfficialWorkflowDefinitionRevisionPayload,
    "name" | "workflow"
  >,
): readonly ArtifactFile[] {
  return [
    {
      path: "SKILL.md",
      content: synthesizeWorkflowSkillMd({
        name: definition.name,
        description: definition.workflow.description,
        instruction: definition.workflow.instruction,
      }),
    },
    ...definition.workflow.files,
  ];
}

/** Encode execution files, or reproduce the exact bytes of a published artifact. */
export function officialWorkflowArtifactFiles(
  definition: Pick<
    OfficialWorkflowDefinitionRevisionPayload,
    "name" | "workflow"
  >,
  published?: PublishedArtifact,
): readonly ArtifactFile[] | null {
  const files = officialWorkflowExecutionFiles(definition);
  if (!published) {
    return files;
  }
  const entries = files.map(fileEntry);
  if (
    computeContentHashFromHashes(published.storageId, entries) ===
    published.storageVersion
  ) {
    return files;
  }

  // Retained immutable Storage artifacts authenticate the old manifest too.
  // Remove this encoding after their migration to content bundles (#44164).
  const manifest = {
    path: OFFICIAL_WORKFLOW_DEFINITION_MANIFEST_PATH,
    content: published.definitionManifest,
  };
  return computeContentHashFromHashes(published.storageId, [
    ...entries,
    fileEntry(manifest),
  ]) === published.storageVersion
    ? [...files, manifest]
    : null;
}

/** Authenticate retained legacy bytes before projecting them into a shared bundle. */
export function verifyOfficialWorkflowArtifact(
  archive: Buffer,
  definition: Pick<
    OfficialWorkflowDefinitionRevisionPayload,
    "name" | "workflow"
  >,
  published: PublishedArtifact,
): void {
  const expectedFiles = officialWorkflowArtifactFiles(definition, published);
  if (!expectedFiles || archive.length > 32 * 1024 * 1024) {
    throw new Error("Official Workflow archive identity is inconsistent");
  }
  const expected = new Map(
    expectedFiles.map((file) => {
      return [file.path, Buffer.from(file.content, "utf8")];
    }),
  );
  const seen = new Set<string>();
  const parser = list({
    sync: true,
    strict: true,
    onReadEntry(entry) {
      const bytes = expected.get(entry.path);
      if (
        !bytes ||
        entry.type !== "File" ||
        entry.size !== bytes.length ||
        seen.has(entry.path)
      ) {
        throw new Error("Official Workflow archive file set is inconsistent");
      }
      seen.add(entry.path);
      const chunks: Buffer[] = [];
      entry.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      entry.on("end", () => {
        if (!Buffer.concat(chunks).equals(bytes))
          throw new Error(
            "Official Workflow archive file content is inconsistent",
          );
      });
    },
  });
  parser.end(archive);
  if (seen.size !== expected.size)
    throw new Error("Official Workflow archive is incomplete");
}
