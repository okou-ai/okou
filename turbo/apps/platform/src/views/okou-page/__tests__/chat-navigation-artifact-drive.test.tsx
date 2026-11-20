import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  GOOGLE_WORKSPACE_MIME_TYPES,
  googleWorkspaceTarget,
  type GoogleDriveUploadMode,
} from "@okouai/core/google-workspace-conversion";
import { mockOAuthCompletions } from "./connector-page-test-helpers.ts";
import type { ArtifactDetail } from "@okouai/api-contracts/contracts/artifact-catalog";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import {
  builtinConnectorOauthStartContract,
  builtinConnectorsMainContract,
} from "@okouai/api-contracts/contracts/connectors";
import {
  connectorAccountsContract,
  type ConnectorAccountConnection,
  type ConnectorAccountMutationIntent,
} from "@okouai/api-contracts/contracts/connector-accounts";
import type { BuiltinConnectorResponse } from "@okouai/api-contracts/contracts/connector-schemas";
import { artifactGoogleDriveContract } from "@okouai/api-contracts/contracts/artifact-google-drive";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { expect, test, describe, it, vi } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  findNamedLink,
  publicArtifactUrl,
} from "./chat-attachment-test-helpers.ts";
import {
  testContext,
  type TestContext,
} from "../../../signals/__tests__/test-helpers.ts";
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "../sidebar-breakpoint.ts";
import {
  artifactRun,
  artifactSummary,
  buttonNamed,
  fileArtifactDetail,
  googleDriveCatalogItem,
  googleDriveConnector,
  mockArtifactConversation,
  openResourceArtifact,
  NAVIGATION_ARTIFACT_RUN_ID,
  NAVIGATION_ARTIFACT_THREAD_ID,
  roleItemNamed,
} from "./chat-navigation-artifact-test-helpers.ts";

vi.hoisted(() => {
  // Product analytics resolves the deployment environment at module load.
  window.location.href = "https://app.okou.ai/";
});

const context = testContext();

function artifactActions(telemetry: ReturnType<typeof context.mocks.posthog>) {
  return telemetry.events
    .filter((event) => {
      return event.name === "artifact_action_clicked";
    })
    .map((event) => {
      return event.properties;
    });
}

const DRIVE_ARTIFACT_ID = "a0000000-0000-4000-a000-000000000940";
const DRIVE_FILE_ID = "f0000000-0000-4000-a000-000000000940";
const SELECTED_DRIVE_CONNECTION_ID = "d0000000-0000-4000-a000-000000000942";
const NEW_DRIVE_CONNECTION_ID = "d0000000-0000-4000-a000-000000000943";
const DRIVE_FILE_URL = publicArtifactUrl("drive-report.pdf");
const AUTHORIZATION_URL = "https://accounts.google.test/authorize-drive";

type DriveConnectionState =
  "not-connected" | BuiltinConnectorResponse["connectionStatus"];

interface OauthRequest {
  readonly account: ConnectorAccountMutationIntent;
  readonly authMethod: string;
  readonly callbackTarget?: "app";
}

interface DriveMockControl {
  readonly completeAuthorization: () => void;
  readonly requireNewConnection: () => void;
  readonly requireScopeConsent: () => void;
  readonly selectOtherAccount: () => void;
  readonly oauthRequests: readonly OauthRequest[];
  readonly syncRequests: readonly {
    readonly artifactId: string;
    readonly chatThreadId: string;
    readonly connectionId?: string;
    readonly mode: GoogleDriveUploadMode;
  }[];
}

interface DriveMockOptions {
  readonly omitDriveMetadata?: boolean;
  readonly filename?: string;
  readonly contentType?: string;
  readonly existingMimeType?: string;
  readonly returnOriginal?: boolean;
  readonly selectedAccountReady?: boolean;
  readonly waitForSync?: (mode: GoogleDriveUploadMode) => Promise<void>;
  readonly failingMode?: GoogleDriveUploadMode;
  readonly uploadError?: "scope" | "forbidden";
  readonly uploadedWebViewLink?: string | null;
}

