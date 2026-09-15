import { randomUUID } from "node:crypto";

import { command, computed, type Command, type Computed } from "ccstate";
import type {
  ChatThreadArtifactGoogleDriveRecovery,
  ChatThreadArtifactGoogleDriveSync,
  ChatThreadArtifactRun,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agents } from "@okouai/db/schema/agent";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import {
  hostedDeployments,
  privateHostedDeployments,
} from "@okouai/db/schema/hosted-site";
import {
  CANONICAL_ASSET_VERSION,
  runUploadedFiles,
} from "@okouai/db/schema/run-uploaded-file";
import { userConnectors } from "@okouai/db/schema/user-connector";
import { and, eq, exists, isNotNull, or } from "drizzle-orm";
import { z } from "zod";
import { ZipArchive } from "archiver";

import { env, optionalEnv } from "../../lib/env";
import { badRequestMessage, notFound } from "../../lib/error";
import {
  artifactKeyFromShortOkouUrl,
  isArtifactKeyV2,
} from "../../lib/file-url";
import { db$, type Db, type ReadonlyDb, writeDb$ } from "../external/db";
import { downloadHostedSitesS3Buffer, downloadS3Buffer } from "../external/s3";
import {
  createDeferredPromise,
  onRejection,
  safeSync,
  tapError,
} from "../utils";
import {
  loadConnectorRuntimeSnapshot,
  type ConnectorRuntimeSnapshot,
} from "./connector-catalog-runtime.service";
import { resolveConnectorAccount } from "./connector-account-resolution.service";
import {
  connectorCredentialRuntimeValueRef,
  loadConnectorCredentialConnection,
  loadConnectorCredentialValues,
  refreshConnectorCredentialAccess,
  type ConnectorCredentialConnection,
} from "./connector-credential-runtime.service";
import { userFeatureSwitchOverrides } from "./feature-switches.service";
import { runOwnedChatEventForRunCondition } from "./chat-event-type.service";
import { artifactFileReference } from "./private-artifact-storage.service";
import { uploadedArtifactObject } from "./uploaded-artifact.service";

const GOOGLE_DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const GOOGLE_DRIVE_UPLOAD_URL =
  "https://www.googleapis.com/upload/drive/v3/files";
const GOOGLE_DRIVE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const GOOGLE_DRIVE_STATUS_TIMEOUT_MS = 2000;
const GOOGLE_DRIVE_ARTIFACT_APP_PROPERTY = "vm0Artifact";
const GOOGLE_DRIVE_THREAD_APP_PROPERTY = "vm0ThreadId";
const GOOGLE_DRIVE_RUN_APP_PROPERTY = "vm0RunId";
const GOOGLE_DRIVE_FILE_APP_PROPERTY = "vm0FileId";
const GOOGLE_DRIVE_ACCESS_TOKEN_ENVIRONMENT_NAME = "GOOGLE_DRIVE_TOKEN";

const driveFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  webViewLink: z.string().nullable().optional(),
  appProperties: z.record(z.string(), z.string()).optional(),
});
const driveFileListSchema = z.object({ files: z.array(driveFileSchema) });

interface DriveSyncResult {
  readonly id: string;
  readonly name: string;
  readonly webViewLink: string | null;
}

type DriveStatusLookup =
  | {
      readonly type: "ready";
      readonly syncedByKey: ReadonlyMap<string, DriveSyncResult>;
    }
  | {
      readonly type: "disconnected";
      readonly recovery: ChatThreadArtifactGoogleDriveRecovery;
    }
  | { readonly type: "unknown" };

interface ConnectorTokens {
  readonly accessToken: string;
  readonly connection: ConnectorCredentialConnection;
}

type DriveConnectorAccountResolution =
  | { readonly type: "resolved"; readonly connectorId: string }
  | { readonly type: "connect" }
  | { readonly type: "unavailable" };

type DriveConnectionLoadResult =
  | { readonly type: "ready"; readonly tokens: ConnectorTokens }
  | {
      readonly type: "disconnected";
      readonly recovery: ChatThreadArtifactGoogleDriveRecovery;
    };

type DriveRefreshResult =
  | { readonly type: "ok"; readonly accessToken: string }
  | { readonly type: "reconnect-required" }
  | { readonly type: "unavailable" };

function artifactKey(runId: string, fileId: string): string {
  return `${runId}:${fileId}`;
}

