import { command } from "ccstate";
import type { HostedArtifactKind } from "@okouai/api-contracts/contracts/host";
import {
  linkLayoutSegment,
  type LinkLayout,
} from "@okouai/api-contracts/contracts/link-layout";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  RUN_UPLOADED_FILE_SOURCES,
  runUploadedFiles,
  type RunUploadedFileSource,
} from "@okouai/db/schema/run-uploaded-file";

import { logger } from "../../lib/log";
import { isForeignKeyViolation } from "../../lib/pg-errors";
import { db$, writeDb$ } from "../external/db";
import { settle } from "../utils";
import {
  queueArtifactCatalogFileSql,
  syncArtifactCatalogForFile$,
} from "./artifact-catalog.service";
import { publishArtifactsChangedForRun$ } from "./artifact-realtime.service";

interface RecordWebUploadedFileArgs {
  readonly runId: string | undefined;
  readonly externalId: string;
  readonly userId: string;
  readonly orgId: string | null | undefined;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly url: string;
  readonly s3Key: string;
  readonly layout: LinkLayout;
  readonly metadata: Record<string, unknown>;
}

interface RecordHostedSiteArtifactArgs {
  readonly runId: string | null | undefined;
  readonly userId: string;
  readonly orgId: string;
  readonly artifactKind: HostedArtifactKind;
  readonly siteId: string;
  readonly deploymentId: string;
  readonly deploymentVersion: number | null;
  readonly immutableContent: boolean;
  readonly site: string;
  readonly publicSlug: string;
  readonly aliasUrl: string | undefined;
  readonly access: "owner-private-v1" | undefined;
  readonly url: string;
  readonly fileCount: number;
  readonly sizeBytes: number;
  readonly entrypoint: string;
  readonly spaFallback: boolean;
  readonly layout: LinkLayout;
}

function isRunUploadedFileSource(
  source: string | null | undefined,
): source is RunUploadedFileSource {
  if (!source) {
    return false;
  }
  return RUN_UPLOADED_FILE_SOURCES.some((candidate) => {
    return candidate === source;
  });
}

export const sourceForRun$ = command(
  async (
    { get },
    runId: string,
    fallback: RunUploadedFileSource,
    signal: AbortSignal,
  ): Promise<RunUploadedFileSource> => {
    const db = get(db$);
    const [run] = await db
      .select({ triggerSource: agentRuns.triggerSource })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), isNotNull(agentRuns.triggerSource)))
      .limit(1);
    signal.throwIfAborted();
    return isRunUploadedFileSource(run?.triggerSource)
      ? run.triggerSource
      : fallback;
  },
);

interface RecordedUploadedFile {
  readonly id: string;
  readonly previewImageUrl: string | null;
}

const L = logger("RunUploadedFiles");

interface RecordRunUploadedFileArgs {
  readonly runId: string;
  readonly source: RunUploadedFileSource;
  readonly externalId: string;
  readonly file: Pick<
    typeof runUploadedFiles.$inferInsert,
    | "userId"
    | "orgId"
    | "filename"
    | "contentType"
    | "sizeBytes"
    | "url"
    | "metadata"
  >;
  readonly resetPreviewForDeploymentId?: string;
}

