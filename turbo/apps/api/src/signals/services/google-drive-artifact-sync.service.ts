import type {
  ChatThreadArtifactGoogleDriveRecovery,
  ChatThreadArtifactGoogleDriveSync,
  ChatThreadArtifactRun,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  GOOGLE_SLIDES_MIME_TYPE,
  convertsToGoogleSlides,
} from "@okouai/core/google-slides-conversion";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import {
  hostedDeployments,
  privateHostedDeployments,
} from "@okouai/db/runtime/hosted-site";
import { agents } from "@okouai/db/schema/agent";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { connectors } from "@okouai/db/schema/connector";
import {
  CANONICAL_ASSET_VERSION,
  runUploadedFiles,
} from "@okouai/db/schema/run-uploaded-file";
import { userBuiltinConnectors } from "@okouai/db/schema/user-connector";
import { ZipArchive } from "archiver";
import { command, computed, type Command, type Computed } from "ccstate";
import { and, eq, exists, isNotNull, isNull, or } from "drizzle-orm";
import { z } from "zod";

import { env, optionalEnv } from "../../lib/env";
import { badRequestMessage, notFound } from "../../lib/error";
import {
  artifactKeyFromShortOkouUrl,
  isArtifactKeyV2,
} from "../../lib/file-url";
import { writeDb$ } from "../external/db";
import { downloadHostedSitesS3Buffer, downloadS3Buffer } from "../external/s3";
import {
  createDeferredPromise,
  onRejection,
  safeSync,
  settle,
  tapError,
} from "../utils";
import {
  loadBuiltinConnectorCredentialConnection$,
  loadBuiltinConnectorCredentialValues$,
  refreshBuiltinConnectorCredentialAccess$,
  builtinConnectorCredentialRuntimeValueRef,
  type BuiltinConnectorCredentialConnection,
} from "./builtin-connector-credential-runtime.service";

import { runOwnedChatEventForRunCondition } from "./chat-event-type.service";
import type { ConnectorRuntimeAuthLookup } from "./connector-catalog-runtime.service";
import { loadConnectorRuntimeAuthSelection } from "./connector-catalog-slug-source.service";
import { userFeatureSwitchOverrides } from "./feature-switches.service";
import { resolveArtifactFileReference$ } from "./private-artifact-storage.service";
import { uploadedArtifactObject$ } from "./uploaded-artifact.service";
import {
  ownedGoogleDriveArtifact$,
  artifactGoogleDriveAccount$,
} from "./artifact-google-drive-authorization.service";

const GOOGLE_DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const GOOGLE_DRIVE_UPLOAD_URL =
  "https://www.googleapis.com/upload/drive/v3/files";
const GOOGLE_SLIDES_PRESENTATIONS_URL =
  "https://slides.googleapis.com/v1/presentations";
const GOOGLE_DRIVE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
/** Drive's documented ceiling for converting an upload into a Slides deck. */
const GOOGLE_SLIDES_MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const GOOGLE_DRIVE_STATUS_TIMEOUT_MS = 2000;
const GOOGLE_DRIVE_ARTIFACT_APP_PROPERTY = "vm0Artifact";
const GOOGLE_DRIVE_THREAD_APP_PROPERTY = "vm0ThreadId";
const GOOGLE_DRIVE_RUN_APP_PROPERTY = "vm0RunId";
const GOOGLE_DRIVE_FILE_APP_PROPERTY = "vm0FileId";
const GOOGLE_DRIVE_CATALOG_ARTIFACT_APP_PROPERTY = "okouArtifactId";
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
      readonly connectionId?: string;
      readonly syncedByKey: ReadonlyMap<string, DriveSyncResult>;
    }
  | {
      readonly type: "disconnected";
      readonly connectionId?: string;
      readonly recovery: ChatThreadArtifactGoogleDriveRecovery;
    }
  | { readonly type: "unknown"; readonly connectionId?: string };

interface ConnectorTokens {
  readonly accessToken: string;
  readonly connection: BuiltinConnectorCredentialConnection;
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

const threadAllowsGoogleDriveArtifactSync$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly threadId: string;
    },
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const [authorization] = await db
      .select({ id: userBuiltinConnectors.id })
      .from(chatThreads)
      .innerJoin(
        userBuiltinConnectors,
        and(
          eq(userBuiltinConnectors.orgId, args.orgId),
          eq(userBuiltinConnectors.userId, args.userId),
          eq(userBuiltinConnectors.agentId, chatThreads.agentId),
          eq(userBuiltinConnectors.connectorSlug, "google-drive"),
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
  },
);