function installDriveMocks(
  targetContext: TestContext,
  initialConnectionState: DriveConnectionState,
  options: DriveMockOptions = {},
): DriveMockControl {
  const completedAttempts = mockOAuthCompletions(targetContext);
  let oauthAttemptId = crypto.randomUUID();
  let oauthConnectionId = SELECTED_DRIVE_CONNECTION_ID;
  let connectionState = initialConnectionState;
  let artifactConnectionState = initialConnectionState;
  let artifactConnectionId = SELECTED_DRIVE_CONNECTION_ID;
  let uploadError = options.uploadError;
  let selectedAccountReady =
    options.selectedAccountReady ?? initialConnectionState === "connected";
  let artifactSynced = options.existingMimeType !== undefined;
  let mimeType = options.existingMimeType;
  let originalUploaded = Boolean(
    mimeType &&
    !Object.values(GOOGLE_WORKSPACE_MIME_TYPES).some((native) => {
      return native === mimeType;
    }),
  );
  const filename = options.filename ?? "drive-report.pdf";
  const displayName = options.filename ?? "Drive report.pdf";
  const contentType = options.contentType ?? "application/pdf";
  const fileUrl = options.filename
    ? publicArtifactUrl(filename)
    : DRIVE_FILE_URL;
  const oauthRequests: OauthRequest[] = [];
  const syncRequests: {
    artifactId: string;
    chatThreadId: string;
    connectionId?: string;
    mode: GoogleDriveUploadMode;
  }[] = [];
  targetContext.mocks.http.get(fileUrl, () => {
    return HttpResponse.text("PDF preview", {
      headers: { "Content-Type": contentType },
    });
  });

  const summary = artifactSummary(DRIVE_ARTIFACT_ID, "file", displayName);
  const details = new Map<string, ArtifactDetail>([
    [
      DRIVE_ARTIFACT_ID,
      fileArtifactDetail(summary, {
        contentType,
        fileId: DRIVE_FILE_ID,
        filename,
        url: fileUrl,
      }),
    ],
  ]);
  const driveMetadata = (): Pick<
    ArtifactDetail,
    "googleDriveConnectionId" | "googleDriveSync"
  > => {
    if (options.omitDriveMetadata) {
      return {};
    }
    return {
      ...(artifactConnectionState === "not-connected"
        ? {}
        : { googleDriveConnectionId: artifactConnectionId }),
      googleDriveSync: artifactSynced
        ? {
            status: "synced",
            accountReady: true,
            id: "drive-file-1",
            name: filename,
            ...(mimeType ? { mimeType } : {}),
            originalUploaded,
            webViewLink: "https://drive.google.test/file/drive-file-1",
          }
        : selectedAccountReady
          ? { status: "not_synced", accountReady: true }
          : {
              status: "disconnected",
              recovery:
                artifactConnectionState === "not-connected"
                  ? { action: "connect" }
                  : artifactConnectionState === "reconnect-required"
                    ? {
                        action: "reconnect",
                        connectionId: SELECTED_DRIVE_CONNECTION_ID,
                      }
                    : { action: "unavailable" },
            },
    };
  };
  mockArtifactConversation(targetContext, {
    catalog: [summary],
    getDetail: (artifactId) => {
      const detail = details.get(artifactId);
      return detail ? { ...detail, ...driveMetadata() } : null;
    },
    onDetailQuery: (chatThreadId) => {
      // Ownership checks read the catalog without a chat scope.
      expect([undefined, NAVIGATION_ARTIFACT_THREAD_ID]).toContain(
        chatThreadId,
      );
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

  targetContext.mocks.api(builtinConnectorsMainContract.list, ({ respond }) => {
    return respond(200, {
      connectors:
        connectionState === "not-connected"
          ? []
          : [googleDriveConnector(connectionState)],
    });
  });
  targetContext.mocks.api(
    connectorCatalogContract.get,
    ({ params, respond }) => {
      return params.connectorSlug === "google-drive"
        ? respond(200, { connector: googleDriveCatalogItem(connectionState) })
        : respond(404, {
            error: { code: "NOT_FOUND", message: "Connector not found" },
          });
    },
  );
  // Registered after the slug route, which would otherwise also match it.
  targetContext.mocks.api(connectorCatalogContract.status, ({ respond }) => {
    return respond(200, {
      connectors: [googleDriveCatalogItem(connectionState)],
    });
  });
  targetContext.mocks.api(
    builtinConnectorOauthStartContract.start,
    ({ body, respond }) => {
      oauthRequests.push(body);
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
  targetContext.mocks.api(
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
  targetContext.mocks.api(
    artifactGoogleDriveContract.uploadFromChat,
    async ({ params, body, respond }) => {
      syncRequests.push({ artifactId: params.artifactId, ...body });
      await options.waitForSync?.(body.mode);
      if (uploadError === "scope") {
        return respond(403, {
          error: {
            code: "GOOGLE_DRIVE_SCOPE_REQUIRED",
            message:
              "Reconnect Google Drive and allow Drive access before uploading artifacts. No file was uploaded.",
          },
          recovery: {
            action: "reconnect",
            connectionId: SELECTED_DRIVE_CONNECTION_ID,
          },
        });
      }
      if (uploadError === "forbidden") {
        return respond(403, {
          error: { code: "FORBIDDEN", message: "Drive access is unavailable" },
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
        body.mode === "google" && target && !options.returnOriginal
          ? GOOGLE_WORKSPACE_MIME_TYPES[target]
          : contentType;
      if (body.mode === "original") {
        originalUploaded = true;
      }
      if (body.mode === "google" || !mimeType) {
        mimeType = uploadedMimeType;
      }
      // The API announces the synced artifact before it responds.
      targetContext.mocks.ably.trigger("artifact:changed", {
        artifactId: params.artifactId,
      });
      return respond(200, {
        id: "drive-file-1",
        name: filename,
        mimeType: uploadedMimeType,
        webViewLink:
          options.uploadedWebViewLink === undefined
            ? "https://drive.google.test/file/drive-file-1"
            : options.uploadedWebViewLink,
      });
    },
  );

  return {
    completeAuthorization: () => {
      uploadError = undefined;
      completedAttempts.set(oauthAttemptId, oauthConnectionId);
      connectionState = "connected";
      artifactConnectionState = "connected";
      artifactConnectionId = oauthConnectionId;
      targetContext.mocks.ably.trigger("connector:changed", {
        connectorSlug: "google-drive",
      });
    },
    requireScopeConsent: () => {
      uploadError = "scope";
    },
    selectOtherAccount: () => {
      artifactConnectionId = NEW_DRIVE_CONNECTION_ID;
      artifactSynced = false;
    },
    requireNewConnection: () => {
      connectionState = "not-connected";
      artifactConnectionState = "not-connected";
      selectedAccountReady = false;
      artifactSynced = false;
    },
    oauthRequests,
    syncRequests,
  };
}

interface AuthorizationPopupMock {
  readonly window: Window;
  readonly location: { href: string };
  readonly open: ReturnType<TestContext["mocks"]["browser"]["open"]>;
}

function installAuthorizationPopup(): AuthorizationPopupMock {
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

function mockWideScreen(): void {
  context.mocks.browser.matchMedia((query) => {
    return (
      query === SIDEBAR_DESKTOP_MEDIA_QUERY || query === "(min-width: 1280px)"
    );
  });
}

function artifactPreview(): HTMLElement {
  return screen.getByTestId("artifact-sidebar");
}

async function openDriveArtifactDownloadMenu(
  filename = "Drive report.pdf",
): Promise<void> {
  await openResourceArtifact(filename);
  await waitFor(() => {
    expect(buttonNamed("Download artifact", artifactPreview())).toBeEnabled();
  });
  click(buttonNamed("Download artifact", artifactPreview()));
}

async function openDriveArtifactMenu(
  actionName = "Connect Google Drive",
  filename = "Drive report.pdf",
): Promise<void> {
  await openDriveArtifactDownloadMenu(filename);
  await waitFor(() => {
    expect(roleItemNamed("menuitem", actionName)).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
}

async function expectSyncCompletedPreview(
  originalAction = "Synced to Google Drive",
  downloadButton = () => {
    return buttonNamed("Download artifact", artifactPreview());
  },
): Promise<void> {
  const successMessages = await screen.findAllByText("Synced to Google Drive");
  expect(successMessages.length).toBeGreaterThan(0);
  await waitFor(() => {
    expect(downloadButton()).toHaveAttribute("aria-expanded", "false");
  });
  click(downloadButton());
  await waitFor(() => {
    const item = roleItemNamed("menuitem", originalAction);
    expect(item.getAttribute("aria-disabled") === "true").toBe(
      originalAction === "Synced to Google Drive",
    );
  });
  expect(roleItemNamed("menuitem", "Download")).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(
    queryAllByRoleFast("menuitem").filter((item) => {
      return item.textContent?.trim() === "Upload to Google Drive";
    }),
  ).toHaveLength(originalAction === "Synced to Google Drive" ? 0 : 1);
}

async function openDriveMessageMenu(actionName = "Connect Google Drive") {
  click(await findNamedLink("Drive preview"));
  const preview = await waitFor(() => {
    const button = buttonNamed("Download options");
    const dialog = button.closest('[role="dialog"]');
    if (!(dialog instanceof HTMLElement)) {
      throw new Error("Expected the artifact's preview dialog");
    }
    expect(button).toBeEnabled();
    return dialog;
  });
  const downloadButton = () => {
    return buttonNamed("Download options", preview);
  };
  click(downloadButton());
  await waitFor(() => {
    expect(roleItemNamed("menuitem", actionName)).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
  return { preview, downloadButton };
}

test.each([
  {
    action: "Upload to Google Drive",
    url: "https://drive.google.test/file/d/original-report/view?usp=drivesdk",
    filename: "script.py",
    mode: "original",
    target: "file",
  },
  {
    action: "Upload to Google Docs",
    url: "https://docs.google.test/document/d/converted-report/edit",
    filename: "report.txt",
    mode: "google",
    target: "document",
  },
] as const)(
  "Offer a link to the uploaded file after $action",
  async ({ action, url, filename, mode, target }) => {
    const telemetry = context.mocks.posthog();
    mockWideScreen();
    const drive = installDriveMocks(context, "connected", {
      filename,
      contentType: "text/plain",
      selectedAccountReady: true,
      uploadedWebViewLink: url,
    });
    await setupPage({
      context,
      path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
      host: "app.okou.ai",
    });

    await openDriveArtifactMenu(action, filename);
    click(roleItemNamed("menuitem", action));

    const link = await findNamedLink("View it");
    expect(link).toHaveAttribute("href", url);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(drive.syncRequests).toStrictEqual([
      {
        artifactId: DRIVE_ARTIFACT_ID,
        chatThreadId: NAVIGATION_ARTIFACT_THREAD_ID,
        connectionId: SELECTED_DRIVE_CONNECTION_ID,
        mode,
      },
    ]);
    expect(artifactActions(telemetry)).toStrictEqual([
      {
        action: "google_drive_sync",
        surface: "page",
        target,
      },
    ]);
  },
);

test("Confirm a Drive upload without a link when Drive returns no view URL", async () => {
  mockWideScreen();
  installDriveMocks(context, "connected", {
    selectedAccountReady: true,
    uploadedWebViewLink: null,
  });
  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
  });

  await openDriveArtifactMenu("Upload to Google Drive");
  click(roleItemNamed("menuitem", "Upload to Google Drive"));

  await expect(
    screen.findByText("Synced to Google Drive"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText("View it")).not.toBeInTheDocument();
});

test("Sync an artifact during a Drive catalog and inventory outage", async () => {
  mockWideScreen();
  const drive = installDriveMocks(context, "connected");
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

  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
  });

  await openDriveArtifactMenu("Upload to Google Drive");
  click(roleItemNamed("menuitem", "Upload to Google Drive"));

  await waitFor(() => {
    expect(drive.syncRequests).toStrictEqual([
      {
        artifactId: DRIVE_ARTIFACT_ID,
        chatThreadId: NAVIGATION_ARTIFACT_THREAD_ID,
        connectionId: SELECTED_DRIVE_CONNECTION_ID,
        mode: "original",
      },
    ]);
    expect(drive.oauthRequests).toHaveLength(0);
  });
  await expectSyncCompletedPreview();
  click(roleItemNamed("menuitem", "Download"));
  await waitFor(() => {
    expect(browser.downloads.at(-1)).toMatchObject({
      filename: "drive-report.pdf",
    });
  });
  expect(browser.downloads.at(-1)?.blob).toBeInstanceOf(Blob);
  expect(artifactPreview()).toBeInTheDocument();
});

test("Keep artifact download available when the response omits Drive metadata", async () => {
  mockWideScreen();
  installDriveMocks(context, "connected", { omitDriveMetadata: true });
  const browser = context.mocks.browser.blobDownload();
  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
  });

  await openDriveArtifactDownloadMenu();
  await waitFor(() => {
    expect(roleItemNamed("menuitem", "Connect Google Drive")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
  click(roleItemNamed("menuitem", "Download"));
  await waitFor(() => {
    expect(browser.downloads.at(-1)).toMatchObject({
      filename: "drive-report.pdf",
    });
  });
  expect(browser.downloads.at(-1)?.blob).toBeInstanceOf(Blob);
});

test("Recheck Drive authorization after leaving and reopening the chat page", async () => {
  mockWideScreen();
  const popup = installAuthorizationPopup();
  const drive = installDriveMocks(context, "connected", {
    selectedAccountReady: true,
    filename: "deck.pptx",
    contentType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  });
  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.GoogleSlidesConversion]: true },
  });

  const initial = await openDriveMessageMenu("Upload to Google Slides");
  click(roleItemNamed("menuitem", "Upload to Google Slides"));
  await screen.findAllByText("Synced to Google Drive");
  await waitFor(() => {
    expect(initial.downloadButton()).toBeEnabled();
    expect(initial.downloadButton()).toHaveAttribute("aria-expanded", "false");
  });
  expect(drive.syncRequests).toStrictEqual([
    {
      artifactId: DRIVE_ARTIFACT_ID,
      chatThreadId: NAVIGATION_ARTIFACT_THREAD_ID,
      connectionId: SELECTED_DRIVE_CONNECTION_ID,
      mode: "google",
    },
  ]);
  expect(drive.oauthRequests).toHaveLength(0);

  click(buttonNamed("Close", initial.preview));
  await waitFor(() => {
    expect(initial.preview).not.toBeInTheDocument();
  });
  click(screen.getByLabelText("Artifacts", { selector: "a" }));
  await expect(
    screen.findByTestId("artifact-catalog-grid"),
  ).resolves.toBeInTheDocument();
  // The external account now requires a new connection. Returning to this
  // artifact must honor that page's recovery instruction, not the old success.
  drive.requireNewConnection();
  click(await screen.findByText("Artifact navigation"));

  const recovered = await openDriveMessageMenu("Upload to Google Slides");
  expect(recovered.preview).toBeInTheDocument();
  click(roleItemNamed("menuitem", "Upload to Google Slides"));
  await waitFor(() => {
    expect(popup.location.href).toBe(AUTHORIZATION_URL);
    expect(drive.oauthRequests).toContainEqual({
      account: { intent: "add" },
      authMethod: "oauth",
      callbackTarget: "app",
    });
  });
  drive.completeAuthorization();
  await waitFor(() => {
    expect(drive.syncRequests).toHaveLength(2);
    expect(drive.syncRequests[1]).toStrictEqual({
      artifactId: DRIVE_ARTIFACT_ID,
      chatThreadId: NAVIGATION_ARTIFACT_THREAD_ID,
      connectionId: NEW_DRIVE_CONNECTION_ID,
      mode: "google",
    });
  });
  await expectSyncCompletedPreview(
    "Open in Google Slides",
    recovered.downloadButton,
  );
});

test("Connect Google Drive and sync an artifact", async () => {
  const telemetry = context.mocks.posthog();
  mockWideScreen();
  const authorizationPopup = installAuthorizationPopup();
  const drive = installDriveMocks(context, "not-connected");

  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
  });

  await openDriveArtifactMenu();
  expect(artifactActions(telemetry)).toStrictEqual([]);
  click(roleItemNamed("menuitem", "Connect Google Drive"));
  expect(artifactActions(telemetry)).toStrictEqual([
    { action: "google_drive_sync", surface: "page", target: "file" },
  ]);

  await waitFor(() => {
    expect(authorizationPopup.open.calls).toHaveLength(1);
    expect(authorizationPopup.open.calls[0]).toMatchObject({
      target: "_blank",
      features: "width=600,height=700",
    });
    expect(drive.oauthRequests).toStrictEqual([
      {
        account: { intent: "add" },
        authMethod: "oauth",
        callbackTarget: "app",
      },
    ]);
    expect(authorizationPopup.location.href).toBe(AUTHORIZATION_URL);
  });

  drive.completeAuthorization();
  await waitFor(() => {
    expect(drive.syncRequests).toStrictEqual([
      {
        artifactId: DRIVE_ARTIFACT_ID,
        chatThreadId: NAVIGATION_ARTIFACT_THREAD_ID,
        connectionId: NEW_DRIVE_CONNECTION_ID,
        mode: "original",
      },
    ]);
  });
  await expectSyncCompletedPreview();
  expect(artifactActions(telemetry)).toStrictEqual([
    { action: "google_drive_sync", surface: "page", target: "file" },
  ]);
});

test("Recover missing Drive scope for a native upload only after explicit exact-account consent", async () => {
  mockWideScreen();
  const popup = installAuthorizationPopup();
  const drive = installDriveMocks(context, "connected", {
    selectedAccountReady: true,
    uploadError: "scope",
    filename: "report.txt",
    contentType: "text/plain",
  });
  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
  });
  await openDriveArtifactMenu("Upload to Google Docs", "report.txt");
  click(roleItemNamed("menuitem", "Upload to Google Docs"));
  await expect(
    screen.findByText(
      "Reconnect Google Drive and allow Drive access before uploading artifacts. No file was uploaded.",
    ),
  ).resolves.toBeInTheDocument();
  expect(drive.syncRequests).toHaveLength(1);
  expect(drive.oauthRequests).toHaveLength(0);
  expect(popup.open.calls).toHaveLength(0);

  // Even though the catalog still says connected, the failed operation owns
  // the recovery and must not resubmit with unchanged permissions.
  click(buttonNamed("Download artifact", artifactPreview()));
  await waitFor(() => {
    expect(
      roleItemNamed("menuitem", "Reconnect Google Drive"),
    ).not.toHaveAttribute("aria-disabled", "true");
  });
  expect(
    queryAllByRoleFast("menuitem").filter((item) => {
      return item.textContent?.trim() === "Reconnect Google Drive";
    }),
  ).toHaveLength(1);
  click(roleItemNamed("menuitem", "Reconnect Google Drive"));
  await waitFor(() => {
    expect(popup.location.href).toBe(AUTHORIZATION_URL);
    expect(drive.oauthRequests).toStrictEqual([
      {
        account: {
          intent: "reconnect",
          connectionId: SELECTED_DRIVE_CONNECTION_ID,
        },
        authMethod: "oauth",
        callbackTarget: "app",
      },
    ]);
  });
  expect(drive.syncRequests).toHaveLength(1);
  drive.completeAuthorization();
  click(buttonNamed("Download artifact", artifactPreview()));
  await waitFor(() => {
    expect(
      roleItemNamed("menuitem", "Upload to Google Docs"),
    ).not.toHaveAttribute("aria-disabled", "true");
  });
  expect(drive.syncRequests).toHaveLength(1);
  expect(screen.queryByText("Synced to Google Drive")).toBeNull();
  click(roleItemNamed("menuitem", "Upload to Google Docs"));
  await expectSyncCompletedPreview("Upload to Google Drive");
  expect(drive.syncRequests).toStrictEqual(
    Array.from({ length: 2 }, () => {
      return {
        artifactId: DRIVE_ARTIFACT_ID,
        chatThreadId: NAVIGATION_ARTIFACT_THREAD_ID,
        connectionId: SELECTED_DRIVE_CONNECTION_ID,
        mode: "google",
      };
    }),
  );
});

test("Keep one scope reconnect action beside an existing native import", async () => {
  mockWideScreen();
  const popup = installAuthorizationPopup();
  const drive = installDriveMocks(context, "connected", {
    filename: "report.txt",
    contentType: "text/plain",
    selectedAccountReady: true,
    existingMimeType: GOOGLE_WORKSPACE_MIME_TYPES.document,
  });
  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
  });
  await openDriveArtifactMenu("Upload to Google Drive", "report.txt");
  expect(roleItemNamed("menuitem", "Open in Google Docs")).toHaveAttribute(
    "href",
    "https://drive.google.test/file/drive-file-1",
  );
  drive.requireScopeConsent();
  click(roleItemNamed("menuitem", "Upload to Google Drive"));
  await expect(
    screen.findByText(
      "Reconnect Google Drive and allow Drive access before uploading artifacts. No file was uploaded.",
    ),
  ).resolves.toBeInTheDocument();
  click(buttonNamed("Download artifact", artifactPreview()));
  await waitFor(() => {
    expect(
      roleItemNamed("menuitem", "Reconnect Google Drive"),
    ).not.toHaveAttribute("aria-disabled", "true");
  });
  expect(roleItemNamed("menuitem", "Open in Google Docs")).toHaveAttribute(
    "href",
    "https://drive.google.test/file/drive-file-1",
  );
  expect(
    queryAllByRoleFast("menuitem").filter((item) => {
      return item.textContent?.trim() === "Reconnect Google Drive";
    }),
  ).toHaveLength(1);
  click(roleItemNamed("menuitem", "Reconnect Google Drive"));
  await waitFor(() => {
    expect(popup.location.href).toBe(AUTHORIZATION_URL);
    expect(drive.oauthRequests[0]?.account).toStrictEqual({
      intent: "reconnect",
      connectionId: SELECTED_DRIVE_CONNECTION_ID,
    });
  });
  drive.completeAuthorization();
  click(buttonNamed("Download artifact", artifactPreview()));
  await waitFor(() => {
    expect(
      roleItemNamed("menuitem", "Upload to Google Drive"),
    ).not.toHaveAttribute("aria-disabled", "true");
  });
  expect(drive.syncRequests).toHaveLength(1);
  expect(roleItemNamed("menuitem", "Open in Google Docs")).toHaveAttribute(
    "href",
    "https://drive.google.test/file/drive-file-1",
  );
  click(roleItemNamed("menuitem", "Upload to Google Drive"));
  await expectSyncCompletedPreview();
  expect(drive.syncRequests).toHaveLength(2);
  expect(roleItemNamed("menuitem", "Open in Google Docs")).toHaveAttribute(
    "href",
    "https://drive.google.test/file/drive-file-1",
  );
});

test("Dismissed Drive scope recovery never resumes an upload", async () => {
  mockWideScreen();
  const popup = installAuthorizationPopup();
  const drive = installDriveMocks(context, "connected", {
    selectedAccountReady: true,
    uploadError: "scope",
  });
  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
  });
  const { preview, downloadButton } = await openDriveMessageMenu(
    "Upload to Google Drive",
  );
  click(roleItemNamed("menuitem", "Upload to Google Drive"));
  await expect(
    screen.findByText(
      "Reconnect Google Drive and allow Drive access before uploading artifacts. No file was uploaded.",
    ),
  ).resolves.toBeInTheDocument();
  click(downloadButton());
  await waitFor(() => {
    expect(
      roleItemNamed("menuitem", "Reconnect Google Drive"),
    ).not.toHaveAttribute("aria-disabled", "true");
  });
  click(roleItemNamed("menuitem", "Reconnect Google Drive"));
  await waitFor(() => {
    expect(popup.location.href).toBe(AUTHORIZATION_URL);
  });
  click(buttonNamed("Close", preview));
  await waitFor(() => {
    expect(screen.queryAllByRole("dialog", { hidden: true })).toHaveLength(0);
  });
  expect(popup.window.closed).toBeTruthy();
  drive.completeAuthorization();
  await openDriveMessageMenu("Reconnect Google Drive");
  expect(drive.syncRequests).toHaveLength(1);
  expect(screen.queryByText("Synced to Google Drive")).toBeNull();
});

