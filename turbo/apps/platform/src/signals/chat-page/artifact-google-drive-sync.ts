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
import type { ApiClientFactory } from "../api-client.ts";
import { settle, withCleanup } from "../utils.ts";

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
  { readonly ok: true } | { readonly ok: false; readonly message: string };

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
): Promise<boolean> {
  signal?.throwIfAborted();
  if (params.files.length === 0) {
    toast.error(
      i18n.t(($) => {
        return $.artifacts.googleDrive.noArtifacts;
      }),
    );
    return false;
  }

  const toastId = toast.loading(googleDriveSyncLoadingMessage(params.files));
  const sync = async (): Promise<boolean> => {
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
            : { ok: true }
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
        ...(params.files.some((file) => {
          return file.mode === "google";
        })
          ? {
              description: i18n.t(($) => {
                return $.artifacts.googleDrive.conversionNotice;
              }),
            }
          : {}),
      });
      return true;
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
    return syncedCount > 0;
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
): Promise<boolean> {
  return await syncArtifactFilesToGoogleDrive(
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
}

const internalGoogleDriveSyncPending$ = state<
  ReadonlyMap<string, GoogleDriveUploadMode>
>(new Map());
export const googleDriveSyncPending$ = computed((get) => {
  return get(internalGoogleDriveSyncPending$);
});

export const syncArtifactFileToGoogleDrive$ = command(
  async (
    { get, set },
    params: ArtifactGoogleDriveSyncParams & {
      readonly createClient: ApiClientFactory;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    signal.throwIfAborted();
    if (get(internalGoogleDriveSyncPending$).has(params.artifactId)) {
      return false;
    }
    set(
      internalGoogleDriveSyncPending$,
      new Map(get(internalGoogleDriveSyncPending$)).set(
        params.artifactId,
        params.mode,
      ),
    );
    return await withCleanup(
      syncArtifactFileToGoogleDrive(params, signal),
      () => {
        const pending = new Map(get(internalGoogleDriveSyncPending$));
        pending.delete(params.artifactId);
        set(internalGoogleDriveSyncPending$, pending);
      },
    );
  },
);

export async function authorizeGoogleDriveForAgent(
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
