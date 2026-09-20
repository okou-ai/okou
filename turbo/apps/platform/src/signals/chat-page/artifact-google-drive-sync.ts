import { toast } from "@okouai/ui/components/ui/sonner";
import { chatThreadArtifactsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import { accept } from "../../lib/accept.ts";
import { i18n } from "../../i18n/index.ts";
import type { ApiClientFactory } from "../api-client.ts";
import { settle, withCleanup } from "../utils.ts";

type ArtifactGoogleDriveSyncParams = {
  readonly agentId?: string;
  readonly threadId: string;
} & ArtifactGoogleDriveSyncFile;

type ArtifactGoogleDriveSyncFile = {
  readonly runId: string;
  readonly fileId: string;
  readonly filename?: string | undefined;
};

type ArtifactGoogleDriveSyncFilesParams = {
  readonly agentId?: string;
  readonly threadId: string;
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
  | { readonly ok: true }
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
    const client = params.createClient(chatThreadArtifactsContract);
    const results: ArtifactGoogleDriveSyncResult[] = [];
    for (const file of params.files) {
      signal?.throwIfAborted();
      const settled = await settle(
        accept(
          client.syncGoogleDrive({
            params: { threadId: params.threadId },
            body: {
              runId: file.runId,
              fileId: file.fileId,
            },
            fetchOptions: signal ? { signal } : undefined,
          }),
          [200, 400, 401, 403, 404, 503],
        ),
        signal,
      );
      const result: ArtifactGoogleDriveSyncResult = settled.ok
        ? settled.value.status === 200
          ? { ok: true }
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

export async function syncArtifactFileToGoogleDrive(
  params: ArtifactGoogleDriveSyncParams & {
    readonly createClient: ApiClientFactory;
  },
  signal?: AbortSignal,
): Promise<boolean> {
  return await syncArtifactFilesToGoogleDrive(
    {
      createClient: params.createClient,
      threadId: params.threadId,
      files: [
        {
          runId: params.runId,
          fileId: params.fileId,
          filename: params.filename,
        },
      ],
    },
    signal,
  );
}

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
