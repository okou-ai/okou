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

/** Encode execution files, or reproduce the exact bytes of a published artifact. */
export function officialWorkflowArtifactFiles(
  definition: Pick<
    OfficialWorkflowDefinitionRevisionPayload,
    "name" | "workflow"
  >,
  published?: PublishedArtifact,
): readonly ArtifactFile[] | null {
  const files = [
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
