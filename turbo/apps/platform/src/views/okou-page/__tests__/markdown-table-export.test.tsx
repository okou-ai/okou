// @vitest-environment-options {"url":"https://app.okou.ai/","settings":{"disableIframePageLoading":true,"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { connectorAccountFixture } from "../../../mocks/handlers/connector-account-fixtures.ts";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { builtinConnectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import {
  googleDriveCatalogItem,
  artifactSummary,
  fileArtifactDetail,
} from "./chat-navigation-artifact-test-helpers.ts";
import {
  mockOAuthCompletions,
  mockSavedConnectorAccounts,
} from "./connector-page-test-helpers.ts";
import { HttpResponse } from "msw";
import { strFromU8, unzipSync } from "fflate";
import { findAction } from "./connector-integrations-test-helpers.ts";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { artifactGoogleDriveContract } from "@okouai/api-contracts/contracts/artifact-google-drive";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createChatRunFixtures,
  RUN_PATH,
  assistantEvent,
  promptEvent,
  completedEvent,
} from "./chat-run-test-fixtures.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
const context = testContext();
async function table(text: string) {
  const runId = crypto.randomUUID();
  createChatRunFixtures(context).installRunChat({
    chatEvents: [
      promptEvent({
        id: crypto.randomUUID(),
        runId,
        seqId: 1,
        text: "List the invoice totals",
      }),
      assistantEvent({ id: crypto.randomUUID(), runId, seqId: 2, text }),
      completedEvent({ id: crypto.randomUUID(), runId, seqId: 3 }),
    ],
  });
  await setupPage({ context, path: RUN_PATH });
}
test("markdown-table-export-002 an empty single-column table keeps its export action", async () => {
  await table("| Invoice |\n| --- |");
  await screen.findByText("Invoice", { selector: "th" });
  await screen.findByText("0 rows · 1 column");
  await expect(findFastControl("button", "Export")).resolves.toBeEnabled();
});
test("markdown-table-export-013 keyboard export reveals both Google destinations and restores focus", async () => {
  await table("| Invoice |\n| --- |\n| March |");
  const trigger = await findFastControl("button", "Export");
  trigger.focus();
  await userEvent.keyboard("{ArrowDown}");
  const excel = await screen.findByText("Export Excel", {
    selector: '[role="menuitem"]',
  });
  await waitFor(() => {
    return expect(excel).toHaveFocus();
  });
  for (const name of ["Save to Google Drive", "Save to Google Sheets"]) {
    expect(
      screen.getByText(name, { selector: '[role="menuitem"]' }),
    ).toBeInTheDocument();
  }
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    return expect(trigger).toHaveFocus();
  });
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

const workbookType =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const sheetsType = "application/vnd.google-apps.spreadsheet";
type SaveMode = "original" | "google";
function spreadsheetBoundary() {
  const fileId = crypto.randomUUID();
  const artifactId = crypto.randomUUID();
  const file = {
    id: fileId,
    filename: "Table.xlsx",
    size: 256,
    contentType: workbookType,
    url: "https://exports.example.test/" + fileId,
  };
  context.mocks.upload.success(file);
  context.mocks.api(uploadsContract.preparePrivate, ({ respond }) => {
    return respond(200, {
      ...file,
      uploadUrl: "https://mock-upload.r2.test/" + fileId,
      uploadHeaders: {},
    });
  });
  context.mocks.api(
    artifactReferencesContract.ownerArtifact,
    ({ params, respond }) => {
      expect(params.reference).toBe(fileId.replaceAll("-", "") + ".xlsx");
      return respond(200, { artifactId });
    },
  );
  const account = crypto.randomUUID();
  const access = { needsConnection: false };
  const detail = fileArtifactDetail(
    artifactSummary(artifactId, "file", "Weekly totals"),
    { fileId, ...file },
  );
  context.mocks.api(artifactCatalogContract.get, ({ params, respond }) => {
    expect(params.artifactId).toBe(artifactId);
    return respond(200, {
      ...detail,
      googleDriveConnectionId: access.needsConnection ? undefined : account,
      googleDriveSync: access.needsConnection
        ? { status: "disconnected", recovery: { action: "connect" } }
        : { status: "not_synced" },
    });
  });
  const destination = {
    url: null as string | null,
    convert: true,
    unavailable: false,
    ready: Promise.resolve(),
    started: context.mocks.deferred<void>(),
  };
  const receipts: SaveMode[] = [];
  context.mocks.api(
    artifactGoogleDriveContract.uploadFromChat,
    async ({ params, body, respond }) => {
      expect(params.artifactId).toBe(artifactId);
      expect(body.connectionId).toBe(account);
      receipts.push(body.mode);
      if (!destination.started.settled()) {
        destination.started.resolve();
      }
      await destination.ready;
      if (destination.unavailable) {
        return respond(503, {
          error: {
            code: "GOOGLE_DRIVE_UNAVAILABLE",
            message: "Google Drive is temporarily unavailable",
          },
        });
      }
      return respond(200, {
        id: "weekly-totals",
        name: "Table.xlsx",
        webViewLink: destination.url,
        mimeType:
          body.mode === "google" && destination.convert
            ? sheetsType
            : workbookType,
      });
    },
  );
  return { destination, receipts, account, access };
}

