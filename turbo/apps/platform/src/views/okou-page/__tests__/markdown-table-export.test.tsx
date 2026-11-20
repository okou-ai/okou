import type { ArtifactDetail } from "@okouai/api-contracts/contracts/artifact-catalog";
import { artifactGoogleDriveContract } from "@okouai/api-contracts/contracts/artifact-google-drive";
import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import {
  connectorAccountsContract,
  type ConnectorAccountConnection,
  type ConnectorAccountMutationIntent,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { builtinConnectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { artifactReferencePath } from "@okouai/api-contracts/validators/artifact-references";
import {
  GOOGLE_WORKSPACE_MIME_TYPES,
  type GoogleDriveUploadMode,
} from "@okouai/core/google-workspace-conversion";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { strFromU8, unzipSync } from "fflate";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockOAuthCompletions } from "./connector-page-test-helpers.ts";
import {
  artifactSummary,
  buttonNamed,
  fileArtifactDetail,
  googleDriveCatalogItem,
  mockArtifactConversation,
  NAVIGATION_ARTIFACT_RUN_ID,
  NAVIGATION_ARTIFACT_THREAD_ID,
  roleItemNamed,
} from "./chat-navigation-artifact-test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";

vi.hoisted(() => {
  // Product analytics resolves the deployment environment at module load.
  window.location.href = "https://app.okou.ai/";
});

const context = testContext();

const SELECTED_CONNECTION_ID = "d0000000-0000-4000-a000-000000000951";
const NEW_CONNECTION_ID = "d0000000-0000-4000-a000-000000000952";
const AUTHORIZATION_URL = "https://accounts.google.test/authorize-table";
const SPREADSHEET_MIME_TYPE = GOOGLE_WORKSPACE_MIME_TYPES.spreadsheet;
const WORKBOOK_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const PLAN_TABLE = ["| Plan | Price |", "| --- | --- |", "| Pro | 20 |"].join(
  "\n",
);
const TEAM_TABLE = [
  "| Member | Role |",
  "| --- | --- |",
  "| Ada | Owner |",
].join("\n");

type DriveAccountState = "ready" | "connect" | "reconnect";

interface DriveUploadOutcome {
  readonly status?: 200 | 503;
  readonly webViewLink?: string | null;
  readonly mimeType?: string;
  readonly message?: string;
}

interface TableSaveOptions {
  readonly accountState?: DriveAccountState;
  readonly uploadStatuses?: readonly number[];
  readonly holdUpload?: Promise<void>;
  readonly driveOutcomes?: readonly DriveUploadOutcome[];
}

interface DriveSyncRequest {
  readonly artifactId: string;
  readonly connectionId?: string;
  readonly mode: GoogleDriveUploadMode;
}

function linkFor(artifactId: string, mode: GoogleDriveUploadMode, n = 1) {
  return `https://drive.google.test/${artifactId}/${mode}/${n}`;
}

function tableEvents(tables: readonly string[]): MockChatEventInput[] {
  return [
    {
      id: "table-message",
      role: "assistant",
      content: tables.join("\n\nAnd another table:\n\n"),
      runId: NAVIGATION_ARTIFACT_RUN_ID,
      runEventId: "table-event",
      sequenceNumber: 1,
      createdAt: "2026-09-01T12:00:00.000Z",
    },
    {
      id: "table-run-completed",
      role: "assistant",
      content: null,
      runId: NAVIGATION_ARTIFACT_RUN_ID,
      runLifecycleEvent: "completed",
      createdAt: "2026-09-01T12:00:01.000Z",
    },
  ];
}

function mockTables(tables: readonly string[]): void {
  mockArtifactConversation(context, {
    catalog: [],
    getDetail: () => {
      return null;
    },
    chatEvents: tableEvents(tables),
  });
}

/**
 * Upload, artifact reference, artifact detail, Drive account and Drive upload
 * boundaries for saving inline tables. Each table upload becomes an artifact.
 */
function mockTableSaves(
  tables: readonly string[],
  options: TableSaveOptions = {},
) {
  const completedAttempts = mockOAuthCompletions(context);
  let accountState: DriveAccountState = options.accountState ?? "ready";
  let connectionId = SELECTED_CONNECTION_ID;
  let oauthAttemptId = "";
  const uploadStatuses = [...(options.uploadStatuses ?? [])];
  const driveOutcomes = [...(options.driveOutcomes ?? [])];
  const uploadedArtifacts: string[] = [];
  const syncRequests: DriveSyncRequest[] = [];
  const oauthRequests: ConnectorAccountMutationIntent[] = [];
  const syncCounts = new Map<string, number>();
  const artifactsByReference = new Map<string, string>();
  const synced = new Set<string>();

  context.mocks.api(uploadsContract.preparePrivate, ({ body, respond }) => {
    const id = crypto.randomUUID();
    const reference = artifactReferencePath(id, body.filename);
    artifactsByReference.set(
      reference.slice("/artifacts/".length),
      crypto.randomUUID(),
    );
    return respond(200, {
      id,
      filename: body.filename,
      contentType: body.contentType,
      size: body.size,
      url: reference,
      uploadUrl: `https://uploads.example.test/tables/${id}`,
      uploadHeaders: {},
    });
  });
  context.mocks.http.put(
    "https://uploads.example.test/tables/:id",
    async () => {
      await options.holdUpload;
      return new HttpResponse(null, { status: uploadStatuses.shift() ?? 200 });
    },
  );
  context.mocks.api(uploadsContract.complete, ({ body, respond }) => {
    const reference = artifactReferencePath(body.id, "Table.xlsx");
    return respond(200, {
      id: body.id,
      filename: "Table.xlsx",
      contentType: WORKBOOK_MIME_TYPE,
      size: 1,
      url: reference,
    });
  });
  context.mocks.api(
    artifactReferencesContract.ownerArtifact,
    ({ params, respond }) => {
      const artifactId = artifactsByReference.get(params.reference);
      if (!artifactId) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Artifact not found" },
        });
      }
      uploadedArtifacts.push(artifactId);
      return respond(200, { artifactId });
    },
  );

  const driveMetadata = (
    artifactId: string,
  ): Pick<ArtifactDetail, "googleDriveConnectionId" | "googleDriveSync"> => {
    if (accountState === "ready") {
      return {
        googleDriveConnectionId: connectionId,
        googleDriveSync: synced.has(artifactId)
          ? {
              status: "synced",
              accountReady: true,
              id: `drive-${artifactId}`,
              name: "Table.xlsx",
              webViewLink: linkFor(artifactId, "original"),
            }
          : { status: "not_synced", accountReady: true },
      };
    }
    return {
      googleDriveConnectionId: connectionId,
      googleDriveSync: {
        status: "disconnected",
        recovery:
          accountState === "reconnect"
            ? { action: "reconnect", connectionId }
            : { action: "connect" },
      },
    };
  };
  mockArtifactConversation(context, {
    catalog: [],
    getDetail: (artifactId) => {
      if (!uploadedArtifacts.includes(artifactId)) {
        return null;
      }
      const summary = artifactSummary(artifactId, "file", "Table.xlsx");
      return {
        ...fileArtifactDetail(summary, {
          contentType: WORKBOOK_MIME_TYPE,
          fileId: artifactId,
          filename: "Table.xlsx",
          url: `https://cdn.vm7.io/artifacts/tests/tables/${artifactId}.xlsx`,
        }),
        ...driveMetadata(artifactId),
      };
    },
    chatEvents: tableEvents(tables),
  });

  context.mocks.api(connectorCatalogContract.get, ({ params, respond }) => {
    return params.connectorSlug === "google-drive"
      ? respond(200, {
          connector: googleDriveCatalogItem(
            accountState === "connect"
              ? "not-connected"
              : accountState === "reconnect"
                ? "reconnect-required"
                : "connected",
          ),
        })
      : respond(404, {
          error: { code: "NOT_FOUND", message: "Connector not found" },
        });
  });
  context.mocks.api(
    builtinConnectorOauthStartContract.start,
    ({ body, respond }) => {
      oauthRequests.push(body.account);
      oauthAttemptId = crypto.randomUUID();
      return respond(200, {
        authorizationUrl: AUTHORIZATION_URL,
        oauthAttemptId,
        ...(body.account.intent === "add"
          ? { connectionId: NEW_CONNECTION_ID }
          : {}),
      });
    },
  );
  context.mocks.api(
    connectorAccountsContract.connection,
    ({ params, respond }) => {
      const account: ConnectorAccountConnection = {
        id: params.connectionId,
        target: { kind: "builtin", connectorSlug: "google-drive" },
        authMethod: "oauth",
        displayName: "Table account",
        isDefault: true,
        externalId: "drive-table-account",
        externalUsername: "table-owner",
        externalEmail: "table-owner@example.test",
        oauthScopes: ["https://www.googleapis.com/auth/drive.file"],
        connectionStatus:
          accountState === "reconnect" ? "reconnect-required" : "connected",
        missingRequiredFields: [],
        configuredFieldKeys: [],
        reconnectReason:
          accountState === "reconnect"
            ? "authorization_expired_or_revoked"
            : null,
        tokenExpiresAt: null,
        createdAt: "2026-09-01T12:00:00.000Z",
        updatedAt: "2026-09-01T12:02:00.000Z",
      };
      return respond(200, account);
    },
  );
  context.mocks.api(
    artifactGoogleDriveContract.uploadFromChat,
    ({ params, body, respond }) => {
      syncRequests.push({
        artifactId: params.artifactId,
        connectionId: body.connectionId,
        mode: body.mode,
      });
      const key = `${params.artifactId}/${body.mode}`;
      const count = (syncCounts.get(key) ?? 0) + 1;
      syncCounts.set(key, count);
      const outcome = driveOutcomes.shift() ?? {};
      if (outcome.status === 503) {
        return respond(503, {
          error: {
            code: "SERVICE_UNAVAILABLE",
            message:
              outcome.message ?? "Google Drive is temporarily unavailable",
          },
        });
      }
      synced.add(params.artifactId);
      return respond(200, {
        id: `drive-${params.artifactId}`,
        name: "Table.xlsx",
        mimeType:
          outcome.mimeType ??
          (body.mode === "google" ? SPREADSHEET_MIME_TYPE : WORKBOOK_MIME_TYPE),
        webViewLink:
          outcome.webViewLink === undefined
            ? linkFor(params.artifactId, body.mode, count)
            : outcome.webViewLink,
      });
    },
  );

  return {
    oauthRequests,
    syncRequests,
    uploadedArtifacts,
    completeAuthorization: () => {
      connectionId =
        accountState === "connect" ? NEW_CONNECTION_ID : connectionId;
      completedAttempts.set(oauthAttemptId, connectionId);
      accountState = "ready";
      context.mocks.ably.trigger("connector:changed", {
        connectorSlug: "google-drive",
      });
    },
  };
}

