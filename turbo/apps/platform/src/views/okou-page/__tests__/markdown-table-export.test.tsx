import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { HttpResponse } from "msw";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  GOOGLE_WORKSPACE_MIME_TYPES,
  type GoogleDriveUploadMode,
} from "@okouai/core/google-workspace-conversion";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import {
  artifactReferencesContract,
  artifactReferencePath,
} from "@okouai/api-contracts/contracts/artifact-references";
import {
  artifactCatalogContract,
  type ArtifactDetail,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import { artifactGoogleDriveContract } from "@okouai/api-contracts/contracts/artifact-google-drive";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { builtinConnectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import {
  click,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createMarkdownChatFixture } from "./markdown-page-test-helpers.ts";
import {
  artifactSummary,
  fileArtifactDetail,
  googleDriveCatalogItem,
  buttonNamed,
} from "./chat-navigation-artifact-test-helpers.ts";
import { mockOAuthCompletions } from "./connector-page-test-helpers.ts";
import { findNamedMenuItem } from "./chat-attachment-test-helpers.ts";

const context = testContext();
const FILE_ID = "a0000000-0000-4000-a000-000000000761";
const CATALOG_ID = "a0000000-0000-4000-a000-000000000762";
const CONNECTION_ID = "a0000000-0000-4000-a000-000000000763";
const TABLE_FILES = [
  { fileId: FILE_ID, artifactId: CATALOG_ID },
  {
    fileId: "a0000000-0000-4000-a000-000000000764",
    artifactId: "a0000000-0000-4000-a000-000000000765",
  },
] as const;
const CLOUD_EXPORTS = [
  {
    mode: "original",
    action: "Save to Google Drive",
    saved: "Saved to Google Drive",
    open: "Open in Google Drive",
  },
  {
    mode: "google",
    action: "Save to Google Sheets",
    saved: "Saved to Google Sheets",
    open: "Open in Google Sheets",
  },
] as const;
const UPLOAD_URL = "https://storage.example.test/table-export";
const TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const SOURCE = [
  "| Name | Details |",
  "| --- | --- |",
  "| **张敏** | [Profile](https://example.com/person?q=a&b=c) |",
  '| 00123 | =HYPERLINK("https://example.com") |',
  "",
  "| Plan | Price |",
  "| --- | --- |",
  "| Team | 42 |",
].join("\n");

async function openTables() {
  const chat = createMarkdownChatFixture(context);
  const rows = [
    chat.outputMessage(SOURCE, { seqId: 1 }),
    chat.runCompleted({ seqId: 2 }),
  ];
  chat.install({
    rows: () => {
      return rows;
    },
  });
  await setupPage({
    context,
    path: chat.path,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.MarkdownTableExport]: true },
  });
  await screen.findByText("张敏");
  return chat;
}

function sheet(bytes: ArrayBuffer) {
  const files = unzipSync(new Uint8Array(bytes));
  const document = new DOMParser().parseFromString(
    strFromU8(files["xl/worksheets/sheet1.xml"]!),
    "application/xml",
  );
  expect(document.querySelector("parsererror")).toBeNull();
  return document;
}

function tableExportButton(index = 0) {
  const button = queryAllByRoleFast("button").filter((candidate) => {
    return ["Export", "Saving…"].includes(candidate.textContent?.trim() ?? "");
  })[index];
  if (!button) {
    throw new Error(`Expected export control for table ${index + 1}`);
  }
  return button;
}

async function openExportMenu(index = 0) {
  await waitFor(() => {
    expect(tableExportButton(index)).toBeEnabled();
  });
  click(tableExportButton(index));
  return screen.findByRole("menu");
}

async function closeExportMenu(index = 0) {
  await userEvent.setup().keyboard("{Escape}");
  await waitFor(() => {
    expect(tableExportButton(index)).toHaveAttribute("aria-expanded", "false");
  });
}

async function expectSavedLink(label: string, url: string, menu: HTMLElement) {
  const item = await findNamedMenuItem(label, menu);
  expect(item.tagName).toBe("A");
  expect(item).toHaveAttribute("href", url);
  expect(item).toHaveAttribute("target", "_blank");
  expect(item).toHaveAttribute("rel", "noopener noreferrer");
}

function googleFile(mode: GoogleDriveUploadMode, webViewLink: string | null) {
  return {
    id: `google-${mode}`,
    name: "Table.xlsx",
    mimeType:
      mode === "google" ? GOOGLE_WORKSPACE_MIME_TYPES.spreadsheet : TYPE,
    webViewLink,
  };
}

