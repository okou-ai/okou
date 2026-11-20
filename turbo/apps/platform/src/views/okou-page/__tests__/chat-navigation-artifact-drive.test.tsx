import type { ArtifactDetail } from "@okouai/api-contracts/contracts/artifact-catalog";
import { artifactGoogleDriveContract } from "@okouai/api-contracts/contracts/artifact-google-drive";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import {
  connectorAccountsContract,
  type ConnectorAccountConnection,
  type ConnectorAccountMutationIntent,
} from "@okouai/api-contracts/contracts/connector-accounts";
import type { BuiltinConnectorResponse } from "@okouai/api-contracts/contracts/connector-schemas";
import {
  builtinConnectorOauthStartContract,
  builtinConnectorsMainContract,
} from "@okouai/api-contracts/contracts/connectors";
import {
  userBuiltinConnectorsContract,
  type UserBuiltinConnectorUpdate,
} from "@okouai/api-contracts/contracts/user-connectors";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  GOOGLE_WORKSPACE_MIME_TYPES,
  googleWorkspaceTarget,
  type GoogleDriveUploadMode,
} from "@okouai/core/google-workspace-conversion";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "../sidebar-breakpoint.ts";
import {
  findNamedLink,
  publicArtifactUrl,
} from "./chat-attachment-test-helpers.ts";
import {
  artifactRun,
  artifactSummary,
  buttonNamed,
  fileArtifactDetail,
  googleDriveCatalogItem,
  googleDriveConnector,
  mockArtifactConversation,
  NAVIGATION_ARTIFACT_RUN_ID,
  NAVIGATION_ARTIFACT_THREAD_ID,
  openResourceArtifact,
  roleItemNamed,
} from "./chat-navigation-artifact-test-helpers.ts";
import { mockOAuthCompletions } from "./connector-page-test-helpers.ts";

const context = testContext();

const DRIVE_ARTIFACT_ID = "a0000000-0000-4000-a000-000000000940";
const DRIVE_FILE_ID = "f0000000-0000-4000-a000-000000000940";
const SELECTED_DRIVE_CONNECTION_ID = "d0000000-0000-4000-a000-000000000942";
const NEW_DRIVE_CONNECTION_ID = "d0000000-0000-4000-a000-000000000943";
const AUTHORIZATION_URL = "https://accounts.google.test/authorize-drive";
const DRIVE_LINK = "https://drive.google.test/file/drive-file-1";
const SCOPE_REQUIRED =
  "Reconnect Google Drive and allow Drive access before uploading artifacts. No file was uploaded.";

type DriveConnectionState =
  "not-connected" | BuiltinConnectorResponse["connectionStatus"];

interface DriveSyncRequest {
  readonly artifactId: string;
  readonly connectionId?: string;
  readonly mode: GoogleDriveUploadMode;
}

interface DriveMockOptions {
  readonly contentType?: string;
  readonly existingMimeType?: string;
  readonly failingMode?: GoogleDriveUploadMode;
  readonly filename?: string;
  readonly omitDriveMetadata?: boolean;
  readonly onUploadResponse?: () => void;
  readonly scopeRequired?: boolean;
  readonly selectedAccountReady?: boolean;
  readonly waitForSync?: (requestSignal: AbortSignal) => Promise<void>;
  readonly withoutViewLink?: boolean;
}

