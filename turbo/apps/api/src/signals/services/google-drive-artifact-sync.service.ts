import {
  GOOGLE_WORKSPACE_MIME_TYPES,
  googleWorkspaceTarget,
  type GoogleDriveUploadMode,
  type GoogleWorkspaceTarget,
} from "@okouai/core/google-workspace-conversion";
import { prepareGoogleWorkspaceImport } from "./google-workspace-import.service";
import {
  prepareGoogleSlidesImport,
  type SlidesTextStyle,
} from "./google-slides-import.service";
import { applyGoogleSlidesTextStyles } from "./google-slides-text-style.service";
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
  connectorCatalog,
  connectorCatalogEntries,
} from "@okouai/db/runtime/connector-catalog";
import {
  hostedDeployments,
  privateHostedDeployments,
} from "@okouai/db/runtime/hosted-site";
import { agents } from "@okouai/db/schema/agent";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { connectors } from "@okouai/db/schema/connector";
import { userBuiltinConnectors } from "@okouai/db/schema/user-connector";
import { ZipArchive } from "archiver";
import { command, computed, type Computed } from "ccstate";
import { and, eq, isNull } from "drizzle-orm";
import * as z from "zod";

import { env, optionalEnv } from "../../lib/env";
import {
  badRequestMessage,
  isBadRequestResponse,
  notFound,
} from "../../lib/error";
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

import type { ConnectorRuntimeAuthLookup } from "./connector-catalog-runtime.service";
import {
  connectorCatalogCurrentWhere,
  connectorRuntimeAuthSelectionReadPlan,
  connectorRuntimeAuthSelectionFromRows,
} from "./connector-catalog-slug-source.service";
import {
  loadUserFeatureSwitchContext$,
  userFeatureSwitchOverrides,
} from "./feature-switches.service";
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
const GOOGLE_SLIDES_TEXT_IMPORT_PROPERTY = "okouTextImport";
const GOOGLE_DRIVE_ACCESS_TOKEN_ENVIRONMENT_NAME = "GOOGLE_DRIVE_TOKEN";

const driveFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  webViewLink: z.string().nullable().optional(),
  appProperties: z.record(z.string(), z.string()).optional(),
  mimeType: z.string().optional(),
});
const driveFileListSchema = z.object({ files: z.array(driveFileSchema) });

interface DriveSyncResult {
  readonly id: string;
  readonly name: string;
  readonly webViewLink: string | null;
  readonly mimeType?: string;
}

interface DriveArtifactStatusSource {
  readonly runId: string | null;
  readonly fileId: string;
}

interface DriveSyncStatusResult extends DriveSyncResult {
  readonly originalUploaded: boolean;
}

