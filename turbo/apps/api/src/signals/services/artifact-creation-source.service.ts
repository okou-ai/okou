import { computed, type Computed } from "ccstate";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { ArtifactCreationSource } from "@okouai/api-contracts/contracts/artifact-catalog";
import { artifacts, presentationArtifacts } from "@okouai/db/schema/artifact";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { hostedSites } from "@okouai/db/runtime/hosted-site";

import { sharedThreadArtifactAuthorUserId } from "../../lib/shared-thread-artifact";
import { db$ } from "../external/db";

interface CreationSourceInput {
  readonly artifactId: string;
  readonly orgId: string;
  readonly userId: string;
}

export function createArtifactCreationSource(
  input$: Computed<CreationSourceInput>,
): Computed<Promise<{ source: ArtifactCreationSource | null } | null>> {
  return computed(async (get) => {
    const input = get(input$);
    const db = get(db$);
    const [artifact] = await db
      .select({
        kind: artifacts.kind,
        chatThreadId: artifacts.chatThreadId,
        siteId: hostedSites.id,
        createdFromRunId: hostedSites.createdFromRunId,
      })
      .from(artifacts)
      .leftJoin(
        presentationArtifacts,
        and(
          eq(artifacts.kind, "presentation"),
          eq(presentationArtifacts.id, artifacts.entityId),
        ),
      )
      .leftJoin(
        hostedSites,
        and(
          or(
            and(
              eq(artifacts.kind, "hosted-site"),
              eq(hostedSites.id, artifacts.entityId),
            ),
            and(
              eq(artifacts.kind, "presentation"),
              eq(hostedSites.id, presentationArtifacts.hostedSiteId),
            ),
          ),
          eq(hostedSites.orgId, input.orgId),
          eq(hostedSites.userId, input.userId),
          isNull(hostedSites.deletedAt),
        ),
      )
      .where(
        and(
          eq(artifacts.id, input.artifactId),
          eq(artifacts.orgId, input.orgId),
          inArray(artifacts.authorUserId, [
            input.userId,
            sharedThreadArtifactAuthorUserId(input.userId),
          ]),
          isNull(artifacts.deletedAt),
        ),
      )
      .limit(1);
    if (!artifact) {
      return null;
    }

    let chatThreadId = artifact.chatThreadId;
    let runId: string | null = null;
    if (artifact.kind === "hosted-site" || artifact.kind === "presentation") {
      if (!artifact.siteId) {
        return { source: null };
      }
      // A stored creation Run is authoritative even when it no longer resolves.
      // Neither the active deployment nor the catalog projection can replace it.
      if (artifact.createdFromRunId !== null) {
        const [run] = await db
          .select({ id: agentRuns.id, chatThreadId: agentRuns.chatThreadId })
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.id, artifact.createdFromRunId),
              eq(agentRuns.userId, input.userId),
              eq(agentRuns.orgId, input.orgId),
            ),
          )
          .limit(1);
        if (!run) {
          return { source: null };
        }
        runId = run.id;
        chatThreadId = run.chatThreadId;
      }
    }
    if (!chatThreadId) {
      return { source: null };
    }

    const [chat] = await db
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.id, chatThreadId),
          eq(chatThreads.userId, input.userId),
          eq(chatThreads.orgId, input.orgId),
          eq(chatThreads.hidden, false),
        ),
      )
      .limit(1);
    return { source: chat ? { chatThreadId: chat.id, runId } : null };
  });
}