function installDriveMocks(
  initialConnectionState: DriveConnectionState,
  options: DriveMockOptions = {},
) {
  const completedAttempts = mockOAuthCompletions(context);
  let oauthAttemptId = crypto.randomUUID();
  let oauthConnectionId = SELECTED_DRIVE_CONNECTION_ID;
  let connectionState = initialConnectionState;
  let scopeRequired = options.scopeRequired ?? false;
  let mimeType = options.existingMimeType;
  let artifactSynced = mimeType !== undefined;
  let originalUploaded = false;
  const selectedAccountReady = options.selectedAccountReady ?? false;
  const filename = options.filename ?? "drive-report.pdf";
  const contentType = options.contentType ?? "application/pdf";
  const fileUrl = publicArtifactUrl(filename);
  const authorizationUpdates: UserBuiltinConnectorUpdate[] = [];
  const oauthRequests: {
    readonly account: ConnectorAccountMutationIntent;
  }[] = [];
  const syncRequests: DriveSyncRequest[] = [];
  context.mocks.http.get(fileUrl, () => {
    return HttpResponse.text("Drive preview", {
      headers: { "Content-Type": contentType },
    });
  });

  const summary = artifactSummary(
    DRIVE_ARTIFACT_ID,
    "file",
    options.filename ?? "Drive report.pdf",
  );
  const detail = fileArtifactDetail(summary, {
    contentType,
    fileId: DRIVE_FILE_ID,
    filename,
    url: fileUrl,
  });
  const driveMetadata = (): Pick<
    ArtifactDetail,
    "googleDriveConnectionId" | "googleDriveSync"
  > => {
    if (options.omitDriveMetadata) {
      return {};
    }
    return {
      googleDriveConnectionId: SELECTED_DRIVE_CONNECTION_ID,
      googleDriveSync: artifactSynced
        ? {
            status: "synced",
            accountReady: true,
            id: "drive-file-1",
            name: filename,
            ...(mimeType ? { mimeType } : {}),
            originalUploaded,
            webViewLink: DRIVE_LINK,
          }
        : selectedAccountReady
          ? { status: "not_synced", accountReady: true }
          : {
              status: "disconnected",
              recovery:
                initialConnectionState === "not-connected"
                  ? { action: "connect" }
                  : initialConnectionState === "reconnect-required"
                    ? {
                        action: "reconnect",
                        connectionId: SELECTED_DRIVE_CONNECTION_ID,
                      }
                    : { action: "authorize" },
            },
    };
  };
  mockArtifactConversation(context, {
    catalog: [summary],
    getDetail: (artifactId) => {
      return artifactId === DRIVE_ARTIFACT_ID
        ? { ...detail, ...driveMetadata() }
        : null;
    },
    chatEvents: [
      {
        id: "drive-preview-message",
        role: "assistant",
        content: `[Drive preview](${fileUrl})`,
        runId: NAVIGATION_ARTIFACT_RUN_ID,
        runEventId: "drive-preview-event",
        sequenceNumber: 1,
        createdAt: "2026-09-01T12:00:00.000Z",
      },
      {
        id: "drive-preview-run-completed",
        role: "assistant",
        content: null,
        runId: NAVIGATION_ARTIFACT_RUN_ID,
        runLifecycleEvent: "completed",
        createdAt: "2026-09-01T12:00:01.000Z",
      },
    ],
    artifactRuns: () => {
      return [
        artifactRun({
          artifactId: DRIVE_ARTIFACT_ID,
          contentType,
          fileId: DRIVE_FILE_ID,
          filename,
          url: fileUrl,
          ...driveMetadata(),
        }),
      ];
    },
  });

  context.mocks.api(builtinConnectorsMainContract.list, ({ respond }) => {
    return respond(200, {
      connectors:
        connectionState === "not-connected"
          ? []
          : [googleDriveConnector(connectionState)],
    });
  });
  context.mocks.api(connectorCatalogContract.get, ({ params, respond }) => {
    return params.connectorSlug === "google-drive"
      ? respond(200, { connector: googleDriveCatalogItem(connectionState) })
      : respond(404, {
          error: { code: "NOT_FOUND", message: "Connector not found" },
        });
  });
  // Registered after the slug route, which would otherwise also match it.
  context.mocks.api(connectorCatalogContract.status, ({ respond }) => {
    return respond(200, {
      connectors: [googleDriveCatalogItem(connectionState)],
    });
  });
  context.mocks.api(
    userBuiltinConnectorsContract.update,
    ({ body, respond }) => {
      authorizationUpdates.push(body);
      return respond(200, { enabledConnectorSlugs: ["google-drive"] });
    },
  );
  context.mocks.api(
    builtinConnectorOauthStartContract.start,
    ({ body, respond }) => {
      oauthRequests.push({ account: body.account });
      oauthAttemptId = crypto.randomUUID();
      oauthConnectionId =
        body.account.intent === "add"
          ? NEW_DRIVE_CONNECTION_ID
          : body.account.connectionId;
      return respond(200, {
        authorizationUrl: AUTHORIZATION_URL,
        oauthAttemptId,
        ...(body.account.intent === "add"
          ? { connectionId: NEW_DRIVE_CONNECTION_ID }
          : {}),
      });
    },
  );
  context.mocks.api(
    connectorAccountsContract.connection,
    ({ params, respond }) => {
      const knownConnection =
        params.connectionId === SELECTED_DRIVE_CONNECTION_ID ||
        (params.connectionId === NEW_DRIVE_CONNECTION_ID &&
          connectionState === "connected");
      if (!knownConnection) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Account not found" },
        });
      }
      const account: ConnectorAccountConnection = {
        id: params.connectionId,
        target: { kind: "builtin", connectorSlug: "google-drive" },
        authMethod: "oauth",
        displayName:
          params.connectionId === SELECTED_DRIVE_CONNECTION_ID
            ? "Artifact account"
            : "New account",
        isDefault: false,
        externalId: "drive-artifact-account",
        externalUsername: "artifact-owner",
        externalEmail: "artifact-owner@example.test",
        oauthScopes: ["https://www.googleapis.com/auth/drive.file"],
        connectionStatus:
          connectionState === "reconnect-required"
            ? "reconnect-required"
            : "connected",
        missingRequiredFields: [],
        configuredFieldKeys: [],
        reconnectReason:
          connectionState === "reconnect-required"
            ? "authorization_expired_or_revoked"
            : null,
        tokenExpiresAt: null,
        createdAt: "2026-09-01T12:00:00.000Z",
        updatedAt:
          connectionState === "connected"
            ? "2026-09-01T12:02:00.000Z"
            : "2026-09-01T12:01:00.000Z",
      };
      return respond(200, account);
    },
  );
  context.mocks.api(
    artifactGoogleDriveContract.uploadWithMode,
    async ({ params, body, respond, signal }) => {
      syncRequests.push({
        artifactId: params.artifactId,
        connectionId: body.connectionId,
        mode: body.mode,
      });
      await options.waitForSync?.(signal);
      if (scopeRequired) {
        return respond(403, {
          error: {
            code: "GOOGLE_DRIVE_SCOPE_REQUIRED",
            message: SCOPE_REQUIRED,
          },
          recovery: {
            action: "reconnect",
            connectionId: SELECTED_DRIVE_CONNECTION_ID,
          },
        });
      }
      if (body.mode === options.failingMode) {
        return respond(400, {
          error: { code: "BAD_REQUEST", message: "Drive upload failed" },
        });
      }
      artifactSynced = true;
      const target = googleWorkspaceTarget(filename);
      const uploadedMimeType =
        body.mode === "google" && target
          ? GOOGLE_WORKSPACE_MIME_TYPES[target]
          : contentType;
      if (body.mode === "original") {
        originalUploaded = true;
      }
      if (body.mode === "google" || !mimeType) {
        mimeType = uploadedMimeType;
      }
      // The API announces the synced artifact before it responds.
      context.mocks.ably.trigger("artifact:changed", {
        artifactId: params.artifactId,
      });
      options.onUploadResponse?.();
      return respond(200, {
        id: "drive-file-1",
        name: filename,
        mimeType: uploadedMimeType,
        webViewLink: options.withoutViewLink ? null : DRIVE_LINK,
      });
    },
  );

  return {
    authorizationUpdates,
    oauthRequests,
    syncRequests,
    completeAuthorization: () => {
      scopeRequired = false;
      completedAttempts.set(oauthAttemptId, oauthConnectionId);
      connectionState = "connected";
      context.mocks.ably.trigger("connector:changed", {
        connectorSlug: "google-drive",
      });
    },
    requireScopeConsent: () => {
      scopeRequired = true;
    },
  };
}