const recordRunUploadedFile$ = command(
  async (
    { set },
    args: RecordRunUploadedFileArgs,
    signal: AbortSignal,
  ): Promise<RecordedUploadedFile | undefined> => {
    const db = set(writeDb$);
    // The file identity, captured thread ownership and durable catalog handoff
    // must commit together so a failed projection can be recovered.
    const result = await settle(
      // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0237; new non-billing transactions are prohibited.
      db.transaction(async (tx) => {
        const [row] = await tx
          .insert(runUploadedFiles)
          .values({
            runId: args.runId,
            source: args.source,
            externalId: args.externalId,
            ...args.file,
          })
          .onConflictDoUpdate({
            target: [
              runUploadedFiles.runId,
              runUploadedFiles.source,
              runUploadedFiles.externalId,
            ],
            set: {
              ...args.file,
              // Mutable legacy aliases lose their preview only when a different
              // deployment takes over. Versioned rows preserve their preview.
              ...(args.resetPreviewForDeploymentId === undefined
                ? {}
                : {
                    previewImageUrl: sql`case
                    when ${eq(sql`${runUploadedFiles.metadata}->>'deploymentId'`, args.resetPreviewForDeploymentId)}
                    then ${runUploadedFiles.previewImageUrl}
                    else null
                  end`,
                  }),
              updatedAt: sql`now()`,
            },
          })
          .returning({
            id: runUploadedFiles.id,
            previewImageUrl: runUploadedFiles.previewImageUrl,
          });
        if (row) {
          // Capture the association at write time so lists never need Run history.
          const [run] = await tx
            .select({
              chatThreadId: agentRuns.chatThreadId,
              orgId: agentRuns.orgId,
            })
            .from(agentRuns)
            .where(
              and(
                eq(agentRuns.id, args.runId),
                isNotNull(agentRuns.triggerSource),
              ),
            )
            .limit(1);
          signal.throwIfAborted();
          if (run) {
            await tx
              .update(runUploadedFiles)
              .set({ chatThreadId: run.chatThreadId, orgId: run.orgId })
              .where(eq(runUploadedFiles.id, row.id));
            signal.throwIfAborted();
          }
          await tx.execute(queueArtifactCatalogFileSql(row.id));
          signal.throwIfAborted();
        }
        return row;
      }),
      signal,
    );
    if (result.ok) {
      return result.value;
    }
    if (!isForeignKeyViolation(result.error)) {
      throw result.error;
    }
    L.debug("Ignored uploaded-file association for deleted run", {
      runId: args.runId,
    });
    return undefined;
  },
);

/**
 * Insert (or upsert) a `run_uploaded_files` row for a hosted website
 * artifact. The artifact URL points at the hosted `*.sites` deployment;
 * no user-storage upload is created. Versioned deployments use their immutable
 * deployment ID for idempotency; legacy deployments continue using the alias
 * URL during the rollout window.
 */
export const recordHostedSiteArtifact$ = command(
  async (
    { set },
    args: RecordHostedSiteArtifactArgs,
    signal: AbortSignal,
  ): Promise<RecordedUploadedFile | null> => {
    if (!args.runId) {
      return null;
    }
    const source = await set(sourceForRun$, args.runId, "web", signal);
    const externalId =
      args.deploymentVersion === null ? args.url : args.deploymentId;
    const filename =
      args.immutableContent || args.deploymentVersion === null
        ? `${args.publicSlug}.html`
        : `${args.site}-v${args.deploymentVersion}.html`;

    const row = await set(
      recordRunUploadedFile$,
      {
        runId: args.runId,
        source,
        externalId,
        file: {
          userId: args.userId,
          orgId: args.orgId,
          filename,
          contentType: "text/html",
          sizeBytes: args.sizeBytes,
          url: args.url,
          metadata: {
            generatedBy: "zero-official-website",
            artifactKind: args.artifactKind,
            siteId: args.siteId,
            deploymentId: args.deploymentId,
            deploymentVersion: args.deploymentVersion,
            aliasUrl: args.aliasUrl,
            access: args.access,
            publicSlug: args.publicSlug,
            fileCount: args.fileCount,
            entrypoint: args.entrypoint,
            spaFallback: args.spaFallback,
            publicBrand: linkLayoutSegment(args.layout),
          },
        },
        resetPreviewForDeploymentId:
          args.deploymentVersion === null ? args.deploymentId : undefined,
      },
      signal,
    );
    signal.throwIfAborted();

    if (!row) {
      return null;
    }

    await set(syncArtifactCatalogForFile$, row.id, signal);
    await set(publishArtifactsChangedForRun$, args.runId, signal);
    return row;
  },
);

/**
 * Insert (or upsert) a `run_uploaded_files` row for a successful web
 * upload, then publish the chat-thread artifacts-changed signal if the
 * run is linked to a thread. No-op when `runId` is undefined (ordinary
 * session callers without a run-scoped token).
 *
 * Verbatim port from the removed `apps/web` app; no upstream copy
 * remains to keep in sync.
 * Idempotency contract is upsert on (runId, source, externalId).
 */