const resolveDriveConnectorAccount$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly threadId: string;
    },
  ): Promise<DriveConnectorAccountResolution> => {
    const db = set(writeDb$);
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
    const rows = await db
      .select({ connectorId: connectors.id })
      .from(connectors)
      .where(
        and(
          eq(connectors.orgId, args.orgId),
          eq(connectors.userId, args.userId),
          eq(connectors.connectorSlug, "google-drive"),
          isNull(connectors.customConnectorId),
          selection
            ? eq(connectors.id, selection.connectorId)
            : eq(connectors.isDefault, true),
        ),
      )
      .limit(2);
    const [row] = rows;
    if (rows.length === 1 && row) {
      return { type: "resolved", connectorId: row.connectorId };
    }
    return !selection && rows.length === 0
      ? { type: "connect" }
      : { type: "unavailable" };
  },
);

const loadDriveConnection$ = command(
  async (
    { set },
    args: {
      readonly featureSwitchContext: FeatureSwitchContext;
      readonly orgId: string;
      readonly snapshot: ConnectorRuntimeAuthLookup;
      readonly userId: string;
    } & ({ readonly threadId: string } | { readonly connectorId: string }),
    signal: AbortSignal,
  ): Promise<DriveConnectionLoadResult> => {
    const resolution: DriveConnectorAccountResolution =
      "connectorId" in args
        ? { type: "resolved", connectorId: args.connectorId }
        : await set(resolveDriveConnectorAccount$, {
            orgId: args.orgId,
            userId: args.userId,
            threadId: args.threadId,
          });
    signal.throwIfAborted();
    if (resolution.type !== "resolved") {
      return {
        type: "disconnected",
        recovery: { action: resolution.type },
      };
    }
    const loaded = await set(loadBuiltinConnectorCredentialConnection$, {
      snapshot: args.snapshot,
      orgId: args.orgId,
      userId: args.userId,
      connectorSlug: "google-drive",
      connectorId: resolution.connectorId,
    });
    signal.throwIfAborted();
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
    const accessTokenValueRef = builtinConnectorCredentialRuntimeValueRef(
      connection,
      GOOGLE_DRIVE_ACCESS_TOKEN_ENVIRONMENT_NAME,
    );
    if (accessTokenValueRef === null) {
      return {
        type: "disconnected",
        recovery: { action: "unavailable" },
      };
    }
    const values = await set(
      loadBuiltinConnectorCredentialValues$,
      {
        connection,
        featureSwitchContext: args.featureSwitchContext,
        valueRefs: [accessTokenValueRef],
      },
      signal,
    );
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
  },
);