async function saveTo(mode: SaveMode, trigger?: HTMLElement) {
  click(trigger ?? (await findFastControl("button", "Export")));
  const label =
    mode === "original" ? "Save to Google Drive" : "Save to Google Sheets";
  click(await screen.findByText(label, { selector: '[role="menuitem"]' }));
}
async function savedLink(mode: SaveMode, href: string) {
  await waitFor(() => {
    const link = queryAllByRoleFast("link", document.body).find((a) => {
      return a.getAttribute("href") === href;
    });
    expect(link).toBeInTheDocument();
    expect(link?.closest("li")).toHaveTextContent(
      mode === "original" ? "Saved to Google Drive" : "Saved to Google Sheets",
    );
  });
}
const forecast = "| Period | Amount |\n|---|---|\n| Spring | 28 |";
test.each([
  ["markdown-table-export-019", "original", "Save to Google Drive"],
  ["markdown-table-export-020", "google", "Save to Google Sheets"],
] as const)(
  "%s a repeated save offers the latest destination link",
  async (_id, mode, label) => {
    const { destination, receipts } = spreadsheetBoundary();
    destination.url = "https://docs.example.test/first-copy";
    await table(forecast);
    await saveTo(mode);
    await savedLink(mode, destination.url);
    destination.url = "https://docs.example.test/second-copy";
    await saveTo(mode);
    await savedLink(mode, destination.url);
    expect(receipts).toStrictEqual([mode, mode]);
    click(await findFastControl("button", "Export"));
    await expect(
      screen.findByText(label, {
        selector: '[role="menuitem"]',
      }),
    ).resolves.toBeEnabled();
  },
);

test("markdown-table-export-022 retrying a Sheets conversion produces a confirmed spreadsheet", async () => {
  const { destination, receipts } = spreadsheetBoundary();
  destination.url = "https://docs.example.test/original";
  await table(forecast);
  await saveTo("original");
  await savedLink("original", destination.url);
  destination.convert = false;
  await saveTo("google");
  await expect(
    screen.findByText(
      "Google conversion could not be confirmed. Check Drive before retrying.",
    ),
  ).resolves.toBeInTheDocument();
  destination.convert = true;
  destination.url = "https://docs.example.test/converted";
  await saveTo("google");
  await savedLink("google", destination.url);
  expect(receipts).toStrictEqual(["original", "google", "google"]);
});

test("markdown-table-export-025 a pending first upload leaves the second table available", async () => {
  const { destination } = spreadsheetBoundary();
  const held = context.mocks.deferred<void>();
  destination.ready = held.promise;
  destination.url = "https://docs.example.test/quarter";
  await table(
    forecast + "\n\n| Region | Owner |\n|---|---|\n| North | Rivera |",
  );
  await screen.findByText("Rivera", { selector: "td" });
  const [first, second] = queryAllByRoleFast("button", document.body).filter(
    (button) => {
      return button.getAttribute("aria-label") === "Export";
    },
  );
  await saveTo("original", first);
  await destination.started.promise;
  await findAction("button", "Saving…");
  expect(first).toHaveAccessibleName("Saving…");
  expect(first).toBeDisabled();
  expect(first).toHaveAttribute("aria-busy", "true");
  expect(second).toBeEnabled();
  expect(second).toHaveAccessibleName("Export");
  held.resolve();
  await savedLink("original", destination.url);
  expect(first).toBeEnabled();
  expect(first).toHaveAttribute("aria-busy", "false");
});
test("markdown-table-export-026 a linkless save remains repeatable and the next response supplies the link", async () => {
  const { destination } = spreadsheetBoundary();
  await table(forecast);
  await saveTo("original");
  const notice = (await screen.findByText("Saved to Google Drive")).closest(
    "li",
  );
  expect(notice).toBeVisible();
  expect(notice?.querySelector("a")).toBeNull();
  destination.url = "https://drive.example.org/second-receipt";
  await saveTo("original");
  await savedLink("original", destination.url);
});