function mockTableCloudFiles(
  options: {
    readonly files?: readonly {
      readonly fileId: string;
      readonly artifactId: string;
    }[];
    readonly onUpload?: (bytes: ArrayBuffer) => void;
    readonly googleDriveSync?: () => NonNullable<
      ArtifactDetail["googleDriveSync"]
    >;
  } = {},
) {
  const files = options.files ?? [TABLE_FILES[0]];
  let nextFile = 0;
  context.mocks.api(uploadsContract.preparePrivate, ({ body, respond }) => {
    expect(body).toMatchObject({
      filename: "Table.xlsx",
      contentType: TYPE,
      requirePrivateArtifact: true,
      purpose: "artifact",
    });
    const file = files[nextFile] ?? files[files.length - 1];
    nextFile += 1;
    if (!file) {
      throw new Error("Expected a table upload fixture");
    }
    return respond(200, {
      id: file.fileId,
      filename: "Table.xlsx",
      contentType: TYPE,
      size: body.size,
      url: `https://app.example.test${artifactReferencePath(file.fileId, "Table.xlsx")}`,
      uploadUrl: UPLOAD_URL,
      uploadHeaders: {},
    });
  });
  context.mocks.http.put(UPLOAD_URL, async ({ request }) => {
    options.onUpload?.(await request.arrayBuffer());
    return new HttpResponse(null, { status: 200 });
  });
  context.mocks.api(uploadsContract.complete, ({ body, respond }) => {
    return respond(200, {
      id: body.id,
      filename: "Table.xlsx",
      contentType: TYPE,
      size: 100,
      url: `https://app.example.test${artifactReferencePath(body.id, "Table.xlsx")}`,
    });
  });
  context.mocks.api(
    artifactReferencesContract.ownerArtifact,
    ({ params, respond }) => {
      const file = files.find((candidate) => {
        return (
          artifactReferencePath(candidate.fileId, "Table.xlsx").slice(
            "/artifacts/".length,
          ) === params.reference
        );
      });
      if (!file) {
        throw new Error(`Unexpected table reference: ${params.reference}`);
      }
      return respond(200, { artifactId: file.artifactId });
    },
  );
  context.mocks.api(artifactCatalogContract.get, ({ params, respond }) => {
    const file = files.find((candidate) => {
      return candidate.artifactId === params.artifactId;
    });
    if (!file) {
      throw new Error(`Unexpected table artifact: ${params.artifactId}`);
    }
    return respond(200, {
      ...fileArtifactDetail(
        artifactSummary(file.artifactId, "file", "Table.xlsx"),
        {
          fileId: file.fileId,
          filename: "Table.xlsx",
          contentType: TYPE,
          url: `https://app.example.test${artifactReferencePath(file.fileId, "Table.xlsx")}`,
        },
      ),
      googleDriveConnectionId: CONNECTION_ID,
      googleDriveSync: options.googleDriveSync?.() ?? {
        status: "not_synced",
        accountReady: true,
      },
    });
  });
}

test("Each table exports its own real workbook with literal values and source URLs", async () => {
  const browser = context.mocks.browser.blobDownload({ deferRead: true });
  await openTables();
  const buttons = queryAllByRoleFast("button").filter((button) => {
    return button.textContent === "Export";
  });
  expect(buttons).toHaveLength(2);
  click(buttons[1]!);
  click(await findNamedMenuItem("Export Excel"));
  await waitFor(() => {
    return expect(browser.downloads).toHaveLength(1);
  });
  expect(browser.downloads[0]?.filename).toBe("Table.xlsx");
  expect(browser.downloads[0]?.blob?.type).toBe(TYPE);
  const second = sheet(await browser.downloads[0]!.blob!.arrayBuffer());
  expect(
    Array.from(second.querySelectorAll("t"), (cell) => {
      return cell.textContent;
    }),
  ).toStrictEqual(["Plan", "Price", "Team", "42"]);

  click(buttons[0]!);
  click(await findNamedMenuItem("Export Excel"));
  await waitFor(() => {
    return expect(browser.downloads).toHaveLength(2);
  });
  const first = sheet(await browser.downloads[1]!.blob!.arrayBuffer());
  expect(
    Array.from(first.querySelectorAll("t"), (cell) => {
      return cell.textContent;
    }),
  ).toStrictEqual([
    "Name",
    "Details",
    "张敏",
    "Profile (https://example.com/person?q=a&b=c)",
    "00123",
    '=HYPERLINK("https://example.com")',
  ]);
  expect(
    Array.from(first.querySelectorAll("c"), (cell) => {
      return cell.getAttribute("t");
    }),
  ).toStrictEqual(
    Array.from({ length: 6 }, () => {
      return "inlineStr";
    }),
  );
});