export const recordWebUploadedFile$ = command(
  async (
    { set },
    args: RecordWebUploadedFileArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!args.runId) {
      return;
    }
    const source = await set(sourceForRun$, args.runId, "web", signal);

    const metadata = {
      ...args.metadata,
      s3Key: args.s3Key,
      publicBrand: linkLayoutSegment(args.layout),
    };

    const row = await set(
      recordRunUploadedFile$,
      {
        runId: args.runId,
        source,
        externalId: args.externalId,
        file: {
          userId: args.userId,
          orgId: args.orgId ?? null,
          filename: args.filename,
          contentType: args.contentType,
          sizeBytes: args.sizeBytes,
          url: args.url,
          metadata,
        },
      },
      signal,
    );
    signal.throwIfAborted();

    if (!row) {
      return;
    }

    await set(syncArtifactCatalogForFile$, row.id, signal);
    await set(publishArtifactsChangedForRun$, args.runId, signal);
  },
);

interface RecordTelegramUploadedFileArgs {
  readonly runId: string | undefined;
  readonly externalId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly url: string;
  readonly layout: LinkLayout;
  readonly metadata: Record<string, unknown>;
}

/**
 * Insert (or upsert) a `run_uploaded_files` row for a Telegram-delivered
 * upload, then publish the chat-thread artifacts-changed signal if the
 * run is linked to a thread. No-op when `runId` is undefined (sandbox
 * callers without a run-scoped token).
 *
 * Verbatim port from the removed `apps/web` app, scoped to the
 * `"telegram"` source; no upstream copy remains to keep in sync.
 * Idempotency contract is upsert on (runId, source, externalId).
 */
export const recordTelegramUploadedFile$ = command(
  async (
    { set },
    args: RecordTelegramUploadedFileArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!args.runId) {
      return;
    }
    const source = await set(sourceForRun$, args.runId, "telegram", signal);

    const row = await set(
      recordRunUploadedFile$,
      {
        runId: args.runId,
        source,
        externalId: args.externalId,
        file: {
          userId: args.userId,
          orgId: args.orgId,
          filename: args.filename,
          contentType: args.contentType,
          sizeBytes: args.sizeBytes,
          url: args.url,
          metadata: {
            ...args.metadata,
            publicBrand: linkLayoutSegment(args.layout),
          },
        },
      },
      signal,
    );
    signal.throwIfAborted();

    if (!row) {
      return;
    }

    await set(syncArtifactCatalogForFile$, row.id, signal);
    await set(publishArtifactsChangedForRun$, args.runId, signal);
  },
);

interface RecordSlackUploadedFileArgs {
  readonly runId: string | undefined;
  readonly externalId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly filename: string | null;
  readonly contentType: string | null;
  readonly sizeBytes: number | null;
  readonly url: string | null;
  readonly layout: LinkLayout;
  readonly metadata: Record<string, unknown>;
}

interface RecordFeishuUploadedFileArgs {
  readonly runId: string | undefined;
  readonly externalId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly url: string;
  readonly layout: LinkLayout;
  readonly metadata: Record<string, unknown>;
}

interface RecordTeamsUploadedFileArgs {
  readonly runId: string | undefined;
  readonly externalId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly url: string;
  readonly layout: LinkLayout;
  readonly metadata: Record<string, unknown>;
}

interface RecordAgentPhoneUploadedFileArgs {
  readonly runId: string | undefined;
  readonly externalId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly url: string;
  readonly layout: LinkLayout;
  readonly metadata: Record<string, unknown>;
}

interface RecordGithubUploadedFileArgs {
  readonly runId: string | undefined;
  readonly externalId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly url: string;
  readonly layout: LinkLayout;
  readonly metadata: Record<string, unknown>;
}

export const recordGithubUploadedFile$ = command(
  async (
    { set },
    args: RecordGithubUploadedFileArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!args.runId) {
      return;
    }
    const source = await set(sourceForRun$, args.runId, "github", signal);

    const row = await set(
      recordRunUploadedFile$,
      {
        runId: args.runId,
        source,
        externalId: args.externalId,
        file: {
          userId: args.userId,
          orgId: args.orgId,
          filename: args.filename,
          contentType: args.contentType,
          sizeBytes: args.sizeBytes,
          url: args.url,
          metadata: {
            ...args.metadata,
            publicBrand: linkLayoutSegment(args.layout),
          },
        },
      },
      signal,
    );
    signal.throwIfAborted();

    if (!row) {
      return;
    }

    await set(syncArtifactCatalogForFile$, row.id, signal);
    await set(publishArtifactsChangedForRun$, args.runId, signal);
  },
);