test.each([
  [
    "markdown-table-export-023",
    "original",
    "Could not upload the table. Please try again.",
  ],
  [
    "markdown-table-export-024",
    "google",
    "Google Drive is temporarily unavailable",
  ],
] as const)(
  "%s retry reaches the requested destination after service recovery",
  async (_id, mode, message) => {
    const { destination } = spreadsheetBoundary();
    const telemetry = context.mocks.posthog();
    let storageHealthy = mode !== "original";
    context.mocks.http.put("https://mock-upload.r2.test/*", () => {
      return new HttpResponse(null, { status: storageHealthy ? 200 : 503 });
    });
    destination.unavailable = mode === "google";
    await table(forecast);
    await saveTo(mode);
    await screen.findByText(message);
    storageHealthy = true;
    destination.unavailable = false;
    destination.url = "https://exports.example.test/recovered";
    await saveTo(mode);
    await savedLink(mode, destination.url);
    const actions = telemetry.events.filter((event) => {
      return event.name === "artifact_action_clicked";
    });
    expect(
      actions.map((event) => {
        return event.properties;
      }),
    ).toStrictEqual(
      Array.from({ length: 2 }, () => {
        return expect.objectContaining({
          action: "google_drive_sync",
          surface: "inline_table",
          target: mode === "original" ? "file" : "spreadsheet",
        });
      }),
    );
  },
);

test("markdown-table-export-014 exporting in reverse order produces two independent literal worksheets", async () => {
  const boundary = context.mocks.browser.blobDownload(),
    telemetry = context.mocks.posthog();
  await table(
    "| 员工 | 编号 | 公式 |\n|---|---|---|\n| [林](https://example.org/lin) | 00071 | =A2+1 |\n\n| Plan | Price |\n|---|---|\n| Annual | 42 |",
  );
  await screen.findByText("Annual", { selector: "td" });
  const buttons = queryAllByRoleFast("button").filter((button) => {
    return button.getAttribute("aria-label") === "Export";
  });
  for (const index of [1, 0]) {
    click(buttons[index]);
    click(
      await screen.findByText("Export Excel", {
        selector: '[role="menuitem"]',
      }),
    );
  }
  expect(
    boundary.downloads.map((d) => {
      return d.filename;
    }),
  ).toStrictEqual(["Table.xlsx", "Table.xlsx"]);
  const sheets = [];
  for (const { blob } of boundary.downloads) {
    if (!blob) {
      throw new Error("Missing workbook");
    }
    const archive = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    expect(archive["xl/workbook.xml"]).toBeDefined();
    const sheet = new DOMParser().parseFromString(
      strFromU8(archive["xl/worksheets/sheet1.xml"]),
      "application/xml",
    );
    const cells = [...sheet.getElementsByTagName("c")];
    expect(
      cells.every((c) => {
        return c.getAttribute("t") === "inlineStr";
      }),
    ).toBeTruthy();
    sheets.push(
      cells.map((c) => {
        return c.textContent;
      }),
    );
  }
  expect(sheets).toStrictEqual([
    ["Plan", "Price", "Annual", "42"],
    ["员工", "编号", "公式", "林 (https://example.org/lin)", "00071", "=A2+1"],
  ]);
  expect(
    telemetry.events
      .filter((e) => {
        return e.name === "artifact_action_clicked";
      })
      .map((e) => {
        return e.properties;
      }),
  ).toStrictEqual(
    Array.from({ length: 2 }, () => {
      return expect.objectContaining({
        surface: "inline_table",
        artifact_type: "spreadsheet",
        action: "download",
      });
    }),
  );
});
test("markdown-table-export-017 a newly connected Drive account serves both destinations", async () => {
  const { access, account, destination, receipts } = spreadsheetBoundary();
  access.needsConnection = true;
  const popup = Object.assign(context.mocks.browser.authWindow(), {
    location: { href: "about:blank" },
  });
  const opened = context.mocks.browser.open(popup);
  const auth = "https://accounts.example.org/table-export";
  const attempt = crypto.randomUUID();
  const completions = mockOAuthCompletions(context);
  context.mocks.api(
    connectorAccountsContract.connection,
    ({ params, respond }) => {
      expect(params.connectionId).toBe(account);
      return respond(
        200,
        connectorAccountFixture(
          { kind: "builtin", connectorSlug: "google-drive" },
          { id: account },
        ),
      );
    },
  );
  context.mocks.api(connectorCatalogContract.get, ({ respond }) => {
    return respond(200, { connector: googleDriveCatalogItem("not-connected") });
  });
  context.mocks.api(
    builtinConnectorOauthStartContract.start,
    ({ params, body, respond }) => {
      expect(params.connectorSlug).toBe("google-drive");
      expect(body.account.intent).toBe("add");
      completions.set(attempt, account);
      return respond(200, { authorizationUrl: auth, oauthAttemptId: attempt });
    },
  );
  await table(forecast);
  destination.url = "https://drive.example.org/native-copy";
  await saveTo("original");
  click(await findAction("button", "Connect"));
  await waitFor(() => {
    return expect(popup.location.href).toBe(auth);
  });
  access.needsConnection = false;
  await savedLink("original", destination.url);
  destination.url = "https://sheets.example.org/converted";
  await saveTo("google");
  await savedLink("google", destination.url);
  expect(receipts).toStrictEqual(["original", "google"]);
  expect(opened.calls).toHaveLength(1);
});