function escapeQuery(value: string): string {
  return value.replace(/\\/g, String.raw`\\`).replace(/'/g, String.raw`\'`);
}

async function threadAllowsGoogleDriveArtifactSync(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly threadId: string;
  },
): Promise<boolean> {
  const [authorization] = await db
    .select({ id: userConnectors.id })
    .from(chatThreads)
    .innerJoin(
      userConnectors,
      and(
        eq(userConnectors.orgId, args.orgId),
        eq(userConnectors.userId, args.userId),
        eq(userConnectors.agentId, chatThreads.agentId),
        eq(userConnectors.connectorSlug, "google-drive"),
      ),
    )
    .where(
      and(
        eq(chatThreads.id, args.threadId),
        eq(chatThreads.userId, args.userId),
      ),
    )
    .limit(1);
  return authorization !== undefined;
}

async function resolveDriveConnectorAccount(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly threadId: string;
  },
): Promise<DriveConnectorAccountResolution> {
  const [selection] = await db
    .select({ connectorId: chatThreadConnectorSelections.connectorId })
    .from(chatThreads)
    .innerJoin(
      agents,
      and(eq(agents.id, chatThreads.agentId), eq(agents.orgId, args.orgId)),
    )
    .innerJoin(
      chatThreadConnectorSelections,
      and(
        eq(chatThreadConnectorSelections.chatThreadId, chatThreads.id),
        eq(chatThreadConnectorSelections.connectorSlug, "google-drive"),
      ),
    )
    .where(
      and(
        eq(chatThreads.id, args.threadId),
        eq(chatThreads.userId, args.userId),
      ),
    )
    .limit(1);
  const resolution = await resolveConnectorAccount(db, {
    orgId: args.orgId,
    userId: args.userId,
    request: {
      target: { kind: "builtin", connectorSlug: "google-drive" },
      selection: selection
        ? { kind: "exact", sourceId: selection.connectorId }
        : { kind: "default" },
    },
  });
  if (resolution.kind === "resolved") {
    return {
      type: "resolved",
      connectorId: resolution.account.connectorId,
    };
  }
  return !selection && resolution.kind === "missing-default"
    ? { type: "connect" }
    : { type: "unavailable" };
}

async function loadDriveConnection(args: {
  readonly db: ReadonlyDb;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly orgId: string;
  readonly snapshot: ConnectorRuntimeSnapshot;
  readonly threadId: string;
  readonly userId: string;
}): Promise<DriveConnectionLoadResult> {
  const resolution = await resolveDriveConnectorAccount(args.db, {
    orgId: args.orgId,
    userId: args.userId,
    threadId: args.threadId,
  });
  if (resolution.type !== "resolved") {
    return {
      type: "disconnected",
      recovery: { action: resolution.type },
    };
  }
  const loaded = await loadConnectorCredentialConnection({
    db: args.db,
    snapshot: args.snapshot,
    orgId: args.orgId,
    userId: args.userId,
    connectorSlug: "google-drive",
    connectorId: resolution.connectorId,
  });
  if (loaded.kind !== "ok") {
    return {
      type: "disconnected",
      recovery: { action: "unavailable" },
    };
  }
  const connection = loaded.connection;
  if (connection.needsReconnect) {
    return {
      type: "disconnected",
      recovery: {
        action: "reconnect",
        connectionId: connection.connectorId,
      },
    };
  }
  const accessTokenValueRef = connectorCredentialRuntimeValueRef(
    connection,
    GOOGLE_DRIVE_ACCESS_TOKEN_ENVIRONMENT_NAME,
  );
  if (accessTokenValueRef === null) {
    return {
      type: "disconnected",
      recovery: { action: "unavailable" },
    };
  }
  const values = await loadConnectorCredentialValues({
    connection,
    db: args.db,
    featureSwitchContext: args.featureSwitchContext,
    valueRefs: [accessTokenValueRef],
  });
  const accessToken = values.get(accessTokenValueRef);
  if (!accessToken) {
    return {
      type: "disconnected",
      recovery: { action: "unavailable" },
    };
  }
  return {
    type: "ready",
    tokens: {
      accessToken,
      connection,
    },
  };
}

async function refreshDriveAccessToken(
  args: {
    readonly connection: ConnectorCredentialConnection;
    readonly db: ReadonlyDb;
    readonly featureSwitchContext: FeatureSwitchContext;
    readonly orgId: string;
    readonly userId: string;
    readonly writeDb?: Db;
  },
  signal: AbortSignal,
): Promise<DriveRefreshResult> {
  const refreshed = await refreshConnectorCredentialAccess(
    {
      connection: args.connection,
      db: args.db,
      featureSwitchContext: args.featureSwitchContext,
      orgId: args.orgId,
      userId: args.userId,
      runtimeEnvironmentName: GOOGLE_DRIVE_ACCESS_TOKEN_ENVIRONMENT_NAME,
      ...(args.writeDb === undefined ? {} : { persist: { db: args.writeDb } }),
    },
    signal,
  );
  if (refreshed.kind === "ok") {
    return { type: "ok", accessToken: refreshed.accessToken };
  }
  return refreshed.kind === "reconnect-required"
    ? { type: "reconnect-required" }
    : { type: "unavailable" };
}