function installAuthorizationPopup() {
  const authorizationWindow = context.mocks.browser.authWindow();
  const location = { href: "about:blank" };
  Object.defineProperty(authorizationWindow, "location", {
    configurable: true,
    value: location,
  });
  return {
    window: authorizationWindow,
    location,
    open: context.mocks.browser.open(authorizationWindow),
  };
}

function useWideScreen(): void {
  context.mocks.browser.matchMedia((query) => {
    return (
      query === SIDEBAR_DESKTOP_MEDIA_QUERY || query === "(min-width: 1280px)"
    );
  });
}

async function openChat(slidesConversion = false): Promise<void> {
  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
    ...(slidesConversion
      ? { featureSwitches: { [FeatureSwitchKey.GoogleSlidesConversion]: true } }
      : {}),
  });
}

function artifactPreview(): HTMLElement {
  return screen.getByTestId("artifact-sidebar");
}

function sidebarDownloadButton(): HTMLElement {
  return buttonNamed("Download artifact", artifactPreview());
}

function menuItems(name: string): HTMLElement[] {
  return queryAllByRoleFast("menuitem").filter((item) => {
    return item.textContent?.trim() === name;
  });
}

async function waitForEnabledItem(name: string): Promise<void> {
  await waitFor(() => {
    expect(roleItemNamed("menuitem", name)).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
}

async function openSidebarMenu(filename: string, action: string) {
  await openResourceArtifact(filename);
  await waitFor(() => {
    expect(sidebarDownloadButton()).toBeEnabled();
  });
  click(sidebarDownloadButton());
  await waitForEnabledItem(action);
}

async function reopenMenu(
  downloadButton: () => HTMLElement,
  action: string,
): Promise<void> {
  await waitFor(() => {
    expect(downloadButton()).toBeEnabled();
    expect(downloadButton()).toHaveAttribute("aria-expanded", "false");
  });
  click(downloadButton());
  await waitForEnabledItem(action);
}

async function openPreviewDialog(filename: string) {
  click(await findNamedLink("Drive preview"));
  const preview = await screen.findByRole("dialog", {
    name: `${filename} preview`,
  });
  const downloadButton = () => {
    return buttonNamed("Download options", preview);
  };
  return { preview, downloadButton };
}

function successToasts(): Element[] {
  return [
    ...document.querySelectorAll('[data-sonner-toast][data-type="success"]'),
  ];
}

async function expectSuccessToast(): Promise<HTMLElement> {
  const message = await screen.findByText("Synced to Google Drive", {
    selector: "[data-sonner-toast] *",
  });
  expect(message.closest("[data-sonner-toast]")).toHaveAttribute(
    "data-type",
    "success",
  );
  return message;
}

test("A Drive upload without a view URL confirms the sync without a link", async () => {
  useWideScreen();
  installDriveMocks("connected", {
    selectedAccountReady: true,
    withoutViewLink: true,
  });
  await openChat();
  await openSidebarMenu("Drive report.pdf", "Upload to Google Drive");

  click(roleItemNamed("menuitem", "Upload to Google Drive"));

  const message = await expectSuccessToast();
  const toast = message.closest("[data-sonner-toast]");
  expect(toast?.textContent).not.toContain("View it");
  expect(screen.queryByText("View it")).not.toBeInTheDocument();
});

test("An artifact syncs with its selected Drive account during a catalog and inventory outage", async () => {
  useWideScreen();
  const drive = installDriveMocks("connected");
  const browser = context.mocks.browser.blobDownload();
  context.mocks.api(builtinConnectorsMainContract.list, ({ respond }) => {
    return respond(500, {
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Drive member inventory unavailable",
      },
    });
  });
  context.mocks.api(connectorCatalogContract.get, ({ respond }) => {
    return respond(500, {
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Drive catalog unavailable",
      },
    });
  });
  await openChat();
  await openSidebarMenu("Drive report.pdf", "Connect Google Drive");

  click(roleItemNamed("menuitem", "Connect Google Drive"));

  await expectSuccessToast();
  expect(drive.authorizationUpdates).toStrictEqual([
    { enabledConnectorSlugs: ["google-drive"], operation: "add" },
  ]);
  expect(drive.syncRequests).toMatchObject([
    {
      artifactId: DRIVE_ARTIFACT_ID,
      connectionId: SELECTED_DRIVE_CONNECTION_ID,
    },
  ]);
  expect(drive.oauthRequests).toHaveLength(0);
  await reopenMenu(sidebarDownloadButton, "Download");
  click(roleItemNamed("menuitem", "Download"));
  await waitFor(() => {
    expect(browser.downloads).toMatchObject([{ filename: "drive-report.pdf" }]);
  });
});