test("Do not offer scope recovery or replay for a generic Drive 403 response", async () => {
  mockWideScreen();
  const popup = installAuthorizationPopup();
  const drive = installDriveMocks(context, "connected", {
    selectedAccountReady: true,
    uploadError: "forbidden",
  });
  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
  });
  await openDriveArtifactMenu("Upload to Google Drive");
  click(roleItemNamed("menuitem", "Upload to Google Drive"));
  await expect(
    screen.findByText("Drive access is unavailable"),
  ).resolves.toBeInTheDocument();
  click(buttonNamed("Download artifact", artifactPreview()));
  await waitFor(() => {
    expect(
      roleItemNamed("menuitem", "Upload to Google Drive"),
    ).not.toHaveAttribute("aria-disabled", "true");
  });
  expect(drive.syncRequests).toHaveLength(1);
  expect(drive.oauthRequests).toHaveLength(0);
  expect(popup.open.calls).toHaveLength(0);
});

test("Sync with the artifact's ready Drive account when the default needs attention", async () => {
  mockWideScreen();
  const drive = installDriveMocks(context, "reconnect-required", {
    selectedAccountReady: true,
  });

  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
  });

  await openDriveArtifactMenu("Upload to Google Drive");
  click(roleItemNamed("menuitem", "Upload to Google Drive"));

  await waitFor(() => {
    expect(drive.syncRequests).toStrictEqual([
      {
        artifactId: DRIVE_ARTIFACT_ID,
        chatThreadId: NAVIGATION_ARTIFACT_THREAD_ID,
        connectionId: SELECTED_DRIVE_CONNECTION_ID,
        mode: "original",
      },
    ]);
  });
  expect(drive.oauthRequests).toHaveLength(0);
  await expectSyncCompletedPreview();
  drive.selectOtherAccount();
  context.mocks.ably.trigger(
    `chatThreadDetailChanged:${NAVIGATION_ARTIFACT_THREAD_ID}`,
  );
  const upload = await waitFor(() => {
    return roleItemNamed("menuitem", "Upload to Google Drive");
  });
  click(upload);
  await waitFor(() => {
    expect(drive.syncRequests[1]).toMatchObject({
      connectionId: NEW_DRIVE_CONNECTION_ID,
      chatThreadId: NAVIGATION_ARTIFACT_THREAD_ID,
    });
  });
});

