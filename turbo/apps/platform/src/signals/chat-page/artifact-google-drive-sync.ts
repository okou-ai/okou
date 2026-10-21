import { command, computed, state } from "ccstate";
import {
  GOOGLE_WORKSPACE_MIME_TYPES,
  googleWorkspaceTarget,
  type GoogleDriveUploadMode,
} from "@okouai/core/google-workspace-conversion";
import { toast } from "@okouai/ui/components/ui/sonner";
import { artifactGoogleDriveContract } from "@okouai/api-contracts/contracts/artifact-google-drive";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import { accept } from "../../lib/accept.ts";
import { i18n } from "../../i18n/index.ts";
import { apiClient$, type ApiClientFactory } from "../api-client.ts";
import { settle, withCleanup } from "../utils.ts";
import { pageVersion$ } from "../page-signal.ts";
import type { z } from "zod";

type GoogleDriveUploadedFile = z.infer<
  (typeof artifactGoogleDriveContract.uploadWithMode.responses)[200]
>;

type ArtifactGoogleDriveSyncParams = {
  readonly agentId: string;
  readonly connectionId?: string;
} & ArtifactGoogleDriveSyncFile;

type ArtifactGoogleDriveSyncFile = {
  readonly artifactId: string;
  readonly filename?: string | undefined;
  readonly mode: GoogleDriveUploadMode;
};

type ArtifactGoogleDriveSyncFilesParams = {
  readonly agentId: string;
  readonly connectionId?: string;
  readonly files: readonly ArtifactGoogleDriveSyncFile[];
};

function googleDriveSyncErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : i18n.t(($) => {
        return $.artifacts.googleDrive.syncFailed;
      });
}

function googleDriveSyncLoadingMessage(
  files: readonly ArtifactGoogleDriveSyncFile[],
): string {
  if (files.length === 1) {
    const filename = files[0]?.filename;
    return filename
      ? i18n.t(
          ($) => {
            return $.artifacts.googleDrive.syncingNamed;
          },
          { filename },
        )
      : i18n.t(($) => {
          return $.artifacts.googleDrive.syncingArtifact;
        });
  }
  return i18n.t(
    ($) => {
      return $.artifacts.googleDrive.syncingFiles;
    },
    {
      count: files.length,
    },
  );
}

function googleDriveSyncSuccessMessage(fileCount: number): string {
  return i18n.t(
    ($) => {
      return $.artifacts.googleDrive.syncedFiles;
    },
    {
      count: fileCount,
    },
  );
}

type ArtifactGoogleDriveSyncResult =
  | { readonly ok: true; readonly file: GoogleDriveUploadedFile }
  | { readonly ok: false; readonly message: string };

function isArtifactGoogleDriveSyncFailure(
  result: ArtifactGoogleDriveSyncResult,
): result is Extract<ArtifactGoogleDriveSyncResult, { readonly ok: false }> {
  return !result.ok;
}