test("An artifact without Drive metadata disables Drive but still downloads", async () => {
  useWideScreen();
  installDriveMocks("connected", { omitDriveMetadata: true });
  const browser = context.mocks.browser.blobDownload();
  await openChat();
  await openSidebarMenu("Drive report.pdf", "Download");

  expect(roleItemNamed("menuitem", "Connect Google Drive")).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  click(roleItemNamed("menuitem", "Download"));
  await waitFor(() => {
    expect(browser.downloads).toMatchObject([{ filename: "drive-report.pdf" }]);
  });
});

test("Missing Drive scope for a Docs upload recovers only after explicit reconnection and retry", async () => {
  useWideScreen();
  const popup = installAuthorizationPopup();
  const drive = installDriveMocks("connected", {
    selectedAccountReady: true,
    scopeRequired: true,
    filename: "report.txt",
    contentType: "text/plain",
  });
  await openChat();
  await openSidebarMenu("report.txt", "Upload to Google Docs");
  click(roleItemNamed("menuitem", "Upload to Google Docs"));

  await expect(screen.findByText(SCOPE_REQUIRED)).resolves.toBeInTheDocument();
  expect(drive.oauthRequests).toHaveLength(0);
  expect(popup.open.calls).toHaveLength(0);

  await reopenMenu(sidebarDownloadButton, "Reconnect Google Drive");
  click(roleItemNamed("menuitem", "Reconnect Google Drive"));
  await waitFor(() => {
    expect(popup.location.href).toBe(AUTHORIZATION_URL);
  });
  expect(drive.oauthRequests).toStrictEqual([
    {
      account: {
        intent: "reconnect",
        connectionId: SELECTED_DRIVE_CONNECTION_ID,
      },
    },
  ]);
  drive.completeAuthorization();
  await reopenMenu(sidebarDownloadButton, "Upload to Google Docs");
  expect(drive.syncRequests).toHaveLength(1);
  expect(successToasts()).toHaveLength(0);

  click(roleItemNamed("menuitem", "Upload to Google Docs"));

  await expectSuccessToast();
  expect(drive.syncRequests).toStrictEqual([
    {
      artifactId: DRIVE_ARTIFACT_ID,
      connectionId: SELECTED_DRIVE_CONNECTION_ID,
      mode: "google",
    },
    {
      artifactId: DRIVE_ARTIFACT_ID,
      connectionId: SELECTED_DRIVE_CONNECTION_ID,
      mode: "google",
    },
  ]);
});