const refreshDriveAccessToken$ = command(
  async (
    { set },
    args: {
      readonly connection: BuiltinConnectorCredentialConnection;
      readonly featureSwitchContext: FeatureSwitchContext;
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<DriveRefreshResult> => {
    const refreshed = await set(
      refreshBuiltinConnectorCredentialAccess$,
      {
        connection: args.connection,
        featureSwitchContext: args.featureSwitchContext,
        orgId: args.orgId,
        userId: args.userId,
        runtimeEnvironmentName: GOOGLE_DRIVE_ACCESS_TOKEN_ENVIRONMENT_NAME,
        persist: {},
      },
      signal,
    );
    if (refreshed.kind === "ok") {
      return { type: "ok", accessToken: refreshed.accessToken };
    }
    return refreshed.kind === "reconnect-required"
      ? { type: "reconnect-required" }
      : { type: "unavailable" };
  },
);

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

const listArtifactFilesWithRefresh$ = command(
  async (
    { set },
    args: {
      readonly featureSwitchContext: FeatureSwitchContext;
      readonly orgId: string;
      readonly tokens: ConnectorTokens;
      readonly threadId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<
    z.infer<typeof driveFileSchema>[] | "reconnect-required" | "unauthorized"
  > => {
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
    const refreshed = await set(
      refreshDriveAccessToken$,
      {
        connection: args.tokens.connection,
        featureSwitchContext: args.featureSwitchContext,
        orgId: args.orgId,
        userId: args.userId,
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
  },
);

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
  const connectionId =
    lookup.connectionId ??
    (lookup.type === "disconnected" && "connectionId" in lookup.recovery
      ? lookup.recovery.connectionId
      : undefined);
  return runs.map((run) => {
    return {
      ...run,
      files: run.files.map((file) => {
        return {
          ...file,
          ...(connectionId ? { googleDriveConnectionId: connectionId } : {}),
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
    const featureSwitchOverrides = await get(
      userFeatureSwitchOverrides(args.orgId, args.userId),
    );
    signal.throwIfAborted();
    const featureSwitchContext = {
      orgId: args.orgId,
      userId: args.userId,
      overrides: featureSwitchOverrides,
    };
    const snapshot = await loadConnectorRuntimeAuthSelection(set(writeDb$), {
      connectorSlugs: ["google-drive"],
    });
    signal.throwIfAborted();
    const connection = await set(
      loadDriveConnection$,
      {
        orgId: args.orgId,
        userId: args.userId,
        threadId: args.threadId,
        featureSwitchContext,
        snapshot,
      },
      signal,
    );
    signal.throwIfAborted();
    if (connection.type === "disconnected") {
      return connection;
    }
    const authorized = await set(threadAllowsGoogleDriveArtifactSync$, {
      orgId: args.orgId,
      userId: args.userId,
      threadId: args.threadId,
    });
    signal.throwIfAborted();
    if (!authorized) {
      return {
        type: "disconnected",
        connectionId: connection.tokens.connection.connectorId,
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
      set(
        listArtifactFilesWithRefresh$,
        {
          featureSwitchContext,
          orgId: args.orgId,
          tokens,
          threadId: args.threadId,
          userId: args.userId,
        },
        providerSignal,
      ),
    );
    signal.throwIfAborted();
    if (files === undefined || files === "unauthorized") {
      return { type: "unknown", connectionId: tokens.connection.connectorId };
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
    return {
      type: "ready",
      connectionId: tokens.connection.connectorId,
      syncedByKey: buildStatusMap(files),
    };
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
  readonly runId: string | null;
  readonly threadId?: string | null;
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

const loadArtifactFile$ = command(
  async (
    { set },
    args: {
      readonly threadId: string;
      readonly runId: string;
      readonly fileId: string;
      readonly userId: string;
    },
  ): Promise<ArtifactFileRow | null> => {
    const db = set(writeDb$);
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
      .where(
        and(
          isNotNull(runUploadedFiles.runId),
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
            eq(runUploadedFiles.chatThreadId, args.threadId),
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
  },
);

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

const resolveArtifactS3Object$ = command(
  async (
    { set },
    artifact: ArtifactFileRow,
    owner: { readonly userId: string; readonly orgId: string },
    signal: AbortSignal,
  ): Promise<ArtifactS3Object | null> => {
    const { userId, orgId } = owner;
    const reference = artifact.url
      ? await set(resolveArtifactFileReference$, artifact.url, signal)
      : null;
    signal.throwIfAborted();
    if (reference) {
      const object = await set(
        uploadedArtifactObject$,
        { id: reference.id, userId, orgId },
        signal,
      );
      signal.throwIfAborted();
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
  },
);

const resolveHostedArtifactContent$ = command(
  async (
    { get, set },
    artifact: ArtifactFileRow,
    owner: { readonly userId: string; readonly orgId: string },
    signal: AbortSignal,
  ): Promise<ResolvedArtifactContent | null> => {
    const db = set(writeDb$);
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
    // A publication that references stylesheets, images, fonts or sibling pages
    // loses them if only its entry document is uploaded. A self-contained page
    // has nothing to bundle, so it stays a page Drive can open on its own.
    const files = Object.values(deployment.manifest.files).sort((a, b) => {
      return a.path.localeCompare(b.path);
    });
    if (files.length > 1) {
      const entries: ZipEntry[] = [];
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
  },
);

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
  readonly threadId: string | null;
}): Promise<DriveTokenResult<string>> {
  let parentFolderId: string | null = null;
  const names = args.threadId
    ? ["Okou Artifacts", `chat-${args.threadId}`]
    : ["Okou Artifacts"];
  for (const name of names) {
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

/**
 * Upload through Drive's resumable protocol.
 *
 * Multipart carries the metadata and the bytes in one request, which Drive
 * documents for files of 5 MB or less; a hosted publication routinely exceeds
 * that. Resumable declares the metadata first and sends the content against the
 * session it returns, so the size of the content stops being a property of the
 * request, and the bytes no longer have to be copied into a combined body.
 */
async function uploadDriveFile(args: {
  readonly accessToken: string;
  readonly parentFolderId: string;
  readonly filename: string;
  readonly threadId: string | null;
  readonly runId: string | null;
  readonly fileId: string;
  readonly artifactId?: string;
  readonly contentType: string;
  readonly targetMimeType?: string | undefined;
  readonly file: Buffer;
}): Promise<Response> {
  const metadata = JSON.stringify({
    name: args.filename,
    // Naming a Google editor type here is what asks Drive to convert; the
    // upload headers below still declare the uploaded bytes' own type.
    mimeType: args.targetMimeType ?? args.contentType,
    parents: [args.parentFolderId],
    appProperties: {
      [GOOGLE_DRIVE_ARTIFACT_APP_PROPERTY]: "true",
      ...(args.threadId
        ? { [GOOGLE_DRIVE_THREAD_APP_PROPERTY]: args.threadId }
        : {}),
      ...(args.runId ? { [GOOGLE_DRIVE_RUN_APP_PROPERTY]: args.runId } : {}),
      [GOOGLE_DRIVE_FILE_APP_PROPERTY]: args.fileId,
      ...(args.artifactId
        ? { [GOOGLE_DRIVE_CATALOG_ARTIFACT_APP_PROPERTY]: args.artifactId }
        : {}),
    },
  });

  const sessionUrl = new URL(GOOGLE_DRIVE_UPLOAD_URL);
  sessionUrl.searchParams.set("uploadType", "resumable");
  sessionUrl.searchParams.set("fields", "id,name,webViewLink");
  const session = await fetch(sessionUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": args.contentType,
      "X-Upload-Content-Length": String(args.file.byteLength),
    },
    body: metadata,
  });
  if (!session.ok) {
    return session;
  }
  const location = session.headers.get("location");
  if (!location) {
    throw badRequestMessage("Google Drive did not open an upload session");
  }

  const body = new Uint8Array(args.file.byteLength);
  body.set(args.file);
  return await fetch(location, {
    method: "PUT",
    headers: {
      // Content-Length is forbidden to set explicitly; fetch derives it.
      "Content-Type": args.contentType,
      // A zero-length artifact has no byte range to declare, only a total.
      ...(body.byteLength === 0
        ? {}
        : {
            "Content-Range": `bytes 0-${String(body.byteLength - 1)}/${String(body.byteLength)}`,
          }),
    },
    body,
  });
}

async function uploadArtifactWithToken(args: {
  readonly accessToken: string;
  readonly threadId: string | null;
  readonly runId: string | null;
  readonly fileId: string;
  readonly artifactId?: string;
  readonly filename: string;
  readonly contentType: string;
  readonly targetMimeType?: string | undefined;
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
    ...(args.artifactId ? { artifactId: args.artifactId } : {}),
    contentType: args.contentType,
    targetMimeType: args.targetMimeType,
    file: args.file,
  });
  if (response.status === 401) {
    return { type: "unauthorized" };
  }
  return { type: "ok", value: response };
}

const driveErrorResponseSchema = z.object({
  error: z.object({
    errors: z.array(z.object({ reason: z.string().optional() })).optional(),
  }),
});

/** Drive's reason code when it cannot read the uploaded bytes at all. */
const UNSUPPORTED_CONVERSION_REASON = "conversionUnsupportedConversionPath";

async function isUnsupportedConversion(response: Response): Promise<boolean> {
  const payload = await settle(response.clone().json());
  if (!payload.ok) {
    return false;
  }
  const parsed = driveErrorResponseSchema.safeParse(payload.value);
  return (
    parsed.success &&
    (parsed.data.error.errors ?? []).some((entry) => {
      return entry.reason === UNSUPPORTED_CONVERSION_REASON;
    })
  );
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

const slidesPresentationSchema = z.object({
  slides: z
    .array(z.object({ pageElements: z.array(z.unknown()).optional() }))
    .optional(),
});

/** Returns whether Drive accepted the discard. */
async function trashDriveFile(
  args: {
    readonly accessToken: string;
    readonly fileId: string;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const response = await fetch(
    new URL(`${GOOGLE_DRIVE_FILES_URL}/${args.fileId}`),
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ trashed: true }),
      signal,
    },
  );
  return response.ok;
}

/**
 * Reject a conversion that produced an empty deck.
 *
 * Drive answers HTTP 200 for source formats its importer cannot actually read,
 * leaving a deck with the right page count and no page elements. The upload
 * response cannot show that, so read the result back and discard it rather
 * than reporting a successful sync of a blank presentation.
 */
async function rejectEmptyConvertedDeck(
  args: {
    readonly accessToken: string;
    readonly presentationId: string;
  },
  signal: AbortSignal,
): Promise<BadRequestResponse | undefined> {
  const response = await fetch(
    new URL(`${GOOGLE_SLIDES_PRESENTATIONS_URL}/${args.presentationId}`),
    {
      headers: { Authorization: `Bearer ${args.accessToken}` },
      signal,
    },
  );
  if (!response.ok) {
    // An unreadable check is not evidence of an empty deck; keep the file.
    return undefined;
  }
  const payload = await settle(response.json());
  if (!payload.ok) {
    return undefined;
  }
  const parsed = slidesPresentationSchema.safeParse(payload.value);
  if (!parsed.success) {
    return undefined;
  }
  const slides = parsed.data.slides ?? [];
  const hasContent = slides.some((slide) => {
    return (slide.pageElements ?? []).length > 0;
  });
  if (slides.length === 0 || hasContent) {
    return undefined;
  }
  const discarded = await trashDriveFile(
    { accessToken: args.accessToken, fileId: args.presentationId },
    signal,
  );
  // A deck we could not discard keeps its artifact appProperties, so the next
  // status lookup still reports it as synced. Say so rather than claiming the
  // blank deck is gone.
  return badRequestMessage(
    discarded
      ? "Google Slides converted this presentation to an empty deck"
      : "Google Slides converted this presentation to an empty deck that could not be removed from Drive",
  );
}

type SlidesTargetResolution =
  | { readonly kind: "target"; readonly mimeType: string | undefined }
  | { readonly kind: "rejected"; readonly response: BadRequestResponse };

/** Decide whether this sync asks Drive for a Slides deck, and whether it can. */
function resolveSlidesTarget(
  content: ResolvedArtifactContent,
  featureSwitchContext: FeatureSwitchContext,
): SlidesTargetResolution {
  const converts =
    isFeatureEnabled(
      FeatureSwitchKey.GoogleSlidesConversion,
      featureSwitchContext,
    ) && convertsToGoogleSlides(content.filename);
  if (!converts) {
    return { kind: "target", mimeType: undefined };
  }
  if (content.file.byteLength > GOOGLE_SLIDES_MAX_SOURCE_BYTES) {
    return {
      kind: "rejected",
      response: badRequestMessage(
        "This presentation is too large to convert to Google Slides",
      ),
    };
  }
  return { kind: "target", mimeType: GOOGLE_SLIDES_MIME_TYPE };
}

interface LegacySyncArtifactArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly fileId: string;
}

interface CatalogSyncArtifactArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly artifactId: string;
  readonly agentId: string;
  readonly connectionId?: string;
  readonly authorizedRunId?: string;
}

type SyncArtifactArgs = LegacySyncArtifactArgs | CatalogSyncArtifactArgs;

interface ArtifactUploadSource {
  readonly threadId: string | null;
  readonly runId: string | null;
  readonly fileId: string;
  readonly artifactId?: string;
}

interface DriveUploadAttempt {
  readonly accessToken: string;
  readonly result: DriveTokenResult<Response>;
}

/** Upload once, then retry under a refreshed token when Drive rejects it. */
const uploadArtifactRefreshingToken$ = command(
  async (
    { set },
    params: {
      readonly args: SyncArtifactArgs;
      readonly source: ArtifactUploadSource;
      readonly content: ResolvedArtifactContent;
      readonly featureSwitchContext: FeatureSwitchContext;
      readonly targetMimeType: string | undefined;
      readonly tokens: ConnectorTokens;
    },
    signal: AbortSignal,
  ): Promise<DriveUploadAttempt> => {
    const upload = async (accessToken: string) => {
      return await uploadArtifactWithToken({
        accessToken,
        ...params.source,
        filename: params.content.filename,
        contentType: params.content.contentType,
        targetMimeType: params.targetMimeType,
        file: params.content.file,
      });
    };

    const accessToken = params.tokens.accessToken;
    const result = await upload(accessToken);
    signal.throwIfAborted();
    if (result.type !== "unauthorized") {
      return { accessToken, result };
    }

    const refreshed = await set(
      refreshDriveAccessToken$,
      {
        connection: params.tokens.connection,
        featureSwitchContext: params.featureSwitchContext,
        orgId: params.args.orgId,
        userId: params.args.userId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (refreshed.type !== "ok") {
      return { accessToken, result };
    }
    const retried = await upload(refreshed.accessToken);
    signal.throwIfAborted();
    return { accessToken: refreshed.accessToken, result: retried };
  },
);

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
    { get, set },
    args: SyncArtifactArgs,
    signal: AbortSignal,
  ): Promise<
    | NotFoundResponse
    | BadRequestResponse
    | { readonly status: 200; readonly body: DriveSyncResult }
  > => {
    const featureSwitchOverrides = await get(
      userFeatureSwitchOverrides(args.orgId, args.userId),
    );
    signal.throwIfAborted();
    const featureSwitchContext = {
      orgId: args.orgId,
      userId: args.userId,
      overrides: featureSwitchOverrides,
    };
    const catalogArtifact =
      "artifactId" in args
        ? await set(ownedGoogleDriveArtifact$, args, signal)
        : null;
    signal.throwIfAborted();
    if ("artifactId" in args && !catalogArtifact) {
      return notFound("Artifact file not found");
    }
    const connectorId =
      "artifactId" in args
        ? await set(artifactGoogleDriveAccount$, args, signal)
        : null;
    signal.throwIfAborted();
    let accountSelector:
      { readonly connectorId: string } | { readonly threadId: string };
    if ("artifactId" in args) {
      if (!connectorId) {
        return badRequestMessage(
          "Connect and authorize Google Drive for this agent before uploading artifacts",
        );
      }
      accountSelector = { connectorId };
    } else {
      accountSelector = { threadId: args.threadId };
    }
    const snapshot = await loadConnectorRuntimeAuthSelection(set(writeDb$), {
      connectorSlugs: ["google-drive"],
    });
    signal.throwIfAborted();
    const connection = await set(
      loadDriveConnection$,
      {
        orgId: args.orgId,
        userId: args.userId,
        ...accountSelector,
        featureSwitchContext,
        snapshot,
      },
      signal,
    );
    signal.throwIfAborted();
    if (connection.type === "disconnected") {
      return badRequestMessage("Connect Google Drive before syncing artifacts");
    }
    const { tokens } = connection;

    const artifact =
      "artifactId" in args
        ? catalogArtifact
        : await set(loadArtifactFile$, args);
    signal.throwIfAborted();
    if (!artifact) {
      return notFound("Artifact file not found");
    }
    // Only old App clients use the chat-scoped adapter. The new upload path
    // has already authorized the resource and Agent/account above.
    const authorized =
      "artifactId" in args ||
      (await set(threadAllowsGoogleDriveArtifactSync$, {
        orgId: args.orgId,
        userId: args.userId,
        threadId: args.threadId,
      }));
    signal.throwIfAborted();
    if (!authorized) {
      return badRequestMessage("Connect Google Drive before syncing artifacts");
    }

    const hostedContent = await set(
      resolveHostedArtifactContent$,
      artifact,
      args,
      signal,
    );
    signal.throwIfAborted();
    const s3Object =
      hostedContent || artifact.metadata.access === "owner-private-v1"
        ? null
        : await set(resolveArtifactS3Object$, artifact, args, signal);
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

    const target = resolveSlidesTarget(content, featureSwitchContext);
    if (target.kind === "rejected") {
      return target.response;
    }
    const targetMimeType = target.mimeType;

    const upload = await set(
      uploadArtifactRefreshingToken$,
      {
        args,
        source:
          "artifactId" in args
            ? {
                artifactId: args.artifactId,
                threadId: artifact.threadId ?? null,
                runId: artifact.runId,
                fileId: artifact.externalId,
              }
            : args,
        content,
        featureSwitchContext,
        targetMimeType,
        tokens,
      },
      signal,
    );
    signal.throwIfAborted();
    const { accessToken, result } = upload;

    if (result.type === "unauthorized") {
      return badRequestMessage("Google Drive upload failed with HTTP 401");
    }

    if (
      targetMimeType !== undefined &&
      !result.value.ok &&
      (await isUnsupportedConversion(result.value))
    ) {
      return badRequestMessage(
        "Google Slides could not read this presentation",
      );
    }
    const body = await parseUploadResponse(result.value);
    signal.throwIfAborted();
    if (targetMimeType !== undefined) {
      const rejected = await rejectEmptyConvertedDeck(
        { accessToken, presentationId: body.id },
        signal,
      );
      signal.throwIfAborted();
      if (rejected) {
        return rejected;
      }
    }

    return { status: 200 as const, body };
  },
);