type DriveListResult =
  | { readonly type: "ok"; readonly files: z.infer<typeof driveFileSchema>[] }
  | { readonly type: "unauthorized" };

async function listArtifactFiles(
  args: {
    readonly accessToken: string;
    readonly threadId: string;
  },
  signal: AbortSignal,
): Promise<DriveListResult> {
  const url = new URL(GOOGLE_DRIVE_FILES_URL);
  url.searchParams.set(
    "q",
    [
      `appProperties has { key='${GOOGLE_DRIVE_ARTIFACT_APP_PROPERTY}' and value='true' }`,
      `appProperties has { key='${GOOGLE_DRIVE_THREAD_APP_PROPERTY}' and value='${escapeQuery(args.threadId)}' }`,
      "trashed = false",
    ].join(" and "),
  );
  url.searchParams.set("fields", "files(id,name,webViewLink,appProperties)");
  url.searchParams.set("pageSize", "1000");

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${args.accessToken}` },
    signal,
  });
  if (response.status === 401) {
    return { type: "unauthorized" };
  }
  if (!response.ok) {
    throw new Error(
      `Google Drive lookup failed with HTTP ${String(response.status)}`,
    );
  }
  const parsed = driveFileListSchema.parse(await response.json());
  return { type: "ok", files: parsed.files };
}

async function listArtifactFilesWithRefresh(
  args: {
    readonly db: ReadonlyDb;
    readonly featureSwitchContext: FeatureSwitchContext;
    readonly orgId: string;
    readonly tokens: ConnectorTokens;
    readonly threadId: string;
    readonly userId: string;
    readonly writeDb: Db;
  },
  signal: AbortSignal,
): Promise<
  z.infer<typeof driveFileSchema>[] | "reconnect-required" | "unauthorized"
> {
  const first = await listArtifactFiles(
    {
      accessToken: args.tokens.accessToken,
      threadId: args.threadId,
    },
    signal,
  );
  if (first.type === "ok") {
    return first.files;
  }
  const refreshed = await refreshDriveAccessToken(
    {
      connection: args.tokens.connection,
      db: args.db,
      featureSwitchContext: args.featureSwitchContext,
      orgId: args.orgId,
      userId: args.userId,
      writeDb: args.writeDb,
    },
    signal,
  );
  if (refreshed.type === "reconnect-required") {
    return "reconnect-required";
  }
  if (refreshed.type === "unavailable") {
    return "unauthorized";
  }
  const second = await listArtifactFiles(
    {
      accessToken: refreshed.accessToken,
      threadId: args.threadId,
    },
    signal,
  );
  if (second.type === "unauthorized") {
    return "unauthorized";
  }
  return second.files;
}

function buildStatusMap(
  files: readonly z.infer<typeof driveFileSchema>[],
): ReadonlyMap<string, DriveSyncResult> {
  const map = new Map<string, DriveSyncResult>();
  for (const file of files) {
    const runId = file.appProperties?.[GOOGLE_DRIVE_RUN_APP_PROPERTY];
    const fileId = file.appProperties?.[GOOGLE_DRIVE_FILE_APP_PROPERTY];
    if (!runId || !fileId) {
      continue;
    }
    map.set(artifactKey(runId, fileId), {
      id: file.id,
      name: file.name,
      webViewLink: file.webViewLink ?? null,
    });
  }
  return map;
}

function resolveGoogleDriveArtifactSyncStatus(
  lookup: DriveStatusLookup,
  runId: string,
  fileId: string,
): ChatThreadArtifactGoogleDriveSync {
  if (lookup.type === "disconnected") {
    return { status: "disconnected", recovery: lookup.recovery };
  }
  if (lookup.type === "unknown") {
    return { status: "unknown", accountReady: true };
  }
  const synced = lookup.syncedByKey.get(artifactKey(runId, fileId));
  return synced
    ? { status: "synced", accountReady: true, ...synced }
    : { status: "not_synced", accountReady: true };
}

export function applyGoogleDriveArtifactSyncStatuses(
  runs: readonly ChatThreadArtifactRun[],
  lookup: DriveStatusLookup,
): ChatThreadArtifactRun[] {
  return runs.map((run) => {
    return {
      ...run,
      files: run.files.map((file) => {
        return {
          ...file,
          googleDriveSync: resolveGoogleDriveArtifactSyncStatus(
            lookup,
            run.runId,
            file.id,
          ),
        };
      }),
    };
  });
}

/**
 * Compute the Drive sync status lookup for a chat thread's artifacts.
 *
 * The lookup persists a successful refresh so later polls use the current
 * access token. A terminal OAuth failure persists reconnect state for the
 * exact credential revision and immediately projects as disconnected.
 */
export function googleDriveArtifactStatusLookup(args: {
  readonly threadId: string;
  readonly orgId: string | undefined;
  readonly userId: string;
}): Command<Promise<DriveStatusLookup>, [AbortSignal]> {
  return command(async ({ get, set }, signal): Promise<DriveStatusLookup> => {
    if (!args.orgId) {
      return {
        type: "disconnected",
        recovery: { action: "unavailable" },
      };
    }
    const db = get(db$);
    const writeDb = set(writeDb$);
    const featureSwitchOverrides = await get(
      userFeatureSwitchOverrides(args.orgId, args.userId),
    );
    signal.throwIfAborted();
    const featureSwitchContext = {
      orgId: args.orgId,
      userId: args.userId,
      overrides: featureSwitchOverrides,
    };
    const snapshot = await loadConnectorRuntimeSnapshot(db);
    signal.throwIfAborted();
    const connection = await loadDriveConnection({
      db,
      orgId: args.orgId,
      userId: args.userId,
      threadId: args.threadId,
      featureSwitchContext,
      snapshot,
    });
    signal.throwIfAborted();
    if (connection.type === "disconnected") {
      return connection;
    }
    const authorized = await threadAllowsGoogleDriveArtifactSync(db, {
      orgId: args.orgId,
      userId: args.userId,
      threadId: args.threadId,
    });
    signal.throwIfAborted();
    if (!authorized) {
      return {
        type: "disconnected",
        recovery: { action: "authorize" },
      };
    }
    const { tokens } = connection;
    // Schema-parse failure or transient network error — treat as "unknown"
    // rather than failing the whole artifacts response. Request aborts still
    // propagate; the status deadline remains an unknown provider outcome.
    const providerSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(GOOGLE_DRIVE_STATUS_TIMEOUT_MS),
    ]);
    const files = await tapError(
      listArtifactFilesWithRefresh(
        {
          db,
          featureSwitchContext,
          orgId: args.orgId,
          tokens,
          threadId: args.threadId,
          userId: args.userId,
          writeDb,
        },
        providerSignal,
      ),
    );
    signal.throwIfAborted();
    if (files === undefined) {
      return { type: "unknown" };
    }
    if (files === "unauthorized") {
      return { type: "unknown" };
    }
    if (files === "reconnect-required") {
      return {
        type: "disconnected",
        recovery: {
          action: "reconnect",
          connectionId: tokens.connection.connectorId,
        },
      };
    }
    return { type: "ready", syncedByKey: buildStatusMap(files) };
  });
}

// =====================================================================
// Upload-side: sync a single artifact to the user's Google Drive.
// =====================================================================

const driveFolderSchema = z.object({ id: z.string(), name: z.string() });
const driveFolderListSchema = z.object({
  files: z.array(driveFolderSchema),
});
const driveUploadResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  webViewLink: z.string().nullable().optional(),
});

const EXT_MIMETYPE_MAP: Readonly<Record<string, string>> = {
  csv: "text/csv",
  txt: "text/plain",
  json: "application/json",
  pdf: "application/pdf",
  html: "text/html",
  md: "text/markdown",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

function inferMimetype(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  const mapped = ext ? EXT_MIMETYPE_MAP[ext] : undefined;
  return mapped ?? "application/octet-stream";
}

interface ArtifactFileRow {
  readonly runId: string;
  readonly source: string;
  readonly externalId: string;
  readonly filename: string | null;
  readonly contentType: string | null;
  readonly url: string | null;
  readonly metadata: Record<string, unknown>;
}

interface ArtifactS3Object {
  readonly bucketName: string;
  readonly key: string;
}

interface ResolvedArtifactContent {
  readonly contentType: string;
  readonly file: Buffer;
  readonly filename: string;
}

interface HostedArtifactMetadata {
  readonly artifactKind: "hosted-site" | "presentation-html";
  readonly deploymentId: string;
}

interface ZipEntry {
  readonly path: string;
  readonly content: Buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hostedArtifactMetadata(
  metadata: unknown,
): HostedArtifactMetadata | null {
  if (!isRecord(metadata)) {
    return null;
  }
  if (
    metadata.artifactKind !== "hosted-site" &&
    metadata.artifactKind !== "presentation-html"
  ) {
    return null;
  }
  return typeof metadata.deploymentId === "string"
    ? {
        artifactKind: metadata.artifactKind,
        deploymentId: metadata.deploymentId,
      }
    : null;
}

function hostedSiteFileKey(prefix: string, path: string): string {
  return `${prefix}${path}`;
}

function zipEntryPath(path: string): string {
  const segments = path.split("/").filter((segment) => {
    return segment.length > 0;
  });
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    path.includes("\0") ||
    segments.some((segment) => {
      return segment === "." || segment === "..";
    })
  ) {
    throw new Error(`Invalid hosted-site path: ${path}`);
  }
  return segments.join("/");
}

async function assembleZip(
  entries: readonly ZipEntry[],
  signal: AbortSignal,
): Promise<Buffer> {
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const chunks: Buffer[] = [];
  const done = createDeferredPromise<Buffer>(signal);

  archive.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });
  archive.on("end", () => {
    if (!done.settled()) {
      done.resolve(Buffer.concat(chunks));
    }
  });
  archive.on("error", (error) => {
    if (!done.settled()) {
      done.reject(error);
    }
  });

  const appendResult = safeSync(() => {
    for (const entry of entries) {
      archive.append(entry.content, { name: entry.path });
    }
  });
  if ("error" in appendResult) {
    if (!done.settled()) {
      done.reject(appendResult.error);
    }
    return await done.promise;
  }

  const finalized = (async () => {
    await onRejection(archive.finalize(), (error) => {
      if (!done.settled()) {
        done.reject(error);
      }
    });
    signal.throwIfAborted();
    return await done.promise;
  })();
  return await Promise.race([done.promise, finalized]);
}

async function loadArtifactFile(
  db: ReadonlyDb,
  args: {
    readonly threadId: string;
    readonly runId: string;
    readonly fileId: string;
    readonly userId: string;
  },
): Promise<ArtifactFileRow | null> {
  const [thread] = await db
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.id, args.threadId),
        eq(chatThreads.userId, args.userId),
      ),
    )
    .limit(1);
  if (!thread) {
    return null;
  }

  const [row] = await db
    .select({
      runId: runUploadedFiles.runId,
      source: runUploadedFiles.source,
      externalId: runUploadedFiles.externalId,
      filename: runUploadedFiles.filename,
      contentType: runUploadedFiles.contentType,
      url: runUploadedFiles.url,
      metadata: runUploadedFiles.metadata,
    })
    .from(runUploadedFiles)
    .innerJoin(agentRuns, eq(agentRuns.id, runUploadedFiles.runId))
    .where(
      and(
        isNotNull(agentRuns.triggerSource),
        eq(runUploadedFiles.userId, args.userId),
        eq(runUploadedFiles.runId, args.runId),
        or(
          eq(runUploadedFiles.externalId, args.fileId),
          and(
            eq(runUploadedFiles.id, args.fileId),
            eq(runUploadedFiles.assetVersion, CANONICAL_ASSET_VERSION),
            eq(runUploadedFiles.classification, "published-output"),
            eq(runUploadedFiles.accessLevel, "published"),
          ),
        ),
        or(
          eq(agentRuns.chatThreadId, args.threadId),
          exists(
            db
              .select({ one: chatEvents.id })
              .from(chatEvents)
              .where(
                runOwnedChatEventForRunCondition({
                  runId: runUploadedFiles.runId,
                  chatThreadId: args.threadId,
                }),
              ),
          ),
        ),
      ),
    )
    .limit(1);
  if (!row?.runId) {
    return null;
  }
  return { ...row, runId: row.runId };
}

function resolveArtifactS3ObjectFromKey(
  value: string,
  userId: string,
): ArtifactS3Object | null {
  if (
    value.startsWith(`artifacts/${encodeURIComponent(userId)}/`) ||
    isArtifactKeyV2(value)
  ) {
    return {
      bucketName: env("R2_USER_ARTIFACTS_BUCKET_NAME"),
      key: value,
    };
  }
  if (!value.startsWith(`uploads/${userId}/`)) {
    return null;
  }
  return {
    bucketName: env("R2_USER_STORAGES_BUCKET_NAME"),
    key: value,
  };
}

function resolveArtifactS3ObjectFromUrl(
  value: string,
  userId: string,
): ArtifactS3Object | null {
  if (!URL.canParse(value)) {
    return null;
  }
  const url = new URL(value);
  const key =
    artifactKeyFromShortOkouUrl(url) ?? url.pathname.replace(/^\/+/, "");
  return resolveArtifactS3ObjectFromKey(key, userId);
}

function artifactSourceUrls(artifact: ArtifactFileRow): readonly string[] {
  const metadataSourceUrl = artifact.metadata.sourceUrl;
  return [
    ...(artifact.url ? [artifact.url] : []),
    ...(typeof metadataSourceUrl === "string" &&
    metadataSourceUrl !== artifact.url
      ? [metadataSourceUrl]
      : []),
  ];
}

function resolveArtifactS3Object(
  artifact: ArtifactFileRow,
  userId: string,
  orgId: string,
): Computed<Promise<ArtifactS3Object | null>> {
  return computed(async (get): Promise<ArtifactS3Object | null> => {
    const reference = artifact.url ? artifactFileReference(artifact.url) : null;
    if (reference) {
      const object = await get(
        uploadedArtifactObject({ id: reference.id, userId, orgId }),
      );
      return object ? { bucketName: object.bucket, key: object.key } : null;
    }
    const value = artifact.metadata.s3Key;
    if (typeof value === "string") {
      const s3Object = resolveArtifactS3ObjectFromKey(value, userId);
      if (s3Object) {
        return s3Object;
      }
    }

    for (const sourceUrl of artifactSourceUrls(artifact)) {
      const s3Object = resolveArtifactS3ObjectFromUrl(sourceUrl, userId);
      if (s3Object) {
        return s3Object;
      }
    }

    return null;
  });
}

function resolveHostedArtifactContent(
  db: ReadonlyDb,
  artifact: ArtifactFileRow,
  owner: { readonly userId: string; readonly orgId: string },
  signal: AbortSignal,
): Computed<Promise<ResolvedArtifactContent | null>> {
  return computed(async (get): Promise<ResolvedArtifactContent | null> => {
    const metadata = hostedArtifactMetadata(artifact.metadata);
    if (!metadata) {
      return null;
    }

    const bucket = optionalEnv("R2_HOSTED_SITES_BUCKET_NAME");
    if (!bucket) {
      return null;
    }

    const isPrivate = artifact.metadata.access === "owner-private-v1";
    const deploymentTable = isPrivate
      ? privateHostedDeployments
      : hostedDeployments;
    const [deployment] = await db
      .select({
        entrypoint: deploymentTable.entrypoint,
        manifest: deploymentTable.manifest,
        r2Prefix: deploymentTable.r2Prefix,
      })
      .from(deploymentTable)
      .where(
        and(
          eq(deploymentTable.id, metadata.deploymentId),
          eq(deploymentTable.userId, owner.userId),
          eq(deploymentTable.orgId, owner.orgId),
          eq(deploymentTable.status, "ready"),
        ),
      )
      .limit(1);

    signal.throwIfAborted();
    if (!deployment) {
      return null;
    }

    if (isPrivate && deployment.manifest.access !== "owner-private-v1") {
      throw new Error("Private hosted deployment has an invalid access policy");
    }
    // Private presentations bundle their images and fonts next to index.html.
    if (isPrivate || metadata.artifactKind === "hosted-site") {
      const entries: ZipEntry[] = [];
      const files = Object.values(deployment.manifest.files).sort((a, b) => {
        return a.path.localeCompare(b.path);
      });
      for (const file of files) {
        const content = await get(
          downloadHostedSitesS3Buffer(
            bucket,
            hostedSiteFileKey(deployment.r2Prefix, file.path),
          ),
        );
        signal.throwIfAborted();
        entries.push({ path: zipEntryPath(file.path), content });
      }
      return {
        contentType: "application/zip",
        file: await assembleZip(entries, signal),
        filename: `${deployment.manifest.publicSlug}.zip`,
      };
    }

    const filename =
      artifact.filename ?? `${deployment.manifest.publicSlug}.html`;
    const manifestFile = deployment.manifest.files[deployment.entrypoint];
    return {
      contentType:
        artifact.contentType ??
        manifestFile?.contentType ??
        inferMimetype(filename),
      file: await get(
        downloadHostedSitesS3Buffer(
          bucket,
          hostedSiteFileKey(deployment.r2Prefix, deployment.entrypoint),
        ),
      ),
      filename,
    };
  });
}

function resolveS3ArtifactContent(
  artifact: ArtifactFileRow,
  s3Object: ArtifactS3Object,
): Computed<Promise<ResolvedArtifactContent>> {
  return computed(async (get): Promise<ResolvedArtifactContent> => {
    const filename = artifact.filename ?? artifact.externalId;
    const contentType = artifact.contentType ?? inferMimetype(filename);
    return {
      contentType,
      file: await get(downloadS3Buffer(s3Object.bucketName, s3Object.key)),
      filename,
    };
  });
}

type DriveTokenResult<T> =
  | { readonly type: "ok"; readonly value: T }
  | { readonly type: "unauthorized" };

async function findDriveFolder(args: {
  readonly accessToken: string;
  readonly parentFolderId: string | null;
  readonly name: string;
}): Promise<DriveTokenResult<z.infer<typeof driveFolderSchema> | null>> {
  const url = new URL(GOOGLE_DRIVE_FILES_URL);
  url.searchParams.set(
    "q",
    [
      `mimeType = '${GOOGLE_DRIVE_FOLDER_MIME_TYPE}'`,
      `name = '${escapeQuery(args.name)}'`,
      "trashed = false",
      args.parentFolderId
        ? `'${escapeQuery(args.parentFolderId)}' in parents`
        : "'root' in parents",
    ].join(" and "),
  );
  url.searchParams.set("fields", "files(id,name)");
  url.searchParams.set("pageSize", "1");

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${args.accessToken}` },
  });
  if (response.status === 401) {
    return { type: "unauthorized" };
  }
  if (!response.ok) {
    throw badRequestMessage(
      `Google Drive folder lookup failed with HTTP ${String(response.status)}`,
    );
  }
  const parsed = driveFolderListSchema.parse(await response.json());
  return { type: "ok", value: parsed.files[0] ?? null };
}