type DriveStatusLookup =
  | {
      readonly type: "ready";
      readonly connectionId?: string;
      readonly syncedByKey: ReadonlyMap<string, DriveSyncStatusResult>;
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
    readonly source?: DriveArtifactStatusSource;
  },
  signal: AbortSignal,
): Promise<DriveListResult> {
  const url = new URL(GOOGLE_DRIVE_FILES_URL);
  url.searchParams.set(
    "q",
    [
      `appProperties has { key='${GOOGLE_DRIVE_ARTIFACT_APP_PROPERTY}' and value='true' }`,
      ...(args.source
        ? [
            `appProperties has { key='${GOOGLE_DRIVE_FILE_APP_PROPERTY}' and value='${escapeQuery(args.source.fileId)}' }`,
            ...(args.source.runId
              ? [
                  `appProperties has { key='${GOOGLE_DRIVE_RUN_APP_PROPERTY}' and value='${escapeQuery(args.source.runId)}' }`,
                ]
              : []),
          ]
        : [
            `appProperties has { key='${GOOGLE_DRIVE_THREAD_APP_PROPERTY}' and value='${escapeQuery(args.threadId)}' }`,
          ]),
      "trashed = false",
    ].join(" and "),
  );
  url.searchParams.set(
    "fields",
    "files(id,name,mimeType,webViewLink,appProperties)",
  );
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
      readonly source?: DriveArtifactStatusSource;
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
        source: args.source,
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
        source: args.source,
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
): ReadonlyMap<string, DriveSyncStatusResult> {
  const map = new Map<string, DriveSyncStatusResult>();
  for (const file of files) {
    if (
      file.appProperties?.[GOOGLE_SLIDES_TEXT_IMPORT_PROPERTY] === "pending-v1"
    ) {
      continue;
    }
    const runId = file.appProperties?.[GOOGLE_DRIVE_RUN_APP_PROPERTY];
    const fileId = file.appProperties?.[GOOGLE_DRIVE_FILE_APP_PROPERTY];
    if (!fileId) {
      continue;
    }
    const key = artifactKey(runId ?? "", fileId);
    const existing = map.get(key);
    const originalUploaded =
      existing?.originalUploaded === true ||
      !Object.values(GOOGLE_WORKSPACE_MIME_TYPES).some((mime) => {
        return mime === file.mimeType;
      });
    // Retain both actions' completion while preferring the native editor link.
    if (
      existing?.mimeType &&
      Object.values(GOOGLE_WORKSPACE_MIME_TYPES).some((mime) => {
        return mime === existing.mimeType;
      })
    ) {
      map.set(key, { ...existing, originalUploaded });
      continue;
    }
    map.set(key, {
      originalUploaded,
      id: file.id,
      name: file.name,
      webViewLink:
        file.webViewLink ??
        (file.mimeType === GOOGLE_WORKSPACE_MIME_TYPES.document
          ? `https://docs.google.com/document/d/${encodeURIComponent(file.id)}/edit`
          : file.mimeType === GOOGLE_WORKSPACE_MIME_TYPES.spreadsheet
            ? `https://docs.google.com/spreadsheets/d/${encodeURIComponent(file.id)}/edit`
            : file.mimeType === GOOGLE_WORKSPACE_MIME_TYPES.presentation
              ? `https://docs.google.com/presentation/d/${encodeURIComponent(file.id)}/edit`
              : null),
      ...(file.mimeType ? { mimeType: file.mimeType } : {}),
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

function googleDriveArtifactStatusFields(
  lookup: DriveStatusLookup,
  source: DriveArtifactStatusSource,
) {
  const connectionId =
    lookup.connectionId ??
    (lookup.type === "disconnected" && "connectionId" in lookup.recovery
      ? lookup.recovery.connectionId
      : undefined);
  return {
    ...(connectionId ? { googleDriveConnectionId: connectionId } : {}),
    googleDriveSync: resolveGoogleDriveArtifactSyncStatus(
      lookup,
      source.runId ?? "",
      source.fileId,
    ),
  };
}

/** Read status for one independently owned resource using the current view's account. */
export const googleDriveArtifactDetailStatus$ = command(
  async (
    { set },
    args: {
      readonly artifactId: string;
      readonly threadId: string;
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ) => {
    const artifact = await set(
      ownedGoogleDriveArtifact$,
      { ...args, catalogOnly: true },
      signal,
    );
    signal.throwIfAborted();
    if (!artifact) {
      return {};
    }
    // Uploads persist externalId, not the catalog ID or the projection row ID.
    const source = { runId: artifact.runId, fileId: artifact.externalId };
    const lookup = await set(
      googleDriveArtifactStatusLookup$,
      { ...args, source },
      signal,
    );
    signal.throwIfAborted();
    return googleDriveArtifactStatusFields(lookup, source);
  },
);

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
          ...googleDriveArtifactStatusFields(lookup, {
            runId: run.runId,
            fileId: file.id,
          }),
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
export const googleDriveArtifactStatusLookup$ = command(
  async (
    { set },
    args: {
      readonly threadId: string;
      readonly orgId: string | undefined;
      readonly userId: string;
      readonly source?: DriveArtifactStatusSource;
    },
    signal: AbortSignal,
  ): Promise<DriveStatusLookup> => {
    if (!args.orgId) {
      return {
        type: "disconnected",
        recovery: { action: "unavailable" },
      };
    }
    const featureSwitchContext = await set(
      loadUserFeatureSwitchContext$,
      args.orgId,
      args.userId,
      signal,
    );
    signal.throwIfAborted();
    const catalogDb = set(writeDb$);
    const catalogPlan = connectorRuntimeAuthSelectionReadPlan({
      connectorSlugs: ["google-drive"],
    });
    const snapshot = connectorRuntimeAuthSelectionFromRows(
      await catalogDb
        .select(catalogPlan.columns)
        .from(connectorCatalog)
        .leftJoin(connectorCatalogEntries, catalogPlan.join)
        .where(connectorCatalogCurrentWhere()),
      catalogPlan.requestedConnectorSlugs,
      catalogPlan.firewallConnectorSlugs,
    );
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
          source: args.source,
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
  },
);

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
  mimeType: z.string().optional(),
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
  readonly textStyles?: readonly SlidesTextStyle[];
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
  readonly pendingTextStyles?: boolean;
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
      ...(args.pendingTextStyles
        ? { [GOOGLE_SLIDES_TEXT_IMPORT_PROPERTY]: "pending-v1" }
        : {}),
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
  sessionUrl.searchParams.set("fields", "id,name,mimeType,webViewLink");
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
  readonly pendingTextStyles?: boolean;
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
    pendingTextStyles: args.pendingTextStyles,
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
    ...(parsed.mimeType ? { mimeType: parsed.mimeType } : {}),
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
    readonly discardInvalid: boolean;
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
  if (!args.discardInvalid) {
    return badRequestMessage(
      "The previously converted presentation is empty. Check Google Slides before retrying.",
    );
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

/** Reuse an existing editable copy after a retry or a stale preview refresh. */
async function findWorkspaceImport(
  args: {
    readonly accessToken: string;
    readonly fileId: string;
    readonly target: GoogleWorkspaceTarget;
  },
  signal: AbortSignal,
): Promise<
  | DriveTokenResult<z.infer<typeof driveFileSchema> | null>
  | { readonly type: "unavailable" }
> {
  const url = new URL(GOOGLE_DRIVE_FILES_URL);
  url.searchParams.set(
    "q",
    [
      `appProperties has { key='${GOOGLE_DRIVE_FILE_APP_PROPERTY}' and value='${escapeQuery(args.fileId)}' }`,
      `mimeType = '${GOOGLE_WORKSPACE_MIME_TYPES[args.target]}'`,
      "trashed = false",
    ].join(" and "),
  );
  url.searchParams.set(
    "fields",
    "files(id,name,mimeType,webViewLink,appProperties)",
  );
  url.searchParams.set("pageSize", "1");
  url.searchParams.set("orderBy", "createdTime desc");
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${args.accessToken}` },
    signal,
  });
  if (response.status === 401) {
    return { type: "unauthorized" };
  }
  if (!response.ok) {
    return { type: "unavailable" };
  }
  const files = driveFileListSchema.parse(await response.json()).files;
  const existing = files.find((file) => {
    return file.mimeType === GOOGLE_WORKSPACE_MIME_TYPES[args.target];
  });
  return { type: "ok", value: existing ?? null };
}

/** Read the created resource back; an Office attachment is not a native import. */
async function verifyWorkspaceImport(
  args: {
    readonly accessToken: string;
    readonly fileId: string;
    readonly target: GoogleWorkspaceTarget;
    readonly discardInvalid: boolean;
  },
  signal: AbortSignal,
): Promise<DriveSyncResult | string> {
  const url = new URL(
    `${GOOGLE_DRIVE_FILES_URL}/${encodeURIComponent(args.fileId)}`,
  );
  url.searchParams.set("fields", "id,name,mimeType,webViewLink,trashed");
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${args.accessToken}` },
    signal,
  });
  if (!response.ok) {
    return "Google created the file, but its conversion result could not be confirmed. Check Drive before retrying.";
  }
  const parsed = driveUploadResponseSchema
    .extend({ trashed: z.boolean().optional() })
    .safeParse(await response.json());
  if (!parsed.success || parsed.data.id !== args.fileId) {
    return "Google created the file, but its conversion result could not be confirmed. Check Drive before retrying.";
  }
  const result = parsed.data;
  if (
    result.mimeType !== GOOGLE_WORKSPACE_MIME_TYPES[args.target] ||
    result.trashed
  ) {
    if (!args.discardInvalid) {
      return "The previously converted file is unavailable. Refresh and try again.";
    }
    const removed = await trashDriveFile(
      { accessToken: args.accessToken, fileId: args.fileId },
      signal,
    );
    return removed
      ? "Google did not produce the requested editable format; the unsuccessful copy was removed"
      : "Google did not produce the requested editable format; an unsuccessful copy remains in Drive";
  }
  const editor = args.target === "spreadsheet" ? "spreadsheets" : args.target;
  return {
    id: result.id,
    name: result.name,
    mimeType: result.mimeType,
    webViewLink:
      result.webViewLink ??
      `https://docs.google.com/${editor}/d/${encodeURIComponent(result.id)}/edit`,
  };
}

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

interface SyncArtifactArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly artifactId: string;
  readonly agentId: string;
  readonly connectionId?: string;
  readonly authorizedRunId?: string;
  readonly mode?: GoogleDriveUploadMode;
}

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
        pendingTextStyles: !!params.content.textStyles?.length,
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
 * Upload an owned artifact to the caller's authorized Google Drive account.
 *
 * Error mapping:
 *  - 404 "Artifact file not found" — no owned, ready artifact for the id.
 *  - 400 "Connect and authorize Google Drive for this agent before uploading
 *    artifacts" — no Agent grant or no matching connected account.
 *  - 400 "Connect Google Drive before syncing artifacts" — the account
 *    needs reconnection or has no usable credentials.
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
    const artifact = await set(ownedGoogleDriveArtifact$, args, signal);
    signal.throwIfAborted();
    if (!artifact) {
      return notFound("Artifact file not found");
    }
    if (args.mode === "google") {
      const target = resolveGoogleConversionTarget(
        artifact.filename ?? "",
        featureSwitchContext,
      );
      if (isBadRequestResponse(target)) {
        return target;
      }
    }
    const connectorId = await set(artifactGoogleDriveAccount$, args, signal);
    signal.throwIfAborted();
    if (!connectorId) {
      return badRequestMessage(
        "Connect and authorize Google Drive for this agent before uploading artifacts",
      );
    }
    const catalogDb = set(writeDb$);
    const catalogPlan = connectorRuntimeAuthSelectionReadPlan({
      connectorSlugs: ["google-drive"],
    });
    const snapshot = connectorRuntimeAuthSelectionFromRows(
      await catalogDb
        .select(catalogPlan.columns)
        .from(connectorCatalog)
        .leftJoin(connectorCatalogEntries, catalogPlan.join)
        .where(connectorCatalogCurrentWhere()),
      catalogPlan.requestedConnectorSlugs,
      catalogPlan.firewallConnectorSlugs,
    );
    signal.throwIfAborted();
    const connection = await set(
      loadDriveConnection$,
      {
        orgId: args.orgId,
        userId: args.userId,
        connectorId,
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

    return await set(
      uploadResolvedArtifact$,
      { args, artifact, tokens, featureSwitchContext },
      signal,
    );
  },
);

function resolveGoogleConversionTarget(
  filename: string,
  featureSwitchContext: FeatureSwitchContext,
): GoogleWorkspaceTarget | BadRequestResponse {
  const target = googleWorkspaceTarget(filename);
  if (!target) {
    return badRequestMessage(
      "This file cannot be converted to a Google editor format",
    );
  }
  const flag =
    target === "presentation"
      ? FeatureSwitchKey.GoogleSlidesConversion
      : FeatureSwitchKey.GoogleDocsSheetsConversion;
  return isFeatureEnabled(flag, featureSwitchContext)
    ? target
    : badRequestMessage(
        target === "presentation"
          ? "Google Slides conversion is not enabled"
          : "Google Docs and Sheets conversion is not enabled",
      );
}

function prepareDriveUpload(
  content: ResolvedArtifactContent,
  featureSwitchContext: FeatureSwitchContext,
  mode: GoogleDriveUploadMode | undefined,
):
  | BadRequestResponse
  | {
      readonly content: ResolvedArtifactContent;
      readonly targetMimeType: string | undefined;
      readonly conversionTarget?: GoogleWorkspaceTarget;
    } {
  if (mode === "original") {
    return { content, targetMimeType: undefined };
  }
  // Requests from cached clients keep the pre-existing Slides behavior.
  if (mode === undefined) {
    const slides = resolveSlidesTarget(content, featureSwitchContext);
    return slides.kind === "rejected"
      ? slides.response
      : { content, targetMimeType: slides.mimeType };
  }
  const target = resolveGoogleConversionTarget(
    content.filename,
    featureSwitchContext,
  );
  if (isBadRequestResponse(target)) {
    return target;
  }
  if (target === "presentation") {
    const slides = resolveSlidesTarget(content, featureSwitchContext);
    return slides.kind === "rejected"
      ? slides.response
      : { content, targetMimeType: slides.mimeType, conversionTarget: target };
  }
  const prepared = prepareGoogleWorkspaceImport(content, target);
  return prepared.ok
    ? {
        content: prepared,
        targetMimeType: GOOGLE_WORKSPACE_MIME_TYPES[target],
        conversionTarget: target,
      }
    : badRequestMessage(prepared.message);
}

const reuseWorkspaceImport$ = command(
  async (
    { set },
    params: {
      readonly tokens: ConnectorTokens;
      readonly featureSwitchContext: FeatureSwitchContext;
      readonly target: GoogleWorkspaceTarget;
      readonly fileId: string;
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<
    | BadRequestResponse
    | {
        readonly tokens: ConnectorTokens;
        readonly existing: DriveSyncResult | null;
      }
  > => {
    const {
      tokens,
      featureSwitchContext,
      target: conversionTarget,
      fileId,
      orgId,
      userId,
    } = params;
    let uploadTokens = tokens;
    const lookupArgs = {
      fileId,
      target: conversionTarget,
    };
    let previous = await findWorkspaceImport(
      { ...lookupArgs, accessToken: uploadTokens.accessToken },
      signal,
    );
    signal.throwIfAborted();
    if (previous.type === "unauthorized") {
      const refreshed = await set(
        refreshDriveAccessToken$,
        {
          connection: tokens.connection,
          featureSwitchContext,
          orgId,
          userId,
        },
        signal,
      );
      signal.throwIfAborted();
      if (refreshed.type !== "ok") {
        return badRequestMessage(
          "Reconnect Google Drive before converting this file",
        );
      }
      uploadTokens = { ...tokens, accessToken: refreshed.accessToken };
      previous = await findWorkspaceImport(
        { ...lookupArgs, accessToken: uploadTokens.accessToken },
        signal,
      );
      signal.throwIfAborted();
    }
    if (previous.type !== "ok") {
      return badRequestMessage(
        previous.type === "unauthorized"
          ? "Reconnect Google Drive before converting this file"
          : "Google Drive could not check previous conversions. Try again.",
      );
    }
    if (previous.value) {
      if (
        previous.value.appProperties?.[GOOGLE_SLIDES_TEXT_IMPORT_PROPERTY] ===
        "pending-v1"
      ) {
        return badRequestMessage(
          "The previous Google Slides upload has unfinished font restoration. Check that copy in Drive before starting a new conversion; it will not be overwritten automatically.",
        );
      }
      const verified = await verifyWorkspaceImport(
        {
          accessToken: uploadTokens.accessToken,
          fileId: previous.value.id,
          target: conversionTarget,
          discardInvalid: false,
        },
        signal,
      );
      signal.throwIfAborted();
      if (typeof verified === "string") {
        return badRequestMessage(verified);
      }
      if (conversionTarget === "presentation") {
        const rejected = await rejectEmptyConvertedDeck(
          {
            accessToken: uploadTokens.accessToken,
            presentationId: verified.id,
            discardInvalid: false,
          },
          signal,
        );
        signal.throwIfAborted();
        if (rejected) {
          return rejected;
        }
      }
      return { tokens: uploadTokens, existing: verified };
    }

    return { tokens: uploadTokens, existing: null };
  },
);

async function finishDriveUpload(
  args: {
    readonly response: Response;
    readonly accessToken: string;
    readonly targetMimeType: string | undefined;
    readonly conversionTarget: GoogleWorkspaceTarget | undefined;
    readonly textStyles?: readonly SlidesTextStyle[];
  },
  signal: AbortSignal,
): Promise<
  BadRequestResponse | { readonly status: 200; readonly body: DriveSyncResult }
> {
  const { response, accessToken, targetMimeType, conversionTarget } = args;
  if (
    targetMimeType !== undefined &&
    !response.ok &&
    (await isUnsupportedConversion(response))
  ) {
    return badRequestMessage(
      conversionTarget && conversionTarget !== "presentation"
        ? "Google could not convert this document or spreadsheet"
        : "Google Slides could not read this presentation",
    );
  }
  let body = await parseUploadResponse(response);
  signal.throwIfAborted();
  if (conversionTarget) {
    const verified = await verifyWorkspaceImport(
      {
        accessToken,
        fileId: body.id,
        target: conversionTarget,
        discardInvalid: true,
      },
      signal,
    );
    signal.throwIfAborted();
    if (typeof verified === "string") {
      return badRequestMessage(verified);
    }
    body = verified;
  }
  if (targetMimeType === GOOGLE_SLIDES_MIME_TYPE) {
    const rejected = await rejectEmptyConvertedDeck(
      { accessToken, presentationId: body.id, discardInvalid: true },
      signal,
    );
    signal.throwIfAborted();
    if (rejected) {
      return rejected;
    }
  }

  if (args.textStyles?.length) {
    const failure = await applyGoogleSlidesTextStyles(
      accessToken,
      body.id,
      args.textStyles,
      signal,
    );
    signal.throwIfAborted();
    if (failure) {
      return badRequestMessage(failure);
    }
    const completed = await fetch(
      `${GOOGLE_DRIVE_FILES_URL}/${encodeURIComponent(body.id)}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          appProperties: {
            [GOOGLE_SLIDES_TEXT_IMPORT_PROPERTY]: "complete-v1",
          },
        }),
        signal,
      },
    );
    if (!completed.ok) {
      return badRequestMessage(
        "Google Slides fonts were restored, but completion could not be recorded. Check the uploaded copy before retrying.",
      );
    }
  }
  return { status: 200 as const, body };
}

const uploadResolvedArtifact$ = command(
  async (
    { get, set },
    params: {
      readonly args: SyncArtifactArgs;
      readonly artifact: ArtifactFileRow;
      readonly tokens: ConnectorTokens;
      readonly featureSwitchContext: FeatureSwitchContext;
    },
    signal: AbortSignal,
  ): Promise<
    | BadRequestResponse
    | { readonly status: 200; readonly body: DriveSyncResult }
  > => {
    const { args, artifact, tokens, featureSwitchContext } = params;
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

    const plan = prepareDriveUpload(content, featureSwitchContext, args.mode);
    if (isBadRequestResponse(plan)) {
      return plan;
    }
    const { targetMimeType, conversionTarget } = plan;
    const previous = conversionTarget
      ? await set(
          reuseWorkspaceImport$,
          {
            tokens,
            featureSwitchContext,
            target: conversionTarget,
            fileId: artifact.externalId,
            orgId: args.orgId,
            userId: args.userId,
          },
          signal,
        )
      : null;
    signal.throwIfAborted();
    if (previous && isBadRequestResponse(previous)) {
      return previous;
    }
    if (previous?.existing) {
      return { status: 200, body: previous.existing };
    }

    let uploadContent = plan.content;
    if (targetMimeType === GOOGLE_SLIDES_MIME_TYPE) {
      const prepared = await prepareGoogleSlidesImport(uploadContent, signal);
      signal.throwIfAborted();
      if (!prepared.ok) {
        return badRequestMessage(prepared.message);
      }
      uploadContent = {
        ...uploadContent,
        file: prepared.file,
        textStyles: prepared.textStyles,
      };
    }

    const upload = await set(
      uploadArtifactRefreshingToken$,
      {
        args,
        source: {
          artifactId: args.artifactId,
          threadId: artifact.threadId ?? null,
          runId: artifact.runId,
          fileId: artifact.externalId,
        },
        content: uploadContent,
        featureSwitchContext,
        targetMimeType,
        tokens: previous?.tokens ?? tokens,
      },
      signal,
    );
    signal.throwIfAborted();
    const { accessToken, result } = upload;

    if (result.type === "unauthorized") {
      return badRequestMessage("Google Drive upload failed with HTTP 401");
    }

    return await finishDriveUpload(
      {
        response: result.value,
        accessToken,
        targetMimeType,
        conversionTarget,
        textStyles: uploadContent.textStyles,
      },
      signal,
    );
  },
);