test.each(["ready", "authorize", "connect", "reconnect"] as const)(
  "Cloud exports preserve the selected account and upload mode (%s)",
  async (accountState) => {
    const storedFiles: ArrayBuffer[] = [];
    const beforeConnectPopupCounts: number[] = [];
    const saves: { artifactId: string; connectionId?: string; mode: string }[] =
      [];
    let authorized = accountState === "ready";
    let needsConnection =
      accountState === "connect" || accountState === "reconnect";
    const authorizationWindow = context.mocks.browser.authWindow();
    Object.defineProperty(authorizationWindow, "location", {
      configurable: true,
      value: { href: "about:blank" },
    });
    const popup = context.mocks.browser.open(authorizationWindow);
    const completedAttempts = mockOAuthCompletions(context);
    const oauthAttemptId = crypto.randomUUID();
    context.mocks.api(connectorCatalogContract.get, ({ respond }) => {
      return respond(200, {
        connector: googleDriveCatalogItem(
          accountState === "reconnect" ? "reconnect-required" : "not-connected",
        ),
      });
    });
    context.mocks.api(
      builtinConnectorOauthStartContract.start,
      ({ body, respond }) => {
        expect(body.account).toStrictEqual(
          accountState === "reconnect"
            ? { intent: "reconnect", connectionId: CONNECTION_ID }
            : { intent: "add" },
        );
        expect(body.authorizeAgent).toBeTruthy();
        authorized = true;
        needsConnection = false;
        completedAttempts.set(oauthAttemptId, CONNECTION_ID);
        return respond(200, {
          authorizationUrl: "https://accounts.google.test/table-export",
          connectionId: CONNECTION_ID,
          oauthAttemptId,
        });
      },
    );
    context.mocks.api(
      connectorAccountsContract.connection,
      ({ params, respond }) => {
        return respond(200, {
          id: params.connectionId,
          target: { kind: "builtin", connectorSlug: "google-drive" },
          authMethod: "oauth",
          displayName: "Table export account",
          isDefault: false,
          externalId: "drive-table-account",
          externalUsername: "table-owner",
          externalEmail: "table-owner@example.test",
          oauthScopes: ["https://www.googleapis.com/auth/drive.file"],
          connectionStatus: "connected",
          missingRequiredFields: [],
          configuredFieldKeys: [],
          reconnectReason: null,
          tokenExpiresAt: null,
          createdAt: "2026-09-01T12:00:00.000Z",
          updatedAt: "2026-09-01T12:01:00.000Z",
        });
      },
    );
    mockTableCloudFiles({
      onUpload: (bytes) => {
        storedFiles.push(bytes);
      },
      googleDriveSync: () => {
        return needsConnection
          ? {
              status: "disconnected",
              recovery:
                accountState === "reconnect"
                  ? { action: "reconnect", connectionId: CONNECTION_ID }
                  : { action: "connect" },
            }
          : authorized
            ? { status: "not_synced", accountReady: true }
            : { status: "disconnected", recovery: { action: "authorize" } };
      },
    });
    context.mocks.api(
      userBuiltinConnectorsContract.update,
      ({ body, respond }) => {
        expect(body).toStrictEqual({
          enabledConnectorSlugs: ["google-drive"],
          operation: "add",
        });
        authorized = true;
        return respond(200, { enabledConnectorSlugs: ["google-drive"] });
      },
    );
    context.mocks.api(
      artifactGoogleDriveContract.uploadWithMode,
      ({ params, body, respond }) => {
        expect(authorized).toBeTruthy();
        saves.push({
          artifactId: params.artifactId,
          connectionId: body.connectionId,
          mode: body.mode,
        });
        return respond(
          200,
          googleFile(body.mode, `https://drive.google.test/${body.mode}`),
        );
      },
    );
    await openTables();
    for (const { action, mode, saved, open } of CLOUD_EXPORTS) {
      const menu = await openExportMenu();
      click(await findNamedMenuItem(action, menu));
      if (needsConnection) {
        const dialog = await screen.findByRole("dialog");
        beforeConnectPopupCounts.push(popup.calls.length);
        click(buttonNamed("Connect", dialog));
      }
      await expect(screen.findByText(saved)).resolves.toBeInTheDocument();
      expect(saves).toContainEqual({
        artifactId: CATALOG_ID,
        connectionId: CONNECTION_ID,
        mode,
      });
      const reopened = await openExportMenu();
      await expectSavedLink(
        open,
        `https://drive.google.test/${mode}`,
        reopened,
      );
      await closeExportMenu();
    }
    expect(beforeConnectPopupCounts).toStrictEqual(
      accountState === "connect" || accountState === "reconnect" ? [0] : [],
    );
    expect(popup.calls).toHaveLength(
      accountState === "connect" || accountState === "reconnect" ? 1 : 0,
    );
    expect(storedFiles).toHaveLength(1);
    expect(sheet(storedFiles[0]!).querySelector('c[r="A2"]')?.textContent).toBe(
      "张敏",
    );
    expect(
      queryAllByRoleFast("link")
        .filter((link) => {
          return link.textContent === "View it";
        })
        .map((link) => {
          return link.getAttribute("href");
        }),
    ).toContain("https://drive.google.test/google");
  },
);

