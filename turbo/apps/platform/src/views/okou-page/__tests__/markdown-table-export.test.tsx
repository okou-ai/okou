import { findAction } from "./connector-integrations-test-helpers.ts";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { artifactGoogleDriveContract } from "@okouai/api-contracts/contracts/artifact-google-drive";
import {
  artifactSummary,
  fileArtifactDetail,
} from "./chat-navigation-artifact-test-helpers.ts";
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
  const detail = fileArtifactDetail(
    artifactSummary(artifactId, "file", "Weekly totals"),
    { fileId, ...file },
  );
  context.mocks.api(artifactCatalogContract.get, ({ params, respond }) => {
    expect(params.artifactId).toBe(artifactId);
    return respond(200, {
      ...detail,
      googleDriveConnectionId: account,
      googleDriveSync: { status: "not_synced" },
    });
  });
  const destination = {
    url: null as string | null,
    convert: true,
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
  return { destination, receipts };
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
test("markdown-table-export-019 saving the same table twice offers the latest Drive link", async () => {
  const { destination, receipts } = spreadsheetBoundary();
  destination.url = "https://docs.example.test/first-copy";
  await table(forecast);
  await saveTo("original");
  await savedLink("original", destination.url);
  destination.url = "https://docs.example.test/second-copy";
  await saveTo("original");
  await savedLink("original", destination.url);
  expect(receipts).toStrictEqual(["original", "original"]);
  click(await findFastControl("button", "Export"));
  await expect(
    screen.findByText("Save to Google Drive", {
      selector: '[role="menuitem"]',
    }),
  ).resolves.toBeEnabled();
});

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
