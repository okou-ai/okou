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
import {
  userBuiltinConnectorsContract,
  type UserBuiltinConnectorUpdate,
} from "@okouai/api-contracts/contracts/user-connectors";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { expect, test, describe, it } from "vitest";

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
  NAVIGATION_ARTIFACT_AGENT_ID,
  NAVIGATION_ARTIFACT_RUN_ID,
  NAVIGATION_ARTIFACT_THREAD_ID,
  roleItemNamed,
} from "./chat-navigation-artifact-test-helpers.ts";

const context = testContext();

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
  readonly agentId?: string;
  readonly authMethod: string;
  readonly authorizeAgent?: true;
  readonly callbackTarget?: "app";
}

interface DriveMockControl {
  readonly authorizationUpdates: readonly UserBuiltinConnectorUpdate[];
  readonly completeAuthorization: () => void;
  readonly requireNewConnection: () => void;
  readonly oauthRequests: readonly OauthRequest[];
  readonly syncRequests: readonly {
    readonly artifactId: string;
    readonly agentId: string;
    readonly connectionId?: string;
    readonly mode: GoogleDriveUploadMode;
  }[];
}

interface DriveMockOptions {
  readonly driveMetadata?: "omitted" | "unavailable";
  readonly filename?: string;
  readonly contentType?: string;
  readonly existingMimeType?: string;
  readonly returnOriginal?: boolean;
  readonly selectedAccountReady?: boolean;
  readonly agentAuthorized?: boolean;
  readonly waitForSync?: (mode: GoogleDriveUploadMode) => Promise<void>;
  readonly failingMode?: GoogleDriveUploadMode;
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
  let selectedAccountReady = options.selectedAccountReady ?? false;
  let agentAuthorized = options.agentAuthorized ?? false;
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
  const authorizationUpdates: UserBuiltinConnectorUpdate[] = [];
  const oauthRequests: OauthRequest[] = [];
  const syncRequests: {
    artifactId: string;
    agentId: string;
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
    if (options.driveMetadata === "omitted") {
      return {};
    }
    return {
      googleDriveConnectionId: SELECTED_DRIVE_CONNECTION_ID,
      googleDriveSync:
        options.driveMetadata === "unavailable"
          ? { status: "disconnected", recovery: { action: "unavailable" } }
          : artifactSynced
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
                        : { action: "authorize" },
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
      expect(chatThreadId).toBe(NAVIGATION_ARTIFACT_THREAD_ID);
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
  targetContext.mocks.api(userBuiltinConnectorsContract.get, ({ respond }) => {
    return respond(200, {
      enabledConnectorSlugs: agentAuthorized ? ["google-drive"] : [],
    });
  });
  targetContext.mocks.api(
    userBuiltinConnectorsContract.update,
    ({ body, respond }) => {
      authorizationUpdates.push(body);
      agentAuthorized = true;
      return respond(200, { enabledConnectorSlugs: ["google-drive"] });
    },
  );
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
    artifactGoogleDriveContract.uploadWithMode,
    async ({ params, body, respond }) => {
      syncRequests.push({ artifactId: params.artifactId, ...body });
      await options.waitForSync?.(body.mode);
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
    authorizationUpdates,
    completeAuthorization: () => {
      completedAttempts.set(oauthAttemptId, oauthConnectionId);
      connectionState = "connected";
      agentAuthorized = true;
      targetContext.mocks.ably.trigger("connector:changed", {
        connectorSlug: "google-drive",
      });
    },
    requireNewConnection: () => {
      connectionState = "not-connected";
      artifactConnectionState = "not-connected";
      selectedAccountReady = false;
      agentAuthorized = false;
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

function artifactList(): HTMLElement {
  return screen.getByTestId("thread-sidebar-artifacts");
}

function artifactPreview(): HTMLElement {
  return screen.getByTestId("artifact-sidebar");
}

async function openDriveArtifactDownloadMenu(
  filename = "Drive report.pdf",
): Promise<void> {
  await waitFor(() => {
    expect(buttonNamed("Open artifacts")).toBeEnabled();
  });
  click(buttonNamed("Open artifacts"));
  await waitFor(() => {
    expect(buttonNamed(`Preview ${filename}`, artifactList())).toBeEnabled();
  });
  click(buttonNamed(`Preview ${filename}`, artifactList()));
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
  },
  {
    action: "Upload to Google Docs",
    url: "https://docs.google.test/document/d/converted-report/edit",
  },
])(
  "Offer a link to the uploaded file after $action",
  async ({ action, url }) => {
    mockWideScreen();
    installDriveMocks(context, "connected", {
      filename: "report.txt",
      contentType: "text/plain",
      selectedAccountReady: true,
      uploadedWebViewLink: url,
    });
    await setupPage({
      context,
      path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
      host: "app.okou.ai",
      featureSwitches: { [FeatureSwitchKey.GoogleDocsSheetsConversion]: true },
    });

    await openDriveArtifactMenu(action, "report.txt");
    click(roleItemNamed("menuitem", action));

    const link = await findNamedLink("View it");
    expect(link).toHaveAttribute("href", url);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
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

test.each(["available", "unavailable"] as const)(
  "Authorize and sync an artifact when unrelated Drive metadata is %s",
  async (metadata) => {
    mockWideScreen();
    const drive = installDriveMocks(context, "connected");
    const browser = context.mocks.browser.blobDownload();
    if (metadata === "unavailable") {
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
    }

    await setupPage({
      context,
      path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
      host: "app.okou.ai",
    });

    await openDriveArtifactMenu();
    click(roleItemNamed("menuitem", "Connect Google Drive"));

    await waitFor(() => {
      expect(drive.authorizationUpdates).toStrictEqual([
        {
          enabledConnectorSlugs: ["google-drive"],
          operation: "add",
        },
      ]);
      expect(drive.syncRequests).toStrictEqual([
        {
          artifactId: DRIVE_ARTIFACT_ID,
          agentId: NAVIGATION_ARTIFACT_AGENT_ID,
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
  },
);

test.each(["omitted", "unavailable"] as const)(
  "Keep artifact download available when Drive metadata is %s",
  async (driveMetadata) => {
    mockWideScreen();
    installDriveMocks(context, "connected", { driveMetadata });
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
  },
);

test.each(["original", "google"] as const)(
  "Recheck Drive authorization after leaving and reopening the chat page (%s)",
  async (mode) => {
    mockWideScreen();
    const popup = installAuthorizationPopup();
    const native = mode === "google";
    const uploadLabel = native
      ? "Upload to Google Slides"
      : "Upload to Google Drive";
    const recoveryLabel = native
      ? "Upload to Google Slides"
      : "Connect Google Drive";
    const drive = installDriveMocks(context, "connected", {
      selectedAccountReady: true,
      agentAuthorized: true,
      ...(native
        ? {
            filename: "deck.pptx",
            contentType:
              "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          }
        : {}),
    });
    await setupPage({
      context,
      path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
      host: "app.okou.ai",
      featureSwitches: { [FeatureSwitchKey.GoogleSlidesConversion]: native },
    });

    const initial = await openDriveMessageMenu(uploadLabel);
    click(roleItemNamed("menuitem", uploadLabel));
    const successMessages = await screen.findAllByText(
      "Synced to Google Drive",
    );
    expect(successMessages.length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(initial.downloadButton()).toBeEnabled();
      expect(initial.downloadButton()).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    });
    expect(drive.syncRequests).toStrictEqual([
      {
        artifactId: DRIVE_ARTIFACT_ID,
        agentId: NAVIGATION_ARTIFACT_AGENT_ID,
        connectionId: SELECTED_DRIVE_CONNECTION_ID,
        mode,
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

    const recovered = await openDriveMessageMenu(recoveryLabel);
    expect(recovered.preview).toBeInTheDocument();
    click(roleItemNamed("menuitem", recoveryLabel));
    await waitFor(() => {
      expect(popup.location.href).toBe(AUTHORIZATION_URL);
      expect(drive.oauthRequests).toContainEqual({
        account: { intent: "add" },
        authMethod: "oauth",
        agentId: NAVIGATION_ARTIFACT_AGENT_ID,
        authorizeAgent: true,
        callbackTarget: "app",
      });
    });
    drive.completeAuthorization();
    await waitFor(() => {
      expect(drive.syncRequests).toContainEqual({
        artifactId: DRIVE_ARTIFACT_ID,
        agentId: NAVIGATION_ARTIFACT_AGENT_ID,
        connectionId: NEW_DRIVE_CONNECTION_ID,
        mode,
      });
    });
    await expectSyncCompletedPreview(
      native ? "Open in Google Slides" : "Upload to Google Drive",
      recovered.downloadButton,
    );
  },
);

test("Connect Google Drive and sync an artifact", async () => {
  mockWideScreen();
  const authorizationPopup = installAuthorizationPopup();
  const drive = installDriveMocks(context, "not-connected");

  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
  });

  await openDriveArtifactMenu();
  click(roleItemNamed("menuitem", "Connect Google Drive"));

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
        agentId: NAVIGATION_ARTIFACT_AGENT_ID,
        authorizeAgent: true,
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
        agentId: NAVIGATION_ARTIFACT_AGENT_ID,
        connectionId: NEW_DRIVE_CONNECTION_ID,
        mode: "original",
      },
    ]);
  });
  await expectSyncCompletedPreview();
});

test("Reconnect the Google Drive account selected for the artifact", async () => {
  mockWideScreen();
  const authorizationPopup = installAuthorizationPopup();
  const drive = installDriveMocks(context, "reconnect-required");

  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
  });

  await openDriveArtifactMenu();
  click(roleItemNamed("menuitem", "Connect Google Drive"));

  await waitFor(() => {
    expect(authorizationPopup.open.calls).toHaveLength(1);
    expect(authorizationPopup.open.calls[0]).toMatchObject({
      target: "_blank",
      features: "width=600,height=700",
    });
    expect(drive.oauthRequests).toStrictEqual([
      {
        account: {
          intent: "reconnect",
          connectionId: SELECTED_DRIVE_CONNECTION_ID,
        },
        authMethod: "oauth",
        agentId: NAVIGATION_ARTIFACT_AGENT_ID,
        authorizeAgent: true,
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
        agentId: NAVIGATION_ARTIFACT_AGENT_ID,
        connectionId: SELECTED_DRIVE_CONNECTION_ID,
        mode: "original",
      },
    ]);
  });
  await expectSyncCompletedPreview();
});

test("Sync with the artifact's ready Drive account when the default needs attention", async () => {
  mockWideScreen();
  const drive = installDriveMocks(context, "reconnect-required", {
    selectedAccountReady: true,
    agentAuthorized: true,
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
        agentId: NAVIGATION_ARTIFACT_AGENT_ID,
        connectionId: SELECTED_DRIVE_CONNECTION_ID,
        mode: "original",
      },
    ]);
  });
  expect(drive.oauthRequests).toHaveLength(0);
  expect(drive.authorizationUpdates).toHaveLength(0);
  await expectSyncCompletedPreview();
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

test.each([
  { state: "not-connected", dismiss: null },
  { state: "reconnect-required", dismiss: null },
  { state: "not-connected", dismiss: "Close" },
] as const)(
  "Reuse the artifact preview for Drive OAuth ($state, dismissal: $dismiss)",
  async ({ state, dismiss }) => {
    mockWideScreen();
    const user = userEvent.setup();
    const popup = installAuthorizationPopup();
    const drive = installDriveMocks(context, state);
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

    if (dismiss) {
      await user.click(buttonNamed("Close", preview));
    }
    const cancelled = dismiss !== null;
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
        agentId: NAVIGATION_ARTIFACT_AGENT_ID,
        connectionId:
          state === "not-connected"
            ? NEW_DRIVE_CONNECTION_ID
            : SELECTED_DRIVE_CONNECTION_ID,
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

  it.each([
    {
      state: "not-connected",
      account: { intent: "add" },
      connectionId: NEW_DRIVE_CONNECTION_ID,
    },
    {
      state: "reconnect-required",
      account: {
        intent: "reconnect",
        connectionId: SELECTED_DRIVE_CONNECTION_ID,
      },
      connectionId: SELECTED_DRIVE_CONNECTION_ID,
    },
  ] as const)(
    "reuses the recovered $state account for another upload mode in the same preview",
    async ({ state, account, connectionId }) => {
      mockWideScreen();
      const popup = installAuthorizationPopup();
      const drive = installDriveMocks(context, state, {
        filename: "report.txt",
        contentType: "text/plain",
      });
      await setupPage({
        context,
        path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
        host: "app.okou.ai",
        featureSwitches: {
          [FeatureSwitchKey.GoogleDocsSheetsConversion]: true,
        },
      });

      await openDriveArtifactMenu("Upload to Google Docs", "report.txt");
      click(roleItemNamed("menuitem", "Upload to Google Docs"));
      const expectedOauthRequests = [
        {
          account,
          authMethod: "oauth",
          agentId: NAVIGATION_ARTIFACT_AGENT_ID,
          authorizeAgent: true,
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

      const expectedSyncRequests: DriveMockControl["syncRequests"][number][] =
        [];
      for (const mode of ["google", "original"] as const) {
        expectedSyncRequests.push({
          artifactId: DRIVE_ARTIFACT_ID,
          agentId: NAVIGATION_ARTIFACT_AGENT_ID,
          connectionId,
          mode,
        });
        await waitFor(() => {
          expect(drive.syncRequests).toStrictEqual(expectedSyncRequests);
        });
        expect(popup.open.calls).toHaveLength(1);
        expect(drive.oauthRequests).toStrictEqual(expectedOauthRequests);
        await expectSyncCompletedPreview(
          mode === "google"
            ? "Upload to Google Drive"
            : "Synced to Google Drive",
        );
        expect(artifactPreview()).toBeInTheDocument();
        expect(
          roleItemNamed("menuitem", "Open in Google Docs"),
        ).toHaveAttribute(
          "href",
          "https://drive.google.test/file/drive-file-1",
        );
        if (mode === "google") {
          click(roleItemNamed("menuitem", "Upload to Google Drive"));
        }
      }
      expect(popup.open.calls).toHaveLength(1);
      expect(drive.oauthRequests).toStrictEqual(expectedOauthRequests);
    },
  );

  it.each([
    {
      filename: "report.docx",
      contentType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      app: "Docs",
    },
    {
      filename: "table.csv",
      contentType: "text/csv",
      app: "Sheets",
    },
    {
      filename: "deck.pptx",
      contentType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      app: "Slides",
    },
  ] as const)(
    "replaces the $app upload action with its editor link without refreshing the preview",
    async ({ filename, contentType, app }) => {
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
          [FeatureSwitchKey.GoogleDocsSheetsConversion]: app !== "Slides",
          [FeatureSwitchKey.GoogleSlidesConversion]: app === "Slides",
        },
      });
      await openDriveArtifactMenu(`Upload to Google ${app}`, filename);
      click(roleItemNamed("menuitem", `Upload to Google ${app}`));
      await waitFor(() => {
        expect(drive.syncRequests).toStrictEqual([
          {
            artifactId: DRIVE_ARTIFACT_ID,
            agentId: NAVIGATION_ARTIFACT_AGENT_ID,
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
    },
  );

  it.each([
    { filename: "report.txt", contentType: "text/plain", enabled: false },
    { filename: "script.py", contentType: "text/plain", enabled: true },
    { filename: "report.pdf", contentType: "application/pdf", enabled: true },
  ])(
    "keeps $filename on the original upload path when conversion is unavailable",
    async ({ filename, contentType, enabled }) => {
      mockWideScreen();
      const drive = installDriveMocks(context, "connected", {
        filename,
        contentType,
        selectedAccountReady: true,
      });
      await setupPage({
        context,
        path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
        host: "app.okou.ai",
        featureSwitches: {
          [FeatureSwitchKey.GoogleDocsSheetsConversion]: enabled,
        },
      });
      await openDriveArtifactMenu("Upload to Google Drive", filename);
      click(roleItemNamed("menuitem", "Upload to Google Drive"));
      await waitFor(() => {
        expect(drive.syncRequests).toHaveLength(1);
      });
      expect(drive.syncRequests[0]).toHaveProperty("mode", "original");
    },
  );

  it.each([
    { filename: "report.txt", contentType: "text/plain", slides: false },
    {
      filename: "deck.pptx",
      contentType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      slides: true,
    },
  ])(
    "uploads $filename unchanged while native conversion is enabled",
    async ({ filename, contentType, slides }) => {
      mockWideScreen();
      const drive = installDriveMocks(context, "connected", {
        filename,
        contentType,
        selectedAccountReady: true,
        existingMimeType:
          GOOGLE_WORKSPACE_MIME_TYPES[slides ? "presentation" : "document"],
      });
      await setupPage({
        context,
        path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
        host: "app.okou.ai",
        featureSwitches: {
          [FeatureSwitchKey.GoogleDocsSheetsConversion]: !slides,
          [FeatureSwitchKey.GoogleSlidesConversion]: slides,
        },
      });
      await openDriveArtifactMenu("Upload to Google Drive", filename);
      click(roleItemNamed("menuitem", "Upload to Google Drive"));
      await waitFor(() => {
        expect(drive.syncRequests).toStrictEqual([
          {
            artifactId: DRIVE_ARTIFACT_ID,
            agentId: NAVIGATION_ARTIFACT_AGENT_ID,
            connectionId: SELECTED_DRIVE_CONNECTION_ID,
            mode: "original",
          },
        ]);
      });
      await expectSyncCompletedPreview();
      expect(
        roleItemNamed(
          "menuitem",
          `Open in Google ${slides ? "Slides" : "Docs"}`,
        ),
      ).toHaveAttribute("href", "https://drive.google.test/file/drive-file-1");
    },
  );

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
      featureSwitches: { [FeatureSwitchKey.GoogleDocsSheetsConversion]: true },
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
          agentId: NAVIGATION_ARTIFACT_AGENT_ID,
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
      featureSwitches: { [FeatureSwitchKey.GoogleDocsSheetsConversion]: true },
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