async function syncArtifactFilesToGoogleDrive(
  params: ArtifactGoogleDriveSyncFilesParams & {
    readonly createClient: ApiClientFactory;
  },
  signal?: AbortSignal,
): Promise<readonly ArtifactGoogleDriveSyncResult[]> {
  signal?.throwIfAborted();
  if (params.files.length === 0) {
    toast.error(
      i18n.t(($) => {
        return $.artifacts.googleDrive.noArtifacts;
      }),
    );
    return [];
  }

  const toastId = toast.loading(googleDriveSyncLoadingMessage(params.files));
  const sync = async (): Promise<readonly ArtifactGoogleDriveSyncResult[]> => {
    const client = params.createClient(artifactGoogleDriveContract);
    const results: ArtifactGoogleDriveSyncResult[] = [];
    for (const file of params.files) {
      const target = googleWorkspaceTarget(file.filename ?? "");
      signal?.throwIfAborted();
      const settled = await settle(
        accept(
          client.uploadWithMode({
            params: { artifactId: file.artifactId },
            body: {
              agentId: params.agentId,
              mode: file.mode,
              ...(params.connectionId
                ? { connectionId: params.connectionId }
                : {}),
            },
            fetchOptions: signal ? { signal } : undefined,
          }),
          [200, 400, 401, 403, 404, 503],
        ),
        signal,
      );
      const result: ArtifactGoogleDriveSyncResult = settled.ok
        ? settled.value.status === 200
          ? file.mode === "google" &&
            (!target ||
              settled.value.body.mimeType !==
                GOOGLE_WORKSPACE_MIME_TYPES[target])
            ? {
                ok: false,
                message: i18n.t(($) => {
                  return $.artifacts.googleDrive.conversionUnconfirmed;
                }),
              }
            : { ok: true, file: settled.value.body }
          : { ok: false, message: settled.value.body.error.message }
        : {
            ok: false,
            message: googleDriveSyncErrorMessage(settled.error),
          };
      results.push(result);
    }
    signal?.throwIfAborted();
    const syncedCount = results.filter((result) => {
      return result.ok;
    }).length;

    if (syncedCount === params.files.length) {
      toast.success(googleDriveSyncSuccessMessage(params.files.length), {
        id: toastId,
      });
      return results;
    }

    const firstFailure = results.find(isArtifactGoogleDriveSyncFailure);
    toast.error(
      syncedCount > 0
        ? i18n.t(
            ($) => {
              return $.artifacts.googleDrive.partial;
            },
            {
              synced: syncedCount,
              count: params.files.length,
            },
          )
        : (firstFailure?.message ??
            i18n.t(($) => {
              return $.artifacts.googleDrive.syncFailed;
            })),
      { id: toastId },
    );
    return results;
  };

  return await withCleanup(sync(), () => {
    if (signal?.aborted) {
      toast.dismiss(toastId);
    }
  });
}

async function syncArtifactFileToGoogleDrive(
  params: ArtifactGoogleDriveSyncParams & {
    readonly createClient: ApiClientFactory;
  },
  signal?: AbortSignal,
): Promise<GoogleDriveUploadedFile | undefined> {
  const results = await syncArtifactFilesToGoogleDrive(
    {
      createClient: params.createClient,
      agentId: params.agentId,
      ...(params.connectionId ? { connectionId: params.connectionId } : {}),
      files: [
        {
          artifactId: params.artifactId,
          filename: params.filename,
          mode: params.mode,
        },
      ],
    },
    signal,
  );
  const result = results[0];
  return result?.ok ? result.file : undefined;
}

type GoogleDriveSyncOperation = Promise<GoogleDriveUploadedFile | undefined>;

// This registry owns real in-flight uploads, not a second pending-state model.
// Repeated surfaces and callers share the same upload result for each mode.
const internalGoogleDriveSyncOperations$ = state<
  ReadonlyMap<
    string,
    ReadonlyMap<GoogleDriveUploadMode, GoogleDriveSyncOperation>
  >
>(new Map());
export const idleGoogleDriveSync$ = computed(() => {
  return undefined;
});
export const googleDriveSyncOperations$ = computed((get) => {
  return new Map(
    [...get(internalGoogleDriveSyncOperations$)].map(([artifactId, modes]) => {
      return [
        artifactId,
        new Map(
          [...modes].map(([mode, operation]) => {
            return [
              mode,
              computed(() => {
                return operation;
              }),
            ] as const;
          }),
        ),
      ] as const;
    }),
  );
});