test("Keep a reopened artifact usable after cancelling the remaining Drive setup", async () => {
  mockWideScreen();
  const popup = installAuthorizationPopup();
  const syncing = context.mocks.deferred<void>();
  const sync = context.mocks.deferred<void>();
  const drive = installDriveMocks(context, "not-connected", {
    waitForSync: () => {
      syncing.resolve();
      return sync.promise;
    },
  });
  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
  });
  click(await findNamedLink("Drive preview"));
  const preview = await screen.findByRole("dialog", {
    name: "drive-report.pdf preview",
  });
  click(buttonNamed("Download options", preview));
  await waitFor(() => {
    expect(
      roleItemNamed("menuitem", "Connect Google Drive"),
    ).not.toHaveAttribute("aria-disabled", "true");
  });
  click(roleItemNamed("menuitem", "Connect Google Drive"));
  await waitFor(() => {
    expect(popup.location.href).toBe(AUTHORIZATION_URL);
    expect(buttonNamed("Download options", preview)).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });
  drive.completeAuthorization();
  await syncing.promise;
  click(buttonNamed("Close", preview));
  await waitFor(() => {
    expect(screen.queryAllByRole("dialog", { hidden: true })).toHaveLength(0);
  });

  click(await findNamedLink("Drive preview"));
  const reopened = await screen.findByRole("dialog", {
    name: "drive-report.pdf preview",
  });
  await waitFor(() => {
    expect(buttonNamed("Download options", reopened)).toBeEnabled();
  });
  expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(1);
  expect(popup.window.closed).toBeTruthy();
  click(buttonNamed("Download options", reopened));
  await waitFor(() => {
    expect(
      roleItemNamed("menuitem", "Connect Google Drive"),
    ).not.toHaveAttribute("aria-disabled", "true");
  });
  await userEvent.setup().keyboard("{Escape}");

  sync.resolve();
  expect(screen.queryByText("Synced to Google Drive")).toBeNull();
  expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(1);
  expect(buttonNamed("Download options", reopened)).toBeEnabled();
});