test("A scope failure beside an existing Docs import keeps one reconnect action and the Docs link", async () => {
  useWideScreen();
  const popup = installAuthorizationPopup();
  const drive = installDriveMocks("connected", {
    filename: "report.txt",
    contentType: "text/plain",
    selectedAccountReady: true,
    existingMimeType: GOOGLE_WORKSPACE_MIME_TYPES.document,
  });
  const expectDocsLink = () => {
    expect(roleItemNamed("menuitem", "Open in Google Docs")).toHaveAttribute(
      "href",
      DRIVE_LINK,
    );
  };
  await openChat();
  await openSidebarMenu("report.txt", "Upload to Google Drive");
  expectDocsLink();
  drive.requireScopeConsent();
  click(roleItemNamed("menuitem", "Upload to Google Drive"));
  await expect(screen.findByText(SCOPE_REQUIRED)).resolves.toBeInTheDocument();

  await reopenMenu(sidebarDownloadButton, "Reconnect Google Drive");
  expect(menuItems("Reconnect Google Drive")).toHaveLength(1);
  expectDocsLink();
  click(roleItemNamed("menuitem", "Reconnect Google Drive"));
  await waitFor(() => {
    expect(popup.location.href).toBe(AUTHORIZATION_URL);
  });
  expect(drive.oauthRequests).toStrictEqual([
    {
      account: {
        intent: "reconnect",
        connectionId: SELECTED_DRIVE_CONNECTION_ID,
      },
    },
  ]);
  drive.completeAuthorization();
  await reopenMenu(sidebarDownloadButton, "Upload to Google Drive");
  expectDocsLink();

  click(roleItemNamed("menuitem", "Upload to Google Drive"));

  await expectSuccessToast();
  expect(drive.syncRequests).toHaveLength(2);
  await reopenMenu(sidebarDownloadButton, "Open in Google Docs");
  expectDocsLink();
});