async function openChat(tableCount: number): Promise<void> {
  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
  });
  await waitFor(() => {
    expect(tableFooters()).toHaveLength(tableCount);
  });
}

function tableFooters(): HTMLElement[] {
  return [
    ...document.querySelectorAll<HTMLElement>("[data-markdown-ui]"),
  ].filter((footer) => {
    return footer.querySelector("[aria-haspopup]") !== null;
  });
}

function tableFooter(index: number): HTMLElement {
  const footer = tableFooters()[index];
  if (!footer) {
    throw new Error(`Table footer ${index} not found`);
  }
  return footer;
}

function exportControl(index: number): HTMLElement {
  const control =
    tableFooter(index).querySelector<HTMLElement>("[aria-haspopup]");
  if (!control) {
    throw new Error(`Export control ${index} not found`);
  }
  return control;
}

async function chooseExport(index: number, action: string): Promise<void> {
  await waitFor(() => {
    expect(exportControl(index)).toBeEnabled();
    expect(exportControl(index)).toHaveAttribute("aria-expanded", "false");
  });
  click(exportControl(index));
  await waitFor(() => {
    expect(roleItemNamed("menuitem", action)).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
  click(roleItemNamed("menuitem", action));
}

function toastsWith(message: string, type: string): HTMLElement[] {
  return [
    ...document.querySelectorAll<HTMLElement>(
      `[data-sonner-toast][data-type="${type}"]`,
    ),
  ].filter((toast) => {
    return toast.textContent?.includes(message);
  });
}

function viewLinks(container: ParentNode = document.body): HTMLElement[] {
  return queryAllByRoleFast("link", container).filter((link) => {
    return link.textContent?.trim() === "View it";
  });
}

async function expectSavedLink(message: string, href: string): Promise<void> {
  await waitFor(() => {
    const links = toastsWith(message, "success").flatMap((toast) => {
      return viewLinks(toast).map((link) => {
        return link.getAttribute("href");
      });
    });
    expect(links).toContain(href);
  });
}

function tableActions(posthog: ReturnType<typeof context.mocks.posthog>) {
  return posthog.events
    .filter((event) => {
      return event.name === "artifact_action_clicked";
    })
    .map((event) => {
      return event.properties;
    });
}

async function workbookRows(blob: Blob | null | undefined) {
  if (!blob) {
    throw new Error("Expected a workbook download");
  }
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  const sheet = strFromU8(
    files["xl/worksheets/sheet1.xml"] ?? new Uint8Array(),
  );
  const document = new DOMParser().parseFromString(sheet, "application/xml");
  const cells = [...document.getElementsByTagName("c")];
  return {
    rows: [...document.getElementsByTagName("row")].map((row) => {
      return [...row.getElementsByTagName("t")].map((text) => {
        return text.textContent;
      });
    }),
    inlineStrings: cells.filter((cell) => {
      return cell.getAttribute("t") === "inlineStr";
    }).length,
    cells: cells.length,
  };
}

test("A header-only table reports zero data rows and one column", async () => {
  mockTables(["| Name |\n| --- |"]);
  await openChat(1);

  expect(tableFooter(0)).toHaveTextContent("0 rows · 1 column");
  expect(exportControl(0)).toHaveAccessibleName("Export");
  expect(exportControl(0)).toBeEnabled();
});

test("Keyboard activation of footer Export preserves the menu and dismissal focus", async () => {
  mockTables([PLAN_TABLE]);
  await openChat(1);
  const user = userEvent.setup();

  exportControl(0).focus();
  await user.keyboard("{ArrowDown}");

  await waitFor(() => {
    expect(roleItemNamed("menuitem", "Export Excel")).toHaveFocus();
  });
  expect(roleItemNamed("menuitem", "Save to Google Drive")).toBeInTheDocument();
  expect(
    roleItemNamed("menuitem", "Save to Google Sheets"),
  ).toBeInTheDocument();

  await user.keyboard("{Escape}");

  await waitFor(() => {
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
  expect(exportControl(0)).toHaveFocus();
});

test("Each table exports its own real workbook with literal values and source URLs", async () => {
  const profileTable = [
    "| 姓名 | 资料 |",
    "| --- | --- |",
    "| 张三 | [Profile](https://example.test/people/zhang) |",
    "| 00123 | =SUM(A1:A2) |",
  ].join("\n");
  const planTable = ["| Plan | Price |", "| --- | --- |", "| Pro | 20 |"].join(
    "\n",
  );
  mockTables([profileTable, planTable]);
  const posthog = context.mocks.posthog();
  const browser = context.mocks.browser.blobDownload();
  await openChat(2);

  await chooseExport(1, "Export Excel");
  await waitFor(() => {
    expect(browser.downloads).toHaveLength(1);
  });
  await chooseExport(0, "Export Excel");
  await waitFor(() => {
    expect(browser.downloads).toHaveLength(2);
  });

  const [second, first] = browser.downloads;
  expect(second?.filename).toBe("Table.xlsx");
  expect(first?.filename).toBe("Table.xlsx");
  expect(second?.blob?.type).toBe(WORKBOOK_MIME_TYPE);
  const secondWorkbook = await workbookRows(second?.blob);
  expect(secondWorkbook.rows).toStrictEqual([
    ["Plan", "Price"],
    ["Pro", "20"],
  ]);
  const firstWorkbook = await workbookRows(first?.blob);
  expect(firstWorkbook.rows).toStrictEqual([
    ["姓名", "资料"],
    ["张三", "Profile (https://example.test/people/zhang)"],
    ["00123", "=SUM(A1:A2)"],
  ]);
  expect(firstWorkbook.inlineStrings).toBe(6);
  expect(firstWorkbook.cells).toBe(6);
  expect(tableActions(posthog)).toStrictEqual([
    {
      action: "download",
      surface: "inline_table",
      artifact_type: "spreadsheet",
    },
    {
      action: "download",
      surface: "inline_table",
      artifact_type: "spreadsheet",
    },
  ]);
});

function popupBoundary() {
  const authorizationWindow = context.mocks.browser.authWindow();
  const location = { href: "about:blank" };
  Object.defineProperty(authorizationWindow, "location", {
    configurable: true,
    value: location,
  });
  return {
    location,
    open: context.mocks.browser.open(authorizationWindow),
  };
}

// #49430 retired the Agent authorization step for chat exports, so the
// former (authorize) row has no current behavior.
test.each([
  {
    accountState: "ready",
  },
] as const)(
  "Cloud exports preserve the selected account and upload mode ($accountState)",
  async ({ accountState }) => {
    const popup = popupBoundary();
    const saves = mockTableSaves([PLAN_TABLE], { accountState });
    await openChat(1);

    await chooseExport(0, "Save to Google Drive");
    const [artifactId] = await waitForUploads(saves, 1);
    await expectSavedLink(
      "Saved to Google Drive",
      linkFor(artifactId, "original"),
    );
    await chooseExport(0, "Save to Google Sheets");
    await expectSavedLink(
      "Saved to Google Sheets",
      linkFor(artifactId, "google"),
    );

    expect(saves.syncRequests).toStrictEqual([
      { artifactId, connectionId: SELECTED_CONNECTION_ID, mode: "original" },
      { artifactId, connectionId: SELECTED_CONNECTION_ID, mode: "google" },
    ]);
    expect(saves.uploadedArtifacts).toStrictEqual([artifactId]);
    expect(popup.open.calls).toHaveLength(0);
    expect(saves.oauthRequests).toStrictEqual([]);
    expect(
      screen.queryByRole("dialog", { name: "Connect Google Drive" }),
    ).not.toBeInTheDocument();
  },
);

async function waitForUploads(
  saves: ReturnType<typeof mockTableSaves>,
  count: number,
): Promise<string[]> {
  await waitFor(() => {
    expect(saves.uploadedArtifacts).toHaveLength(count);
  });
  return saves.uploadedArtifacts;
}

test("Cloud exports preserve the selected account and upload mode (connect)", async () => {
  const popup = popupBoundary();
  const saves = mockTableSaves([PLAN_TABLE], { accountState: "connect" });
  await openChat(1);

  await chooseExport(0, "Save to Google Drive");
  const dialog = await screen.findByRole("dialog", {
    name: "Connect Google Drive",
  });
  expect(saves.syncRequests).toStrictEqual([]);
  click(buttonNamed("Connect", dialog));
  await waitFor(() => {
    expect(popup.location.href).toBe(AUTHORIZATION_URL);
  });
  expect(saves.oauthRequests).toStrictEqual([{ intent: "add" }]);
  saves.completeAuthorization();

  const [artifactId] = await waitForUploads(saves, 1);
  await expectSavedLink(
    "Saved to Google Drive",
    linkFor(artifactId, "original"),
  );
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
  await chooseExport(0, "Save to Google Sheets");
  await expectSavedLink(
    "Saved to Google Sheets",
    linkFor(artifactId, "google"),
  );

  expect(saves.syncRequests).toStrictEqual([
    { artifactId, connectionId: NEW_CONNECTION_ID, mode: "original" },
    { artifactId, connectionId: NEW_CONNECTION_ID, mode: "google" },
  ]);
  expect(popup.open.calls).toHaveLength(1);
  expect(saves.oauthRequests).toHaveLength(1);
});

test.each([
  {
    action: "Save to Google Drive",
    notice: "Saved to Google Drive",
    mode: "original",
    destination: "Google Drive",
  },
  {
    action: "Save to Google Sheets",
    notice: "Saved to Google Sheets",
    mode: "google",
    destination: "Google Sheets",
  },
] as const)(
  "Repeating Save to $destination after success shows the new response link",
  async ({ action, notice, mode }) => {
    const saves = mockTableSaves([PLAN_TABLE]);
    await openChat(1);

    await chooseExport(0, action);
    const [artifactId] = await waitForUploads(saves, 1);
    await expectSavedLink(notice, linkFor(artifactId, mode, 1));
    await chooseExport(0, action);

    await expectSavedLink(notice, linkFor(artifactId, mode, 2));
    click(exportControl(0));
    await waitFor(() => {
      expect(roleItemNamed("menuitem", action)).not.toHaveAttribute(
        "aria-disabled",
        "true",
      );
    });
    expect(saves.syncRequests).toHaveLength(2);
  },
);

test("Interleaving two tables and Google destinations shows the matching success links", async () => {
  const saves = mockTableSaves([PLAN_TABLE, TEAM_TABLE]);
  await openChat(2);

  await chooseExport(0, "Save to Google Drive");
  const [first] = await waitForUploads(saves, 1);
  await expectSavedLink("Saved to Google Drive", linkFor(first, "original"));
  await chooseExport(1, "Save to Google Sheets");
  const [, second] = await waitForUploads(saves, 2);
  await expectSavedLink("Saved to Google Sheets", linkFor(second, "google"));
  await chooseExport(0, "Save to Google Sheets");
  await expectSavedLink("Saved to Google Sheets", linkFor(first, "google"));
  await chooseExport(1, "Save to Google Drive");
  await expectSavedLink("Saved to Google Drive", linkFor(second, "original"));

  expect(first).not.toBe(second);
  expect(saves.syncRequests).toStrictEqual([
    {
      artifactId: first,
      connectionId: SELECTED_CONNECTION_ID,
      mode: "original",
    },
    {
      artifactId: second,
      connectionId: SELECTED_CONNECTION_ID,
      mode: "google",
    },
    { artifactId: first, connectionId: SELECTED_CONNECTION_ID, mode: "google" },
    {
      artifactId: second,
      connectionId: SELECTED_CONNECTION_ID,
      mode: "original",
    },
  ]);
  await waitFor(() => {
    expect(exportControl(0)).toBeEnabled();
  });
  click(exportControl(0));
  await waitFor(() => {
    expect(exportControl(0)).toHaveAttribute("aria-expanded", "true");
  });
  expect(exportControl(1)).toBeEnabled();
  expect(exportControl(1)).toHaveAccessibleName("Export");
});

test("An unconfirmed Sheets conversion can be retried after saving to Drive", async () => {
  const saves = mockTableSaves([PLAN_TABLE], {
    driveOutcomes: [{}, { mimeType: WORKBOOK_MIME_TYPE }, {}],
  });
  await openChat(1);

  await chooseExport(0, "Save to Google Drive");
  const [artifactId] = await waitForUploads(saves, 1);
  await expectSavedLink(
    "Saved to Google Drive",
    linkFor(artifactId, "original"),
  );
  await chooseExport(0, "Save to Google Sheets");
  await waitFor(() => {
    expect(
      toastsWith(
        "Google conversion could not be confirmed. Check Drive before retrying.",
        "warning",
      ),
    ).toHaveLength(1);
  });
  expect(toastsWith("Saved to Google Sheets", "success")).toHaveLength(0);

  await chooseExport(0, "Save to Google Sheets");

  await expectSavedLink(
    "Saved to Google Sheets",
    linkFor(artifactId, "google", 2),
  );
  expect(
    saves.syncRequests.map(({ mode }) => {
      return mode;
    }),
  ).toStrictEqual(["original", "google", "google"]);
});

test.each([
  {
    source: "upload",
    action: "Save to Google Drive",
    notice: "Saved to Google Drive",
    mode: "original",
    target: "file",
    message: "Could not upload the table. Please try again.",
    options: { uploadStatuses: [503] },
  },
  {
    source: "Google Drive API",
    action: "Save to Google Sheets",
    notice: "Saved to Google Sheets",
    mode: "google",
    target: "spreadsheet",
    message: "Google Drive is temporarily unavailable",
    options: { driveOutcomes: [{ status: 503 }] },
  },
] as const)(
  "A $source failure leaves the table save available for retry",
  async ({ action, notice, mode, target, message, options }) => {
    const posthog = context.mocks.posthog();
    const saves = mockTableSaves([PLAN_TABLE], options);
    await openChat(1);

    await chooseExport(0, action);
    await waitFor(() => {
      expect(toastsWith(message, "error")).toHaveLength(1);
    });
    expect(toastsWith(notice, "success")).toHaveLength(0);

    await chooseExport(0, action);

    const [artifactId = ""] = await waitForUploads(saves, 1);
    await expectSavedLink(
      notice,
      linkFor(artifactId, mode, mode === "google" ? 2 : 1),
    );
    expect(tableActions(posthog)).toStrictEqual([
      { action: "google_drive_sync", surface: "inline_table", target },
      { action: "google_drive_sync", surface: "inline_table", target },
    ]);
  },
);

test("The table export trigger is disabled and named Saving… during the initial upload", async () => {
  const upload = context.mocks.deferred<void>();
  const saves = mockTableSaves([PLAN_TABLE, TEAM_TABLE], {
    holdUpload: upload.promise,
  });
  await openChat(2);

  await chooseExport(0, "Save to Google Drive");

  await waitFor(() => {
    expect(exportControl(0)).toHaveAccessibleName("Saving…");
  });
  expect(exportControl(0)).toBeDisabled();
  expect(exportControl(0)).toHaveAttribute("aria-busy", "true");
  expect(exportControl(1)).toBeEnabled();
  expect(exportControl(1)).toHaveAccessibleName("Export");

  upload.resolve();

  const [artifactId] = await waitForUploads(saves, 1);
  await expectSavedLink(
    "Saved to Google Drive",
    linkFor(artifactId, "original"),
  );
  await waitFor(() => {
    expect(exportControl(0)).toHaveAttribute("aria-busy", "false");
  });
  expect(exportControl(0)).toHaveAccessibleName("Export");
});

test("A completed original save without a URL remains available to save again", async () => {
  const saves = mockTableSaves([PLAN_TABLE], {
    driveOutcomes: [{ webViewLink: null }],
  });
  await openChat(1);

  await chooseExport(0, "Save to Google Drive");
  await waitFor(() => {
    expect(toastsWith("Saved to Google Drive", "success")).toHaveLength(1);
  });
  expect(viewLinks()).toStrictEqual([]);

  await chooseExport(0, "Save to Google Drive");

  const [artifactId] = saves.uploadedArtifacts;
  await expectSavedLink(
    "Saved to Google Drive",
    linkFor(artifactId ?? "", "original", 2),
  );
});