async function createDriveFolder(args: {
  readonly accessToken: string;
  readonly parentFolderId: string | null;
  readonly name: string;
}): Promise<DriveTokenResult<z.infer<typeof driveFolderSchema>>> {
  const url = new URL(GOOGLE_DRIVE_FILES_URL);
  url.searchParams.set("fields", "id,name");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: args.name,
      mimeType: GOOGLE_DRIVE_FOLDER_MIME_TYPE,
      ...(args.parentFolderId ? { parents: [args.parentFolderId] } : {}),
    }),
  });
  if (response.status === 401) {
    return { type: "unauthorized" };
  }
  if (!response.ok) {
    throw badRequestMessage(
      `Google Drive folder creation failed with HTTP ${String(response.status)}`,
    );
  }
  return {
    type: "ok",
    value: driveFolderSchema.parse(await response.json()),
  };
}

async function ensureDriveFolder(args: {
  readonly accessToken: string;
  readonly parentFolderId: string | null;
  readonly name: string;
}): Promise<DriveTokenResult<z.infer<typeof driveFolderSchema>>> {
  const existing = await findDriveFolder(args);
  if (existing.type === "unauthorized") {
    return existing;
  }
  if (existing.value) {
    return { type: "ok", value: existing.value };
  }
  return await createDriveFolder(args);
}