test.each([false, true])(
  "Reuse the artifact preview for Drive OAuth (dismissed: %s)",
  async (cancelled) => {
    mockWideScreen();
    const user = userEvent.setup();
    const popup = installAuthorizationPopup();
    const drive = installDriveMocks(context, "not-connected");
    await setupPage({
      context,
      path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
      host: "app.okou.ai",
    });
    await user.click(await findNamedLink("Drive preview"));
    const preview = await screen.findByRole("dialog", {
      name: "drive-report.pdf preview",
    });
    await user.click(buttonNamed("Download options", preview));
    await waitFor(() => {
      expect(
        roleItemNamed("menuitem", "Connect Google Drive"),
      ).not.toHaveAttribute("aria-disabled", "true");
    });
    await user.click(roleItemNamed("menuitem", "Connect Google Drive"));
    await waitFor(() => {
      expect(buttonNamed("Download options", preview)).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    });
    expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(1);
    expect(buttonNamed("Close", preview)).toBeEnabled();
    await waitFor(() => {
      expect(popup.location.href).toBe(AUTHORIZATION_URL);
    });

    if (cancelled) {
      await user.click(buttonNamed("Close", preview));
    }
    await waitFor(() => {
      expect(screen.queryAllByRole("dialog", { hidden: true })).toHaveLength(
        cancelled ? 0 : 1,
      );
    });
    expect(popup.window.closed).toBe(cancelled);

    drive.completeAuthorization();
    expect(screen.queryByText("Synced to Google Drive")).toBeNull();
    if (cancelled) {
      return;
    }
    await expect(
      screen.findByText("Synced to Google Drive"),
    ).resolves.toBeInTheDocument();
    await user.click(buttonNamed("Download options", preview));
    await waitFor(() => {
      expect(
        roleItemNamed("menuitem", "Upload to Google Drive"),
      ).not.toHaveAttribute("aria-disabled", "true");
    });
    expect(drive.syncRequests).toStrictEqual([
      {
        artifactId: DRIVE_ARTIFACT_ID,
        chatThreadId: NAVIGATION_ARTIFACT_THREAD_ID,
        connectionId: NEW_DRIVE_CONNECTION_ID,
        mode: "original",
      },
    ]);
    await waitFor(() => {
      expect(
        queryAllByRoleFast("button").filter((button) => {
          return button.getAttribute("aria-label") === "Download options";
        }),
      ).toHaveLength(1);
    });
    expect(screen.queryAllByRole("dialog", { hidden: true })).toHaveLength(1);
    expect(roleItemNamed("menuitem", "Download")).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  },
);