test("Interleaving two tables and Google destinations retains each saved link", async () => {
  const firstLinks = {
    original: "https://drive.google.test/file/d/first-table/view?usp=sharing",
    google: "https://docs.google.test/spreadsheets/d/first-table/edit",
  };
  const secondLinks = {
    original: "https://drive.google.test/file/d/second-table/view",
    google:
      "https://docs.google.test/spreadsheets/d/second-table/edit?usp=sharing",
  };
  mockTableCloudFiles({ files: TABLE_FILES });
  context.mocks.api(
    artifactGoogleDriveContract.uploadWithMode,
    ({ params, body, respond }) => {
      const links = params.artifactId === CATALOG_ID ? firstLinks : secondLinks;
      return respond(200, googleFile(body.mode, links[body.mode]));
    },
  );
  await openTables();

  let menu = await openExportMenu(0);
  click(await findNamedMenuItem("Save to Google Drive", menu));
  menu = await openExportMenu(0);
  await expectSavedLink("Open in Google Drive", firstLinks.original, menu);
  await closeExportMenu(0);

  menu = await openExportMenu(1);
  await expect(
    findNamedMenuItem("Save to Google Drive", menu),
  ).resolves.not.toHaveAttribute("aria-disabled", "true");
  click(await findNamedMenuItem("Save to Google Sheets", menu));
  menu = await openExportMenu(1);
  await expectSavedLink("Open in Google Sheets", secondLinks.google, menu);
  await closeExportMenu(1);

  menu = await openExportMenu(0);
  await expectSavedLink("Open in Google Drive", firstLinks.original, menu);
  click(await findNamedMenuItem("Save to Google Sheets", menu));
  menu = await openExportMenu(0);
  await expectSavedLink("Open in Google Drive", firstLinks.original, menu);
  await expectSavedLink("Open in Google Sheets", firstLinks.google, menu);
  await closeExportMenu(0);

  menu = await openExportMenu(1);
  await expectSavedLink("Open in Google Sheets", secondLinks.google, menu);
  click(await findNamedMenuItem("Save to Google Drive", menu));
  menu = await openExportMenu(1);
  await expectSavedLink("Open in Google Drive", secondLinks.original, menu);
  await expectSavedLink("Open in Google Sheets", secondLinks.google, menu);
  await closeExportMenu(1);

  menu = await openExportMenu(0);
  await expectSavedLink("Open in Google Drive", firstLinks.original, menu);
  await expectSavedLink("Open in Google Sheets", firstLinks.google, menu);
});

test("An unconfirmed Sheets conversion remains retryable without replacing the Drive save", async () => {
  const driveUrl = "https://drive.google.test/file/d/original-table/view";
  const sheetsUrl =
    "https://docs.google.test/spreadsheets/d/confirmed-table/edit";
  let conversionConfirmed = false;
  mockTableCloudFiles();
  context.mocks.api(
    artifactGoogleDriveContract.uploadWithMode,
    ({ body, respond }) => {
      if (body.mode === "google" && !conversionConfirmed) {
        return respond(200, {
          ...googleFile(
            "google",
            "https://drive.google.test/file/d/unconverted/view",
          ),
          mimeType: TYPE,
        });
      }
      return respond(
        200,
        googleFile(body.mode, body.mode === "google" ? sheetsUrl : driveUrl),
      );
    },
  );
  await openTables();

  let menu = await openExportMenu();
  click(await findNamedMenuItem("Save to Google Drive", menu));
  await expect(
    screen.findByText("Saved to Google Drive"),
  ).resolves.toBeInTheDocument();
  menu = await openExportMenu();
  await expectSavedLink("Open in Google Drive", driveUrl, menu);
  click(await findNamedMenuItem("Save to Google Sheets", menu));
  await expect(
    screen.findByText(
      "Google conversion could not be confirmed. Check Drive before retrying.",
    ),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText("Saved to Google Sheets")).not.toBeInTheDocument();

  menu = await openExportMenu();
  await expectSavedLink("Open in Google Drive", driveUrl, menu);
  const retry = await findNamedMenuItem("Save to Google Sheets", menu);
  expect(retry).not.toHaveAttribute("aria-disabled", "true");
  conversionConfirmed = true;
  click(retry);
  await expect(
    screen.findByText("Saved to Google Sheets"),
  ).resolves.toBeInTheDocument();
  menu = await openExportMenu();
  await expectSavedLink("Open in Google Drive", driveUrl, menu);
  await expectSavedLink("Open in Google Sheets", sheetsUrl, menu);
});