test("Dismissing Drive scope recovery never resumes the upload", async () => {
  useWideScreen();
  const popup = installAuthorizationPopup();
  const drive = installDriveMocks("connected", {
    selectedAccountReady: true,
    scopeRequired: true,
  });
  await openChat();
  const { preview, downloadButton } =
    await openPreviewDialog("drive-report.pdf");
  await reopenMenu(downloadButton, "Upload to Google Drive");
  click(roleItemNamed("menuitem", "Upload to Google Drive"));
  await expect(screen.findByText(SCOPE_REQUIRED)).resolves.toBeInTheDocument();
  await reopenMenu(downloadButton, "Reconnect Google Drive");
  click(roleItemNamed("menuitem", "Reconnect Google Drive"));
  await waitFor(() => {
    expect(popup.location.href).toBe(AUTHORIZATION_URL);
  });

  click(buttonNamed("Close", preview));
  await waitFor(() => {
    expect(screen.queryAllByRole("dialog", { hidden: true })).toHaveLength(0);
  });
  // Dismissal aborts the authorization attempt, which closes its window and
  // stops completion polling; a later completion has nothing to resume.
  await waitFor(() => {
    expect(popup.window.closed).toBeTruthy();
  });
  drive.completeAuthorization();

  const reopened = await openPreviewDialog("drive-report.pdf");
  await reopenMenu(reopened.downloadButton, "Reconnect Google Drive");
  expect(drive.syncRequests).toHaveLength(1);
  expect(successToasts()).toHaveLength(0);
});

test("A reopened preview stays usable after its pending Drive setup is cancelled", async () => {
  useWideScreen();
  const popup = installAuthorizationPopup();
  const syncing = context.mocks.deferred<void>();
  const sync = context.mocks.deferred<void>();
  const cancelled = context.mocks.deferred<void>();
  const uploadResponse = context.mocks.deferred<void>();
  const drive = installDriveMocks("not-connected", {
    waitForSync: async (requestSignal) => {
      requestSignal.addEventListener(
        "abort",
        () => {
          cancelled.resolve();
        },
        { once: true },
      );
      syncing.resolve();
      await sync.promise;
    },
    onUploadResponse: () => {
      uploadResponse.resolve();
    },
  });
  await openChat();
  const initial = await openPreviewDialog("drive-report.pdf");
  await reopenMenu(initial.downloadButton, "Connect Google Drive");
  click(roleItemNamed("menuitem", "Connect Google Drive"));
  await waitFor(() => {
    expect(popup.location.href).toBe(AUTHORIZATION_URL);
  });
  drive.completeAuthorization();
  await syncing.promise;
  click(buttonNamed("Close", initial.preview));
  await waitFor(() => {
    expect(screen.queryAllByRole("dialog", { hidden: true })).toHaveLength(0);
  });

  const reopened = await openPreviewDialog("drive-report.pdf");
  await reopenMenu(reopened.downloadButton, "Connect Google Drive");
  expect(reopened.preview).toBeVisible();
  await userEvent.setup().keyboard("{Escape}");
  // The client abandoned the pending upload request, so its late response
  // cannot reach the success path.
  await cancelled.promise;

  sync.resolve();
  await uploadResponse.promise;
  await reopenMenu(reopened.downloadButton, "Download");
  expect(reopened.preview).toBeVisible();
  expect(successToasts()).toHaveLength(0);
});

test("Drive authorization keeps the artifact preview open and syncs it", async () => {
  useWideScreen();
  const popup = installAuthorizationPopup();
  const drive = installDriveMocks("not-connected");
  const browser = context.mocks.browser.blobDownload();
  await openChat();
  const { preview, downloadButton } =
    await openPreviewDialog("drive-report.pdf");
  await reopenMenu(downloadButton, "Connect Google Drive");
  click(roleItemNamed("menuitem", "Connect Google Drive"));
  await waitFor(() => {
    expect(popup.location.href).toBe(AUTHORIZATION_URL);
  });

  drive.completeAuthorization();

  await expectSuccessToast();
  expect(drive.syncRequests).toMatchObject([{ artifactId: DRIVE_ARTIFACT_ID }]);
  expect(preview).toBeVisible();
  expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(1);
  await reopenMenu(downloadButton, "Upload to Google Drive");
  await waitForEnabledItem("Download");
  click(roleItemNamed("menuitem", "Download"));
  await waitFor(() => {
    expect(browser.downloads).toMatchObject([{ filename: "drive-report.pdf" }]);
  });
});