describe("google editor conversion", () => {
  it("keeps the Slides editor link when a subsequent original upload fails", async () => {
    mockWideScreen();
    const drive = installDriveMocks(context, "connected", {
      filename: "deck.pptx",
      contentType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      selectedAccountReady: true,
      failingMode: "original",
    });
    await setupPage({
      context,
      path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
      host: "app.okou.ai",
      featureSwitches: { [FeatureSwitchKey.GoogleSlidesConversion]: true },
    });

    await openDriveArtifactMenu("Upload to Google Slides", "deck.pptx");
    click(roleItemNamed("menuitem", "Upload to Google Slides"));
    await expectSyncCompletedPreview("Upload to Google Drive");
    expect(roleItemNamed("menuitem", "Open in Google Slides")).toHaveAttribute(
      "href",
      "https://drive.google.test/file/drive-file-1",
    );
    click(roleItemNamed("menuitem", "Upload to Google Drive"));
    await expect(
      screen.findByText("Drive upload failed"),
    ).resolves.toBeInTheDocument();
    click(buttonNamed("Download artifact", artifactPreview()));
    await waitFor(() => {
      expect(
        roleItemNamed("menuitem", "Open in Google Slides"),
      ).toHaveAttribute("href", "https://drive.google.test/file/drive-file-1");
    });
    expect(
      queryAllByRoleFast("menuitem").find((item) => {
        return item.textContent?.trim() === "Upload to Google Slides";
      }),
    ).toBeUndefined();
    expect(
      drive.syncRequests.map((request) => {
        return request.mode;
      }),
    ).toStrictEqual(["google", "original"]);
  });

  it("reuses a reconnected Drive account for both upload modes in the same preview", async () => {
    mockWideScreen();
    const popup = installAuthorizationPopup();
    const drive = installDriveMocks(context, "reconnect-required", {
      filename: "report.txt",
      contentType: "text/plain",
    });
    await setupPage({
      context,
      path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
      host: "app.okou.ai",
    });

    await openDriveArtifactMenu("Upload to Google Docs", "report.txt");
    click(roleItemNamed("menuitem", "Upload to Google Docs"));
    const expectedOauthRequests = [
      {
        account: {
          intent: "reconnect",
          connectionId: SELECTED_DRIVE_CONNECTION_ID,
        },
        authMethod: "oauth",
        callbackTarget: "app",
      },
    ];
    await waitFor(() => {
      expect(popup.open.calls).toHaveLength(1);
      expect(popup.location.href).toBe(AUTHORIZATION_URL);
      expect(drive.oauthRequests).toStrictEqual(expectedOauthRequests);
    });
    expect(drive.syncRequests).toHaveLength(0);
    drive.completeAuthorization();

    const expectedSyncRequests: DriveMockControl["syncRequests"][number][] = [];
    for (const mode of ["google", "original"] as const) {
      expectedSyncRequests.push({
        artifactId: DRIVE_ARTIFACT_ID,
        chatThreadId: NAVIGATION_ARTIFACT_THREAD_ID,
        connectionId: SELECTED_DRIVE_CONNECTION_ID,
        mode,
      });
      await waitFor(() => {
        expect(drive.syncRequests).toStrictEqual(expectedSyncRequests);
      });
      expect(popup.open.calls).toHaveLength(1);
      expect(drive.oauthRequests).toStrictEqual(expectedOauthRequests);
      await expectSyncCompletedPreview(
        mode === "google" ? "Upload to Google Drive" : "Synced to Google Drive",
      );
      expect(artifactPreview()).toBeInTheDocument();
      expect(roleItemNamed("menuitem", "Open in Google Docs")).toHaveAttribute(
        "href",
        "https://drive.google.test/file/drive-file-1",
      );
      if (mode === "google") {
        click(roleItemNamed("menuitem", "Upload to Google Drive"));
      }
    }
    expect(popup.open.calls).toHaveLength(1);
    expect(drive.oauthRequests).toStrictEqual(expectedOauthRequests);
  });

  it.each([
    {
      filename: "table.csv",
      contentType: "text/csv",
      app: "Sheets",
      target: "spreadsheet",
    },
    {
      filename: "deck.pptx",
      contentType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      app: "Slides",
      target: "presentation",
    },
  ] as const)(
    "replaces the $app upload action with its editor link without refreshing the preview",
    async ({ filename, contentType, app, target }) => {
      const telemetry = context.mocks.posthog();
      mockWideScreen();
      const drive = installDriveMocks(context, "connected", {
        filename,
        contentType,
        selectedAccountReady: true,
        existingMimeType: contentType,
      });
      await setupPage({
        context,
        path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
        host: "app.okou.ai",
        featureSwitches: {
          [FeatureSwitchKey.GoogleSlidesConversion]: app === "Slides",
        },
      });
      await openDriveArtifactMenu(`Upload to Google ${app}`, filename);
      click(roleItemNamed("menuitem", `Upload to Google ${app}`));
      await waitFor(() => {
        expect(drive.syncRequests).toStrictEqual([
          {
            artifactId: DRIVE_ARTIFACT_ID,
            chatThreadId: NAVIGATION_ARTIFACT_THREAD_ID,
            connectionId: SELECTED_DRIVE_CONNECTION_ID,
            mode: "google",
          },
        ]);
      });
      await screen.findAllByText("Synced to Google Drive");
      await waitFor(() => {
        expect(
          buttonNamed("Download artifact", artifactPreview()),
        ).toBeEnabled();
        expect(
          buttonNamed("Download artifact", artifactPreview()),
        ).toHaveAttribute("aria-expanded", "false");
      });
      click(buttonNamed("Download artifact", artifactPreview()));
      await waitFor(() => {
        expect(
          roleItemNamed("menuitem", `Open in Google ${app}`),
        ).toHaveAttribute(
          "href",
          "https://drive.google.test/file/drive-file-1",
        );
      });
      expect(
        roleItemNamed("menuitem", "Synced to Google Drive"),
      ).toHaveAttribute("aria-disabled", "true");
      expect(
        queryAllByRoleFast("menuitem").filter((item) => {
          return item.textContent?.trim() === `Upload to Google ${app}`;
        }),
      ).toHaveLength(0);
      expect(roleItemNamed("menuitem", "Download")).not.toHaveAttribute(
        "aria-disabled",
        "true",
      );
      expect(drive.syncRequests).toHaveLength(1);
      expect(artifactActions(telemetry)).toStrictEqual([
        { action: "google_drive_sync", surface: "page", target },
      ]);
    },
  );

  it("uploads a PPTX unchanged while its Slides conversion is available", async () => {
    mockWideScreen();
    const drive = installDriveMocks(context, "connected", {
      filename: "deck.pptx",
      contentType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      selectedAccountReady: true,
      existingMimeType: GOOGLE_WORKSPACE_MIME_TYPES.presentation,
    });
    await setupPage({
      context,
      path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
      host: "app.okou.ai",
      featureSwitches: {
        [FeatureSwitchKey.GoogleSlidesConversion]: true,
      },
    });
    await openDriveArtifactMenu("Upload to Google Drive", "deck.pptx");
    click(roleItemNamed("menuitem", "Upload to Google Drive"));
    await waitFor(() => {
      expect(drive.syncRequests).toStrictEqual([
        {
          artifactId: DRIVE_ARTIFACT_ID,
          chatThreadId: NAVIGATION_ARTIFACT_THREAD_ID,
          connectionId: SELECTED_DRIVE_CONNECTION_ID,
          mode: "original",
        },
      ]);
    });
    await expectSyncCompletedPreview();
    expect(roleItemNamed("menuitem", "Open in Google Slides")).toHaveAttribute(
      "href",
      "https://drive.google.test/file/drive-file-1",
    );
  });

  it("connects Drive from the document preview dialog and exposes the converted file without refreshing its snapshot", async () => {
    const popup = installAuthorizationPopup();
    const drive = installDriveMocks(context, "not-connected", {
      filename: "report.txt",
      contentType: "text/plain",
    });
    await setupPage({
      context,
      path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
      host: "app.okou.ai",
    });
    click(await findNamedLink("Drive preview"));
    const preview = await screen.findByRole("dialog", {
      name: "report.txt preview",
    });
    click(buttonNamed("Download options", preview));
    await waitFor(() => {
      expect(
        roleItemNamed("menuitem", "Upload to Google Docs"),
      ).not.toHaveAttribute("aria-disabled", "true");
    });
    click(roleItemNamed("menuitem", "Upload to Google Docs"));
    await waitFor(() => {
      expect(popup.location.href).toBe(AUTHORIZATION_URL);
    });
    drive.completeAuthorization();
    await waitFor(() => {
      expect(drive.syncRequests).toStrictEqual([
        {
          artifactId: DRIVE_ARTIFACT_ID,
          chatThreadId: NAVIGATION_ARTIFACT_THREAD_ID,
          connectionId: NEW_DRIVE_CONNECTION_ID,
          mode: "google",
        },
      ]);
    });
    await expect(
      screen.findByText("Synced to Google Drive"),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(buttonNamed("Download options", preview)).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    });
    click(buttonNamed("Download options", preview));
    await waitFor(() => {
      expect(roleItemNamed("menuitem", "Open in Google Docs")).toHaveAttribute(
        "href",
        "https://drive.google.test/file/drive-file-1",
      );
    });
    expect(preview).toBeInTheDocument();
    expect(
      queryAllByRoleFast("menuitem").find((item) => {
        return item.textContent?.trim() === "Upload to Google Docs";
      }),
    ).toBeUndefined();
    expect(
      queryAllByRoleFast("menuitem").find((item) => {
        return item.textContent?.trim() === "Synced to Google Drive";
      }),
    ).toBeUndefined();
  });

  it("does not mark an unconverted response as a successful native document", async () => {
    mockWideScreen();
    installDriveMocks(context, "connected", {
      filename: "report.txt",
      contentType: "text/plain",
      selectedAccountReady: true,
      returnOriginal: true,
    });
    await setupPage({
      context,
      path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
      host: "app.okou.ai",
    });
    await openDriveArtifactMenu("Upload to Google Docs", "report.txt");
    click(roleItemNamed("menuitem", "Upload to Google Docs"));
    await waitFor(() => {
      expect(
        screen.getByText(
          "Google conversion could not be confirmed. Check Drive before retrying.",
        ),
      ).toBeInTheDocument();
    });
  });
});
