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
import type { ChatThreadArtifactGoogleDriveRecovery } from "@okouai/api-contracts/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import { i18n } from "../../i18n/index.ts";
import { apiClient$ } from "../api-client.ts";
import { pageVersion$ } from "../page-signal.ts";
import type { infer as zInfer } from "zod";

type GoogleDriveUploadedFile = zInfer<
  (typeof SourceArtifactGoogleDriveContract.uploadFromChat.responses)[200]
>;

type ArtifactGoogleDriveUploadParams = {
  readonly artifactId: string;
  readonly filename?: string | undefined;
  readonly mode: GoogleDriveUploadMode;
  readonly threadId: string;
  readonly connectionId?: string;
  readonly successMessage?: string;
};

type ArtifactGoogleDriveSyncParams = ArtifactGoogleDriveUploadParams & {
  readonly recoveryAtStart?: ChatThreadArtifactGoogleDriveRecovery | undefined;
};

type GoogleDriveUploadDenied = {
  readonly status: 403;
  readonly body: zInfer<
    (typeof SourceArtifactGoogleDriveContract.uploadFromChat.responses)[403]
  >;
};

type ArtifactGoogleDriveSyncResult =
  | {
      readonly kind: "scope-required";
      readonly response: GoogleDriveUploadDenied;
      readonly recovery: NonNullable<
        GoogleDriveUploadDenied["body"]["recovery"]
      >;
    }
  | { readonly kind: "uploaded"; readonly file: GoogleDriveUploadedFile }
  | { readonly kind: "conversion-unconfirmed" };

export const uploadArtifactToGoogleDrive$ = command(
  async (
    { get },
    params: ArtifactGoogleDriveUploadParams,
    signal: AbortSignal,
  ): Promise<ArtifactGoogleDriveSyncResult> => {
    signal.throwIfAborted();
    const client = get(apiClient$)(artifactGoogleDriveContract);
    const attempted = await accept(
      client.uploadFromChat({
        params: { artifactId: params.artifactId },
        body: {
          chatThreadId: params.threadId,
          mode: params.mode,
          ...(params.connectionId ? { connectionId: params.connectionId } : {}),
        },
        fetchOptions: { signal },
      }),
      [200, 403],
      signal,
    );
    signal.throwIfAborted();
    if (
      attempted.status === 403 &&
      attempted.body.error.code === "GOOGLE_DRIVE_SCOPE_REQUIRED" &&
      attempted.body.recovery
    ) {
      return {
        kind: "scope-required",
        response: attempted,
        recovery: attempted.body.recovery,
      };
    }
    // Preserve normal error presentation for unrelated denials, without sending
    // another request or treating a generic 403 as a consent problem.
    const response = await accept(Promise.resolve(attempted), [200], signal);
    const target = googleWorkspaceTarget(params.filename ?? "");
    if (
      params.mode === "google" &&
      (!target ||
        response.body.mimeType !== GOOGLE_WORKSPACE_MIME_TYPES[target])
    ) {
      toast.warning(
        i18n.t(($) => {
          return $.artifacts.googleDrive.conversionUnconfirmed;
        }),
      );
      return { kind: "conversion-unconfirmed" };
    }
    toast.success(
      params.successMessage ??
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
  },
);

type GoogleDriveArtifactOperation = {
  readonly connectionId: string | undefined;
  readonly ready: boolean;
  readonly recoveryAtStart?: ChatThreadArtifactGoogleDriveRecovery | undefined;
  readonly recovery?: NonNullable<GoogleDriveUploadDenied["body"]["recovery"]>;
  readonly googleImport?: GoogleDriveUploadedFile | undefined;
};

function driveOperationKey(target: { threadId: string; artifactId: string }) {
  return `${target.threadId}:${target.artifactId}`;
}

const pageGoogleDriveOperations$ = computed((get) => {
  get(pageVersion$);
  return state<ReadonlyMap<string, GoogleDriveArtifactOperation>>(new Map());
});

export const googleDriveArtifactOperation$ = computed((get) => {
  const operations = get(get(pageGoogleDriveOperations$));
  return (target: { threadId: string; artifactId: string }) => {
    return operations.get(driveOperationKey(target));
  };
});

// Retain the selected account and acknowledged native import for menu state.
// Explicit saves still reach the API so every attempt gets current feedback.
export const syncArtifactAndRefresh$ = command(
  async (
    { get, set },
    params: ArtifactGoogleDriveSyncParams,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    // Capture this page's state before any await; old work cannot write into
    // a replacement page's graph even if its completion races navigation.
    const operations$ = get(pageGoogleDriveOperations$);
    const key = driveOperationKey(params);
    const result = await set(uploadArtifactToGoogleDrive$, params, signal);
    signal.throwIfAborted();
    // Another upload mode may have completed while this request was pending.
    const operations = get(operations$);
    const account = operations.get(key);
    const sameCurrentAccount =
      account !== undefined && account.connectionId === params.connectionId;
    if (result.kind === "scope-required") {
      // This lookup failed before any file upload. Offer exact-account OAuth
      // only on the user's next action; never replay this request here.
      set(
        operations$,
        new Map(operations).set(key, {
          connectionId: result.recovery.connectionId,
          recoveryAtStart: params.recoveryAtStart,
          ready: false,
          recovery: result.recovery,
          googleImport: sameCurrentAccount ? account.googleImport : undefined,
        }),
      );
      await accept(Promise.resolve(result.response), [200], signal, {
        expectedErrors: { 403: ["GOOGLE_DRIVE_SCOPE_REQUIRED"] },
      });
      return;
    }
    if (result.kind === "uploaded") {
      set(
        operations$,
        new Map(operations).set(key, {
          connectionId: params.connectionId,
          recoveryAtStart: params.recoveryAtStart,
          ready: true,
          googleImport:
            params.mode === "google"
              ? result.file
              : sameCurrentAccount
                ? account.googleImport
                : undefined,
        }),
      );
    } else if (sameCurrentAccount) {
      set(
        operations$,
        new Map(operations).set(key, { ...account, ready: false }),
      );
    }
  },
);

/** A confirmed reconnect restores the action, but never resumes an upload. */
export const finishArtifactDriveReconnect$ = command(
  (
    { get, set },
    params: {
      readonly artifactId: string;
      readonly threadId: string;
      readonly connectionId: string;
    },
    signal: AbortSignal,
  ): void => {
    signal.throwIfAborted();
    const operations$ = get(pageGoogleDriveOperations$);
    const operations = get(operations$);
    const key = driveOperationKey(params);
    const account = operations.get(key);
    if (account?.recovery?.connectionId !== params.connectionId) {
      return;
    }
    set(
      operations$,
      new Map(operations).set(key, {
        connectionId: params.connectionId,
        ready: true,
        recoveryAtStart: account.recoveryAtStart,
        googleImport: account.googleImport,
      }),
    );
  },
);