async function ensureArtifactFolder(args: {
  readonly accessToken: string;
  readonly threadId: string;
}): Promise<DriveTokenResult<string>> {
  let parentFolderId: string | null = null;
  for (const name of ["Okou Artifacts", `chat-${args.threadId}`]) {
    const folder = await ensureDriveFolder({
      accessToken: args.accessToken,
      parentFolderId,
      name,
    });
    if (folder.type === "unauthorized") {
      return folder;
    }
    parentFolderId = folder.value.id;
  }
  if (!parentFolderId) {
    throw badRequestMessage(
      "Google Drive artifact folder could not be resolved",
    );
  }
  return { type: "ok", value: parentFolderId };
}

async function uploadDriveFile(args: {
  readonly accessToken: string;
  readonly parentFolderId: string;
  readonly filename: string;
  readonly threadId: string;
  readonly runId: string;
  readonly fileId: string;
  readonly contentType: string;
  readonly file: Buffer;
}): Promise<Response> {
  const boundary = `multipart-${randomUUID()}`;
  const metadata = JSON.stringify({
    name: args.filename,
    mimeType: args.contentType,
    parents: [args.parentFolderId],
    appProperties: {
      [GOOGLE_DRIVE_ARTIFACT_APP_PROPERTY]: "true",
      [GOOGLE_DRIVE_THREAD_APP_PROPERTY]: args.threadId,
      [GOOGLE_DRIVE_RUN_APP_PROPERTY]: args.runId,
      [GOOGLE_DRIVE_FILE_APP_PROPERTY]: args.fileId,
    },
  });
  const body = Buffer.concat([
    Buffer.from(
      [
        `--${boundary}`,
        "Content-Type: application/json; charset=UTF-8",
        "",
        metadata,
        `--${boundary}`,
        `Content-Type: ${args.contentType}`,
        "",
        "",
      ].join("\r\n"),
      "utf8",
    ),
    args.file,
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
  ]);

  const uploadUrl = new URL(GOOGLE_DRIVE_UPLOAD_URL);
  uploadUrl.searchParams.set("uploadType", "multipart");
  uploadUrl.searchParams.set("fields", "id,name,webViewLink");

  return await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
}

