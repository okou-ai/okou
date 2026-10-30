import { command, computed, state } from "ccstate";
import { createElement } from "react";
import {
  GOOGLE_WORKSPACE_MIME_TYPES,
  googleWorkspaceTarget,
  type GoogleDriveUploadMode,
} from "@okouai/core/google-workspace-conversion";
import { toast } from "@okouai/ui/components/ui/sonner";
import { artifactGoogleDriveContract } from "@okouai/api-contracts/client/artifact-google-drive";
import type { artifactGoogleDriveContract as SourceArtifactGoogleDriveContract } from "@okouai/api-contracts/contracts/artifact-google-drive";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/client/user-connectors";
import { accept } from "../../lib/accept.ts";
import { i18n } from "../../i18n/index.ts";
import { apiClient$, type ApiClientFactory } from "../api-client.ts";
import { pageVersion$ } from "../page-signal.ts";
import type { infer as zInfer } from "zod";

type GoogleDriveUploadedFile = zInfer<
  (typeof SourceArtifactGoogleDriveContract.uploadWithMode.responses)[200]
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

type ArtifactGoogleDriveSyncResult =
  | { readonly kind: "uploaded"; readonly file: GoogleDriveUploadedFile }
  | {
      readonly kind: "conversion-unconfirmed";
      readonly file: GoogleDriveUploadedFile;
    };

async function syncArtifactFileToGoogleDrive(
  params: ArtifactGoogleDriveSyncParams & {
    readonly createClient: ApiClientFactory;
  },
  signal: AbortSignal,
): Promise<ArtifactGoogleDriveSyncResult> {
  signal.throwIfAborted();
  const client = params.createClient(artifactGoogleDriveContract);
  const response = await accept(
    client.uploadWithMode({
      params: { artifactId: params.artifactId },
      body: {
        agentId: params.agentId,
        mode: params.mode,
        ...(params.connectionId ? { connectionId: params.connectionId } : {}),
      },
      fetchOptions: { signal },
    }),
    [200],
    signal,
  );
  signal.throwIfAborted();
  const target = googleWorkspaceTarget(params.filename ?? "");
  if (
    params.mode === "google" &&
    (!target || response.body.mimeType !== GOOGLE_WORKSPACE_MIME_TYPES[target])
  ) {
    toast.warning(
      i18n.t(($) => {
        return $.artifacts.googleDrive.conversionUnconfirmed;
      }),
    );
    return { kind: "conversion-unconfirmed", file: response.body };
  }
  toast.success(
    i18n.t(
      ($) => {
        return $.artifacts.googleDrive.syncedFiles;
      },
      { count: 1 },
    ),
    {
      action: response.body.webViewLink
        ? createElement(
            "a",
            {
              href: response.body.webViewLink,
              target: "_blank",
              rel: "noopener noreferrer",
              className:
                "ml-4 shrink-0 underline underline-offset-4 hover:opacity-80",
            },
            i18n.t(($) => {
              return $.artifacts.googleDrive.viewIt;
            }),
          )
        : undefined,
    },
  );
  return { kind: "uploaded", file: response.body };
}

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
    const result = await syncArtifactFileToGoogleDrive(
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
    if (result.kind === "uploaded") {
      set(account$, {
        artifactId: params.artifactId,
        agentId: params.agentId,
        connectionId: params.connectionId,
        ready: true,
        googleImport:
          params.mode === "google"
            ? result.file
            : sameCurrentAccount
              ? account.googleImport
              : undefined,
      });
    } else if (sameCurrentAccount) {
      set(account$, { ...account, ready: false });
    }
    if (result.kind === "uploaded") {
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
    signal,
  );
  signal.throwIfAborted();
}
