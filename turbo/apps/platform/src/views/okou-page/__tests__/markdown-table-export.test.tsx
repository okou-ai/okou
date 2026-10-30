import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { HttpResponse } from "msw";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { GOOGLE_WORKSPACE_MIME_TYPES } from "@okouai/core/google-workspace-conversion";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import {
  artifactReferencesContract,
  artifactReferencePath,
} from "@okouai/api-contracts/contracts/artifact-references";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
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
    context.mocks.api(uploadsContract.preparePrivate, ({ body, respond }) => {
      expect(body).toMatchObject({
        filename: "Table.xlsx",
        contentType: TYPE,
        requirePrivateArtifact: true,
        purpose: "artifact",
      });
      return respond(200, {
        id: FILE_ID,
        filename: "Table.xlsx",
        contentType: TYPE,
        size: body.size,
        url: `https://app.example.test${artifactReferencePath(FILE_ID, "table.xlsx")}`,
        uploadUrl: "https://storage.example.test/table-export",
        uploadHeaders: {},
      });
    });
    context.mocks.http.put(
      "https://storage.example.test/table-export",
      async ({ request }) => {
        storedFiles.push(await request.arrayBuffer());
        return new HttpResponse(null, { status: 200 });
      },
    );
    context.mocks.api(uploadsContract.complete, ({ respond }) => {
      return respond(200, {
        id: FILE_ID,
        filename: "Table.xlsx",
        contentType: TYPE,
        size: 100,
        url: `https://app.example.test${artifactReferencePath(FILE_ID, "table.xlsx")}`,
      });
    });
    context.mocks.api(
      artifactReferencesContract.ownerArtifact,
      ({ respond }) => {
        return respond(200, { artifactId: CATALOG_ID });
      },
    );
    context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
      return respond(200, {
        ...fileArtifactDetail(
          artifactSummary(CATALOG_ID, "file", "Table.xlsx"),
          {
            fileId: FILE_ID,
            filename: "Table.xlsx",
            contentType: TYPE,
            url: `https://app.example.test${artifactReferencePath(FILE_ID, "table.xlsx")}`,
          },
        ),
        googleDriveConnectionId: CONNECTION_ID,
        googleDriveSync: needsConnection
          ? {
              status: "disconnected",
              recovery:
                accountState === "reconnect"
                  ? { action: "reconnect", connectionId: CONNECTION_ID }
                  : { action: "connect" },
            }
          : authorized
            ? { status: "not_synced", accountReady: true }
            : { status: "disconnected", recovery: { action: "authorize" } },
      });
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
        return respond(200, {
          id: `google-${body.mode}`,
          name: "Table.xlsx",
          mimeType:
            body.mode === "google"
              ? GOOGLE_WORKSPACE_MIME_TYPES.spreadsheet
              : TYPE,
          webViewLink: `https://drive.google.test/${body.mode}`,
        });
      },
    );
    await openTables();
    for (const [label, mode] of [
      ["Save to Google Drive", "original"],
      ["Save to Google Sheets", "google"],
    ]) {
      click(
        queryAllByRoleFast("button").filter((button) => {
          return button.textContent === "Export";
        })[0]!,
      );
      click(await findNamedMenuItem(label!));
      if (needsConnection) {
        const dialog = await screen.findByRole("dialog");
        beforeConnectPopupCounts.push(popup.calls.length);
        click(buttonNamed("Connect", dialog));
      }
      await waitFor(() => {
        return expect(saves).toContainEqual({
          artifactId: CATALOG_ID,
          connectionId: CONNECTION_ID,
          mode,
        });
      });
      await waitFor(() => {
        return expect(
          queryAllByRoleFast("button").filter((button) => {
            return button.textContent === "Export";
          })[0],
        ).toBeEnabled();
      });
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
