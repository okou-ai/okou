import { artifacts } from "@okouai/db/schema/artifact";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { connectors } from "@okouai/db/schema/connector";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import { userBuiltinConnectors } from "@okouai/db/schema/user-connector";
import { and, eq, isNull, isNotNull, or } from "drizzle-orm";
import { command } from "ccstate";
import { writeDb$ } from "../external/db";

/** Authorize the stored resource, never the chat that happened to produce it. */
export const ownedGoogleDriveArtifact$ = command(
  async (
    { set },
    args: {
      readonly artifactId: string;
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ) => {
    const [file] = await set(writeDb$)
      .select({
        runId: runUploadedFiles.runId,
        threadId: runUploadedFiles.chatThreadId,
        source: runUploadedFiles.source,
        externalId: runUploadedFiles.externalId,
        filename: runUploadedFiles.filename,
        contentType: runUploadedFiles.contentType,
        url: runUploadedFiles.url,
        metadata: runUploadedFiles.metadata,
      })
      .from(runUploadedFiles)
      .leftJoin(artifacts, eq(runUploadedFiles.id, artifacts.projectionFileId))
      .where(
        and(
          or(
            and(
              eq(artifacts.id, args.artifactId),
              eq(artifacts.orgId, args.orgId),
              eq(artifacts.authorUserId, args.userId),
            ),
            eq(runUploadedFiles.id, args.artifactId),
          ),
          eq(runUploadedFiles.orgId, args.orgId),
          eq(runUploadedFiles.userId, args.userId),
          isNotNull(runUploadedFiles.url),
          // Noncanonical upload/host writers legitimately omit assetVersion
          // and materializationStatus. Only canonical assets have a ready gate.
          or(
            isNull(runUploadedFiles.assetVersion),
            eq(runUploadedFiles.materializationStatus, "ready"),
          ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return file ?? null;
  },
);

/** Account ownership and Agent grants remain independent authorization checks. */
export const artifactGoogleDriveAccount$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly agentId: string;
      readonly connectionId?: string;
      readonly authorizedRunId?: string;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    if (args.authorizedRunId) {
      const [run] = await db
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .innerJoin(agentSessions, eq(agentSessions.id, agentRuns.sessionId))
        .where(
          and(
            eq(agentRuns.id, args.authorizedRunId),
            eq(agentRuns.orgId, args.orgId),
            eq(agentRuns.userId, args.userId),
            eq(agentSessions.agentId, args.agentId),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (!run) {
        return null;
      }
    }
    const [grant] = await db
      .select({ id: agents.id })
      .from(agents)
      .innerJoin(
        userBuiltinConnectors,
        and(
          eq(userBuiltinConnectors.agentId, agents.id),
          eq(userBuiltinConnectors.orgId, args.orgId),
          eq(userBuiltinConnectors.userId, args.userId),
          eq(userBuiltinConnectors.connectorSlug, "google-drive"),
        ),
      )
      .where(and(eq(agents.id, args.agentId), eq(agents.orgId, args.orgId)))
      .limit(1);
    signal.throwIfAborted();
    if (!grant) {
      return null;
    }
    const rows = await db
      .select({ connectorId: connectors.id })
      .from(connectors)
      .where(
        and(
          eq(connectors.orgId, args.orgId),
          eq(connectors.userId, args.userId),
          eq(connectors.connectorSlug, "google-drive"),
          isNull(connectors.customConnectorId),
          args.connectionId
            ? eq(connectors.id, args.connectionId)
            : eq(connectors.isDefault, true),
        ),
      )
      .limit(2);
    signal.throwIfAborted();
    return rows.length === 1 ? (rows[0]?.connectorId ?? null) : null;
  },
);
