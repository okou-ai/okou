import { command } from "ccstate";
import type { HostedArtifactKind } from "@okouai/api-contracts/contracts/host";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  RUN_UPLOADED_FILE_SOURCES,
  runUploadedFiles,
  type RunUploadedFileSource,
} from "@okouai/db/schema/run-uploaded-file";

import { logger } from "../../lib/log";
import { isForeignKeyViolation } from "../../lib/pg-errors";
import { type Db, writeDb$ } from "../external/db";
import { settle } from "../utils";
import { syncArtifactCatalogForFile$ } from "./artifact-catalog.service";
import { publishArtifactsChangedForRun } from "./artifact-realtime.service";
import {
  scheduleArtifactPreviewRender$,
  VIDEO_POSTER_MAX_INPUT_BYTES,
  type RenderArtifactPreviewArgs,
} from "./artifact-preview.service";

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
  readonly publicBrand: PublicBrand;
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
  readonly publicBrand: PublicBrand;
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

export async function sourceForRun(
  writeDb: Db,
  runId: string,
  fallback: RunUploadedFileSource,
  signal: AbortSignal,
): Promise<RunUploadedFileSource> {
  const [run] = await writeDb
    .select({ triggerSource: agentRuns.triggerSource })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), isNotNull(agentRuns.triggerSource)))
    .limit(1);
  signal.throwIfAborted();
  return isRunUploadedFileSource(run?.triggerSource)
    ? run.triggerSource
    : fallback;
}

interface RecordedUploadedFile {
  readonly id: string;
  readonly previewImageUrl: string | null;
  readonly sizeBytes: number | null;
}

const L = logger("RunUploadedFiles");

async function recordRunUploadedFileWrite(
  write: Promise<readonly RecordedUploadedFile[]>,
  runId: string,
  signal: AbortSignal,
): Promise<RecordedUploadedFile | undefined> {
  const result = await settle(write, signal);
  if (result.ok) {
    return result.value[0];
  }
  if (!isForeignKeyViolation(result.error)) {
    throw result.error;
  }
  L.debug("Ignored uploaded-file association for deleted run", { runId });
  return undefined;
}