async function uploadArtifactWithToken(args: {
  readonly accessToken: string;
  readonly threadId: string;
  readonly runId: string;
  readonly fileId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly file: Buffer;
}): Promise<DriveTokenResult<Response>> {
  const folder = await ensureArtifactFolder({
    accessToken: args.accessToken,
    threadId: args.threadId,
  });
  if (folder.type === "unauthorized") {
    return folder;
  }
  const response = await uploadDriveFile({
    accessToken: args.accessToken,
    parentFolderId: folder.value,
    filename: args.filename,
    threadId: args.threadId,
    runId: args.runId,
    fileId: args.fileId,
    contentType: args.contentType,
    file: args.file,
  });
  if (response.status === 401) {
    return { type: "unauthorized" };
  }
  return { type: "ok", value: response };
}

async function parseUploadResponse(
  response: Response,
): Promise<DriveSyncResult> {
  if (!response.ok) {
    throw badRequestMessage(
      `Google Drive upload failed with HTTP ${String(response.status)}`,
    );
  }
  const parsed = driveUploadResponseSchema.parse(await response.json());
  return {
    id: parsed.id,
    name: parsed.name,
    webViewLink: parsed.webViewLink ?? null,
  };
}

type NotFoundResponse = ReturnType<typeof notFound>;
type BadRequestResponse = ReturnType<typeof badRequestMessage>;