export const recordFeishuUploadedFile$ = command(
  async (
    { set },
    args: RecordFeishuUploadedFileArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!args.runId) {
      return;
    }
    const source = await set(sourceForRun$, args.runId, "feishu", signal);

    const row = await set(
      recordRunUploadedFile$,
      {
        runId: args.runId,
        source,
        externalId: args.externalId,
        file: {
          userId: args.userId,
          orgId: args.orgId,
          filename: args.filename,
          contentType: args.contentType,
          sizeBytes: args.sizeBytes,
          url: args.url,
          metadata: {
            ...args.metadata,
            publicBrand: linkLayoutSegment(args.layout),
          },
        },
      },
      signal,
    );
    signal.throwIfAborted();

    if (!row) {
      return;
    }

    await set(syncArtifactCatalogForFile$, row.id, signal);
    await set(publishArtifactsChangedForRun$, args.runId, signal);
  },
);

export const recordTeamsUploadedFile$ = command(
  async (
    { set },
    args: RecordTeamsUploadedFileArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!args.runId) {
      return;
    }
    const source = await set(sourceForRun$, args.runId, "teams", signal);

    const row = await set(
      recordRunUploadedFile$,
      {
        runId: args.runId,
        source,
        externalId: args.externalId,
        file: {
          userId: args.userId,
          orgId: args.orgId,
          filename: args.filename,
          contentType: args.contentType,
          sizeBytes: args.sizeBytes,
          url: args.url,
          metadata: {
            ...args.metadata,
            publicBrand: linkLayoutSegment(args.layout),
          },
        },
      },
      signal,
    );
    signal.throwIfAborted();

    if (!row) {
      return;
    }

    await set(syncArtifactCatalogForFile$, row.id, signal);
    await set(publishArtifactsChangedForRun$, args.runId, signal);
  },
);

/**
 * Insert (or upsert) a `run_uploaded_files` row for an AgentPhone-delivered
 * upload, then publish the chat-thread artifacts-changed signal if the
 * run is linked to a thread. No-op when `runId` is undefined (sandbox
 * callers without a run-scoped token).
 */
export const recordAgentPhoneUploadedFile$ = command(
  async (
    { set },
    args: RecordAgentPhoneUploadedFileArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!args.runId) {
      return;
    }
    const source = await set(sourceForRun$, args.runId, "agentphone", signal);

    const row = await set(
      recordRunUploadedFile$,
      {
        runId: args.runId,
        source,
        externalId: args.externalId,
        file: {
          userId: args.userId,
          orgId: args.orgId,
          filename: args.filename,
          contentType: args.contentType,
          sizeBytes: args.sizeBytes,
          url: args.url,
          metadata: {
            ...args.metadata,
            publicBrand: linkLayoutSegment(args.layout),
          },
        },
      },
      signal,
    );
    signal.throwIfAborted();

    if (!row) {
      return;
    }

    await set(syncArtifactCatalogForFile$, row.id, signal);
    await set(publishArtifactsChangedForRun$, args.runId, signal);
  },
);

/**
 * Insert (or upsert) a `run_uploaded_files` row for a Slack-delivered
 * upload, then publish the chat-thread artifacts-changed signal if the
 * run is linked to a thread. No-op when `runId` is undefined (sandbox
 * callers without a run-scoped token).
 *
 * Mirrors recordTelegramUploadedFile$ but scoped to the `"slack"` source
 * and allows nullable metadata fields because Slack's files.info may not
 * surface every attribute. Idempotency contract is upsert on
 * (runId, source, externalId).
 */
export const recordSlackUploadedFile$ = command(
  async (
    { set },
    args: RecordSlackUploadedFileArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!args.runId) {
      return;
    }
    const source = await set(sourceForRun$, args.runId, "slack", signal);

    const row = await set(
      recordRunUploadedFile$,
      {
        runId: args.runId,
        source,
        externalId: args.externalId,
        file: {
          userId: args.userId,
          orgId: args.orgId,
          filename: args.filename,
          contentType: args.contentType,
          sizeBytes: args.sizeBytes,
          url: args.url,
          metadata: {
            ...args.metadata,
            publicBrand: linkLayoutSegment(args.layout),
          },
        },
      },
      signal,
    );
    signal.throwIfAborted();

    if (!row) {
      return;
    }

    await set(syncArtifactCatalogForFile$, row.id, signal);
    await set(publishArtifactsChangedForRun$, args.runId, signal);
  },
);