test("A failed original upload keeps the Slides editor link", async () => {
  useWideScreen();
  const drive = installDriveMocks("connected", {
    filename: "deck.pptx",
    contentType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    selectedAccountReady: true,
    failingMode: "original",
  });
  await openChat(true);
  await openSidebarMenu("deck.pptx", "Upload to Google Slides");
  click(roleItemNamed("menuitem", "Upload to Google Slides"));
  await expectSuccessToast();
  await reopenMenu(sidebarDownloadButton, "Upload to Google Drive");
  click(roleItemNamed("menuitem", "Upload to Google Drive"));

  await expect(
    screen.findByText("Drive upload failed"),
  ).resolves.toBeInTheDocument();
  expect(
    drive.syncRequests.map(({ mode }) => {
      return mode;
    }),
  ).toStrictEqual(["google", "original"]);
  await reopenMenu(sidebarDownloadButton, "Open in Google Slides");
  expect(roleItemNamed("menuitem", "Open in Google Slides")).toHaveAttribute(
    "href",
    DRIVE_LINK,
  );
  expect(menuItems("Upload to Google Slides")).toHaveLength(0);
});

test("One Drive reconnection serves both upload modes in the same preview", async () => {
  useWideScreen();
  const popup = installAuthorizationPopup();
  const drive = installDriveMocks("reconnect-required", {
    filename: "report.txt",
    contentType: "text/plain",
  });
  await openChat();
  await openSidebarMenu("report.txt", "Upload to Google Docs");
  click(roleItemNamed("menuitem", "Upload to Google Docs"));
  await waitFor(() => {
    expect(popup.location.href).toBe(AUTHORIZATION_URL);
  });
  expect(drive.oauthRequests).toStrictEqual([
    {
      account: {
        intent: "reconnect",
        connectionId: SELECTED_DRIVE_CONNECTION_ID,
      },
    },
  ]);
  drive.completeAuthorization();
  await expectSuccessToast();
  await reopenMenu(sidebarDownloadButton, "Upload to Google Drive");
  click(roleItemNamed("menuitem", "Upload to Google Drive"));

  await waitFor(() => {
    expect(drive.syncRequests).toHaveLength(2);
  });
  expect(drive.syncRequests).toStrictEqual([
    {
      artifactId: DRIVE_ARTIFACT_ID,
      connectionId: SELECTED_DRIVE_CONNECTION_ID,
      mode: "google",
    },
    {
      artifactId: DRIVE_ARTIFACT_ID,
      connectionId: SELECTED_DRIVE_CONNECTION_ID,
      mode: "original",
    },
  ]);
  await waitFor(() => {
    expect(successToasts()).toHaveLength(2);
  });
  expect(popup.open.calls).toHaveLength(1);
  expect(drive.oauthRequests).toHaveLength(1);
  await reopenMenu(sidebarDownloadButton, "Open in Google Docs");
  expect(roleItemNamed("menuitem", "Open in Google Docs")).toHaveAttribute(
    "href",
    DRIVE_LINK,
  );
});

test("Connecting Drive from a document preview exposes its Google Docs link in place", async () => {
  const popup = installAuthorizationPopup();
  const drive = installDriveMocks("not-connected", {
    filename: "report.txt",
    contentType: "text/plain",
  });
  await openChat();
  const { preview, downloadButton } = await openPreviewDialog("report.txt");
  await reopenMenu(downloadButton, "Upload to Google Docs");
  click(roleItemNamed("menuitem", "Upload to Google Docs"));
  await waitFor(() => {
    expect(popup.location.href).toBe(AUTHORIZATION_URL);
  });
  drive.completeAuthorization();
  await expectSuccessToast();
  expect(drive.syncRequests).toMatchObject([{ mode: "google" }]);

  await reopenMenu(downloadButton, "Open in Google Docs");

  expect(preview).toBeVisible();
  expect(roleItemNamed("menuitem", "Open in Google Docs")).toHaveAttribute(
    "href",
    DRIVE_LINK,
  );
  expect(menuItems("Upload to Google Docs")).toHaveLength(0);
});