function videoArtifactPreviewArgs(
  args: {
    readonly runId: string;
    readonly userId: string;
    readonly orgId: string | null | undefined;
    readonly url: string | null;
    readonly contentType: string | null;
    readonly publicBrand: PublicBrand;
  },
  row: RecordedUploadedFile | undefined,
): RenderArtifactPreviewArgs | null {
  if (
    !row ||
    row.previewImageUrl ||
    !args.orgId ||
    !args.url ||
    !args.contentType?.startsWith("video/") ||
    // An oversized input always fails with `9402`; the video element fallback
    // covers it instead. An unknown size still gets one attempt.
    (row.sizeBytes !== null && row.sizeBytes >= VIDEO_POSTER_MAX_INPUT_BYTES)
  ) {
    return null;
  }
  return {
    id: row.id,
    runId: args.runId,
    userId: args.userId,
    orgId: args.orgId,
    url: args.url,
    contentType: args.contentType,
    publicBrand: args.publicBrand,
  };
}

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
    const writeDb = set(writeDb$);
    const source = await sourceForRun(writeDb, args.runId, "web", signal);
    const externalId =
      args.deploymentVersion === null ? args.url : args.deploymentId;
    const filename =
      args.immutableContent || args.deploymentVersion === null
        ? `${args.publicSlug}.html`
        : `${args.site}-v${args.deploymentVersion}.html`;

    const write = writeDb
      .insert(runUploadedFiles)
      .values({
        runId: args.runId,
        source,
        externalId,
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
          publicBrand: args.publicBrand,
        },
      })
      .onConflictDoUpdate({
        target: [
          runUploadedFiles.runId,
          runUploadedFiles.source,
          runUploadedFiles.externalId,
        ],
        set: {
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
            publicBrand: args.publicBrand,
          },
          // Legacy redeploys reuse a mutable alias row. Preserve the preview
          // when the same deployment is completed again, but clear it when a
          // new deployment takes over that row. Versioned rows are immutable
          // and keep their own preview.
          ...(args.deploymentVersion === null
            ? {
                previewImageUrl: sql`case
                  when ${eq(
                    sql`${runUploadedFiles.metadata}->>'deploymentId'`,
                    args.deploymentId,
                  )}
                  then ${runUploadedFiles.previewImageUrl}
                  else null
                end`,
              }
            : {}),
          updatedAt: sql`now()`,
        },
      })
      .returning({
        id: runUploadedFiles.id,
        previewImageUrl: runUploadedFiles.previewImageUrl,
        sizeBytes: runUploadedFiles.sizeBytes,
      });
    const row = await recordRunUploadedFileWrite(write, args.runId, signal);
    signal.throwIfAborted();

    if (!row) {
      return null;
    }

    await set(syncArtifactCatalogForFile$, row.id, signal);
    await publishArtifactsChangedForRun(writeDb, args.runId, signal);
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
    const writeDb = set(writeDb$);
    const source = await sourceForRun(writeDb, args.runId, "web", signal);

    const metadata = {
      ...args.metadata,
      s3Key: args.s3Key,
      publicBrand: args.publicBrand,
    };

    const write = writeDb
      .insert(runUploadedFiles)
      .values({
        runId: args.runId,
        source,
        externalId: args.externalId,
        userId: args.userId,
        orgId: args.orgId ?? null,
        filename: args.filename,
        contentType: args.contentType,
        sizeBytes: args.sizeBytes,
        url: args.url,
        metadata,
      })
      .onConflictDoUpdate({
        target: [
          runUploadedFiles.runId,
          runUploadedFiles.source,
          runUploadedFiles.externalId,
        ],
        set: {
          userId: args.userId,
          orgId: args.orgId ?? null,
          filename: args.filename,
          contentType: args.contentType,
          sizeBytes: args.sizeBytes,
          url: args.url,
          metadata,
          updatedAt: sql`now()`,
        },
      })
      .returning({
        id: runUploadedFiles.id,
        previewImageUrl: runUploadedFiles.previewImageUrl,
        sizeBytes: runUploadedFiles.sizeBytes,
      });
    const row = await recordRunUploadedFileWrite(write, args.runId, signal);
    signal.throwIfAborted();

    if (!row) {
      return;
    }

    await set(syncArtifactCatalogForFile$, row.id, signal);
    await publishArtifactsChangedForRun(writeDb, args.runId, signal);
    set(
      scheduleArtifactPreviewRender$,
      videoArtifactPreviewArgs(
        {
          runId: args.runId,
          userId: args.userId,
          orgId: args.orgId,
          url: args.url,
          contentType: args.contentType,
          publicBrand: args.publicBrand,
        },
        row,
      ),
    );
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
  readonly publicBrand: PublicBrand;
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
    const writeDb = set(writeDb$);
    const source = await sourceForRun(writeDb, args.runId, "telegram", signal);

    const write = writeDb
      .insert(runUploadedFiles)
      .values({
        runId: args.runId,
        source,
        externalId: args.externalId,
        userId: args.userId,
        orgId: args.orgId,
        filename: args.filename,
        contentType: args.contentType,
        sizeBytes: args.sizeBytes,
        url: args.url,
        metadata: { ...args.metadata, publicBrand: args.publicBrand },
      })
      .onConflictDoUpdate({
        target: [
          runUploadedFiles.runId,
          runUploadedFiles.source,
          runUploadedFiles.externalId,
        ],
        set: {
          userId: args.userId,
          orgId: args.orgId,
          filename: args.filename,
          contentType: args.contentType,
          sizeBytes: args.sizeBytes,
          url: args.url,
          metadata: { ...args.metadata, publicBrand: args.publicBrand },
          updatedAt: sql`now()`,
        },
      })
      .returning({
        id: runUploadedFiles.id,
        previewImageUrl: runUploadedFiles.previewImageUrl,
        sizeBytes: runUploadedFiles.sizeBytes,
      });
    const row = await recordRunUploadedFileWrite(write, args.runId, signal);
    signal.throwIfAborted();

    if (!row) {
      return;
    }

    await set(syncArtifactCatalogForFile$, row.id, signal);
    await publishArtifactsChangedForRun(writeDb, args.runId, signal);
    set(
      scheduleArtifactPreviewRender$,
      videoArtifactPreviewArgs(
        {
          runId: args.runId,
          userId: args.userId,
          orgId: args.orgId,
          url: args.url,
          contentType: args.contentType,
          publicBrand: args.publicBrand,
        },
        row,
      ),
    );
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
  readonly publicBrand: PublicBrand;
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
  readonly publicBrand: PublicBrand;
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
  readonly publicBrand: PublicBrand;
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
  readonly publicBrand: PublicBrand;
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
  readonly publicBrand: PublicBrand;
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
    const writeDb = set(writeDb$);
    const source = await sourceForRun(writeDb, args.runId, "github", signal);

    const write = writeDb
      .insert(runUploadedFiles)
      .values({
        runId: args.runId,
        source,
        externalId: args.externalId,
        userId: args.userId,
        orgId: args.orgId,
        filename: args.filename,
        contentType: args.contentType,
        sizeBytes: args.sizeBytes,
        url: args.url,
        metadata: { ...args.metadata, publicBrand: args.publicBrand },
      })
      .onConflictDoUpdate({
        target: [
          runUploadedFiles.runId,
          runUploadedFiles.source,
          runUploadedFiles.externalId,
        ],
        set: {
          userId: args.userId,
          orgId: args.orgId,
          filename: args.filename,
          contentType: args.contentType,
          sizeBytes: args.sizeBytes,
          url: args.url,
          metadata: { ...args.metadata, publicBrand: args.publicBrand },
          updatedAt: sql`now()`,
        },
      })
      .returning({
        id: runUploadedFiles.id,
        previewImageUrl: runUploadedFiles.previewImageUrl,
        sizeBytes: runUploadedFiles.sizeBytes,
      });
    const row = await recordRunUploadedFileWrite(write, args.runId, signal);
    signal.throwIfAborted();

    if (!row) {
      return;
    }

    await set(syncArtifactCatalogForFile$, row.id, signal);
    await publishArtifactsChangedForRun(writeDb, args.runId, signal);
    set(
      scheduleArtifactPreviewRender$,
      videoArtifactPreviewArgs(
        {
          runId: args.runId,
          userId: args.userId,
          orgId: args.orgId,
          url: args.url,
          contentType: args.contentType,
          publicBrand: args.publicBrand,
        },
        row,
      ),
    );
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
    const writeDb = set(writeDb$);
    const source = await sourceForRun(writeDb, args.runId, "feishu", signal);

    const write = writeDb
      .insert(runUploadedFiles)
      .values({
        runId: args.runId,
        source,
        externalId: args.externalId,
        userId: args.userId,
        orgId: args.orgId,
        filename: args.filename,
        contentType: args.contentType,
        sizeBytes: args.sizeBytes,
        url: args.url,
        metadata: { ...args.metadata, publicBrand: args.publicBrand },
      })
      .onConflictDoUpdate({
        target: [
          runUploadedFiles.runId,
          runUploadedFiles.source,
          runUploadedFiles.externalId,
        ],
        set: {
          userId: args.userId,
          orgId: args.orgId,
          filename: args.filename,
          contentType: args.contentType,
          sizeBytes: args.sizeBytes,
          url: args.url,
          metadata: { ...args.metadata, publicBrand: args.publicBrand },
          updatedAt: sql`now()`,
        },
      })
      .returning({
        id: runUploadedFiles.id,
        previewImageUrl: runUploadedFiles.previewImageUrl,
        sizeBytes: runUploadedFiles.sizeBytes,
      });
    const row = await recordRunUploadedFileWrite(write, args.runId, signal);
    signal.throwIfAborted();

    if (!row) {
      return;
    }

    await set(syncArtifactCatalogForFile$, row.id, signal);
    await publishArtifactsChangedForRun(writeDb, args.runId, signal);
    set(
      scheduleArtifactPreviewRender$,
      videoArtifactPreviewArgs(
        {
          runId: args.runId,
          userId: args.userId,
          orgId: args.orgId,
          url: args.url,
          contentType: args.contentType,
          publicBrand: args.publicBrand,
        },
        row,
      ),
    );
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
    const writeDb = set(writeDb$);
    const source = await sourceForRun(writeDb, args.runId, "teams", signal);

    const write = writeDb
      .insert(runUploadedFiles)
      .values({
        runId: args.runId,
        source,
        externalId: args.externalId,
        userId: args.userId,
        orgId: args.orgId,
        filename: args.filename,
        contentType: args.contentType,
        sizeBytes: args.sizeBytes,
        url: args.url,
        metadata: { ...args.metadata, publicBrand: args.publicBrand },
      })
      .onConflictDoUpdate({
        target: [
          runUploadedFiles.runId,
          runUploadedFiles.source,
          runUploadedFiles.externalId,
        ],
        set: {
          userId: args.userId,
          orgId: args.orgId,
          filename: args.filename,
          contentType: args.contentType,
          sizeBytes: args.sizeBytes,
          url: args.url,
          metadata: { ...args.metadata, publicBrand: args.publicBrand },
          updatedAt: sql`now()`,
        },
      })
      .returning({
        id: runUploadedFiles.id,
        previewImageUrl: runUploadedFiles.previewImageUrl,
        sizeBytes: runUploadedFiles.sizeBytes,
      });
    const row = await recordRunUploadedFileWrite(write, args.runId, signal);
    signal.throwIfAborted();

    if (!row) {
      return;
    }

    await set(syncArtifactCatalogForFile$, row.id, signal);
    await publishArtifactsChangedForRun(writeDb, args.runId, signal);
    set(
      scheduleArtifactPreviewRender$,
      videoArtifactPreviewArgs(
        {
          runId: args.runId,
          userId: args.userId,
          orgId: args.orgId,
          url: args.url,
          contentType: args.contentType,
          publicBrand: args.publicBrand,
        },
        row,
      ),
    );
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
    const writeDb = set(writeDb$);
    const source = await sourceForRun(
      writeDb,
      args.runId,
      "agentphone",
      signal,
    );

    const write = writeDb
      .insert(runUploadedFiles)
      .values({
        runId: args.runId,
        source,
        externalId: args.externalId,
        userId: args.userId,
        orgId: args.orgId,
        filename: args.filename,
        contentType: args.contentType,
        sizeBytes: args.sizeBytes,
        url: args.url,
        metadata: { ...args.metadata, publicBrand: args.publicBrand },
      })
      .onConflictDoUpdate({
        target: [
          runUploadedFiles.runId,
          runUploadedFiles.source,
          runUploadedFiles.externalId,
        ],
        set: {
          userId: args.userId,
          orgId: args.orgId,
          filename: args.filename,
          contentType: args.contentType,
          sizeBytes: args.sizeBytes,
          url: args.url,
          metadata: { ...args.metadata, publicBrand: args.publicBrand },
          updatedAt: sql`now()`,
        },
      })
      .returning({
        id: runUploadedFiles.id,
        previewImageUrl: runUploadedFiles.previewImageUrl,
        sizeBytes: runUploadedFiles.sizeBytes,
      });
    const row = await recordRunUploadedFileWrite(write, args.runId, signal);
    signal.throwIfAborted();

    if (!row) {
      return;
    }

    await set(syncArtifactCatalogForFile$, row.id, signal);
    await publishArtifactsChangedForRun(writeDb, args.runId, signal);
    set(
      scheduleArtifactPreviewRender$,
      videoArtifactPreviewArgs(
        {
          runId: args.runId,
          userId: args.userId,
          orgId: args.orgId,
          url: args.url,
          contentType: args.contentType,
          publicBrand: args.publicBrand,
        },
        row,
      ),
    );
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
    const writeDb = set(writeDb$);
    const source = await sourceForRun(writeDb, args.runId, "slack", signal);

    const write = writeDb
      .insert(runUploadedFiles)
      .values({
        runId: args.runId,
        source,
        externalId: args.externalId,
        userId: args.userId,
        orgId: args.orgId,
        filename: args.filename,
        contentType: args.contentType,
        sizeBytes: args.sizeBytes,
        url: args.url,
        metadata: { ...args.metadata, publicBrand: args.publicBrand },
      })
      .onConflictDoUpdate({
        target: [
          runUploadedFiles.runId,
          runUploadedFiles.source,
          runUploadedFiles.externalId,
        ],
        set: {
          userId: args.userId,
          orgId: args.orgId,
          filename: args.filename,
          contentType: args.contentType,
          sizeBytes: args.sizeBytes,
          url: args.url,
          metadata: { ...args.metadata, publicBrand: args.publicBrand },
          updatedAt: sql`now()`,
        },
      })
      .returning({
        id: runUploadedFiles.id,
        previewImageUrl: runUploadedFiles.previewImageUrl,
        sizeBytes: runUploadedFiles.sizeBytes,
      });
    const row = await recordRunUploadedFileWrite(write, args.runId, signal);
    signal.throwIfAborted();

    if (!row) {
      return;
    }

    await set(syncArtifactCatalogForFile$, row.id, signal);
    await publishArtifactsChangedForRun(writeDb, args.runId, signal);
    set(
      scheduleArtifactPreviewRender$,
      videoArtifactPreviewArgs(
        {
          runId: args.runId,
          userId: args.userId,
          orgId: args.orgId,
          url: args.url,
          contentType: args.contentType,
          publicBrand: args.publicBrand,
        },
        row,
      ),
    );
  },
);