/**
 * Sync a chat-thread artifact file to the caller's connected Google Drive.
 *
 * Error mapping (preserves legacy web behavior where applicable):
 *  - 404 "Artifact file not found" — thread missing/cross-user, or no row.
 *  - 400 "Connect Google Drive before syncing artifacts" — connector
 *    absent, `needsReconnect`, or not authorized for the thread's agent.
 *  - 400 "This artifact file cannot be synced to Google Drive" — file
 *    location is missing or doesn't match a caller-owned artifact prefix.
 *  - 400 "Google Drive upload failed with HTTP <status>" — upload error
 *    after refresh-token retry exhausted.
 *  - 200 with `{ id, name, webViewLink }`.
 */
export const syncArtifactToGoogleDrive$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly threadId: string;
      readonly runId: string;
      readonly fileId: string;
    },
    signal: AbortSignal,
  ): Promise<
    | NotFoundResponse
    | BadRequestResponse
    | { readonly status: 200; readonly body: DriveSyncResult }
  > => {
    const db = get(db$);

    const featureSwitchOverrides = await get(
      userFeatureSwitchOverrides(args.orgId, args.userId),
    );
    signal.throwIfAborted();
    const featureSwitchContext = {
      orgId: args.orgId,
      userId: args.userId,
      overrides: featureSwitchOverrides,
    };
    const snapshot = await loadConnectorRuntimeSnapshot(db);
    signal.throwIfAborted();
    const connection = await loadDriveConnection({
      db,
      orgId: args.orgId,
      userId: args.userId,
      threadId: args.threadId,
      featureSwitchContext,
      snapshot,
    });
    signal.throwIfAborted();
    if (connection.type === "disconnected") {
      return badRequestMessage("Connect Google Drive before syncing artifacts");
    }
    const { tokens } = connection;

    const artifact = await loadArtifactFile(db, {
      threadId: args.threadId,
      runId: args.runId,
      fileId: args.fileId,
      userId: args.userId,
    });
    signal.throwIfAborted();
    if (!artifact) {
      return notFound("Artifact file not found");
    }

    const authorized = await threadAllowsGoogleDriveArtifactSync(db, {
      orgId: args.orgId,
      userId: args.userId,
      threadId: args.threadId,
    });
    signal.throwIfAborted();
    if (!authorized) {
      return badRequestMessage("Connect Google Drive before syncing artifacts");
    }

    const hostedContent = await get(
      resolveHostedArtifactContent(db, artifact, args, signal),
    );
    signal.throwIfAborted();
    const s3Object =
      hostedContent || artifact.metadata.access === "owner-private-v1"
        ? null
        : await get(resolveArtifactS3Object(artifact, args.userId, args.orgId));
    signal.throwIfAborted();
    let content: ResolvedArtifactContent;
    if (hostedContent) {
      content = hostedContent;
    } else if (s3Object) {
      content = await get(resolveS3ArtifactContent(artifact, s3Object));
      signal.throwIfAborted();
    } else {
      return badRequestMessage(
        "This artifact file cannot be synced to Google Drive",
      );
    }

    let result = await uploadArtifactWithToken({
      accessToken: tokens.accessToken,
      threadId: args.threadId,
      runId: args.runId,
      fileId: args.fileId,
      filename: content.filename,
      contentType: content.contentType,
      file: content.file,
    });
    signal.throwIfAborted();

    if (result.type === "unauthorized") {
      const refreshed = await refreshDriveAccessToken(
        {
          connection: tokens.connection,
          db,
          featureSwitchContext,
          orgId: args.orgId,
          userId: args.userId,
        },
        signal,
      );
      signal.throwIfAborted();
      if (refreshed.type === "ok") {
        result = await uploadArtifactWithToken({
          accessToken: refreshed.accessToken,
          threadId: args.threadId,
          runId: args.runId,
          fileId: args.fileId,
          filename: content.filename,
          contentType: content.contentType,
          file: content.file,
        });
        signal.throwIfAborted();
      }
    }

    if (result.type === "unauthorized") {
      return badRequestMessage("Google Drive upload failed with HTTP 401");
    }

    return {
      status: 200 as const,
      body: await parseUploadResponse(result.value),
    };
  },
);