test("markdown-table-export-021 alternating destinations preserves each table's artifact identity", async () => {
  const ids = [crypto.randomUUID(), crypto.randomUUID()],
    artifacts: string[] = [crypto.randomUUID(), crypto.randomUUID()];
  const account = crypto.randomUUID();
  let next = 0;
  const metadata = (id: string) => {
    return {
      id,
      filename: "Table.xlsx",
      contentType: workbookType,
      size: 290,
      url: "https://files.example.org/" + id,
    };
  };
  context.mocks.api(uploadsContract.preparePrivate, ({ respond }) => {
    const id = ids[next++];
    return respond(200, {
      ...metadata(id),
      uploadUrl: "https://storage.example.org/" + id,
      uploadHeaders: {},
    });
  });
  context.mocks.http.put("https://storage.example.org/*", () => {
    return new HttpResponse(null, { status: 200 });
  });
  context.mocks.api(uploadsContract.complete, ({ body, respond }) => {
    return respond(200, metadata(body.id));
  });
  context.mocks.api(
    artifactReferencesContract.ownerArtifact,
    ({ params, respond }) => {
      const index = ids.findIndex((id) => {
        return params.reference === id.replaceAll("-", "") + ".xlsx";
      });
      if (index === -1) {
        throw new Error("Unknown spreadsheet");
      }
      return respond(200, { artifactId: artifacts[index] });
    },
  );
  context.mocks.api(artifactCatalogContract.get, ({ params, respond }) => {
    const ix = artifacts.indexOf(params.artifactId),
      file = metadata(ids[ix]);
    return respond(200, {
      ...fileArtifactDetail(
        artifactSummary(params.artifactId, "file", "Budget"),
        { ...file, fileId: file.id },
      ),
      googleDriveSync: { status: "not_synced" },
      googleDriveConnectionId: account,
    });
  });
  const link = (id: string, mode: SaveMode) => {
    return "https://drive.example.org/" + id + "/" + mode;
  };
  context.mocks.api(
    artifactGoogleDriveContract.uploadFromChat,
    ({ params, body, respond }) => {
      return respond(200, {
        id: params.artifactId,
        name: "Table.xlsx",
        mimeType: body.mode === "google" ? sheetsType : workbookType,
        webViewLink: link(params.artifactId, body.mode),
      });
    },
  );
  await table(forecast + "\n\n| Team | Delta |\n|---|---|\n| East | 47 |");
  await screen.findByText("East", { selector: "td" });
  const buttons = queryAllByRoleFast("button").filter((b) => {
    return b.getAttribute("aria-label") === "Export";
  });
  for (const [index, mode] of [
    [0, "original"],
    [1, "google"],
    [0, "google"],
    [1, "original"],
  ] as const) {
    await saveTo(mode, buttons[index]);
    await savedLink(mode, link(artifacts[index], mode));
  }
  click(buttons[0]);
  await expect(screen.findByRole("menu")).resolves.toBeVisible();
  expect(buttons[1]).toBeEnabled();
});

test("markdown-table-export-015 a ready Google destination serves each export with its selected account without opening authorization", async () => {
  const { account, destination, receipts } = spreadsheetBoundary();
  mockSavedConnectorAccounts(context, () => {
    return [];
  });
  const opened = context.mocks.browser.open();
  await table("| Region | Units |\n|---|---|\n| Port | 86 |");
  for (const mode of ["original", "google"] as const) {
    const receipt = "https://workspace.example.test/" + account + "/" + mode;
    destination.url = receipt;
    await saveTo(mode);
    await savedLink(mode, receipt);
  }
  expect(receipts).toStrictEqual(["original", "google"]);
  expect(opened.calls).toStrictEqual([]);
});
