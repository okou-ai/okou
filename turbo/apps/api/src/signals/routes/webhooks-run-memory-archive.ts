import { createErrorResponse } from "@okouai/api-contracts/contracts/errors";
import { webhookMemoryArchiveContract } from "@okouai/api-contracts/contracts/webhooks";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  memberMemories,
  memoryVersionLineage,
  memoryVersions,
} from "@okouai/db/schema/member-memory";
import { command } from "ccstate";
import { and, eq, gt, ne } from "drizzle-orm";
import { env } from "../../lib/env";
import { verifyFirewallToken } from "../auth/tokens";
import { authorization$, setResHeader$ } from "../context/hono";
import { db$ } from "../external/db";
import { generatePresignedGetUrl } from "../external/s3";
import type { RouteEntry } from "../route-entry";
import {
  memberMemoryOwnerCondition,
  memberMemoryRevisionCondition,
} from "../services/member-memory-head.service";

const readPublishedMemoryArchive$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const authorization = get(authorization$);
    const auth = authorization?.startsWith("Bearer ")
      ? verifyFirewallToken(authorization.slice("Bearer ".length))
      : null;
    if (!auth) {
      return createErrorResponse(
        "UNAUTHORIZED",
        "Invalid host Run authorization",
      );
    }

    set(setResHeader$, "Cache-Control", "private, no-store");
    const [archive] = await get(db$)
      .select({
        versionId: memoryVersions.id,
        archiveSize: memoryVersions.archiveSize,
        objectPrefix: memoryVersions.objectPrefix,
      })
      .from(memberMemories)
      .innerJoin(memoryVersions, memberMemoryRevisionCondition)
      .innerJoin(
        memoryVersionLineage,
        and(
          eq(memoryVersionLineage.runId, auth.runId),
          eq(memoryVersionLineage.memoryId, memberMemories.id),
          eq(memoryVersionLineage.versionId, memoryVersions.id),
        ),
      )
      .innerJoin(agentRuns, eq(agentRuns.id, memoryVersionLineage.runId))
      .where(
        and(
          memberMemoryOwnerCondition(auth),
          eq(agentRuns.orgId, auth.orgId),
          eq(agentRuns.userId, auth.userId),
          eq(agentRuns.status, "completed"),
          gt(memoryVersions.archiveSize, 0),
          ne(memoryVersionLineage.parentVersionId, memoryVersions.id),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!archive) {
      return { status: 200 as const, body: {} };
    }

    const archiveUrl = await get(
      generatePresignedGetUrl(
        env("R2_USER_STORAGES_BUCKET_NAME"),
        `${archive.objectPrefix}/archive.tar.gz`,
        undefined,
        true,
      ),
    );
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: {
        archive: {
          versionId: archive.versionId,
          archiveSize: archive.archiveSize,
          archiveUrl,
        },
      },
    };
  },
);

export const webhooksRunMemoryArchiveRoutes: readonly RouteEntry[] = [
  {
    route: webhookMemoryArchiveContract.read,
    handler: readPublishedMemoryArchive$,
  },
];