const syncArtifactFileToGoogleDrive$ = command(
  (
    { get, set },
    params: ArtifactGoogleDriveSyncParams & {
      readonly createClient: ApiClientFactory;
    },
    signal: AbortSignal,
  ): GoogleDriveSyncOperation => {
    signal.throwIfAborted();
    const modes = get(internalGoogleDriveSyncOperations$).get(
      params.artifactId,
    );
    const existing = modes?.get(params.mode);
    if (existing) {
      return existing;
    }
    const operation: GoogleDriveSyncOperation = withCleanup(
      syncArtifactFileToGoogleDrive(params, signal),
      () => {
        const operations = new Map(get(internalGoogleDriveSyncOperations$));
        if (operations.get(params.artifactId)?.get(params.mode) !== operation) {
          return;
        }
        const remaining = new Map(operations.get(params.artifactId));
        remaining.delete(params.mode);
        if (remaining.size > 0) {
          operations.set(params.artifactId, remaining);
        } else {
          operations.delete(params.artifactId);
        }
        set(internalGoogleDriveSyncOperations$, operations);
      },
    );
    set(
      internalGoogleDriveSyncOperations$,
      new Map(get(internalGoogleDriveSyncOperations$)).set(
        params.artifactId,
        new Map(modes).set(params.mode, operation),
      ),
    );
    return operation;
  },
);

type GoogleDriveSyncAccount = {
  readonly artifactId: string;
  readonly agentId: string;
  readonly connectionId: string | undefined;
  readonly ready: boolean;
  readonly googleImport?: GoogleDriveUploadedFile | undefined;
};

function createGoogleDriveSyncAccount() {
  return state<GoogleDriveSyncAccount | undefined>(undefined);
}

// Keep only the latest successful operation in the current page's graph.
// A new page version replaces the graph rather than retaining artifact keys.
const pageGoogleDriveSyncAccount$ = computed((get) => {
  get(pageVersion$);
  return createGoogleDriveSyncAccount();
});

export const googleDriveSyncAccount$ = computed((get) => {
  return get(get(pageGoogleDriveSyncAccount$));
});

// Retain the selected account and acknowledged native import without reloading
// the thread's attachment list. Catalog consumers can still refresh.
export const syncArtifactAndRefresh$ = command(
  async (
    { get, set },
    params: ArtifactGoogleDriveSyncParams & {
      readonly authorize: boolean;
      readonly onSyncSuccess?: () => void;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    // Capture this page's state before any await; old work cannot write into
    // a replacement page's graph even if its completion races navigation.
    const account$ = get(pageGoogleDriveSyncAccount$);
    const createClient = get(apiClient$);
    const previous = get(account$);
    const sameAccount =
      previous?.artifactId === params.artifactId &&
      previous.agentId === params.agentId &&
      previous.connectionId === params.connectionId;
    if (params.mode === "google" && sameAccount && previous.googleImport) {
      return;
    }
    if (params.authorize) {
      await authorizeGoogleDriveForAgent(
        { agentId: params.agentId, createClient },
        signal,
      );
    }
    const uploaded = await set(
      syncArtifactFileToGoogleDrive$,
      { ...params, createClient },
      signal,
    );
    signal.throwIfAborted();
    // Another upload mode may have completed while this request was pending.
    const account = get(account$);
    const sameCurrentAccount =
      account?.artifactId === params.artifactId &&
      account.agentId === params.agentId &&
      account.connectionId === params.connectionId;
    if (uploaded) {
      set(account$, {
        artifactId: params.artifactId,
        agentId: params.agentId,
        connectionId: params.connectionId,
        ready: true,
        googleImport:
          params.mode === "google"
            ? uploaded
            : sameCurrentAccount
              ? account.googleImport
              : undefined,
      });
    } else if (sameCurrentAccount) {
      set(account$, { ...account, ready: false });
    }
    if (uploaded) {
      params.onSyncSuccess?.();
    }
  },
);

async function authorizeGoogleDriveForAgent(
  params: {
    readonly agentId: string;
    readonly createClient: ApiClientFactory;
  },
  signal: AbortSignal,
): Promise<void> {
  const client = params.createClient(userBuiltinConnectorsContract);
  await accept(
    client.update({
      params: { id: params.agentId },
      body: {
        enabledConnectorSlugs: ["google-drive"],
        operation: "add",
      },
      fetchOptions: { signal },
    }),
    [200],
  );
  signal.throwIfAborted();
}
