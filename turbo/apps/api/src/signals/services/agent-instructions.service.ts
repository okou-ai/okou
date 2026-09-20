import { computed, type Computed } from "ccstate";
import {
  getInstructionsStorageName,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import { getInstructionsFilename } from "@okouai/core/frameworks";
import { stripMetadataFrontmatter } from "@okouai/core/instructions-frontmatter";
import { agents } from "@okouai/db/schema/agent";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { and, eq } from "drizzle-orm";

import { db$ } from "../external/db";
import { downloadS3Buffer, downloadManifest } from "../external/s3";
import { env } from "../../lib/env";
import { extractFileFromTarGz } from "../../lib/tar";
import { visibleJoinedAgentCondition } from "./agent-data.service";
import { APPLICATION_OWNED_AGENT_EXECUTION_PLAN } from "./agent-execution-plan";

interface AgentInstructionsResult {
  readonly content: string | null;
  readonly filename: string | null;
}

/**
 * Retrieve the instructions content for an agent.
 *
 * Looks up the agent by ID within the given org, locates the instructions
 * storage volume, and extracts the canonical instructions file from the
 * S3 archive. Returns null when the agent is not found.
 */
export function agentInstructions(
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string;
  },
  signal?: AbortSignal,
): Computed<Promise<AgentInstructionsResult | null>> {
  return computed(async (get): Promise<AgentInstructionsResult | null> => {
    signal?.throwIfAborted();
    const [agent] = await get(db$)
      .select({
        name: agents.name,
        orgId: agents.orgId,
      })
      .from(agents)
      .where(
        and(
          eq(agents.orgId, args.orgId),
          eq(agents.id, args.agentId),
          visibleJoinedAgentCondition(args.userId),
        ),
      )
      .limit(1);
    signal?.throwIfAborted();

    if (!agent) {
      return null;
    }

    const instructionsFilename = getInstructionsFilename(
      APPLICATION_OWNED_AGENT_EXECUTION_PLAN.framework.fallback,
    );

    const storageName = getInstructionsStorageName(agent.name);
    const [storage] = await get(db$)
      .select({
        headVersionId: storages.headVersionId,
      })
      .from(storages)
      .where(
        and(
          eq(storages.orgId, agent.orgId),
          eq(storages.userId, VOLUME_ORG_USER_ID),
          eq(storages.name, storageName),
        ),
      )
      .limit(1);
    signal?.throwIfAborted();

    if (!storage?.headVersionId) {
      return { content: null, filename: instructionsFilename };
    }

    const [version] = await get(db$)
      .select({ s3Key: storageVersions.s3Key })
      .from(storageVersions)
      .where(eq(storageVersions.id, storage.headVersionId))
      .limit(1);
    signal?.throwIfAborted();

    if (!version) {
      return { content: null, filename: instructionsFilename };
    }

    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const manifest = await get(downloadManifest(bucket, version.s3Key, signal));
    signal?.throwIfAborted();
    const normalize = (p: string): string => {
      return p.replace(/^\.\//, "");
    };

    const instructionFile = manifest.files.find((f) => {
      return normalize(f.path) === normalize(instructionsFilename);
    });

    if (!instructionFile) {
      return { content: null, filename: instructionsFilename };
    }

    const archiveKey = `${version.s3Key}/archive.tar.gz`;
    const archiveBuffer = await get(
      downloadS3Buffer(bucket, archiveKey, signal),
    );
    signal?.throwIfAborted();
    const rawContent = extractFileFromTarGz(
      archiveBuffer,
      instructionFile.path,
    );

    if (rawContent === null) {
      return { content: null, filename: instructionsFilename };
    }

    const hasLegacyBlocks =
      rawContent.includes("[AGENT_PROFILE]") ||
      rawContent.includes("<!-- ZERO_PROFILE");
    const content = hasLegacyBlocks
      ? stripMetadataFrontmatter(rawContent)
      : rawContent;

    return {
      content,
      filename: instructionsFilename,
    };
  });
}