test.each([
  {
    failure: "upload",
    destination: CLOUD_EXPORTS[0],
    error: "Could not upload the table. Please try again.",
  },
  {
    failure: "Google Drive API",
    destination: CLOUD_EXPORTS[1],
    error: "Google Drive is temporarily unavailable",
  },
])(
  "A $failure failure leaves the table save available for retry",
  async ({ failure, destination, error }) => {
    let recovered = false;
    const savedUrl = `https://drive.google.test/retried-${destination.mode}`;
    mockTableCloudFiles();
    context.mocks.http.put(UPLOAD_URL, () => {
      return new HttpResponse(null, {
        status: failure === "upload" && !recovered ? 503 : 200,
      });
    });
    context.mocks.api(
      artifactGoogleDriveContract.uploadWithMode,
      ({ body, respond }) => {
        if (failure === "Google Drive API" && !recovered) {
          return respond(503, {
            error: { code: "DRIVE_UPLOAD_FAILED", message: error },
          });
        }
        return respond(200, googleFile(body.mode, savedUrl));
      },
    );
    await openTables();

    let menu = await openExportMenu();
    click(await findNamedMenuItem(destination.action, menu));
    await expect(screen.findByText(error)).resolves.toBeInTheDocument();
    menu = await openExportMenu();
    const retry = await findNamedMenuItem(destination.action, menu);
    expect(retry).not.toHaveAttribute("aria-disabled", "true");

    recovered = true;
    click(retry);
    await expect(
      screen.findByText(destination.saved),
    ).resolves.toBeInTheDocument();
    menu = await openExportMenu();
    await expectSavedLink(destination.open, savedUrl, menu);
  },
);

test("The table export trigger is disabled and says Saving… during the initial upload", async () => {
  const uploadStarted = context.mocks.deferred<void>();
  const releaseUpload = context.mocks.deferred<void>();
  const savedUrl = "https://drive.google.test/file/d/pending-table/view";
  mockTableCloudFiles();
  context.mocks.http.put(UPLOAD_URL, async () => {
    uploadStarted.resolve();
    await releaseUpload.promise;
    return new HttpResponse(null, { status: 200 });
  });
  context.mocks.api(
    artifactGoogleDriveContract.uploadWithMode,
    ({ body, respond }) => {
      return respond(200, googleFile(body.mode, savedUrl));
    },
  );
  await openTables();

  const menu = await openExportMenu();
  click(await findNamedMenuItem("Save to Google Drive", menu));
  await uploadStarted.promise;
  await waitFor(() => {
    expect(buttonNamed("Saving…")).toBeDisabled();
  });
  expect(buttonNamed("Saving…")).toHaveAttribute("aria-busy", "true");
  expect(tableExportButton(1)).toBeEnabled();
  expect(tableExportButton(1)).toHaveTextContent("Export");

  releaseUpload.resolve();
  await expect(
    screen.findByText("Saved to Google Drive"),
  ).resolves.toBeInTheDocument();
  const reopened = await openExportMenu();
  expect(tableExportButton()).toHaveAttribute("aria-busy", "false");
  await expectSavedLink("Open in Google Drive", savedUrl, reopened);
});

test.each(CLOUD_EXPORTS)(
  "A completed $mode save without a URL renders a disabled saved item",
  async ({ action, saved }) => {
    mockTableCloudFiles();
    context.mocks.api(
      artifactGoogleDriveContract.uploadWithMode,
      ({ body, respond }) => {
        return respond(200, googleFile(body.mode, null));
      },
    );
    await openTables();

    const menu = await openExportMenu();
    click(await findNamedMenuItem(action, menu));
    await expect(screen.findByText(saved)).resolves.toBeInTheDocument();
    const reopened = await openExportMenu();
    const savedItem = await findNamedMenuItem(saved, reopened);
    expect(savedItem).toHaveAttribute("aria-disabled", "true");
    expect(savedItem).not.toHaveAttribute("href");
    expect(savedItem.tagName).not.toBe("A");
  },
);
